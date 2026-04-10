#!/usr/bin/env node
/**
 * TV Show → Reeltime YAML Generator
 * Uses the TVmaze public API (https://www.tvmaze.com/api)
 *
 * Generates a Reeltime-compatible playlist config YAML for a given TV show.
 * See: https://github.com/rorpage/reeltime
 *
 * Usage:
 *   node tvmaze_import.js "<show name>"
 *   node tvmaze_import.js --id <tvmaze_id>
 *
 * Examples:
 *   node tvmaze_import.js "Brooklyn Nine-Nine"
 *   node tvmaze_import.js "Brooklyn Nine-Nine" --season 2
 *   node tvmaze_import.js --id 49
 *   node tvmaze_import.js --id 49 --season 2 --output brooklyn-nine-nine-s02.yaml
 *
 * Find a TVmaze show ID at: https://www.tvmaze.com (it's in the URL of any show page)
 *
 * Requires: Node.js 18+ (built-in fetch, no npm dependencies needed)
 */

'use strict';

const { writeFileSync } = require('fs');
const { resolve }       = require('path');
const { stripHtml }     = require('../../shared/utils.js');

const BASE_URL = 'https://api.tvmaze.com';

// ─── TVmaze API ───────────────────────────────────────────────────────────────

/** Fetch a show directly by its TVmaze ID — skips the search/relevance step. */
async function getShowById(id) {
  const res = await fetch(`${BASE_URL}/shows/${id}`);
  if (res.status === 404) throw new Error(`No show found with TVmaze ID: ${id}`);
  if (!res.ok) throw new Error(`Failed to fetch show: ${res.status} ${res.statusText}`);
  return res.json();
}

/** Search for a show by name and return the best match. */
async function searchShow(query) {
  const res = await fetch(`${BASE_URL}/search/shows?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`Search failed: ${res.status} ${res.statusText}`);
  const results = await res.json();
  if (!results.length) throw new Error(`No shows found matching: "${query}"`);
  // TVmaze returns results sorted by relevance — index 0 is the best match
  return results[0].show;
}

/** Fetch all episodes for a given show ID. */
async function getEpisodes(showId) {
  const res = await fetch(`${BASE_URL}/shows/${showId}/episodes`);
  if (!res.ok) throw new Error(`Failed to fetch episodes: ${res.status} ${res.statusText}`);
  return res.json();
}

// ─── Data Helpers ─────────────────────────────────────────────────────────────


/** "2024-03-15" → "20240315"  (XMLTV / Reeltime date format). */
function toXmltvDate(airdate) {
  return airdate ? airdate.replace(/-/g, '') : null;
}

/** TVmaze runtime is minutes; Reeltime duration is seconds. */
function toSeconds(minutes) {
  return minutes ? minutes * 60 : null;
}

const pad     = (n) => String(n).padStart(2, '0');
const fmtEp   = (s, e) => `S${pad(s)}E${pad(e)}`;
const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** "Some Title (2)" → "Some Title - Part 2"  (TVmaze multi-part episode naming) */
const normalizeTitle = (s) => s.replace(/\s*\((\d+)\)$/, (_, n) => ` - Part ${n}`);

// ─── YAML Helpers ─────────────────────────────────────────────────────────────

/** Encode a value to its YAML literal. Strings are safely double-quoted. */
function yamlVal(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number')  return String(v);
  if (v === null || v === undefined) return '""';
  return '"' + String(v)
    .replace(/\\/g,    '\\\\')
    .replace(/"/g,     '\\"')
    .replace(/\r?\n/g, ' ')
    .replace(/\t/g,    ' ')
    .trim() + '"';
}

/**
 * Render an ordered list of [key, value] pairs as an aligned YAML block.
 * Pairs with null / undefined values are omitted.
 *
 * The value column is automatically aligned to the longest key in the block,
 * matching the style used in config.example.yaml.
 *
 * @param {[string, any][]} entries
 * @param {Object}  opts
 * @param {string}  [opts.indent='  ']     - Leading whitespace for each line
 * @param {boolean} [opts.listItem=false]  - Prefix first line with "- "
 * @param {Object}  [opts.comments={}]     - { key: 'inline comment text' }
 */
function buildBlock(entries, { indent = '  ', listItem = false, comments = {} } = {}) {
  const rows = entries.filter(([, v]) => v !== null && v !== undefined);
  if (!rows.length) return '';

  // Pad "key:" to the width of the longest key so all values line up
  const maxLen   = Math.max(...rows.map(([k]) => k.length));
  const valueCol = maxLen + 2; // +1 for colon, +1 for minimum space

  return rows.map(([key, value], i) => {
    const keyPad    = `${key}:`.padEnd(valueCol);
    const comment   = comments[key] ? `  # ${comments[key]}` : '';
    const lineStart = listItem
      ? indent + (i === 0 ? '- ' : '  ')
      : indent;
    return `${lineStart}${keyPad}${yamlVal(value)}${comment}`;
  }).join('\n');
}

// ─── YAML Builders ────────────────────────────────────────────────────────────

/** Pick the best available image URL from a TVmaze image object, or null. */
function pickImage(image) {
  return image?.original || image?.medium || null;
}

function buildStreamSection(show) {
  const block = buildBlock([
    ['name',       show.name],
    ['icon',       pickImage(show.image)],
    ['loop',       true],
    ['loop_count', -1],
  ]);
  return `stream:\n${block}`;
}

function buildEpisodeEntry(show, ep) {
  const epIcon = pickImage(ep.image) || pickImage(show.image);

  const title = normalizeTitle(ep.name || 'TBA');
  return buildBlock([
    ['title',        title],
    ['series_title', show.name],
    ['sub_title',    title],
    ['episode_num',  fmtEp(ep.season, ep.number)],
    ['date',         toXmltvDate(ep.airdate)],
    ['url',          ''],
    ['icon',         epIcon],
    ['duration',     toSeconds(ep.runtime)],
    ['description',  stripHtml(ep.summary) || null],
    ['category',     'Series'],
  ], {
    listItem: true,
    comments: { url: 'TODO: replace with actual video URL' },
  });
}

function buildVideosSection(show, episodes) {
  const entries = episodes.map((ep) => buildEpisodeEntry(show, ep));
  return `videos:\n${entries.join('\n\n')}`;
}

/** Assemble the complete YAML document. */
function generateYaml(show, episodes) {
  const seasonCount = new Set(episodes.map((e) => e.season)).size;
  const timestamp   = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const hr          = '─'.repeat(77);

  const header = [
    `# ${hr}`,
    `# Reeltime — Playlist Configuration`,
    `# ${hr}`,
    `# Show:      ${show.name}`,
    `# Seasons:   ${seasonCount}`,
    `# Episodes:  ${episodes.length}`,
    `# Generated: ${timestamp}`,
    `# Source:    TVmaze — https://www.tvmaze.com/shows/${show.id}/${slugify(show.name)}`,
    `# ${hr}`,
    `#`,
    `# ⚠  The "url" field for each episode is intentionally left blank.`,
    `#    Replace each empty string with the actual video URL before running Reeltime.`,
    `# ${hr}`,
    '',
  ].join('\n');

  return [
    header,
    buildStreamSection(show),
    '',
    buildVideosSection(show, episodes),
    '',
  ].join('\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  if (!args.length) return { query: null, id: null, season: null, output: null };

  let id     = null;
  let season = null;
  let output = null;

  // --output <filename>
  const outputIdx = args.indexOf('--output');
  if (outputIdx !== -1) {
    const val = args[outputIdx + 1];
    if (!val || val.startsWith('--')) throw new Error('--output requires a filename.');
    output = val;
    args.splice(outputIdx, 2);
  }

  // --id <showId>
  const idIdx = args.indexOf('--id');
  if (idIdx !== -1) {
    const val = args[idIdx + 1];
    if (!val || val.startsWith('--')) throw new Error('--id requires a TVmaze show ID.');
    id = Number(val);
    if (!Number.isInteger(id) || id <= 0) throw new Error('--id must be a positive integer.');
    args.splice(idIdx, 2);
  }

  // --season <number>
  const seasonIdx = args.indexOf('--season');
  if (seasonIdx !== -1) {
    const val = args[seasonIdx + 1];
    if (!val || val.startsWith('--')) throw new Error('--season requires a season number.');
    season = Number(val);
    if (!Number.isInteger(season) || season <= 0) throw new Error('--season must be a positive integer.');
    args.splice(seasonIdx, 2);
  }

  // Anything left over is treated as a search query
  const query = args.join(' ').trim() || null;

  // --id and a search query are mutually exclusive
  if (id !== null && query) {
    throw new Error('Provide either a show name or --id, not both.');
  }

  return { query, id, season, output };
}

function printUsage() {
  console.log('\n  Usage:');
  console.log('    node tvmaze_import.js "<show name>"');
  console.log('    node tvmaze_import.js --id <tvmaze_id>');
  console.log('\n  Examples:');
  console.log('    node tvmaze_import.js "Brooklyn Nine-Nine"');
  console.log('    node tvmaze_import.js "Brooklyn Nine-Nine" --season 2');
  console.log('    node tvmaze_import.js --id 49');
  console.log('    node tvmaze_import.js --id 49 --season 2 --output brooklyn-nine-nine-s02.yaml');
  console.log('\n  Tip: Find a show\'s TVmaze ID in its page URL, e.g.:');
  console.log('    https://www.tvmaze.com/shows/49/brooklyn-nine-nine  →  ID is 49\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`\n  ❌  ${err.message}`);
    printUsage();
    process.exit(1);
  }

  const { query, id, season, output } = args;

  if (!query && id === null) {
    printUsage();
    process.exit(0);
  }

  try {
    let show;

    if (id !== null) {
      console.log(`\n  🔍 Fetching show with TVmaze ID: ${id}...`);
      show = await getShowById(id);
      console.log(`  ✅ Found: ${show.name}`);
    } else {
      console.log(`\n  🔍 Searching for "${query}"...`);
      show = await searchShow(query);
      console.log(`  ✅ Found: ${show.name} (TVmaze ID: ${show.id})`);
    }

    console.log(`  📡 Fetching episodes...`);
    let episodes = await getEpisodes(show.id);

    const totalSeasons = new Set(episodes.map((e) => e.season)).size;
    console.log(`  ✅ Found ${episodes.length} episode(s) across ${totalSeasons} season(s)`);

    if (season !== null) {
      episodes = episodes.filter((ep) => ep.season === season);
      if (!episodes.length) throw new Error(`Season ${season} not found for "${show.name}".`);
      console.log(`  📋 Filtered to season ${season}: ${episodes.length} episode(s)`);
    }

    console.log('  ⚙️  Generating YAML...');
    const yaml = generateYaml(show, episodes);

    const filename = output ?? `${slugify(show.name)}${season ? `-s${pad(season)}` : ''}.yaml`;
    const filepath = resolve(process.cwd(), filename);

    writeFileSync(filepath, yaml, 'utf8');
    console.log(`  💾 Saved to: ${filepath}\n`);

  } catch (err) {
    console.error(`\n  ❌  ${err.message}\n`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports (for testing) — only when not the entry-point
// ─────────────────────────────────────────────────────────────────────────────

if (require.main !== module) {
  module.exports = {
    stripHtml,
    toXmltvDate,
    toSeconds,
    pad,
    fmtEp,
    slugify,
    normalizeTitle,
    yamlVal,
    buildBlock,
    pickImage,
    buildStreamSection,
    buildEpisodeEntry,
    buildVideosSection,
    generateYaml,
    parseArgs,
  };
} else {
  main();
}

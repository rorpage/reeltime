#!/usr/bin/env node
'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { stripHtml } = require('../../shared/utils.js');

function printUsage() {
  console.log([
    'Usage:',
    '  node tools/merge-configs/merge_configs.js --archive <path> --tvmaze <path> [options]',
    '',
    'Options:',
    '  --archive <path>   Config from archive_to_config.js (provides URLs, durations, descriptions)',
    '  --tvmaze <path>    Config from tvmaze_import.js (provides clean titles, series_title, dates)',
    '  --output <path>    Output file path (default: merged.yaml)',
    '  --dry-run          Print merged result to stdout without writing',
    '  --help             Show this help',
    '',
    'Entries are matched by episode_num (e.g. S01E01).',
    'Unmatched entries are included as-is with a warning.',
    '',
    'Merge priorities:',
    '  title, series_title, sub_title, episode_num, date, icon, description, category  ->  TVmaze wins',
    '  url, duration                                                                  ->  Archive.org wins',
    '',
    'Examples:',
    '  node tools/merge-configs/merge_configs.js \\',
    '    --archive brooklyn-nine-nine-archive.yaml \\',
    '    --tvmaze  brooklyn-nine-nine-tvmaze.yaml  \\',
    '    --output  brooklyn-nine-nine.yaml',
    '',
    '  node tools/merge-configs/merge_configs.js \\',
    '    --archive brooklyn-nine-nine-archive.yaml \\',
    '    --tvmaze  brooklyn-nine-nine-tvmaze.yaml  \\',
    '    --dry-run',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {
    archive: '',
    tvmaze:  '',
    output:  'merged.yaml',
    dryRun:  false,
    help:    false,
  };

  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--help' || t === '-h') { args.help   = true;                       continue; }
    if (t === '--dry-run')            { args.dryRun = true;                       continue; }
    if (t === '--archive')            { args.archive = argv[++i] || '';           continue; }
    if (t === '--tvmaze')             { args.tvmaze  = argv[++i] || '';           continue; }
    if (t === '--output')             { args.output  = argv[++i] || 'merged.yaml'; continue; }
    throw new Error(`Unknown argument: ${t}`);
  }

  return args;
}

// Return the first value that is non-null, non-undefined, and non-empty-string.
function first(...vals) {
  for (const v of vals) {
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// Extract the string value of a named field from a YAML entry block.
// Handles both the first line (  - key: value) and subsequent lines (    key: value).
function getField(block, key) {
  const re = new RegExp(
    `^[ \\t]+(?:-[ \\t]+)?${escapeRe(key)}:[ \\t]+(?:"((?:[^"\\\\]|\\\\[\\s\\S])*)"|'([^']*)'|(\\S[^\\n]*?))?(?:[ \\t]*#[^\\n]*)?$`,
    'm',
  );
  const m = block.match(re);
  if (!m) return null;
  if (m[1] !== undefined) return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (m[2] !== undefined) return m[2];
  if (m[3] !== undefined) return m[3].trim();
  return ''; // key present but empty value
}

// Extract the indented lines of the videos: section.
function extractVideosSection(text) {
  const lines = text.split('\n');
  const si    = lines.findIndex(l => /^videos:\s*$/.test(l));
  if (si === -1) return '';

  const out = [];
  for (let i = si + 1; i < lines.length; i++) {
    if (lines[i].length > 0 && !/^\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

// Split a videos section into individual entry blocks.
function parseEntries(text) {
  const section = extractVideosSection(text);
  const entries = [];
  const re      = /^  - /gm;
  let last = null;
  let m;

  while ((m = re.exec(section)) !== null) {
    if (last !== null) entries.push(section.slice(last.index, m.index).trimEnd());
    last = m;
  }
  if (last !== null) entries.push(section.slice(last.index).trimEnd());

  return entries.filter(e => e.trim());
}

// Extract the stream: block (all indented lines that follow it).
function getStreamBlock(text) {
  const lines = text.split('\n');
  const si    = lines.findIndex(l => /^stream:\s*$/.test(l));
  if (si === -1) return '';

  const out = [lines[si]];
  for (let i = si + 1; i < lines.length; i++) {
    if (lines[i].length > 0 && !/^\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trimEnd();
}

function yamlQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const FIELD_ORDER = [
  'title', 'series_title', 'sub_title', 'episode_num',
  'date', 'url', 'icon', 'duration', 'description', 'category',
];

function renderEntry(fields) {
  const rows = FIELD_ORDER
    .map(k => [k, fields[k]])
    .filter(([key, v]) => {
      // Always emit url so it's visible even when blank
      if (key === 'url') return true;
      return v !== null && v !== undefined && v !== '';
    });

  if (!rows.length) return '';

  const maxLen   = Math.max(...rows.map(([k]) => k.length));
  const valueCol = maxLen + 2;

  return rows.map(([key, value], i) => {
    const keyPad = `${key}:`.padEnd(valueCol);
    let val;

    if (key === 'duration') {
      const n = Math.round(Number(value) || 0);
      val = String(n > 0 ? n : 3600);
    } else if (key === 'url' && !value) {
      val = `""  # TODO: replace with actual video URL`;
    } else {
      val = yamlQuote(String(value));
    }

    return `${i === 0 ? '  - ' : '    '}${keyPad}${val}`;
  }).join('\n');
}

function mergeEntry(a, t) {
  const af = k => a ? getField(a, k) : null;
  const tf = k => t ? getField(t, k) : null;

  return {
    title:        first(tf('title'),        af('title')),
    series_title: first(tf('series_title'), af('series_title')),
    sub_title:    first(tf('sub_title'),    af('sub_title')),
    episode_num:  first(tf('episode_num'),  af('episode_num')),
    date:         first(tf('date'),         af('date')),
    url:          af('url') ?? '',  // always from archive, default to empty
    icon:         first(tf('icon'),         af('icon')),
    duration:     first(af('duration'),     tf('duration')),
    description:  first(stripHtml(tf('description')), stripHtml(af('description'))) || null,
    category:     first(tf('category'),     af('category')),
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    printUsage();
    process.exit(1);
  }

  if (args.help) { printUsage(); return; }

  if (!args.archive || !args.tvmaze) {
    console.error('Error: --archive and --tvmaze are both required.');
    printUsage();
    process.exit(1);
  }

  for (const [flag, p] of [['--archive', args.archive], ['--tvmaze', args.tvmaze]]) {
    if (!fs.existsSync(p)) {
      console.error(`File not found (${flag}): ${p}`);
      process.exit(1);
    }
  }

  const archiveText = fs.readFileSync(path.resolve(args.archive), 'utf8');
  const tvmazeText  = fs.readFileSync(path.resolve(args.tvmaze),  'utf8');

  const archiveEntries = parseEntries(archiveText);
  const tvmazeEntries  = parseEntries(tvmazeText);

  const byEpA = new Map();
  const byEpT = new Map();
  const noEpA = [];

  for (const e of archiveEntries) {
    const ep = getField(e, 'episode_num');
    if (ep) byEpA.set(ep.toUpperCase(), e);
    else    noEpA.push(e);
  }
  for (const e of tvmazeEntries) {
    const ep = getField(e, 'episode_num');
    if (ep) byEpT.set(ep.toUpperCase(), e);
    // TVmaze entries without episode_num are skipped — they have no URL anyway
  }

  const sortedKeys = [...new Set([...byEpA.keys(), ...byEpT.keys()])].sort();

  let matched = 0, archiveOnly = 0, tvmazeOnly = 0;
  const blocks = [];

  for (const key of sortedKeys) {
    const a = byEpA.get(key) ?? null;
    const t = byEpT.get(key) ?? null;

    if (a && t)   matched++;
    else if (a) { archiveOnly++; console.warn(`[merge] WARN: ${key} found in archive config only`); }
    else        { tvmazeOnly++;  console.warn(`[merge] WARN: ${key} found in tvmaze config only — url will be blank`); }

    blocks.push(renderEntry(mergeEntry(a, t)));
  }

  // Archive entries without episode_num can't be matched — include as-is at the end
  if (noEpA.length) {
    console.warn(`[merge] WARN: ${noEpA.length} archive entry/entries with no episode_num — appended as-is`);
    blocks.push(...noEpA);
  }

  const stream = getStreamBlock(tvmazeText) || getStreamBlock(archiveText);
  const output = `${stream}\n\nvideos:\n${blocks.join('\n\n')}\n`;

  if (args.dryRun) {
    process.stdout.write(output);
  } else {
    const outPath = path.resolve(process.cwd(), args.output);
    fs.writeFileSync(outPath, output, 'utf8');
    console.log(`Merged ${matched} entries (${archiveOnly} archive-only, ${tvmazeOnly} tvmaze-only) -> ${outPath}`);
  }
}

main();

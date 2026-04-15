#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { stripHtml } = require('../../shared/utils.js');

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), 'config.yaml');
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi', '.ts']);
const ARCHIVE_DOWNLOAD_BASE = 'https://archive.org/download';
const ARCHIVE_METADATA_BASE = 'https://archive.org/metadata';
const ARCHIVE_DETAILS_BASE = 'https://archive.org/details';
const execFileAsync = promisify(execFile);

function printUsage() {
  console.log([
    'Usage:',
    '  node tools/archive-org-import/archive_to_config.js --item <archive.org url-or-identifier> [options]',
    '',
    'Options:',
    '  --config <path>       Path to config yaml (default: ./config.yaml)',
    '  --category <name>     Category value for all appended videos (default: Series)',
    '  --dry-run             Show what would be appended without writing file',
    '  --no-probe            Use archive metadata duration instead of ffprobe',
    '  --help                Show this help',
    '',
    'Examples:',
    '  node tools/archive-org-import/archive_to_config.js --item https://archive.org/details/my-show',
    '  node tools/archive-org-import/archive_to_config.js --item my-show --category Documentary',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {
    item: '',
    configPath: DEFAULT_CONFIG_PATH,
    category: 'Series',
    dryRun: false,
    noProbe: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }

    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (token === '--no-probe') {
      args.noProbe = true;
      continue;
    }

    if (token === '--item') {
      args.item = argv[++i] || '';
      continue;
    }

    if (token === '--config') {
      args.configPath = path.resolve(process.cwd(), argv[++i] || '');
      continue;
    }

    if (token === '--category') {
      args.category = argv[++i] || 'Series';
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function extractIdentifier(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Missing --item. Provide an Archive.org URL or identifier.');

  if (!raw.includes('://')) return raw;

  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL passed to --item.');
  }

  const parts = u.pathname.split('/').filter(Boolean);
  const detailsIdx = parts.indexOf('details');
  const downloadIdx = parts.indexOf('download');

  if (detailsIdx >= 0 && parts[detailsIdx + 1]) return parts[detailsIdx + 1];
  if (downloadIdx >= 0 && parts[downloadIdx + 1]) return parts[downloadIdx + 1];

  if (parts[0]) return parts[0];

  throw new Error('Could not determine archive identifier from URL.');
}

function parseDurationSeconds(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.round(n);

  const s = String(v || '').trim();
  const m = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (!m) return 0;

  if (m[3] != null) {
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  return Number(m[1]) * 60 + Number(m[2]);
}

function normalizeWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}


async function fetchDetailsH1(identifier) {
  const url = `${ARCHIVE_DETAILS_BASE}/${encodeURIComponent(identifier)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'reeltime-archive-importer/1.0' },
  });

  if (!res.ok) {
    throw new Error(`Archive details request failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const m = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';

  return stripHtml(m[1]);
}

function isVideoFile(file) {
  const name = String(file?.name || '');
  const ext = path.extname(name).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) return false;

  const format = String(file?.format || '').toLowerCase();
  if (format.includes('thumbnail') || format.includes('gif')) return false;

  return true;
}

function buildArchiveDownloadUrl(identifier, fileName) {
  const encoded = String(fileName)
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/');
  return `${ARCHIVE_DOWNLOAD_BASE}/${encodeURIComponent(identifier)}/${encoded}`;
}

function findArchiveIconUrl(identifier, files) {
  const list = Array.isArray(files) ? files : [];
  const byName = name => list.find(f => String(f?.name || '').toLowerCase() === name.toLowerCase());

  const iaThumb = byName('__ia_thumb.jpg');
  if (iaThumb) return buildArchiveDownloadUrl(identifier, iaThumb.name);

  const itemTile = list.find(f => /item tile/i.test(String(f?.format || '')) && /\.(jpg|jpeg|png|webp)$/i.test(String(f?.name || '')));
  if (itemTile) return buildArchiveDownloadUrl(identifier, itemTile.name);

  const thumb = list.find(f => /thumbnail/i.test(String(f?.format || '')) && /\.(jpg|jpeg|png|webp)$/i.test(String(f?.name || '')));
  if (thumb) return buildArchiveDownloadUrl(identifier, thumb.name);

  const image = list.find(f => /\.(jpg|jpeg|png|webp)$/i.test(String(f?.name || '')));
  if (image) return buildArchiveDownloadUrl(identifier, image.name);

  return '';
}

function normalizeDescription(metaDescription) {
  const clean = value => stripHtml(String(value || ''));
  if (Array.isArray(metaDescription)) {
    return clean(metaDescription[0]);
  }
  return clean(metaDescription);
}

function toTokenList(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

function dropCommonPrefix(title, prefix) {
  let out = normalizeWhitespace(title);
  const pref = normalizeWhitespace(prefix);
  if (!pref) return out;

  if (out.toLowerCase().startsWith(pref.toLowerCase())) {
    out = out.slice(pref.length);
  }

  return out.replace(/^[\s:|\-–-]+/, '').trim();
}

function stripEpisodeMarkers(title) {
  const tokens = normalizeWhitespace(title).split(' ');
  let i = 0;

  const isMarker = t => {
    const x = t.toLowerCase().replace(/[^a-z0-9x]/g, '');
    if (!x) return false;
    if (/^s\d{1,3}$/.test(x)) return true;
    if (/^e\d{1,3}$/.test(x)) return true;
    if (/^\d{1,3}x\d{1,3}$/.test(x)) return true;
    if (/^(season|series|episode|ep|part|pt)$/.test(x)) return true;
    if (/^\d{1,3}$/.test(x)) return true;
    return false;
  };

  while (i < tokens.length && isMarker(tokens[i])) i++;
  const out = tokens.slice(i).join(' ').trim();
  return out || normalizeWhitespace(title);
}

function inferEpisodeTitle(rawTitle, streamName, identifier) {
  let out = normalizeWhitespace(rawTitle);
  if (!out) return out;

  // Prefer removing known leading context (stream name / identifier words), then markers.
  out = dropCommonPrefix(out, streamName);

  const idWords = toTokenList(identifier).join(' ');
  if (idWords) out = dropCommonPrefix(out, idWords);

  out = stripEpisodeMarkers(out).replace(/^[\s:|\-–-]+/, '').trim();

  return out || normalizeWhitespace(rawTitle);
}

function inferEpisodeNum(...values) {
  for (const value of values) {
    const text = String(value || '');
    let match = text.match(/S(\d{1,3})E(\d{1,3})(?:E(\d{1,3}))?/i);
    if (match) {
      const season = match[1].padStart(2, '0');
      const firstEpisode = match[2].padStart(2, '0');
      const secondEpisode = match[3] ? match[3].padStart(2, '0') : '';
      return secondEpisode ? `S${season}E${firstEpisode}-E${secondEpisode}` : `S${season}E${firstEpisode}`;
    }

    match = text.match(/(\d{1,3})x(\d{1,3})/i);
    if (match) {
      return `S${match[1].padStart(2, '0')}E${match[2].padStart(2, '0')}`;
    }
  }

  return '';
}

function getExtensionRank(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (ext === '.mp4') return 0;
  if (ext === '.m4v') return 1;
  if (ext === '.webm') return 2;
  if (ext === '.mkv') return 3;
  return 9;
}

function choosePreferredFiles(videoFiles) {
  const byBase = new Map();

  for (const file of videoFiles) {
    const name = String(file?.name || '');
    const ext = path.extname(name);
    const base = path.basename(name, ext).toLowerCase();
    const current = byBase.get(base);

    if (!current || getExtensionRank(name) < getExtensionRank(current.name)) {
      byBase.set(base, file);
    }
  }

  return [...byBase.values()];
}

function pickTitle(file, itemTitle) {
  const fileTitle = String(file?.title || '').trim();
  if (fileTitle) return fileTitle;

  const base = path.basename(String(file?.name || ''), path.extname(String(file?.name || '')));
  if (base) return base;

  return itemTitle || 'Untitled';
}

function getStreamNameFromConfig(configText) {
  const m = String(configText).match(/^\s*name:\s*(?:"([^"]+)"|'([^']+)'|([^\n#]+))\s*$/m);
  return normalizeWhitespace(m?.[1] || m?.[2] || m?.[3] || '');
}

async function probeDurationSeconds(url) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    String(url),
  ], {
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });

  const n = Number(String(stdout || '').trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`ffprobe returned invalid duration for URL: ${url}`);
  }
  return Math.round(n);
}

async function toVideoEntry({ identifier, file, itemMeta, category, streamName, detailsH1, noProbe, iconUrl }) {
  const itemTitle = String(itemMeta?.title || '').trim();
  const itemDescription = normalizeDescription(itemMeta?.description);
  const fileDescription = normalizeDescription(file?.description);
  const fileTitle = String(file?.title || '').trim();
  const h1Title = normalizeWhitespace(detailsH1);

  const rawTitle = h1Title || fileTitle || itemTitle || pickTitle(file, itemTitle);
  const title = inferEpisodeTitle(rawTitle, streamName, identifier) || pickTitle(file, itemTitle);
  const episodeNum = inferEpisodeNum(identifier, file?.name, fileTitle, h1Title, itemTitle);
  const url = buildArchiveDownloadUrl(identifier, String(file?.name || ''));
  const fallbackDuration = parseDurationSeconds(file?.length) || 3600;
  const duration = noProbe ? fallbackDuration : await probeDurationSeconds(url);

  const description = fileDescription || itemDescription || title;
  return {
    title,
    series_title: String(streamName || ''),
    sub_title: String(title || ''),
    episode_num: episodeNum,
    url,
    duration,
    description,
    category: String(category || 'Series'),
    icon: String(iconUrl || ''),
  };
}

function yamlQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderVideoEntry(v) {
  return [
    `  - title:       ${yamlQuote(v.title)}`,
    ...(v.series_title ? [`    series_title: ${yamlQuote(v.series_title)}`] : []),
    ...(v.sub_title ? [`    sub_title:    ${yamlQuote(v.sub_title)}`] : []),
    ...(v.episode_num ? [`    episode_num:  ${yamlQuote(v.episode_num)}`] : []),
    ...(v.date ? [`    date:         ${yamlQuote(v.date)}`] : []),
    `    url:         ${yamlQuote(v.url)}`,
    `    icon:        ${yamlQuote(v.icon || '')}`,
    `    duration:    ${Math.max(1, Math.round(Number(v.duration) || 3600))}`,
    `    description: ${yamlQuote(v.description)}`,
    `    category:    ${yamlQuote(v.category)}`,
  ].join('\n');
}

function renderVideoEntries(entries) {
  return entries.map(renderVideoEntry).join('\n\n');
}

async function fetchMetadata(identifier) {
  const url = `${ARCHIVE_METADATA_BASE}/${encodeURIComponent(identifier)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'reeltime-archive-importer/1.0' },
  });

  if (!res.ok) {
    throw new Error(`Archive metadata request failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  return fs.readFileSync(configPath, 'utf8');
}

function getExistingUrls(configText) {
  const existingUrls = new Set();
  const re = /^\s*url:\s*(?:"([^"]+)"|'([^']+)'|([^\n#]+))\s*$/gm;
  let m;

  while ((m = re.exec(configText)) !== null) {
    const url = (m[1] || m[2] || m[3] || '').trim();
    if (url) existingUrls.add(url);
  }

  return existingUrls;
}

function appendUniqueVideos(configText, candidates) {
  const existingUrls = getExistingUrls(configText);
  const toAppend = [];

  for (const v of candidates) {
    if (!v.url || existingUrls.has(v.url)) continue;
    existingUrls.add(v.url);
    toAppend.push(v);
  }

  return toAppend;
}

function appendVideosToConfig(configText, entries) {
  const chunk = renderVideoEntries(entries);
  const normalized = configText.replace(/\s+$/, '');

  if (!/^[ \t]*videos:[ \t]*$/m.test(normalized)) {
    return `${normalized}\n\nvideos:\n${chunk}\n`;
  }

  return `${normalized}\n\n${chunk}\n`;
}

function ensureStreamIcon(configText, iconUrl) {
  const icon = String(iconUrl || '').trim();
  if (!icon) return configText;

  const lines = String(configText).split(/\r?\n/);
  const streamStart = lines.findIndex(line => /^\s*stream:\s*$/.test(line));
  if (streamStart === -1) return configText;

  let streamEnd = lines.length;
  for (let i = streamStart + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) {
      streamEnd = i;
      break;
    }
  }

  for (let i = streamStart + 1; i < streamEnd; i++) {
    if (/^\s+icon\s*:/.test(lines[i])) return configText;
  }

  let insertAt = streamStart + 1;
  for (let i = streamStart + 1; i < streamEnd; i++) {
    if (/^\s+name\s*:/.test(lines[i])) {
      insertAt = i + 1;
      break;
    }
  }

  lines.splice(insertAt, 0, `  icon: ${yamlQuote(icon)}`);
  return `${lines.join('\n').replace(/\s+$/, '')}\n`;
}

function writeConfig(configPath, configText) {
  fs.writeFileSync(configPath, configText, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const identifier = extractIdentifier(args.item);
  const configText = readConfig(args.configPath);
  const streamName = getStreamNameFromConfig(configText);
  const metadata = await fetchMetadata(identifier);
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  const iconUrl = findArchiveIconUrl(identifier, files);
  let detailsH1 = '';

  try {
    detailsH1 = await fetchDetailsH1(identifier);
  } catch (err) {
    console.warn(`[archive_to_config] WARN: could not read details page <h1>: ${err.message}`);
  }

  const videoFiles = choosePreferredFiles(files.filter(isVideoFile));

  if (!videoFiles.length) {
    throw new Error(`No video files found in archive item: ${identifier}`);
  }

  const candidates = [];
  for (const file of videoFiles) {
    const entry = await toVideoEntry({
      identifier,
      file,
      itemMeta: metadata.metadata || {},
      category: args.category,
      streamName,
      detailsH1,
      noProbe: args.noProbe,
      iconUrl,
    });
    candidates.push(entry);
  }
  const added = appendUniqueVideos(configText, candidates);

  if (!added.length) {
    console.log(`No new videos added. All ${candidates.length} discovered URLs already exist in config.`);
    return;
  }

  if (args.dryRun) {
    console.log(`Would add ${added.length} video entries to ${args.configPath}:`);
    console.log(`videos:\n${renderVideoEntries(added)}`);
    if (iconUrl) console.log(`stream.icon suggestion: ${iconUrl}`);
    return;
  }

  const updated = ensureStreamIcon(appendVideosToConfig(configText, added), iconUrl);
  writeConfig(args.configPath, updated);
  console.log(`Added ${added.length} videos from '${identifier}' to ${args.configPath}.`);
}

main().catch(err => {
  console.error(`[archive_to_config] ${err.message}`);
  process.exit(1);
});

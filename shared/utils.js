'use strict';

const fs   = require('node:fs');
const path = require('node:path');

/**
 * Shared utility functions used by reel, scout, boom, and director.
 */

/**
 * Convert a string to snake_case.
 * Lowercases, collapses non-alphanumeric runs to single underscores,
 * and trims leading/trailing underscores.
 * Falls back to `fallback` when the result is empty.
 *
 * @param {string} str
 * @param {string} [fallback='reeltime']
 * @returns {string}
 */
function toSnakeCase(str, fallback = 'reeltime') {
  if (typeof str !== 'string' || str.trim() === '') return fallback;
  // Collapse any run of non-alphanumeric characters to a single underscore
  const slug  = str.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  // After the replace above, leading/trailing underscores are at most one char -
  // trim them with string slicing to avoid regex backtracking concerns.
  const start = slug[0] === '_' ? 1 : 0;
  const end   = slug[slug.length - 1] === '_' ? slug.length - 1 : slug.length;
  const result = slug.slice(start, end);
  return result.length > 0 ? result : fallback;
}

/**
 * HTML-escape a string.
 * Uses `&#39;` for single quotes (safe in HTML attribute values).
 *
 * @param {string} s
 * @returns {string}
 */
function escHtml(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * XML-escape a string.
 * Uses `&apos;` for single quotes (valid XML entity).
 *
 * @param {string} s
 * @returns {string}
 */
function escXML(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

/**
 * Strip HTML tags and decode common entities from a string.
 * Tags are replaced with a space to preserve word boundaries.
 * Handles named entities (amp, lt, gt, quot, apos, nbsp) and
 * numeric entities (decimal &#123; and hex &#x7b;).
 * Returns an empty string for null/undefined/empty input.
 *
 * @param {string} s
 * @returns {string}
 */
function stripHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g,            (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g,         ' ')
    .replace(/&lt;/g,           '<')
    .replace(/&gt;/g,           '>')
    .replace(/&quot;/g,         '"')
    .replace(/&#039;|&apos;/g,  "'")
    .replace(/&amp;/g,          '&')  // always last - avoids double-decoding
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fisher-Yates shuffle - returns a new shuffled array, does not mutate the input.
 *
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Scan a directory for MP3 files and write an ffconcat playlist file.
 * Returns true when at least one file was found and the playlist was written,
 * false when the directory is empty or unreadable (caller handles fallback).
 *
 * @param {object} opts
 * @param {string}   opts.musicDir  - directory to scan for .mp3 files
 * @param {boolean}  opts.shuffle   - whether to randomize playback order
 * @param {string}   opts.listPath  - path to write the ffconcat playlist
 * @param {Function} opts.info      - info-level logger
 * @param {Function} opts.warn      - warn-level logger
 * @returns {boolean}
 */
function buildAudioList({ musicDir, shuffle, listPath, info, warn }) {
  let files = [];
  try {
    files = fs.readdirSync(musicDir).filter(f => f.toLowerCase().endsWith('.mp3'));
  } catch {
    warn(`Cannot read music directory: ${musicDir}`);
  }
  if (files.length === 0) return false;
  if (shuffle) files = shuffleArray(files);
  const lines = files.map(f => `file "${path.join(musicDir, f).replace(/"/g, '\\"')}"`).join('\n');
  fs.writeFileSync(listPath, lines + '\n');
  info(`Loaded ${files.length} music file(s)${shuffle ? ' (shuffled)' : ''}`);
  return true;
}

module.exports = { toSnakeCase, escHtml, escXML, stripHtml, shuffleArray, buildAudioList };

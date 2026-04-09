'use strict';

/**
 * Shared utility functions used by both reeltime (streamer.js) and
 * reeltime-director (director/src/director.js).
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

module.exports = { toSnakeCase, escHtml, escXML };

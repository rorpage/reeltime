'use strict';

/**
 * tv-show-query.test.js — unit tests for tv-show-query.js pure functions
 * Run with: node --test tools/tv-show-query.test.js  (from repo root)
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  stripHtml,
  toXmltvDate,
  toSeconds,
  pad,
  fmtEp,
  slugify,
  yamlVal,
  buildBlock,
  pickImage,
  buildStreamSection,
  buildEpisodeEntry,
  buildVideosSection,
  generateYaml,
  parseArgs,
} = require('./tv-show-query.js');

// ─────────────────────────────────────────────────────────────────────────────
// 1. stripHtml
// ─────────────────────────────────────────────────────────────────────────────

test('stripHtml — removes simple HTML tags', () => {
  assert.equal(stripHtml('<p>Hello world</p>'), 'Hello world');
});

test('stripHtml — removes nested tags', () => {
  assert.equal(stripHtml('<p>Some <b>bold</b> text</p>'), 'Some bold text');
});

test('stripHtml — decodes &amp; entity', () => {
  assert.equal(stripHtml('Fish &amp; Chips'), 'Fish & Chips');
});

test('stripHtml — decodes &lt; and &gt; entities', () => {
  assert.equal(stripHtml('a &lt; b &gt; c'), 'a < b > c');
});

test('stripHtml — decodes &quot; entity', () => {
  assert.equal(stripHtml('Say &quot;hello&quot;'), 'Say "hello"');
});

test('stripHtml — decodes &#039; entity', () => {
  assert.equal(stripHtml("It&#039;s fine"), "It's fine");
});

test('stripHtml — decodes &apos; entity', () => {
  assert.equal(stripHtml("It&apos;s fine"), "It's fine");
});

test('stripHtml — collapses whitespace', () => {
  assert.equal(stripHtml('  hello   world  '), 'hello world');
});

test('stripHtml — returns null for empty string', () => {
  assert.equal(stripHtml(''), null);
});

test('stripHtml — returns null for null', () => {
  assert.equal(stripHtml(null), null);
});

test('stripHtml — returns null for tags-only input', () => {
  assert.equal(stripHtml('<p></p>'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. toXmltvDate
// ─────────────────────────────────────────────────────────────────────────────

test('toXmltvDate — converts ISO date to XMLTV format', () => {
  assert.equal(toXmltvDate('2024-03-15'), '20240315');
});

test('toXmltvDate — returns null for null input', () => {
  assert.equal(toXmltvDate(null), null);
});

test('toXmltvDate — returns null for undefined input', () => {
  assert.equal(toXmltvDate(undefined), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. toSeconds
// ─────────────────────────────────────────────────────────────────────────────

test('toSeconds — converts minutes to seconds', () => {
  assert.equal(toSeconds(60), 3600);
  assert.equal(toSeconds(30), 1800);
  assert.equal(toSeconds(1),  60);
});

test('toSeconds — returns null for null', () => {
  assert.equal(toSeconds(null), null);
});

test('toSeconds — returns null for 0', () => {
  assert.equal(toSeconds(0), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. pad
// ─────────────────────────────────────────────────────────────────────────────

test('pad — pads single digit', () => {
  assert.equal(pad(1),  '01');
  assert.equal(pad(9),  '09');
});

test('pad — does not pad two-digit number', () => {
  assert.equal(pad(10), '10');
  assert.equal(pad(99), '99');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. fmtEp
// ─────────────────────────────────────────────────────────────────────────────

test('fmtEp — formats season and episode', () => {
  assert.equal(fmtEp(1, 1),   'S01E01');
  assert.equal(fmtEp(2, 13),  'S02E13');
  assert.equal(fmtEp(10, 5),  'S10E05');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. slugify
// ─────────────────────────────────────────────────────────────────────────────

test('slugify — lowercases and replaces spaces with hyphens', () => {
  assert.equal(slugify('Breaking Bad'), 'breaking-bad');
});

test('slugify — removes leading and trailing hyphens', () => {
  assert.equal(slugify('  The Office  '), 'the-office');
});

test('slugify — replaces multiple non-alphanumeric chars with single hyphen', () => {
  assert.equal(slugify("It's Always Sunny"), 'it-s-always-sunny');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. yamlVal
// ─────────────────────────────────────────────────────────────────────────────

test('yamlVal — encodes boolean values', () => {
  assert.equal(yamlVal(true),  'true');
  assert.equal(yamlVal(false), 'false');
});

test('yamlVal — encodes numbers', () => {
  assert.equal(yamlVal(42),  '42');
  assert.equal(yamlVal(-1),  '-1');
  assert.equal(yamlVal(3600), '3600');
});

test('yamlVal — encodes null as empty string', () => {
  assert.equal(yamlVal(null),      '""');
  assert.equal(yamlVal(undefined), '""');
});

test('yamlVal — wraps strings in double quotes', () => {
  assert.equal(yamlVal('hello'), '"hello"');
});

test('yamlVal — escapes backslashes and double quotes in strings', () => {
  assert.equal(yamlVal('say "hi"'), '"say \\"hi\\""');
  assert.equal(yamlVal('C:\\path'), '"C:\\\\path"');
});

test('yamlVal — collapses newlines to spaces in strings', () => {
  assert.equal(yamlVal('line1\nline2'), '"line1 line2"');
  assert.equal(yamlVal('line1\r\nline2'), '"line1 line2"');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. buildBlock
// ─────────────────────────────────────────────────────────────────────────────

test('buildBlock — omits null values', () => {
  const out = buildBlock([['title', 'Foo'], ['icon', null]]);
  assert.ok(out.includes('title'));
  assert.ok(!out.includes('icon'));
});

test('buildBlock — aligns values to same column', () => {
  const out = buildBlock([['title', 'T'], ['description', 'D']]);
  const lines = out.split('\n');
  // "description:" is 12 chars + colon = 13; value column at 14
  const valCol = lines[1].indexOf('"D"');
  assert.ok(valCol > 0);
  assert.equal(lines[0].indexOf('"T"'), valCol);
});

test('buildBlock — prefixes first entry with "- " when listItem=true', () => {
  const out = buildBlock([['title', 'T'], ['url', 'U']], { listItem: true });
  const lines = out.split('\n');
  assert.ok(lines[0].includes('- '));
  assert.ok(!lines[1].includes('- '));
});

test('buildBlock — adds inline comment', () => {
  const out = buildBlock([['url', '']], { comments: { url: 'TODO' } });
  assert.ok(out.includes('# TODO'));
});

test('buildBlock — returns empty string when all values are null', () => {
  assert.equal(buildBlock([['a', null], ['b', undefined]]), '');
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. pickImage
// ─────────────────────────────────────────────────────────────────────────────

test('pickImage — returns original when present', () => {
  assert.equal(pickImage({ original: 'http://orig', medium: 'http://med' }), 'http://orig');
});

test('pickImage — falls back to medium when original absent', () => {
  assert.equal(pickImage({ medium: 'http://med' }), 'http://med');
});

test('pickImage — returns null for null image', () => {
  assert.equal(pickImage(null), null);
});

test('pickImage — returns null when both original and medium are absent', () => {
  assert.equal(pickImage({}), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. buildStreamSection
// ─────────────────────────────────────────────────────────────────────────────

test('buildStreamSection — starts with "stream:"', () => {
  const show = { name: 'My Show', image: null };
  assert.ok(buildStreamSection(show).startsWith('stream:'));
});

test('buildStreamSection — includes show name', () => {
  const show = { name: 'My Show', image: null };
  assert.ok(buildStreamSection(show).includes('"My Show"'));
});

test('buildStreamSection — omits icon when show has no image', () => {
  const show = { name: 'My Show', image: null };
  const out = buildStreamSection(show);
  assert.ok(!out.includes('icon:'));
});

test('buildStreamSection — includes icon when show has image', () => {
  const show = { name: 'My Show', image: { original: 'http://img' } };
  const out = buildStreamSection(show);
  assert.ok(out.includes('"http://img"'));
});

test('buildStreamSection — includes loop: true and loop_count: -1', () => {
  const show = { name: 'S', image: null };
  const out = buildStreamSection(show);
  assert.ok(out.includes('true'));
  assert.ok(out.includes('-1'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. buildEpisodeEntry
// ─────────────────────────────────────────────────────────────────────────────

const SHOW = { name: 'Test Show', image: { original: 'http://show.img' } };
const EP = {
  name:    'Pilot',
  season:  1,
  number:  1,
  airdate: '2020-01-15',
  runtime: 30,
  summary: '<p>A great pilot.</p>',
  image:   { original: 'http://ep.img' },
};

test('buildEpisodeEntry — includes episode title', () => {
  const out = buildEpisodeEntry(SHOW, EP);
  assert.ok(out.includes('"Pilot"'));
});

test('buildEpisodeEntry — includes formatted episode number', () => {
  const out = buildEpisodeEntry(SHOW, EP);
  assert.ok(out.includes('"S01E01"'));
});

test('buildEpisodeEntry — converts airdate to XMLTV format', () => {
  const out = buildEpisodeEntry(SHOW, EP);
  assert.ok(out.includes('"20200115"'));
});

test('buildEpisodeEntry — converts runtime to seconds', () => {
  const out = buildEpisodeEntry(SHOW, EP);
  assert.ok(out.includes('1800'));
});

test('buildEpisodeEntry — strips HTML from summary', () => {
  const out = buildEpisodeEntry(SHOW, EP);
  assert.ok(out.includes('"A great pilot."'));
  assert.ok(!out.includes('<p>'));
});

test('buildEpisodeEntry — uses "TBA" when episode name is missing', () => {
  const ep = { ...EP, name: null };
  const out = buildEpisodeEntry(SHOW, ep);
  assert.ok(out.includes('"TBA"'));
});

test('buildEpisodeEntry — falls back to show image when episode has no image', () => {
  const ep = { ...EP, image: null };
  const out = buildEpisodeEntry(SHOW, ep);
  assert.ok(out.includes('"http://show.img"'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. buildVideosSection
// ─────────────────────────────────────────────────────────────────────────────

test('buildVideosSection — starts with "videos:"', () => {
  const out = buildVideosSection(SHOW, [EP]);
  assert.ok(out.startsWith('videos:'));
});

test('buildVideosSection — includes all episodes', () => {
  const ep2 = { ...EP, name: 'Episode 2', number: 2 };
  const out = buildVideosSection(SHOW, [EP, ep2]);
  assert.ok(out.includes('"Pilot"'));
  assert.ok(out.includes('"Episode 2"'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. generateYaml
// ─────────────────────────────────────────────────────────────────────────────

const SHOW_WITH_ID = { ...SHOW, id: 999 };

test('generateYaml — contains header comment with show name', () => {
  const out = generateYaml(SHOW_WITH_ID, [EP]);
  assert.ok(out.includes('# Show:      Test Show'));
});

test('generateYaml — contains episode count in header', () => {
  const out = generateYaml(SHOW_WITH_ID, [EP]);
  assert.ok(out.includes('# Episodes:  1'));
});

test('generateYaml — contains season count in header', () => {
  const ep2 = { ...EP, season: 2, number: 1 };
  const out = generateYaml(SHOW_WITH_ID, [EP, ep2]);
  assert.ok(out.includes('# Seasons:   2'));
});

test('generateYaml — contains stream: section', () => {
  const out = generateYaml(SHOW_WITH_ID, [EP]);
  assert.ok(out.includes('stream:'));
});

test('generateYaml — contains videos: section', () => {
  const out = generateYaml(SHOW_WITH_ID, [EP]);
  assert.ok(out.includes('videos:'));
});

test('generateYaml — contains TVmaze source URL in header', () => {
  const out = generateYaml(SHOW_WITH_ID, [EP]);
  assert.ok(out.includes('https://www.tvmaze.com/shows/999/test-show'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. parseArgs
// ─────────────────────────────────────────────────────────────────────────────

test('parseArgs — returns default null values when no args provided', () => {
  const r = parseArgs(['node', 'script.js']);
  assert.deepEqual(r, { query: null, id: null, season: null, output: null });
});

test('parseArgs — parses a show name query', () => {
  const r = parseArgs(['node', 'script.js', 'Breaking Bad']);
  assert.equal(r.query, 'Breaking Bad');
  assert.equal(r.id, null);
});

test('parseArgs — parses --id flag', () => {
  const r = parseArgs(['node', 'script.js', '--id', '169']);
  assert.equal(r.id, 169);
  assert.equal(r.query, null);
});

test('parseArgs — parses --season flag', () => {
  const r = parseArgs(['node', 'script.js', 'Breaking Bad', '--season', '2']);
  assert.equal(r.season, 2);
  assert.equal(r.query, 'Breaking Bad');
});

test('parseArgs — parses --output flag', () => {
  const r = parseArgs(['node', 'script.js', 'Breaking Bad', '--output', 'out.yaml']);
  assert.equal(r.output, 'out.yaml');
  assert.equal(r.query, 'Breaking Bad');
});

test('parseArgs — parses all flags together', () => {
  const r = parseArgs(['node', 'script.js', '--id', '169', '--season', '2', '--output', 'bb-s2.yaml']);
  assert.equal(r.id, 169);
  assert.equal(r.season, 2);
  assert.equal(r.output, 'bb-s2.yaml');
  assert.equal(r.query, null);
});

test('parseArgs — throws when --id and query both provided', () => {
  assert.throws(
    () => parseArgs(['node', 'script.js', '--id', '169', 'Breaking Bad']),
    /either a show name or --id/i,
  );
});

test('parseArgs — throws when --output has no value', () => {
  assert.throws(
    () => parseArgs(['node', 'script.js', 'Breaking Bad', '--output']),
    /--output requires/i,
  );
});

test('parseArgs — throws when --id has no value', () => {
  assert.throws(
    () => parseArgs(['node', 'script.js', '--id']),
    /--id requires/i,
  );
});

test('parseArgs — throws when --season has no value', () => {
  assert.throws(
    () => parseArgs(['node', 'script.js', 'Breaking Bad', '--season']),
    /--season requires/i,
  );
});

test('parseArgs — throws when --id is not a positive integer', () => {
  assert.throws(
    () => parseArgs(['node', 'script.js', '--id', 'abc']),
    /positive integer/i,
  );
  assert.throws(
    () => parseArgs(['node', 'script.js', '--id', '-5']),
    /positive integer/i,
  );
});

test('parseArgs — throws when --season is not a positive integer', () => {
  assert.throws(
    () => parseArgs(['node', 'script.js', 'Breaking Bad', '--season', 'abc']),
    /positive integer/i,
  );
});

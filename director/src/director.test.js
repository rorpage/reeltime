'use strict';

/**
 * director.test.js — unit tests for director.js pure functions
 * Run with: node --test src/director.test.js  (from director/ directory)
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const {
  toSnakeCase,
  escHtml,
  escXML,
  deriveChannelId,
  loadConfig,
  buildAggregatedM3U,
  buildGuideHTML,
  buildPlayerHTML,
  buildAggregatedNow,
  buildHealthResponse,
} = require('./director.js');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a YAML string to a temp file and return the file path.
 * Uses os.tmpdir() for cross-platform safety.
 */
function writeTempYaml(content) {
  const filePath = path.join(os.tmpdir(), `director-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. toSnakeCase
// ─────────────────────────────────────────────────────────────────────────────

test('toSnakeCase — converts to snake_case', () => {
  assert.equal(toSnakeCase('Channel One'), 'channel_one');
  assert.equal(toSnakeCase('My Channel 3'), 'my_channel_3');
  assert.equal(toSnakeCase('hello-world'), 'hello_world');
  assert.equal(toSnakeCase('ABC DEF'), 'abc_def');
});

test('toSnakeCase — trims leading/trailing underscores', () => {
  assert.equal(toSnakeCase('  Channel 1  '), 'channel_1');
  assert.equal(toSnakeCase('--hello--'), 'hello');
});

test('toSnakeCase — handles empty string → "director"', () => {
  assert.equal(toSnakeCase(''), 'director');
  assert.equal(toSnakeCase('   '), 'director');
});

test('toSnakeCase — single word unchanged', () => {
  assert.equal(toSnakeCase('news'), 'news');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. escHtml
// ─────────────────────────────────────────────────────────────────────────────

test('escHtml — escapes & < > " \'', () => {
  assert.equal(escHtml('&'),  '&amp;');
  assert.equal(escHtml('<'),  '&lt;');
  assert.equal(escHtml('>'),  '&gt;');
  assert.equal(escHtml('"'),  '&quot;');
  assert.equal(escHtml("'"),  '&#39;');
});

test('escHtml — escapes combined string', () => {
  assert.equal(
    escHtml('<script>alert("xss&\'stuff\'");</script>'),
    '&lt;script&gt;alert(&quot;xss&amp;&#39;stuff&#39;&quot;);&lt;/script&gt;',
  );
});

test('escHtml — leaves safe text unchanged', () => {
  assert.equal(escHtml('Hello World 123'), 'Hello World 123');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. escXML
// ─────────────────────────────────────────────────────────────────────────────

test('escXML — escapes & < > " \'', () => {
  assert.equal(escXML('&'),  '&amp;');
  assert.equal(escXML('<'),  '&lt;');
  assert.equal(escXML('>'),  '&gt;');
  assert.equal(escXML('"'),  '&quot;');
  assert.equal(escXML("'"),  '&apos;');
});

test('escXML — escapes combined XML string', () => {
  const result = escXML('<tag attr="val\'ue">text & more</tag>');
  assert.ok(result.includes('&lt;'));
  assert.ok(result.includes('&amp;'));
  assert.ok(result.includes('&apos;'));
  assert.ok(result.includes('&quot;'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. deriveChannelId
// ─────────────────────────────────────────────────────────────────────────────

test('deriveChannelId — uses id when present', () => {
  assert.equal(deriveChannelId({ id: 'my_custom_id', name: 'Channel 1', url: 'http://x' }), 'my_custom_id');
});

test('deriveChannelId — derives from name when no id', () => {
  assert.equal(deriveChannelId({ name: 'Channel One', url: 'http://x' }), 'channel_one');
  assert.equal(deriveChannelId({ name: 'BBC News 24', url: 'http://x' }), 'bbc_news_24');
});

test('deriveChannelId — ignores empty id, falls back to name', () => {
  assert.equal(deriveChannelId({ id: '', name: 'Channel X', url: 'http://x' }), 'channel_x');
  assert.equal(deriveChannelId({ id: '   ', name: 'Channel X', url: 'http://x' }), 'channel_x');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. loadConfig
// ─────────────────────────────────────────────────────────────────────────────

test('loadConfig — throws when channels key is missing', () => {
  const f = writeTempYaml('director:\n  name: "Test"\n');
  assert.throws(
    () => loadConfig(f),
    /channels/i,
  );
  fs.unlinkSync(f);
});

test('loadConfig — throws when channels array is empty', () => {
  const f = writeTempYaml('director:\n  name: "Test"\nchannels: []\n');
  assert.throws(
    () => loadConfig(f),
    /channels/i,
  );
  fs.unlinkSync(f);
});

test('loadConfig — throws when channel lacks url', () => {
  const f = writeTempYaml(
    'channels:\n  - name: "Chan1"\n',
  );
  assert.throws(
    () => loadConfig(f),
    /url/i,
  );
  fs.unlinkSync(f);
});

test('loadConfig — throws when channel lacks name', () => {
  const f = writeTempYaml(
    'channels:\n  - url: "http://x"\n',
  );
  assert.throws(
    () => loadConfig(f),
    /name/i,
  );
  fs.unlinkSync(f);
});

test('loadConfig — returns correct shape for valid config', () => {
  const f = writeTempYaml(`
director:
  name: "My Director"
channels:
  - name: "Channel 1"
    url: "http://reeltime-1:8080"
  - name: "Channel 2"
    id: "ch2"
    url: "http://reeltime-2:8080"
`);
  const cfg = loadConfig(f);
  fs.unlinkSync(f);

  assert.equal(cfg.directorName, 'My Director');
  assert.equal(cfg.channels.length, 2);
  assert.equal(cfg.channels[0].id,   'channel_1');
  assert.equal(cfg.channels[0].name, 'Channel 1');
  assert.equal(cfg.channels[0].url,  'http://reeltime-1:8080');
  assert.equal(cfg.channels[1].id,   'ch2');
  assert.equal(cfg.channels[1].url,  'http://reeltime-2:8080');
});

test('loadConfig — defaults directorName when director.name absent', () => {
  const f = writeTempYaml(
    'channels:\n  - name: "C"\n    url: "http://x"\n',
  );
  const cfg = loadConfig(f);
  fs.unlinkSync(f);
  assert.equal(cfg.directorName, 'Reeltime Director');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. buildAggregatedM3U
// ─────────────────────────────────────────────────────────────────────────────

const sampleChannels = [
  { id: 'channel_1', name: 'Channel 1', url: 'http://reeltime-1:8080' },
  { id: 'channel_2', name: 'Channel 2', url: 'http://reeltime-2:8080' },
];

test('buildAggregatedM3U — starts with #EXTM3U', () => {
  const m3u = buildAggregatedM3U(sampleChannels, 'localhost:10000');
  assert.ok(m3u.startsWith('#EXTM3U'));
});

test('buildAggregatedM3U — contains tvg-url pointing to /xmltv', () => {
  const m3u = buildAggregatedM3U(sampleChannels, 'localhost:10000');
  assert.ok(m3u.includes('x-tvg-url="http://localhost:10000/xmltv"'));
});

test('buildAggregatedM3U — contains correct stream URLs', () => {
  const m3u = buildAggregatedM3U(sampleChannels, 'localhost:10000');
  assert.ok(m3u.includes('http://reeltime-1:8080/stream.m3u8'));
  assert.ok(m3u.includes('http://reeltime-2:8080/stream.m3u8'));
});

test('buildAggregatedM3U — contains channel names in EXTINF lines', () => {
  const m3u = buildAggregatedM3U(sampleChannels, 'localhost:10000');
  assert.ok(m3u.includes('Channel 1'));
  assert.ok(m3u.includes('Channel 2'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. buildGuideHTML
// ─────────────────────────────────────────────────────────────────────────────

test('buildGuideHTML — contains channel names', () => {
  const cache = new Map();
  cache.set('channel_1', { online: true, now: { title: 'Movie A', progress: 0.5, remaining: 1800, next: 'Movie B' } });
  cache.set('channel_2', { online: false });

  const html = buildGuideHTML('My Director', sampleChannels, cache);
  assert.ok(html.includes('Channel 1'));
  assert.ok(html.includes('Channel 2'));
});

test('buildGuideHTML — contains WATCH links', () => {
  const cache = new Map();
  cache.set('channel_1', { online: true, now: { title: 'Movie A', progress: 0.4, remaining: 900, next: 'Movie B' } });
  cache.set('channel_2', { online: true, now: { title: 'Show X', progress: 0.2, remaining: 600, next: 'Show Y' } });

  const html = buildGuideHTML('My Director', sampleChannels, cache);
  assert.ok(html.includes('/watch/channel_1'));
  assert.ok(html.includes('/watch/channel_2'));
  assert.ok(html.includes('WATCH'));
});

test('buildGuideHTML — contains neon colors', () => {
  const cache = new Map();
  const html = buildGuideHTML('My Director', sampleChannels, cache);
  assert.ok(html.includes('#00d4ff') || html.includes('#39ff14') || html.includes('#ff2d78'));
});

test('buildGuideHTML — shows OFFLINE for offline channels', () => {
  const cache = new Map();
  cache.set('channel_1', { online: false });
  const html = buildGuideHTML('My Director', sampleChannels, cache);
  assert.ok(html.includes('OFFLINE'));
});

test('buildGuideHTML — contains director name in title', () => {
  const cache = new Map();
  const html = buildGuideHTML('Awesome Director', sampleChannels, cache);
  assert.ok(html.includes('Awesome Director'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. buildPlayerHTML
// ─────────────────────────────────────────────────────────────────────────────

test('buildPlayerHTML — contains channel name', () => {
  const ch   = { id: 'channel_1', name: 'Channel 1', url: 'http://reeltime-1:8080' };
  const html = buildPlayerHTML(ch, '#00d4ff');
  assert.ok(html.includes('Channel 1'));
});

test('buildPlayerHTML — contains stream.m3u8 URL', () => {
  const ch   = { id: 'channel_1', name: 'Channel 1', url: 'http://reeltime-1:8080' };
  const html = buildPlayerHTML(ch, '#00d4ff');
  assert.ok(html.includes('http://reeltime-1:8080/stream.m3u8'));
});

test('buildPlayerHTML — contains neon color', () => {
  const ch   = { id: 'channel_2', name: 'Channel 2', url: 'http://reeltime-2:8080' };
  const html = buildPlayerHTML(ch, '#39ff14');
  assert.ok(html.includes('#39ff14'));
});

test('buildPlayerHTML — contains back link to guide', () => {
  const ch   = { id: 'channel_1', name: 'Channel 1', url: 'http://reeltime-1:8080' };
  const html = buildPlayerHTML(ch, '#00d4ff');
  assert.ok(html.includes('href="/"'));
});

test('buildPlayerHTML — contains HLS.js script tag', () => {
  const ch   = { id: 'channel_1', name: 'Channel 1', url: 'http://reeltime-1:8080' };
  const html = buildPlayerHTML(ch, '#00d4ff');
  assert.ok(html.includes('hls.js'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. buildAggregatedNow
// ─────────────────────────────────────────────────────────────────────────────

test('buildAggregatedNow — returns correct shape', () => {
  const cache = new Map();
  cache.set('channel_1', { online: true,  now: { title: 'Movie A', progress: 0.5 } });
  cache.set('channel_2', { online: false, now: null });

  const result = buildAggregatedNow(sampleChannels, cache);
  assert.ok(Array.isArray(result.channels));
  assert.equal(result.channels.length, 2);
});

test('buildAggregatedNow — online channel has correct data', () => {
  const cache = new Map();
  cache.set('channel_1', { online: true, now: { title: 'Movie A', progress: 0.5 } });
  cache.set('channel_2', { online: false });

  const result = buildAggregatedNow(sampleChannels, cache);
  const ch1 = result.channels.find(c => c.id === 'channel_1');
  assert.ok(ch1);
  assert.equal(ch1.online, true);
  assert.equal(ch1.now.title, 'Movie A');
  assert.equal(ch1.name, 'Channel 1');
  assert.equal(ch1.url,  'http://reeltime-1:8080');
});

test('buildAggregatedNow — offline channel has online: false', () => {
  const cache = new Map();
  cache.set('channel_1', { online: false });

  const result = buildAggregatedNow(sampleChannels, cache);
  const ch1 = result.channels.find(c => c.id === 'channel_1');
  assert.equal(ch1.online, false);
  assert.equal(ch1.now, null);
});

test('buildAggregatedNow — uncached channel defaults to offline', () => {
  const cache  = new Map();
  const result = buildAggregatedNow(sampleChannels, cache);
  assert.equal(result.channels[0].online, false);
  assert.equal(result.channels[0].now,    null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. buildHealthResponse
// ─────────────────────────────────────────────────────────────────────────────

test('buildHealthResponse — returns status: ok', () => {
  const cache  = new Map();
  const result = buildHealthResponse(sampleChannels, cache);
  assert.equal(result.status, 'ok');
});

test('buildHealthResponse — includes uptime as a number', () => {
  const cache  = new Map();
  const result = buildHealthResponse(sampleChannels, cache);
  assert.equal(typeof result.uptime, 'number');
  assert.ok(result.uptime >= 0);
});

test('buildHealthResponse — includes channels array with correct shape', () => {
  const cache = new Map();
  cache.set('channel_1', { online: true });
  cache.set('channel_2', { online: false });

  const result = buildHealthResponse(sampleChannels, cache);
  assert.ok(Array.isArray(result.channels));
  assert.equal(result.channels.length, 2);

  const ch1 = result.channels.find(c => c.id === 'channel_1');
  assert.ok(ch1);
  assert.equal(ch1.online, true);
  assert.equal(ch1.name, 'Channel 1');
  assert.equal(ch1.url,  'http://reeltime-1:8080');

  const ch2 = result.channels.find(c => c.id === 'channel_2');
  assert.equal(ch2.online, false);
});

test('buildHealthResponse — uncached channel is offline', () => {
  const cache  = new Map();
  const result = buildHealthResponse(sampleChannels, cache);
  assert.equal(result.channels[0].online, false);
  assert.equal(result.channels[1].online, false);
});

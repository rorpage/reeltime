'use strict';

/**
 * director.test.js - unit tests for director.js pure functions
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
  readChannelConfig,
  loadConfig,
  generateCompose,
  buildAggregatedM3U,
  buildPlayerHTML,
  buildAggregatedNow,
  buildHealthResponse,
} = require('./director.js');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function tmpFile(ext) {
  return path.join(os.tmpdir(), `director-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

/** Write content to a new temp file; return its path. */
function writeTmp(content, ext = '.yaml') {
  const f = tmpFile(ext);
  fs.writeFileSync(f, content, 'utf8');
  return f;
}

/** Minimal reeltime config with a given stream name. */
function reeltimeCfg(name, opts = {}) {
  const channelId = opts.channelId ? `\n  channel_id: "${opts.channelId}"` : '';
  const icon      = opts.icon      ? `\n  icon: "${opts.icon}"` : '';
  return `stream:\n  name: "${name}"${channelId}${icon}\nvideos:\n  - title: "T"\n    url: "http://x"\n    duration: 60\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. toSnakeCase
// ─────────────────────────────────────────────────────────────────────────────

test('toSnakeCase - converts to snake_case', () => {
  assert.equal(toSnakeCase('Channel One'), 'channel_one');
  assert.equal(toSnakeCase('My Channel 3'), 'my_channel_3');
  assert.equal(toSnakeCase('hello-world'), 'hello_world');
  assert.equal(toSnakeCase('ABC DEF'), 'abc_def');
});

test('toSnakeCase - trims leading/trailing underscores', () => {
  assert.equal(toSnakeCase('  Channel 1  '), 'channel_1');
  assert.equal(toSnakeCase('--hello--'), 'hello');
});

test('toSnakeCase - handles empty string → "director"', () => {
  assert.equal(toSnakeCase(''), 'director');
  assert.equal(toSnakeCase('   '), 'director');
});

test('toSnakeCase - single word unchanged', () => {
  assert.equal(toSnakeCase('news'), 'news');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. escHtml
// ─────────────────────────────────────────────────────────────────────────────

test('escHtml - escapes & < > " \'', () => {
  assert.equal(escHtml('&'),  '&amp;');
  assert.equal(escHtml('<'),  '&lt;');
  assert.equal(escHtml('>'),  '&gt;');
  assert.equal(escHtml('"'),  '&quot;');
  assert.equal(escHtml("'"),  '&#39;');
});

test('escHtml - escapes combined string', () => {
  assert.equal(
    escHtml('<script>alert("xss&\'stuff\'");</script>'),
    '&lt;script&gt;alert(&quot;xss&amp;&#39;stuff&#39;&quot;);&lt;/script&gt;',
  );
});

test('escHtml - leaves safe text unchanged', () => {
  assert.equal(escHtml('Hello World 123'), 'Hello World 123');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. escXML
// ─────────────────────────────────────────────────────────────────────────────

test('escXML - escapes & < > " \'', () => {
  assert.equal(escXML('&'),  '&amp;');
  assert.equal(escXML('<'),  '&lt;');
  assert.equal(escXML('>'),  '&gt;');
  assert.equal(escXML('"'),  '&quot;');
  assert.equal(escXML("'"),  '&apos;');
});

test('escXML - escapes combined XML string', () => {
  const result = escXML('<tag attr="val\'ue">text & more</tag>');
  assert.ok(result.includes('&lt;'));
  assert.ok(result.includes('&amp;'));
  assert.ok(result.includes('&apos;'));
  assert.ok(result.includes('&quot;'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. deriveChannelId
// ─────────────────────────────────────────────────────────────────────────────

test('deriveChannelId - uses id when present', () => {
  assert.equal(deriveChannelId({ id: 'my_custom_id', name: 'Channel 1' }), 'my_custom_id');
});

test('deriveChannelId - derives from name when no id', () => {
  assert.equal(deriveChannelId({ name: 'Channel One' }), 'channel_one');
  assert.equal(deriveChannelId({ name: 'BBC News 24' }), 'bbc_news_24');
});

test('deriveChannelId - ignores empty id, falls back to name', () => {
  assert.equal(deriveChannelId({ id: '', name: 'Channel X' }),    'channel_x');
  assert.equal(deriveChannelId({ id: '   ', name: 'Channel X' }), 'channel_x');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. readChannelConfig
// ─────────────────────────────────────────────────────────────────────────────

test('readChannelConfig - throws when file not found', () => {
  assert.throws(
    () => readChannelConfig('/nonexistent/path/channel.yaml', 0, null),
    /not found/i,
  );
});

test('readChannelConfig - reads stream.name', () => {
  const f   = writeTmp(reeltimeCfg('My Channel'));
  const ch  = readChannelConfig(f, 0, null);
  fs.unlinkSync(f);
  assert.equal(ch.name, 'My Channel');
});

test('readChannelConfig - derives id from name when channel_id absent', () => {
  const f  = writeTmp(reeltimeCfg('My Channel'));
  const ch = readChannelConfig(f, 0, null);
  fs.unlinkSync(f);
  assert.equal(ch.id, 'my_channel');
});

test('readChannelConfig - uses stream.channel_id when present', () => {
  const f  = writeTmp(reeltimeCfg('My Channel', { channelId: 'custom_id' }));
  const ch = readChannelConfig(f, 0, null);
  fs.unlinkSync(f);
  assert.equal(ch.id, 'custom_id');
});

test('readChannelConfig - derives url from channel id', () => {
  const f  = writeTmp(reeltimeCfg('News Now'));
  const ch = readChannelConfig(f, 0, null);
  fs.unlinkSync(f);
  assert.equal(ch.url, 'http://reeltime-news_now:8080');
});

test('readChannelConfig - respects urlOverride', () => {
  const f  = writeTmp(reeltimeCfg('News Now'));
  const ch = readChannelConfig(f, 0, 'http://custom-host:9000');
  fs.unlinkSync(f);
  assert.equal(ch.url, 'http://custom-host:9000');
});

test('readChannelConfig - assigns port = 10001 + index', () => {
  const f0 = writeTmp(reeltimeCfg('Ch A'));
  const f1 = writeTmp(reeltimeCfg('Ch B'));
  const f2 = writeTmp(reeltimeCfg('Ch C'));
  assert.equal(readChannelConfig(f0, 0, null).port, 10001);
  assert.equal(readChannelConfig(f1, 1, null).port, 10002);
  assert.equal(readChannelConfig(f2, 2, null).port, 10003);
  [f0, f1, f2].forEach(f => fs.unlinkSync(f));
});

test('readChannelConfig - assigns channelNum = index + 1', () => {
  const f0 = writeTmp(reeltimeCfg('Ch A'));
  const f1 = writeTmp(reeltimeCfg('Ch B'));
  assert.equal(readChannelConfig(f0, 0, null).channelNum, 1);
  assert.equal(readChannelConfig(f1, 1, null).channelNum, 2);
  [f0, f1].forEach(f => fs.unlinkSync(f));
});

test('readChannelConfig - reads stream.icon', () => {
  const f  = writeTmp(reeltimeCfg('Ch', { icon: 'https://example.com/icon.png' }));
  const ch = readChannelConfig(f, 0, null);
  fs.unlinkSync(f);
  assert.equal(ch.icon, 'https://example.com/icon.png');
});

test('readChannelConfig - defaults to empty icon when absent', () => {
  const f  = writeTmp(reeltimeCfg('Ch'));
  const ch = readChannelConfig(f, 0, null);
  fs.unlinkSync(f);
  assert.equal(ch.icon, '');
});

test('readChannelConfig - exposes configPath', () => {
  const f  = writeTmp(reeltimeCfg('Ch'));
  const ch = readChannelConfig(f, 0, null);
  fs.unlinkSync(f);
  assert.equal(ch.configPath, f);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. loadConfig
// ─────────────────────────────────────────────────────────────────────────────

test('loadConfig - throws when configs key is missing', () => {
  const f = writeTmp('director:\n  name: "Test"\n');
  assert.throws(() => loadConfig(f), /configs/i);
  fs.unlinkSync(f);
});

test('loadConfig - throws when configs array is empty', () => {
  const f = writeTmp('director:\n  name: "Test"\nconfigs: []\n');
  assert.throws(() => loadConfig(f), /configs/i);
  fs.unlinkSync(f);
});

test('loadConfig - throws when a referenced config file does not exist', () => {
  const f = writeTmp('configs:\n  - /nonexistent/channel.yaml\n');
  assert.throws(() => loadConfig(f), /not found/i);
  fs.unlinkSync(f);
});

test('loadConfig - reads channel name and id from reeltime config files', () => {
  const ch1 = writeTmp(reeltimeCfg('Channel 1'));
  const ch2 = writeTmp(reeltimeCfg('Channel 2', { channelId: 'ch2_custom' }));
  const dir = writeTmp(`configs:\n  - ${ch1}\n  - ${ch2}\n`);

  const cfg = loadConfig(dir);
  [ch1, ch2, dir].forEach(f => fs.unlinkSync(f));

  assert.equal(cfg.channels.length, 2);
  assert.equal(cfg.channels[0].name, 'Channel 1');
  assert.equal(cfg.channels[0].id,   'channel_1');
  assert.equal(cfg.channels[1].name, 'Channel 2');
  assert.equal(cfg.channels[1].id,   'ch2_custom');
});

test('loadConfig - derives channel url from id', () => {
  const ch = writeTmp(reeltimeCfg('Sports HD'));
  const dir = writeTmp(`configs:\n  - ${ch}\n`);

  const cfg = loadConfig(dir);
  [ch, dir].forEach(f => fs.unlinkSync(f));

  assert.equal(cfg.channels[0].url, 'http://reeltime-sports_hd:8080');
});

test('loadConfig - respects per-entry url override', () => {
  const ch  = writeTmp(reeltimeCfg('Sports HD'));
  const dir = writeTmp(`configs:\n  - path: ${ch}\n    url: http://remote:9001\n`);

  const cfg = loadConfig(dir);
  [ch, dir].forEach(f => fs.unlinkSync(f));

  assert.equal(cfg.channels[0].url, 'http://remote:9001');
});

test('loadConfig - returns correct directorName', () => {
  const ch  = writeTmp(reeltimeCfg('C'));
  const dir = writeTmp(`director:\n  name: "My Director"\nconfigs:\n  - ${ch}\n`);

  const cfg = loadConfig(dir);
  [ch, dir].forEach(f => fs.unlinkSync(f));

  assert.equal(cfg.directorName, 'My Director');
});

test('loadConfig - defaults directorName when director.name absent', () => {
  const ch  = writeTmp(reeltimeCfg('C'));
  const dir = writeTmp(`configs:\n  - ${ch}\n`);

  const cfg = loadConfig(dir);
  [ch, dir].forEach(f => fs.unlinkSync(f));

  assert.equal(cfg.directorName, 'Reeltime Director');
});

test('loadConfig - resolves relative config paths', () => {
  // Write channel config and director config in the same temp dir,
  // then reference the channel by relative path.
  const ch   = writeTmp(reeltimeCfg('Relative Ch'));
  const base = path.basename(ch);
  const dir  = writeTmp(`configs:\n  - ./${base}\n`);
  // Move director config to same directory as ch
  const dirSameDir = path.join(os.tmpdir(), `dir-${Date.now()}.yaml`);
  fs.copyFileSync(dir, dirSameDir);
  fs.unlinkSync(dir);

  const cfg = loadConfig(dirSameDir);
  [ch, dirSameDir].forEach(f => fs.unlinkSync(f));

  assert.equal(cfg.channels[0].name, 'Relative Ch');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. generateCompose
// ─────────────────────────────────────────────────────────────────────────────

function makeDirectorCfg() {
  const ch1 = writeTmp(reeltimeCfg('Channel 1'));
  const ch2 = writeTmp(reeltimeCfg('Channel 2'));
  const dir = writeTmp(`configs:\n  - ${ch1}\n  - ${ch2}\n`);
  return { ch1, ch2, dir };
}

test('generateCompose - contains director service', () => {
  const { ch1, ch2, dir } = makeDirectorCfg();
  const out = generateCompose(dir);
  [ch1, ch2, dir].forEach(f => fs.unlinkSync(f));
  assert.ok(out.includes('reeltime-director'));
  assert.ok(out.includes('director:'));
});

test('generateCompose - contains a reeltime service per channel', () => {
  const { ch1, ch2, dir } = makeDirectorCfg();
  const out = generateCompose(dir);
  [ch1, ch2, dir].forEach(f => fs.unlinkSync(f));
  assert.ok(out.includes('reeltime-channel_1'));
  assert.ok(out.includes('reeltime-channel_2'));
});

test('generateCompose - assigns sequential host ports', () => {
  const { ch1, ch2, dir } = makeDirectorCfg();
  const out = generateCompose(dir);
  [ch1, ch2, dir].forEach(f => fs.unlinkSync(f));
  assert.ok(out.includes('"10001:8080"'));
  assert.ok(out.includes('"10002:8080"'));
});

test('generateCompose - director listens on port 10000', () => {
  const { ch1, ch2, dir } = makeDirectorCfg();
  const out = generateCompose(dir);
  [ch1, ch2, dir].forEach(f => fs.unlinkSync(f));
  assert.ok(out.includes('"10000:10000"'));
});

test('generateCompose - contains volume mounts for channel configs', () => {
  const { ch1, ch2, dir } = makeDirectorCfg();
  const out = generateCompose(dir);
  [ch1, ch2, dir].forEach(f => fs.unlinkSync(f));
  // Config directory (not file) is mounted at /config
  assert.ok(out.includes(':/config\n'));
});

test('generateCompose - contains volume mount for director config', () => {
  const { ch1, ch2, dir } = makeDirectorCfg();
  const dirBase = path.basename(dir);
  const out = generateCompose(dir);
  [ch1, ch2, dir].forEach(f => fs.unlinkSync(f));
  assert.ok(out.includes(`/config/${dirBase}:ro`));
});

test('generateCompose - contains depends_on for each channel', () => {
  const { ch1, ch2, dir } = makeDirectorCfg();
  const out = generateCompose(dir);
  [ch1, ch2, dir].forEach(f => fs.unlinkSync(f));
  assert.ok(out.includes('depends_on'));
  assert.ok(out.includes('- reeltime-channel_1'));
  assert.ok(out.includes('- reeltime-channel_2'));
});

test('generateCompose - mounts config directory and sets CONFIG_PATH for each channel', () => {
  const { ch1, ch2, dir } = makeDirectorCfg();
  const out = generateCompose(dir);
  [ch1, ch2, dir].forEach(f => fs.unlinkSync(f));
  // The directory containing each channel config is mounted at /config
  // so the reel can write state files alongside the config (no separate state volume).
  assert.ok(out.includes(':/config\n'));
  assert.ok(out.includes('CONFIG_PATH:'));
  assert.ok(!out.includes('STATE_PATH'));
  assert.ok(!out.includes('./state/reeltime-'));
});

test('loadConfig - passes volumes through to channel descriptor', () => {
  const ch  = writeTmp(reeltimeCfg('Ch'));
  const dir = writeTmp(`configs:\n  - path: ${ch}\n    volumes:\n      - ./videos:/videos:ro\n`);

  const cfg = loadConfig(dir);
  [ch, dir].forEach(f => fs.unlinkSync(f));

  assert.deepEqual(cfg.channels[0].volumes, ['./videos:/videos:ro']);
});

test('loadConfig - defaults volumes to empty array for bare string entry', () => {
  const ch  = writeTmp(reeltimeCfg('Ch'));
  const dir = writeTmp(`configs:\n  - ${ch}\n`);

  const cfg = loadConfig(dir);
  [ch, dir].forEach(f => fs.unlinkSync(f));

  assert.deepEqual(cfg.channels[0].volumes, []);
});

test('generateCompose - emits extra volume mounts from volumes array (relative path)', () => {
  const ch  = writeTmp(reeltimeCfg('Channel 1'));
  const dir = writeTmp(`configs:\n  - path: ${ch}\n    volumes:\n      - ./videos:/videos:ro\n`);

  const out = generateCompose(dir);
  [ch, dir].forEach(f => fs.unlinkSync(f));

  assert.ok(out.includes(':/videos:ro'));
});

test('generateCompose - passes absolute volume host paths through unchanged', () => {
  const ch  = writeTmp(reeltimeCfg('Channel 1'));
  const dir = writeTmp(`configs:\n  - path: ${ch}\n    volumes:\n      - /data/shows/my-show:/videos:ro\n`);

  const out = generateCompose(dir);
  [ch, dir].forEach(f => fs.unlinkSync(f));

  assert.ok(out.includes('- /data/shows/my-show:/videos:ro'));
});

test('generateCompose - no extra volume line when volumes array is empty', () => {
  const { ch1, ch2, dir } = makeDirectorCfg();
  const out = generateCompose(dir);
  [ch1, ch2, dir].forEach(f => fs.unlinkSync(f));

  const volumeLines = out.split('\n').filter(l => l.trim().startsWith('- ') && l.includes(':/'));
  // Only the /config mount should appear per channel (plus the director config mount)
  const extraMounts = volumeLines.filter(l => !l.includes(':/config'));
  assert.equal(extraMounts.length, 0);
});

test('generateCompose - scout/boom channel with volumes emits volumes block', () => {
  const ch  = writeTmp(reeltimeCfg('Channel 1'));
  const dir = writeTmp(
    `configs:\n  - ${ch}\n` +
    `  - name: "Weather"\n    type: boom\n    volumes:\n      - /data/music:/music:ro\n` +
    `    environment:\n      MUSIC_DIR: "/music"\n`
  );

  const out = generateCompose(dir);
  [ch, dir].forEach(f => fs.unlinkSync(f));

  assert.ok(out.includes('- /data/music:/music:ro'));
});

test('generateCompose - scout/boom channel with no volumes has no volumes block', () => {
  const ch  = writeTmp(reeltimeCfg('Channel 1'));
  const dir = writeTmp(
    `configs:\n  - ${ch}\n` +
    `  - name: "Weather"\n    type: boom\n    environment:\n      ZIP_CODE: "12345"\n`
  );

  const out = generateCompose(dir);
  [ch, dir].forEach(f => fs.unlinkSync(f));

  // Find the boom service block and verify it has no volumes: key
  const boomStart = out.indexOf('reeltime-weather:');
  const boomBlock = out.slice(boomStart);
  const nextService = boomBlock.indexOf('\n  reeltime-', 1);
  const boomSection = nextService === -1 ? boomBlock : boomBlock.slice(0, nextService);
  assert.ok(!boomSection.includes('volumes:'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. buildAggregatedM3U
// ─────────────────────────────────────────────────────────────────────────────

const sampleChannels = [
  { id: 'channel_1', name: 'Channel 1', url: 'http://reeltime-channel_1:8080', port: 10001, channelNum: 1 },
  { id: 'channel_2', name: 'Channel 2', url: 'http://reeltime-channel_2:8080', port: 10002, channelNum: 2 },
];

test('buildAggregatedM3U - starts with #EXTM3U', () => {
  const m3u = buildAggregatedM3U(sampleChannels, 'localhost:10000');
  assert.ok(m3u.startsWith('#EXTM3U'));
});

test('buildAggregatedM3U - contains tvg-url pointing to /xmltv', () => {
  const m3u = buildAggregatedM3U(sampleChannels, 'localhost:10000');
  assert.ok(m3u.includes('x-tvg-url="http://localhost:10000/xmltv"'));
});

test('buildAggregatedM3U - contains correct stream URLs', () => {
  const m3u = buildAggregatedM3U(sampleChannels, 'localhost:10000');
  assert.ok(m3u.includes('http://localhost:10001/stream.m3u8'));
  assert.ok(m3u.includes('http://localhost:10002/stream.m3u8'));
});

test('buildAggregatedM3U - contains channel names in EXTINF lines', () => {
  const m3u = buildAggregatedM3U(sampleChannels, 'localhost:10000');
  assert.ok(m3u.includes('Channel 1'));
  assert.ok(m3u.includes('Channel 2'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. static index.html
// ─────────────────────────────────────────────────────────────────────────────

test('index.html - static file exists', () => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  assert.ok(fs.existsSync(indexPath), 'public/index.html must exist');
});

test('index.html - contains guide-grid element', () => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  assert.ok(html.includes('id="guide-grid"'));
});

test('index.html - contains neon colors in JS', () => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  assert.ok(html.includes('#00d4ff'));
});

test('index.html - fetches /now in JS', () => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  assert.ok(html.includes("fetch('/now')"));
});

test('index.html - contains /watch/ link pattern in JS', () => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  assert.ok(html.includes('/watch/'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. buildPlayerHTML
// ─────────────────────────────────────────────────────────────────────────────

test('buildPlayerHTML - contains channel name', () => {
  const ch   = sampleChannels[0];
  const html = buildPlayerHTML(ch, '#00d4ff');
  assert.ok(html.includes('Channel 1'));
});

test('buildPlayerHTML - contains stream.m3u8 URL (fallback to channel.url)', () => {
  const ch   = sampleChannels[0];
  const html = buildPlayerHTML(ch, '#00d4ff');
  assert.ok(html.includes('http://reeltime-channel_1:8080/stream.m3u8'));
});

test('buildPlayerHTML - uses externalBase when provided', () => {
  const ch   = sampleChannels[0];
  const html = buildPlayerHTML(ch, '#00d4ff', 'http://192.168.1.10:10001');
  assert.ok(html.includes('http://192.168.1.10:10001/stream.m3u8'));
  assert.ok(!html.includes('reeltime-channel_1'));
});

test('buildPlayerHTML - contains neon color', () => {
  const ch   = sampleChannels[1];
  const html = buildPlayerHTML(ch, '#39ff14');
  assert.ok(html.includes('#39ff14'));
});

test('buildPlayerHTML - contains back link to guide', () => {
  const ch   = sampleChannels[0];
  const html = buildPlayerHTML(ch, '#00d4ff');
  assert.ok(html.includes('href="/"'));
});

test('buildPlayerHTML - contains HLS.js script tag', () => {
  const ch   = sampleChannels[0];
  const html = buildPlayerHTML(ch, '#00d4ff');
  assert.ok(html.includes('hls.js'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. buildAggregatedNow
// ─────────────────────────────────────────────────────────────────────────────

test('buildAggregatedNow - returns correct shape', () => {
  const cache = new Map();
  cache.set('channel_1', { online: true,  now: { current: { title: 'Movie A', progress: 0.5 }, next: null } });
  cache.set('channel_2', { online: false, now: null });

  const result = buildAggregatedNow('My Director', sampleChannels, cache);
  assert.ok(Array.isArray(result.channels));
  assert.equal(result.channels.length, 2);
});

test('buildAggregatedNow - includes director name', () => {
  const cache  = new Map();
  const result = buildAggregatedNow('Test Director', sampleChannels, cache);
  assert.equal(result.name, 'Test Director');
});

test('buildAggregatedNow - online channel has correct data', () => {
  const cache = new Map();
  cache.set('channel_1', { online: true, now: { current: { title: 'Movie A', progress: 0.5 }, next: null } });
  cache.set('channel_2', { online: false });

  const result = buildAggregatedNow('My Director', sampleChannels, cache, '192.168.1.5');
  const ch1 = result.channels.find(c => c.id === 'channel_1');
  assert.ok(ch1);
  assert.equal(ch1.online, true);
  assert.equal(ch1.now.current.title, 'Movie A');
  assert.equal(ch1.name, 'Channel 1');
  assert.equal(ch1.stream, 'http://192.168.1.5:10001/stream.m3u8');
  assert.equal(ch1.channelNum, 1);
  assert.equal(ch1.port, 10001);
});

test('buildAggregatedNow - strips stream from now object', () => {
  const cache = new Map();
  cache.set('channel_1', {
    online: true,
    now: { current: { title: 'Movie A', progress: 0.5 }, next: null, stream: 'http://reeltime-channel_1:8080/stream.m3u8' },
  });

  const result = buildAggregatedNow('My Director', sampleChannels, cache, '192.168.1.5');
  const ch1 = result.channels.find(c => c.id === 'channel_1');
  assert.ok(ch1);
  assert.equal(ch1.now.current.title, 'Movie A');
  assert.equal(ch1.now.stream, undefined);
});

test('buildAggregatedNow - offline channel has online: false', () => {
  const cache = new Map();
  cache.set('channel_1', { online: false });

  const result = buildAggregatedNow('My Director', sampleChannels, cache);
  const ch1 = result.channels.find(c => c.id === 'channel_1');
  assert.equal(ch1.online, false);
  assert.equal(ch1.now, null);
});

test('buildAggregatedNow - uncached channel defaults to offline', () => {
  const cache  = new Map();
  const result = buildAggregatedNow('My Director', sampleChannels, cache);
  assert.equal(result.channels[0].online, false);
  assert.equal(result.channels[0].now,    null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. buildHealthResponse
// ─────────────────────────────────────────────────────────────────────────────

test('buildHealthResponse - returns status: ok', () => {
  const cache  = new Map();
  const result = buildHealthResponse(sampleChannels, cache);
  assert.equal(result.status, 'ok');
});

test('buildHealthResponse - includes uptime as a number', () => {
  const cache  = new Map();
  const result = buildHealthResponse(sampleChannels, cache);
  assert.equal(typeof result.uptime, 'number');
  assert.ok(result.uptime >= 0);
});

test('buildHealthResponse - includes channels array with correct shape', () => {
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

  const ch2 = result.channels.find(c => c.id === 'channel_2');
  assert.equal(ch2.online, false);
});

test('buildHealthResponse - uncached channel is offline', () => {
  const cache  = new Map();
  const result = buildHealthResponse(sampleChannels, cache);
  assert.equal(result.channels[0].online, false);
  assert.equal(result.channels[1].online, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. buildAggregatedNow - upcoming array passthrough
// ─────────────────────────────────────────────────────────────────────────────

test('buildAggregatedNow - passes through upcoming array', () => {
  const cache = new Map();
  cache.set('channel_1', {
    online: true,
    now: {
      current:  { title: 'Now',  startedAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-01-01T00:10:00.000Z', progress: 0.5 },
      upcoming: [
        { title: 'Next',   startsAt: '2026-01-01T00:10:00.000Z', endsAt: '2026-01-01T00:20:00.000Z', duration: 600 },
        { title: 'After',  startsAt: '2026-01-01T00:20:00.000Z', endsAt: '2026-01-01T00:30:00.000Z', duration: 600 },
      ],
    },
  });

  const result = buildAggregatedNow('My Director', sampleChannels, cache);
  const ch1 = result.channels.find(c => c.id === 'channel_1');
  assert.ok(Array.isArray(ch1.now.upcoming));
  assert.equal(ch1.now.upcoming.length, 2);
  assert.equal(ch1.now.upcoming[0].title, 'Next');
});

test('buildAggregatedNow - upcoming absent when not returned by reel', () => {
  const cache = new Map();
  cache.set('channel_1', {
    online: true,
    now: { current: { title: 'Now', progress: 0.5 }, next: null },
  });

  const result = buildAggregatedNow('My Director', sampleChannels, cache);
  const ch1 = result.channels.find(c => c.id === 'channel_1');
  assert.equal(ch1.now.upcoming, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. TV guide HTML structure
// ─────────────────────────────────────────────────────────────────────────────

test('index.html - contains prog-rail for TV grid layout', () => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  assert.ok(html.includes('prog-rail'));
});

test('index.html - contains time-strip for time header', () => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  assert.ok(html.includes('time-strip'));
});

test('index.html - contains upcoming array handling in JS', () => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  assert.ok(html.includes('upcoming'));
});


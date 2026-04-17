'use strict';

/**
 * streamer.test.js - unit tests for mixer streamer pure functions
 * Run with: node --test src/streamer.test.js  (from mixer/ directory)
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeTitle,
  findCurrentTrack,
  buildNowResponse,
  buildXMLTV,
  buildM3U,
  buildPlayerHTML,
} = require('./streamer.js');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal track list for use in tests. */
function makeTracks(durations) {
  return durations.map((d, i) => ({
    path:     `/music/track${i + 1}.mp3`,
    title:    `Track ${i + 1}`,
    duration: d,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. normalizeTitle
// ─────────────────────────────────────────────────────────────────────────────

test('normalizeTitle - strips directory and extension', () => {
  assert.equal(normalizeTitle('/music/01-Dreams.mp3'), '01 Dreams');
});

test('normalizeTitle - replaces hyphens with spaces', () => {
  assert.equal(normalizeTitle('01-big-love.mp3'), '01 big love');
});

test('normalizeTitle - replaces underscores with spaces', () => {
  assert.equal(normalizeTitle('the_chain.mp3'), 'the chain');
});

test('normalizeTitle - collapses multiple separators', () => {
  assert.equal(normalizeTitle('01--the__chain.mp3'), '01 the chain');
});

test('normalizeTitle - trims whitespace', () => {
  assert.equal(normalizeTitle('  spaces  .mp3'), 'spaces');
});

test('normalizeTitle - works with no directory prefix', () => {
  assert.equal(normalizeTitle('Song Title.mp3'), 'Song Title');
});

test('normalizeTitle - strips leading dot from dotfile-style names', () => {
  // path.extname('.mp3') === '' in Node.js (treated as a dotfile), so
  // the whole base is ".mp3". We strip the leading dot to yield "mp3".
  assert.equal(normalizeTitle('.mp3'), 'mp3');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. findCurrentTrack
// ─────────────────────────────────────────────────────────────────────────────

test('findCurrentTrack - returns null for empty track list', () => {
  assert.equal(findCurrentTrack([], 0, 1000), null);
});

test('findCurrentTrack - returns null for null track list', () => {
  assert.equal(findCurrentTrack(null, 0, 1000), null);
});

test('findCurrentTrack - returns null when total duration is zero', () => {
  const tracks = makeTracks([0, 0]);
  assert.equal(findCurrentTrack(tracks, 0, 1000), null);
});

test('findCurrentTrack - returns first track at playback start', () => {
  const tracks = makeTracks([120, 180]);
  const result = findCurrentTrack(tracks, 0, 0);
  assert.ok(result);
  assert.equal(result.track.title, 'Track 1');
  assert.equal(result.position, 0);
  assert.equal(result.remaining, 120);
});

test('findCurrentTrack - returns second track after first ends', () => {
  const tracks  = makeTracks([120, 180]);
  const startMs = 1_000_000;
  const nowMs   = startMs + 121_000;  // 121 seconds in = second track
  const result  = findCurrentTrack(tracks, startMs, nowMs);
  assert.ok(result);
  assert.equal(result.track.title, 'Track 2');
  assert.ok(result.position < 180);
});

test('findCurrentTrack - wraps around after full loop', () => {
  const tracks  = makeTracks([100, 100]);
  const startMs = 0;
  const nowMs   = 201_000;   // 201s in - one full loop (200s) plus 1s into track 1 again
  const result  = findCurrentTrack(tracks, startMs, nowMs);
  assert.ok(result);
  assert.equal(result.track.title, 'Track 1');
  assert.ok(result.position >= 0 && result.position < 100);
});

test('findCurrentTrack - position and remaining sum to track duration', () => {
  const tracks  = makeTracks([200, 300]);
  const startMs = 0;
  const nowMs   = 50_000;    // 50s into first 200s track
  const result  = findCurrentTrack(tracks, startMs, nowMs);
  assert.ok(result);
  const sum = result.position + result.remaining;
  assert.ok(Math.abs(sum - result.track.duration) < 0.01);
});

test('findCurrentTrack - nextTrack wraps to first after last track', () => {
  const tracks  = makeTracks([100, 100]);
  const startMs = 0;
  const nowMs   = 150_000;   // inside track 2
  const result  = findCurrentTrack(tracks, startMs, nowMs);
  assert.ok(result);
  assert.equal(result.track.title, 'Track 2');
  assert.equal(result.nextTrack.title, 'Track 1');
});

test('findCurrentTrack - nextTrack is second when on first track', () => {
  const tracks  = makeTracks([100, 100, 100]);
  const startMs = 0;
  const nowMs   = 50_000;
  const result  = findCurrentTrack(tracks, startMs, nowMs);
  assert.ok(result);
  assert.equal(result.nextTrack.title, 'Track 2');
});

test('findCurrentTrack - startedAt and endsAt are ISO strings', () => {
  const tracks  = makeTracks([120, 180]);
  const startMs = Date.now();
  const result  = findCurrentTrack(tracks, startMs, startMs + 10_000);
  assert.ok(result);
  assert.ok(typeof result.startedAt === 'string');
  assert.ok(typeof result.endsAt    === 'string');
  assert.ok(!isNaN(Date.parse(result.startedAt)));
  assert.ok(!isNaN(Date.parse(result.endsAt)));
});

test('findCurrentTrack - endsAt is later than startedAt', () => {
  const tracks  = makeTracks([120, 180]);
  const startMs = Date.now();
  const result  = findCurrentTrack(tracks, startMs, startMs + 10_000);
  assert.ok(result);
  assert.ok(new Date(result.endsAt) > new Date(result.startedAt));
});

test('findCurrentTrack - handles single-track list', () => {
  const tracks  = makeTracks([300]);
  const startMs = 0;
  const result  = findCurrentTrack(tracks, startMs, 150_000);
  assert.ok(result);
  assert.equal(result.track.title, 'Track 1');
  assert.equal(result.nextTrack.title, 'Track 1');  // wraps to itself
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. buildNowResponse
// ─────────────────────────────────────────────────────────────────────────────

test('buildNowResponse - returns null current when no tracks', () => {
  const result = buildNowResponse([], 0, Date.now(), 'localhost:8080');
  assert.equal(result.current, null);
  assert.equal(result.next, null);
});

test('buildNowResponse - includes stream URL', () => {
  const result = buildNowResponse([], 0, Date.now(), 'localhost:8080');
  assert.equal(result.stream, 'http://localhost:8080/stream.m3u8');
});

test('buildNowResponse - current has required fields', () => {
  const tracks  = makeTracks([200, 300]);
  const startMs = Date.now() - 50_000;
  const result  = buildNowResponse(tracks, startMs, Date.now(), 'localhost:8080');
  assert.ok(result.current);
  assert.equal(typeof result.current.title,     'string');
  assert.equal(typeof result.current.duration,  'number');
  assert.equal(typeof result.current.position,  'number');
  assert.equal(typeof result.current.remaining, 'number');
  assert.equal(typeof result.current.progress,  'number');
  assert.equal(typeof result.current.startedAt, 'string');
  assert.equal(typeof result.current.endsAt,    'string');
});

test('buildNowResponse - current has empty seriesTitle and episodeNum', () => {
  const tracks  = makeTracks([200]);
  const startMs = Date.now();
  const result  = buildNowResponse(tracks, startMs, startMs, 'localhost:8080');
  assert.ok(result.current);
  assert.equal(result.current.seriesTitle, '');
  assert.equal(result.current.episodeNum,  '');
  assert.equal(result.current.subTitle,    '');
});

test('buildNowResponse - progress is between 0 and 1', () => {
  const tracks  = makeTracks([300]);
  const startMs = Date.now() - 100_000;
  const result  = buildNowResponse(tracks, startMs, Date.now(), 'localhost:8080');
  assert.ok(result.current);
  assert.ok(result.current.progress >= 0);
  assert.ok(result.current.progress <= 1);
});

test('buildNowResponse - next has title and duration', () => {
  const tracks  = makeTracks([100, 200]);
  const startMs = Date.now();
  const result  = buildNowResponse(tracks, startMs, startMs, 'localhost:8080');
  assert.ok(result.next);
  assert.equal(typeof result.next.title,    'string');
  assert.equal(typeof result.next.duration, 'number');
});

test('buildNowResponse - description equals title', () => {
  const tracks  = makeTracks([200]);
  const startMs = Date.now();
  const result  = buildNowResponse(tracks, startMs, startMs, 'localhost:8080');
  assert.ok(result.current);
  assert.equal(result.current.description, result.current.title);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. buildXMLTV
// ─────────────────────────────────────────────────────────────────────────────

test('buildXMLTV - starts with XML declaration', () => {
  const xml = buildXMLTV('mixer', 'Mixer', '', 'localhost:8080', 4);
  assert.ok(xml.startsWith('<?xml version="1.0"'));
});

test('buildXMLTV - contains channel element with correct id', () => {
  const xml = buildXMLTV('my_music', 'My Music', '', 'localhost:8080', 4);
  assert.ok(xml.includes('<channel id="my_music">'));
});

test('buildXMLTV - contains display-name', () => {
  const xml = buildXMLTV('mixer', 'My Music Channel', '', 'localhost:8080', 4);
  assert.ok(xml.includes('<display-name>My Music Channel</display-name>'));
});

test('buildXMLTV - contains correct number of programme elements', () => {
  const xml    = buildXMLTV('mixer', 'Mixer', '', 'localhost:8080', 3);
  const count  = (xml.match(/<programme /g) || []).length;
  assert.equal(count, 3);
});

test('buildXMLTV - clamps hours to 1-24', () => {
  const xml0  = buildXMLTV('m', 'M', '', 'h', 0);
  const xml25 = buildXMLTV('m', 'M', '', 'h', 25);
  assert.equal((xml0.match( /<programme /g) || []).length, 1);
  assert.equal((xml25.match(/<programme /g) || []).length, 24);
});

test('buildXMLTV - escapes XML special characters in channel name', () => {
  const xml = buildXMLTV('ch', 'Music & More <Best>', '', 'localhost', 1);
  assert.ok(xml.includes('Music &amp; More &lt;Best&gt;'));
});

test('buildXMLTV - programme category is Music', () => {
  const xml = buildXMLTV('mixer', 'Mixer', '', 'localhost:8080', 1);
  assert.ok(xml.includes('<category lang="en">Music</category>'));
});

test('buildXMLTV - includes icon when channelIcon is set', () => {
  const xml = buildXMLTV('mixer', 'Mixer', 'https://example.com/icon.png', 'localhost:8080', 1);
  assert.ok(xml.includes('<icon src="https://example.com/icon.png"'));
});

test('buildXMLTV - omits icon element when channelIcon is empty', () => {
  const xml = buildXMLTV('mixer', 'Mixer', '', 'localhost:8080', 1);
  assert.ok(!xml.includes('<icon'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. buildM3U
// ─────────────────────────────────────────────────────────────────────────────

test('buildM3U - starts with #EXTM3U', () => {
  const m3u = buildM3U('mixer', 'Mixer', '1', '', 'localhost:8080');
  assert.ok(m3u.startsWith('#EXTM3U'));
});

test('buildM3U - contains tvg-id', () => {
  const m3u = buildM3U('my_music', 'My Music', '1', '', 'localhost:8080');
  assert.ok(m3u.includes('tvg-id="my_music"'));
});

test('buildM3U - contains tvg-name', () => {
  const m3u = buildM3U('mixer', 'My Music Channel', '1', '', 'localhost:8080');
  assert.ok(m3u.includes('tvg-name="My Music Channel"'));
});

test('buildM3U - contains tvg-channel-no', () => {
  const m3u = buildM3U('mixer', 'Mixer', '42', '', 'localhost:8080');
  assert.ok(m3u.includes('tvg-channel-no="42"'));
});

test('buildM3U - contains stream URL', () => {
  const m3u = buildM3U('mixer', 'Mixer', '1', '', 'localhost:8080');
  assert.ok(m3u.includes('http://localhost:8080/stream.m3u8'));
});

test('buildM3U - includes tvg-logo when channelIcon is set', () => {
  const m3u = buildM3U('mixer', 'Mixer', '1', 'https://example.com/icon.png', 'localhost:8080');
  assert.ok(m3u.includes('tvg-logo="https://example.com/icon.png"'));
});

test('buildM3U - omits tvg-logo when channelIcon is empty', () => {
  const m3u = buildM3U('mixer', 'Mixer', '1', '', 'localhost:8080');
  assert.ok(!m3u.includes('tvg-logo'));
});

test('buildM3U - escapes HTML special characters in channel name', () => {
  const m3u = buildM3U('ch', 'Music & More', '1', '', 'localhost:8080');
  assert.ok(m3u.includes('Music &amp; More'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. buildPlayerHTML
// ─────────────────────────────────────────────────────────────────────────────

test('buildPlayerHTML - contains channel name in title', () => {
  const html = buildPlayerHTML('My Music Channel');
  assert.ok(html.includes('<title>My Music Channel</title>'));
});

test('buildPlayerHTML - contains HLS.js script tag', () => {
  const html = buildPlayerHTML('Mixer');
  assert.ok(html.includes('hls.js'));
});

test('buildPlayerHTML - contains stream.m3u8 source reference', () => {
  const html = buildPlayerHTML('Mixer');
  assert.ok(html.includes('/stream.m3u8'));
});

test('buildPlayerHTML - contains /now fetch call', () => {
  const html = buildPlayerHTML('Mixer');
  assert.ok(html.includes("fetch('/now')"));
});

test('buildPlayerHTML - escapes HTML special characters in channel name', () => {
  const html = buildPlayerHTML('Music & More <Best>');
  assert.ok(html.includes('Music &amp; More &lt;Best&gt;'));
  assert.ok(!html.includes('<Best>'));
});

test('buildPlayerHTML - contains video element', () => {
  const html = buildPlayerHTML('Mixer');
  assert.ok(html.includes('<video'));
});

test('buildPlayerHTML - is valid UTF-8 HTML with DOCTYPE', () => {
  const html = buildPlayerHTML('Mixer');
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<html lang="en">'));
});

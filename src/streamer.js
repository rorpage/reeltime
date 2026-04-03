'use strict';

/**
 * HLS Video Streamer — ffconcat FIFO edition
 *
 * Endpoints
 * ─────────────────────────────────────────────────
 *  GET /                Web player  (HLS.js + now-playing ticker)
 *  GET /stream.m3u8     Live HLS playlist
 *  GET /seg_*.ts        MPEG-TS segments
 *  GET /now             Now-playing JSON  (title · position · next)
 *  GET /xmltv           XMLTV guide  (?hours=N, default 4, max 24)
 *  GET /xmltv.xml       Alias for /xmltv
 *  GET /channels.m3u    M3U tuner file for Jellyfin / Plex
 *  GET /playlist.m3u    Alias for /channels.m3u
 *  GET /health          Health + loop state JSON
 */

const { spawn, execSync } = require('node:child_process');
const fs                  = require('node:fs');
const path                = require('node:path');
const http                = require('node:http');
const yaml                = require('js-yaml');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const CFG = {
  configPath:   process.env.CONFIG_PATH      || '/config/config.yaml',
  hlsDir:       process.env.HLS_DIR          || '/tmp/hls',
  fifoPath:     process.env.FIFO_PATH        || '/tmp/playlist.ffconcat',
  port:        +(process.env.PORT            || 8080),
  segDuration: +(process.env.HLS_SEG         || 6),
  listSize:    +(process.env.HLS_SIZE         || 10),
  resolution:    process.env.RESOLUTION      || '1280:720',
  videoBitrate:  process.env.VIDEO_BITRATE   || '2000k',
  audioBitrate:  process.env.AUDIO_BITRATE   || '128k',
  framerate:   +(process.env.FRAMERATE        || 30),
  threads:     +(process.env.FFMPEG_THREADS   || 0),
  foreverPasses: +(process.env.PASSES_PER_CYCLE || 3),
  // statePath is resolved after loadConfig() so it can incorporate channel_id.
  // STATE_PATH env var overrides the derived default.
  statePath:       process.env.STATE_PATH || null,
  stateMaxAgeSec: +(process.env.STATE_MAX_AGE_SEC || 86400),
  debug:           process.env.DEBUG === '1',
};

const [VW, VH] = CFG.resolution.split(':').map(Number);
const GOP      = CFG.framerate * CFG.segDuration;

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

const ts    = () => new Date().toISOString();
const info  = (...a) => console.log( `${ts()} INFO `, ...a);
const warn  = (...a) => console.warn( `${ts()} WARN `, ...a);
const error = (...a) => console.error(`${ts()} ERROR`, ...a);
const debug = (...a) => CFG.debug && console.log(`${ts()} DEBUG`, ...a);

// ─────────────────────────────────────────────────────────────────────────────
// Config loader
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CFG.configPath)) {
    error(`Config not found: ${CFG.configPath}`);
    error('Mount your playlist:  -v /path/to/config.yaml:/config/config.yaml:ro');
    process.exit(1);
  }

  let raw;
  try   { raw = yaml.load(fs.readFileSync(CFG.configPath, 'utf8')); }
  catch (e) { error(`YAML parse error: ${e.message}`); process.exit(1); }

  if (!Array.isArray(raw?.videos) || raw.videos.length === 0) {
    error('config.yaml must contain a non-empty "videos" list');
    process.exit(1);
  }

  const videos = raw.videos.map((v, i) => {
    const n = i + 1;
    if (!v.url)      { error(`Video ${n}: "url" is required`); process.exit(1); }
    if (!v.title)    warn(`Video ${n}: no "title" — using URL basename`);
    if (!v.duration) warn(`Video ${n}: no "duration" — defaulting to 3600 s`);
    return {
      title:       String(v.title       || path.basename(String(v.url))),
      url:         String(v.url),
      duration:    Number(v.duration)   > 0 ? Number(v.duration)   : 3600,
      // Optional XMLTV metadata
      seriesTitle: String(v.series_title || ''),
      subTitle:    String(v.sub_title    || ''),
      episodeNum:  String(v.episode_num  || ''),
      date:        String(v.date         || ''),
      description: String(v.description || v.title || path.basename(String(v.url))),
      category:    String(v.category    || 'Movie'),
      icon:        String(v.icon        || ''),
    };
  });

  const name = String(raw.stream?.name || 'HLS Stream');

  return {
    name,
    // channel_id is optional; default derives from stream name for XMLTV + M3U consistency.
    channelId:  String(raw.stream?.channel_id || toSnakeCase(name)),
    icon:       String(raw.stream?.icon || ''),
    loop:              raw.stream?.loop !== false,
    loopCount:  Number(raw.stream?.loop_count ?? -1),
    videos,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem helpers
// ─────────────────────────────────────────────────────────────────────────────

function setupDirs() {
  fs.mkdirSync(CFG.hlsDir, { recursive: true });
  const stale = fs.readdirSync(CFG.hlsDir)
    .filter(f => f.endsWith('.ts') || f.endsWith('.m3u8'));
  stale.forEach(f => { try { fs.unlinkSync(path.join(CFG.hlsDir, f)); } catch (_) {} });
  if (stale.length) info(`Cleaned ${stale.length} stale HLS file(s)`);
}

function createFifo() {
  try { fs.unlinkSync(CFG.fifoPath); } catch (_) {}
  execSync(`mkfifo "${CFG.fifoPath}"`);
  info(`Named FIFO created: ${CFG.fifoPath}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule  —  wall-clock aligned programme listings
//
// Every time a clip entry is written into the FIFO, addToSchedule() records
// its LOGICAL playback window (not the FIFO write time) so that:
//
//   • /now   can report accurate position / remaining / progress
//   • /xmltv can return precise start/stop times for any future window
//
// Design notes
// ─────────────────────────────────────────────────────────────────────────────
//
//   schedNextStart is updated to entry.endAt each time a clip is added, so
//   the logical clock advances by duration as entries are queued.
//
//   getScheduleWindow() merges already-written entries with extrapolated
//   future entries so the XMLTV guide can cover several hours ahead even
//   when only a bounded number of future entries are prefilled.
//
// Entry shape:
//   { title, url, duration, description, category,
//     startAt(ms), endAt(ms), videoIndex, pass }
// ─────────────────────────────────────────────────────────────────────────────

const schedule      = [];         // chronologically ordered entries
let   schedNextStart = null;      // epoch-ms when the next clip will start
const HISTORY_MS    = 2 * 3600 * 1000;  // keep 2 h of past entries

/**
 * Record one clip in the logical schedule.
 * Called once per clip, immediately before its FIFO entry is written.
 */
function addToSchedule(video, videoIndex, pass) {
  const startAt = schedNextStart ?? Date.now();  // first clip anchors to now
  const endAt   = startAt + video.duration * 1000;

  schedule.push({ ...video, startAt, endAt, videoIndex, pass });
  schedNextStart = endAt;

  // Prune history (always keep ≥ 1 entry so seed-based extrapolation works)
  const cutoff = Date.now() - HISTORY_MS;
  while (schedule.length > 1 && schedule[0].endAt < cutoff) schedule.shift();
}

/**
 * The clip that should be playing right now according to wall-clock time.
 * Falls back to the last known entry (stream may have ended or is starting).
 */
function getCurrentEntry() {
  const now = Date.now();
  return (
    schedule.find(e => e.startAt <= now && now < e.endAt) ??
    (schedule.length ? schedule[schedule.length - 1] : null)
  );
}

/**
 * Return a sorted array of schedule entries that overlap [fromMs, toMs].
 *
 * Combines:
 *   • already-written entries from schedule[] (known, accurate)
 *   • extrapolated entries beyond the last written entry (computed on demand)
 *
 * The extrapolation mirrors writeFifo()'s loop/termination logic exactly,
 * so it respects loop: false and finite loop_count values correctly.
 *
 * @param {number}   fromMs     window start  (epoch ms)
 * @param {number}   toMs       window end    (epoch ms)
 * @param {object[]} videos     full video list from config
 * @param {boolean}  loop
 * @param {number}   loopCount  -1 = infinite
 */
function getScheduleWindow(fromMs, toMs, videos, loop, loopCount) {
  const forever = loop && loopCount <= 0;

  // ── Known entries that overlap the window ──────────────────────────────────
  const known = schedule.filter(e => e.endAt > fromMs && e.startAt < toMs);

  // ── Extrapolate beyond the last written entry ──────────────────────────────
  const seed  = schedule.length ? schedule[schedule.length - 1] : null;
  const extra = [];

  if (seed) {
    let cursor   = seed.endAt;
    let vidIndex = seed.videoIndex;
    let pass     = seed.pass;

    while (cursor < toMs) {
      // Advance playlist pointer (wraps around and increments pass)
      vidIndex++;
      if (vidIndex >= videos.length) { vidIndex = 0; pass++; }

      // Termination — mirrors the outer-loop conditions in writeFifo()
      if (!loop && pass >= 1)                    break;
      if (loop && !forever && pass >= loopCount) break;

      const v     = videos[vidIndex];
      const endAt = cursor + v.duration * 1000;

      if (endAt > fromMs) {
        extra.push({ ...v, startAt: cursor, endAt, videoIndex: vidIndex, pass });
      }
      cursor = endAt;
    }
  }

  // Merge, deduplicate by startAt, sort ascending
  const knownStarts = new Set(known.map(e => e.startAt));
  return [...known, ...extra.filter(e => !knownStarts.has(e.startAt))]
    .sort((a, b) => a.startAt - b.startAt);
}

// ─────────────────────────────────────────────────────────────────────────────
// XMLTV  +  M3U  formatters
// ─────────────────────────────────────────────────────────────────────────────

const pad2 = n => String(n).padStart(2, '0');

/** Format a JS timestamp as an XMLTV date string: "YYYYMMDDHHmmss +0000" */
function toXMLTVDate(ms) {
  const d = new Date(ms);
  return (
    d.getUTCFullYear()         +
    pad2(d.getUTCMonth() + 1)  +
    pad2(d.getUTCDate())       +
    pad2(d.getUTCHours())      +
    pad2(d.getUTCMinutes())    +
    pad2(d.getUTCSeconds())    +
    ' +0000'
  );
}

/** Convert a label into a stable snake_case identifier. */
function toSnakeCase(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'reeltime';
}

/** XML-safe string escaping. */
function escXML(s) {
  return String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

function normalizeXMLTVValueDate(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length >= 8) return digits.slice(0, 8);
  if (digits.length === 4) return digits;
  return '';
}

/**
 * Build a complete XMLTV document.
 * Channel ID is provided by config loading and defaults to stream name in snake_case.
 *
 * Compatible with:  Jellyfin · Plex (via xTeve/Threadfin) · Emby · Kodi
 */
function buildXMLTV(entries, channelId, streamName, channelIcon = '') {
  const escapedName = escXML(streamName);
  const escapedChannelId = escXML(channelId);
  const channelIconTag = channelIcon ? `\n    <icon src="${escXML(channelIcon)}"/>` : '';

  const programmes = entries.map(e => {
    const title = escXML(e.seriesTitle || e.title);
    const subTitleTag = e.subTitle ? `\n    <sub-title lang="en">${escXML(e.subTitle)}</sub-title>` : '';
    const episodeNumTag = e.episodeNum ? `\n    <episode-num system="onscreen">${escXML(e.episodeNum)}</episode-num>` : '';
    const dateTag = normalizeXMLTVValueDate(e.date) ? `\n    <date>${normalizeXMLTVValueDate(e.date)}</date>` : '';
    const iconTag = e.icon ? `\n    <icon src="${escXML(e.icon)}"/>` : '';

    return `  <programme start="${toXMLTVDate(e.startAt)}" stop="${toXMLTVDate(e.endAt)}" channel="${escapedChannelId}">
    <title lang="en">${title}</title>${subTitleTag}${episodeNumTag}${dateTag}
    <desc lang="en">${escXML(e.description)}</desc>
    <length units="seconds">${e.duration}</length>
    <category lang="en">${escXML(e.category)}</category>${iconTag}
  </programme>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv source-info-name="${escapedName}" generator-info-name="reeltime">
  <channel id="${escapedChannelId}">
    <display-name lang="en">${escapedName}</display-name>${channelIconTag}
  </channel>
${programmes}
</tv>`;
}

/**
 * Build a single-channel M3U playlist.
 * Jellyfin → Live TV → Add Tuner → M3U Tuner → point here.
 * The x-tvg-url attribute links the guide data automatically.
 */
function buildM3U(host, channelId, streamName, channelIcon = '') {
  const logoAttr = channelIcon ? ` tvg-logo="${channelIcon.replace(/"/g, '&quot;')}"` : '';
  return [
    `#EXTM3U x-tvg-url="http://${host}/xmltv"`,
    `#EXTINF:-1 tvg-id="${channelId}" tvg-name="${streamName}"${logoAttr} tvg-chno="1" group-title="Reeltime",${streamName}`,
    `http://${host}/stream.m3u8`,
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Playlist state  (used by /health)
// ─────────────────────────────────────────────────────────────────────────────

const playState = {
  pass:        0,
  videoIndex:  0,
  videoTitle:  '(starting…)',
  totalQueued: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// State persistence  —  survive container restarts
//
// Every STATE_SAVE_INTERVAL_MS the current video index, pass, and playback
// position are written atomically to a JSON file so the stream can resume
// approximately where it left off after a restart.
//
// File location: STATE_PATH  (default: <config dir>/state.<channel_id>_reeltime.json)
// ─────────────────────────────────────────────────────────────────────────────

const STATE_SAVE_INTERVAL_MS = 5000;

let stateSaveInterval = null;

/**
 * Read and validate a previously saved state file.
 * Returns { videoIndex, pass, positionSec } if the state is usable,
 * or null if it is missing, corrupt, out-of-bounds, or too old.
 *
 * @param {object[]} videos  Full video list from config (used for bounds check)
 */
function loadState(videos) {
  try {
    if (!fs.existsSync(CFG.statePath)) return null;

    const raw = JSON.parse(fs.readFileSync(CFG.statePath, 'utf8'));
    const { videoIndex, pass, positionSec, savedAt } = raw;

    if (typeof videoIndex !== 'number' || videoIndex < 0 || videoIndex >= videos.length) {
      warn('State file has invalid videoIndex — starting from beginning');
      return null;
    }
    if (typeof pass !== 'number' || pass < 0) {
      warn('State file has invalid pass — starting from beginning');
      return null;
    }
    if (typeof positionSec !== 'number' || positionSec < 0) {
      warn('State file has invalid positionSec — starting from beginning');
      return null;
    }

    if (!savedAt || typeof savedAt !== 'string' || isNaN(new Date(savedAt).getTime())) {
      warn('State file has invalid savedAt — starting from beginning');
      return null;
    }

    const ageMs = Date.now() - new Date(savedAt).getTime();
    if (ageMs > CFG.stateMaxAgeSec * 1000) {
      info(`State file is too old (${Math.round(ageMs / 3600000)} h) — starting from beginning`);
      return null;
    }

    info(`Resuming from saved state: pass ${pass + 1}, video index ${videoIndex}, position ${positionSec.toFixed(1)}s`);
    return { videoIndex, pass, positionSec };
  } catch (e) {
    warn(`Could not load state file: ${e.message}`);
    return null;
  }
}

/**
 * Write the current playback position to STATE_PATH atomically.
 * Uses a .tmp file + rename to avoid partial writes on container crash.
 */
function saveState() {
  const entry = getCurrentEntry();
  if (!entry) return;

  const positionSec = Math.max(0, (Date.now() - entry.startAt) / 1000);
  const payload = JSON.stringify({
    videoIndex:  entry.videoIndex,
    pass:        entry.pass,
    positionSec: Math.round(positionSec * 10) / 10,
    savedAt:     new Date().toISOString(),
  });

  const tmp = CFG.statePath + '.tmp';
  try {
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, CFG.statePath);
    debug(`State saved: video ${entry.videoIndex}, pass ${entry.pass}, pos ${positionSec.toFixed(1)}s`);
  } catch (e) {
    warn(`Could not save state: ${e.message}`);
  }
}

/** Start the periodic state-save interval (idempotent). */
function startStateSaving() {
  if (stateSaveInterval) return;
  stateSaveInterval = setInterval(saveState, STATE_SAVE_INTERVAL_MS);
}

/** Stop the periodic state-save interval. */
function stopStateSaving() {
  if (stateSaveInterval) {
    clearInterval(stateSaveInterval);
    stateSaveInterval = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ffconcat FIFO writer
// ─────────────────────────────────────────────────────────────────────────────

function buildConcatEntry({ url, duration }, inpoint) {
  let entry = `file '${url.replace(/'/g, '%27')}'\n`;
  if (inpoint != null && inpoint > 0) entry += `inpoint ${inpoint}\n`;
  entry += `outpoint ${duration}\n\n`;
  return entry;
}

function writeFifo(videos, { loop, loopCount }, resumeFrom = null) {
  return new Promise((resolve, reject) => {
    const forever = loop && loopCount <= 0;
    const totalPasses = loop
      ? (forever ? Math.max(1, CFG.foreverPasses) : Math.max(0, loopCount))
      : 1;
    const abort   = new AbortController();
    let settled   = false;
    const settle  = fn => { if (!settled) { settled = true; fn(); } };

    info('Opening FIFO for writing (blocks until ffmpeg opens read end)…');
    const writer = fs.createWriteStream(CFG.fifoPath);

    writer.on('error', err => {
      abort.abort();
      if (err.code === 'EPIPE') {
        // ffmpeg closed its read end — expected on finite playlist end / SIGTERM
        info('FIFO: read end closed by ffmpeg (EPIPE) — writer done');
        settle(resolve);
      } else {
        settle(() => reject(err));
      }
    });

    writer.on('finish', () => { info('FIFO: all entries flushed'); settle(resolve); });
    writer.on('open',   () => { info('FIFO connected — beginning playlist'); runLoop().catch(e => settle(() => reject(e))); });

    // Write with backpressure: pause source if kernel FIFO buffer is full
    const writeEntry = data => new Promise(res => {
      const ok = writer.write(data);
      if (ok) res(); else writer.once('drain', res);
    });

    async function runLoop() {
      await writeEntry('ffconcat version 1.0\n\n');

      // ── Resume validation ────────────────────────────────────────────────────
      if (resumeFrom) {
        if (resumeFrom.pass >= totalPasses) {
          warn(`Saved pass ${resumeFrom.pass} exceeds cycle size ${totalPasses} — starting from beginning`);
          resumeFrom = null;
        } else {
          // Pre-set the logical clock so the first scheduled entry has a startAt
          // in the "past" matching the saved position, keeping /now accurate.
          schedNextStart = Date.now() - resumeFrom.positionSec * 1000;
          info(`Resuming: pass ${resumeFrom.pass + 1}, video ${resumeFrom.videoIndex}, pos ${resumeFrom.positionSec.toFixed(1)}s`);
        }
      }

      let resumeApplied = false;

      for (let pass = 0; pass < totalPasses; pass++) {
        if (abort.signal.aborted) break;

        // Skip entire passes that precede the resume point
        if (resumeFrom && pass < resumeFrom.pass) continue;

        const displayTotal = forever ? `∞ (prefill ${totalPasses})` : totalPasses;
        info(`── Pass ${pass + 1} / ${displayTotal} ${'─'.repeat(36)}`);

        outer: for (let i = 0; i < videos.length; i++) {
          if (abort.signal.aborted) break outer;

          // Skip individual videos before the resume index (resume pass only)
          if (resumeFrom && !resumeApplied && i < resumeFrom.videoIndex) continue;

          const video = videos[i];

          // ── Update state ──────────────────────────────────────────────────
          playState.pass        = pass;
          playState.videoIndex  = i;
          playState.videoTitle  = video.title;
          playState.totalQueued++;

          addToSchedule(video, i, pass);  // ← wall-clock schedule entry

          // For the very first entry when resuming, seek into the clip via inpoint.
          // positionSec must be positive and less than the clip duration to be useful.
          const inpoint = (resumeFrom && !resumeApplied && resumeFrom.positionSec > 0 && resumeFrom.positionSec < video.duration)
            ? resumeFrom.positionSec
            : undefined;
          // Mark applied unconditionally so the resume logic is only evaluated once,
          // even if inpoint was skipped (e.g. positionSec >= video.duration).
          resumeApplied = true;

          if (inpoint != null) {
            info(`  ↳  "${video.title}"  (resuming at ${inpoint.toFixed(1)}s, ${(video.duration - inpoint).toFixed(0)}s remaining)`);
          } else {
            info(`  ↳  "${video.title}"  (${video.duration} s)`);
          }

          await writeEntry(buildConcatEntry(video, inpoint));
          startStateSaving();  // no-op after first call
          if (abort.signal.aborted) break outer;
        }
      }

      if (!abort.signal.aborted) {
        info('All passes queued — closing FIFO write-end');
        writer.end();
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ffmpeg  —  single long-running process
// ─────────────────────────────────────────────────────────────────────────────

let ffmpegProc = null;

function startFFmpeg() {
  return new Promise((resolve, reject) => {
    const playlist = path.join(CFG.hlsDir, 'stream.m3u8');
    const segPat   = path.join(CFG.hlsDir, 'seg_%06d.ts');

    // Scale to fit target dimensions (letterbox / pillarbox with black bars),
    // then force H.264-compatible pixel format.
    const vf = [
      `scale=${VW}:${VH}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      `pad=${VW}:${VH}:(ow-iw)/2:(oh-ih)/2:black`,
      'format=yuv420p',
    ].join(',');

    const args = [
      '-y', '-hide_banner',
      '-loglevel', CFG.debug ? 'info' : 'warning',

      // Input: read ffconcat entries from named FIFO at native (1×) speed
      '-re',
      '-f',    'concat',
      '-safe',  '0',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,fd,pipe',
      '-i',    CFG.fifoPath,

      // Video encoding
      '-vf',           vf,
      '-r',            String(CFG.framerate),
      '-c:v',          'libx264',
      '-preset',       'veryfast',
      '-tune',         'zerolatency',
      '-profile:v',    'main',
      '-level:v',      '3.1',
      '-b:v',          CFG.videoBitrate,
      '-maxrate',      CFG.videoBitrate,
      '-bufsize',      '4000k',
      '-g',            String(GOP),        // keyframe every segment boundary
      '-keyint_min',   String(GOP),
      '-sc_threshold', '0',               // no scene-cut keyframes → clean CBR
      '-threads',      String(CFG.threads),

      // Audio encoding
      '-c:a', 'aac',
      '-b:a', CFG.audioBitrate,
      '-ar',  '44100',
      '-ac',  '2',

      // HLS muxer
      '-f',                    'hls',
      '-hls_time',             String(CFG.segDuration),
      '-hls_list_size',        String(CFG.listSize),
      '-hls_flags',            'delete_segments+independent_segments',
      '-hls_segment_type',     'mpegts',
      '-hls_segment_filename', segPat,
      playlist,
    ];

    info('Starting ffmpeg (ffconcat FIFO → HLS)…');
    debug(`ffmpeg ${args.join(' ')}`);

    ffmpegProc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    ffmpegProc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (!msg) return;
      if (CFG.debug) debug(`[ffmpeg] ${msg}`);
      else warn(`[ffmpeg] ${msg}`);
    });
    ffmpegProc.on('error', reject);
    ffmpegProc.on('close', code => { info(`ffmpeg exited (code ${code})`); resolve(code); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts':   'video/mp2t',
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control':                'no-cache, no-store',
};

function escHtml(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildPlayerHTML(name) {
  const n = escHtml(name);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${n}</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
    body {
      background: #0d0d0d; color: #f0f0f0; font-family: system-ui, sans-serif;
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; min-height: 100vh; gap: .75rem; padding: 1rem;
    }
    h1    { font-size: 1.1rem; font-weight: 500; opacity: .6 }
    video {
      width: 100%; max-width: 920px; border-radius: 6px;
      background: #000; box-shadow: 0 6px 40px rgba(0,0,0,.6);
    }
    #now  {
      font-size: .82rem; opacity: .55; min-height: 1.3em;
      text-align: center; letter-spacing: .01em;
    }
    #prog-wrap {
      width: 100%; max-width: 920px; height: 3px;
      background: #333; border-radius: 2px; overflow: hidden;
    }
    #prog-bar { height: 100%; background: #e50; width: 0%; transition: width .5s linear }
    small { font-size: .72rem; opacity: .28 }
    code  { background: #222; padding: 2px 6px; border-radius: 3px }
  </style>
</head>
<body>
  <h1>🎬 ${n}</h1>
  <video id="v" controls autoplay muted playsinline></video>
  <div id="prog-wrap"><div id="prog-bar"></div></div>
  <div id="now">Loading…</div>
  <small>Stream: <code>/stream.m3u8</code> &nbsp;·&nbsp; Guide: <code>/xmltv</code> &nbsp;·&nbsp; Tuner: <code>/channels.m3u</code></small>
  <script>
    (function () {
      // ── HLS player ──────────────────────────────────────────────────────────
      var v = document.getElementById('v'), src = '/stream.m3u8';
      if (Hls.isSupported()) {
        var hls = new Hls({
          liveSyncDurationCount:       3,
          liveMaxLatencyDurationCount: 6,
          enableWorker:                true,
        });
        hls.loadSource(src);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, function () { v.play().catch(function () {}); });
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = src;
        v.play().catch(function () {});
      } else {
        document.body.innerHTML += '<p style="color:red">HLS not supported in this browser.</p>';
      }

      // ── Now-playing ticker (polls /now every 5 s) ───────────────────────────
      var nowEl  = document.getElementById('now');
      var barEl  = document.getElementById('prog-bar');

      function fetchNow() {
        fetch('/now')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d.current) { nowEl.textContent = 'Stream starting…'; return; }
            var pct  = Math.round(d.current.progress * 100);
            var mins = Math.round(d.current.remaining / 60);
            var text = '▶  ' + d.current.title + '  ·  ' + pct + '%  (' + mins + ' min remaining)';
            if (d.next) text += '   ·   Up next: ' + d.next.title;
            nowEl.textContent = text;
            barEl.style.width = pct + '%';
          })
          .catch(function () { nowEl.textContent = ''; });
      }

      fetchNow();
      setInterval(fetchNow, 5000);
    }());
  </script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request router
// ─────────────────────────────────────────────────────────────────────────────

function startServer(cfg) {
  const { name, channelId, icon, videos, loop, loopCount } = cfg;

  const server = http.createServer((req, res) => {
    const questionMark = req.url.indexOf('?');
    const url          = questionMark === -1 ? req.url : req.url.slice(0, questionMark);
    const params       = new URLSearchParams(questionMark === -1 ? '' : req.url.slice(questionMark + 1));
    const host         = req.headers.host ?? `localhost:${CFG.port}`;

    // CORS preflight
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

    // ─────────────────────────────────────────────────────────────────────────
    // GET /health
    // ─────────────────────────────────────────────────────────────────────────
    if (url === '/health') {
      const forever = loop && loopCount <= 0;
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        loop: {
          enabled:      loop,
          count:        forever ? 'infinite' : loopCount,
          currentPass:  playState.pass + 1,
          currentVideo: playState.videoTitle,
          totalQueued:  playState.totalQueued,
        },
        endpoints: {
          player:   `http://${host}/`,
          stream:   `http://${host}/stream.m3u8`,
          now:      `http://${host}/now`,
          xmltv:    `http://${host}/xmltv`,
          channels: `http://${host}/channels.m3u`,
        },
      }));
      return;
    }

    // GET /now
    //
    // Returns JSON with the current video's name, playback position, and the
    // next video.
    //
    // {
    //   current: { title, duration, position, remaining, progress,
    //              startedAt, endsAt },
    //   next:    { title, duration, startsAt }  | null,
    //   stream:  "http://…/stream.m3u8"
    // }
    // ─────────────────────────────────────────────────────────────────────────
    if (url === '/now') {
      const now     = Date.now();
      const current = getCurrentEntry();

      if (!current) {
        res.writeHead(503, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'starting', message: 'Stream not yet started' }));
        return;
      }

      const position  = Math.max(0, (now - current.startAt) / 1000);
      const remaining = Math.max(0, (current.endAt - now)   / 1000);
      const progress  = parseFloat(Math.min(1, position / current.duration).toFixed(4));

      // Find next: prefer already-scheduled entry, otherwise extrapolate
      const idx  = schedule.indexOf(current);
      let   next = (idx >= 0 && idx < schedule.length - 1) ? schedule[idx + 1] : null;

      if (!next) {
        // Peek one entry beyond current.endAt
        const peek = getScheduleWindow(
          current.endAt,
          current.endAt + 1,   // just past the boundary — gets exactly 1 entry
          videos, loop, loopCount,
        );
        next = peek[0] ?? null;
      }

      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        current: {
          title:     current.title,
          duration:  current.duration,
          position:  Math.round(position  * 10) / 10,  // 1 decimal place (seconds)
          remaining: Math.round(remaining * 10) / 10,
          progress,                                     // 0.0000 → 1.0000
          startedAt: new Date(current.startAt).toISOString(),
          endsAt:    new Date(current.endAt).toISOString(),
        },
        next: next ? {
          title:    next.title,
          duration: next.duration,
          startsAt: new Date(next.startAt).toISOString(),
        } : null,
        stream: `http://${host}/stream.m3u8`,
      }));
      return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET /xmltv   (alias: /xmltv.xml)
    //
    // XMLTV guide data compatible with Jellyfin, Plex (xTeve/Threadfin),
    // Emby, Kodi, and any other XMLTV-aware application.
    //
    // Query params:
    //   ?hours=N   Hours of future guide data to include (1–24, default 4).
    //              Always prepends 1 hour of history so the current programme
    //              is always visible in the guide.
    //
    // Jellyfin setup:
    //   Dashboard → Live TV → Add TV Guide Data Provider → XMLTV
    //   URL: http://<host>:<port>/xmltv
    // ─────────────────────────────────────────────────────────────────────────
    if (url === '/xmltv' || url === '/xmltv.xml') {
      const hours   = Math.min(24, Math.max(1, +(params.get('hours') ?? 4)));
      const now     = Date.now();
      const fromMs  = now - 3600 * 1000;          // 1 h of history
      const toMs    = now + hours * 3600 * 1000;   // up to 24 h of future

      const entries = getScheduleWindow(fromMs, toMs, videos, loop, loopCount);
      const xml     = buildXMLTV(entries, channelId, name, icon);

      res.writeHead(200, { ...CORS, 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(xml);
      return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET /channels.m3u   (alias: /playlist.m3u)
    //
    // Single-channel M3U playlist for Jellyfin's "M3U Tuner" and similar.
    // The x-tvg-url attribute points to /xmltv so clients can auto-link
    // the guide without extra configuration.
    //
    // Jellyfin setup:
    //   Dashboard → Live TV → Add Tuner Device → M3U Tuner
    //   URL: http://<host>:<port>/channels.m3u
    // ─────────────────────────────────────────────────────────────────────────
    if (url === '/channels.m3u' || url === '/playlist.m3u') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/x-mpegurl; charset=utf-8' });
      res.end(buildM3U(host, channelId, name, icon));
      return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET /   (alias: /player)   —  embedded HLS.js web player
    // ─────────────────────────────────────────────────────────────────────────
    if (url === '/' || url === '/player') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildPlayerHTML(name));
      return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GET /stream.m3u8  and  GET /seg_*.ts  —  HLS files
    // ─────────────────────────────────────────────────────────────────────────
    const file = path.basename(url);
    const ext  = path.extname(file);

    if (!MIME_TYPES[ext]) { res.writeHead(403, CORS); res.end('Forbidden'); return; }

    const rs = fs.createReadStream(path.join(CFG.hlsDir, file));
    rs.on('open',  ()    => { res.writeHead(200, { ...CORS, 'Content-Type': MIME_TYPES[ext] }); rs.pipe(res); });
    rs.on('error', err => {
      if (res.headersSent) return;
      if (err.code === 'ENOENT' && ext === '.m3u8') {
        res.writeHead(503, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'starting',
          message: 'HLS playlist not generated yet; try again shortly',
        }));
        return;
      }
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, CORS);
      res.end(err.code === 'ENOENT' ? 'Not Found' : 'Internal Server Error');
    });
  });

  server.on('error', e => error(`HTTP: ${e.message}`));
  server.listen(CFG.port, '0.0.0.0', () => {
    info('─'.repeat(60));
    info('  Reeltime ready');
    info('─'.repeat(60));
    info(`  Player      : http://0.0.0.0:${CFG.port}/`);
    info(`  Stream      : http://0.0.0.0:${CFG.port}/stream.m3u8`);
    info(`  Now Playing : http://0.0.0.0:${CFG.port}/now`);
    info(`  XMLTV Guide : http://0.0.0.0:${CFG.port}/xmltv`);
    info(`  M3U Tuner   : http://0.0.0.0:${CFG.port}/channels.m3u`);
    info(`  Health      : http://0.0.0.0:${CFG.port}/health`);
    info('─'.repeat(60));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────

['SIGTERM', 'SIGINT'].forEach(sig =>
  process.on(sig, () => {
    info(`${sig} — shutting down`);
    saveState();
    stopStateSaving();
    if (ffmpegProc) ffmpegProc.kill('SIGTERM');
    process.exit(0);
  })
);

process.on('uncaughtException', err => {
  error(`Uncaught exception: ${err.message}`);
  error(err.stack || '');
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  setupDirs();
  createFifo();

  const config  = loadConfig();
  const { name, channelId, icon, videos, loop, loopCount } = config;
  const forever = loop && loopCount <= 0;

  // Resolve state file path now that channel_id is known.
  if (!CFG.statePath) {
    CFG.statePath = path.join(path.dirname(CFG.configPath), `state.${channelId}_reeltime.json`);
  }
  info(`State file: ${CFG.statePath}`);

  info(`Stream    : "${name}"  (channel: ${channelId})`);
  if (icon) info(`Icon      : ${icon}`);
  info(`Loop      : ${!loop ? 'play once' : forever ? `infinite (prefill=${CFG.foreverPasses} passes)` : `${loopCount}×`}`);
  info(`Videos    : ${videos.length}`);
  videos.forEach((v, i) =>
    info(`  ${String(i + 1).padStart(3)}. [${String(v.duration).padStart(6)} s]  ${v.title}`)
  );
  info(
    `Encode    : ${CFG.resolution}  v=${CFG.videoBitrate}  a=${CFG.audioBitrate}  ` +
    `${CFG.framerate} fps  threads=${CFG.threads || 'auto'}`
  );

  startServer(config);

  const autoRollover = forever;
  const ROLLOVER_DELAY_MS = 1000;
  const RETRY_DELAY_MS = 5000;
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  let cycle = 0;

  // Load saved state once; applied only to the first writeFifo call.
  let resumeState = loadState(videos);

  while (true) {
    cycle++;
    if (autoRollover) info(`Starting rollover cycle ${cycle}`);

    // Both promises start concurrently.
    // They unblock each other via the FIFO:
    //   ffmpeg opens the read end  →  Node.js write-end open() unblocks
    //   Node.js writes first entry →  ffmpeg starts decoding
    const [ffmpegCode] = await Promise.all([
      startFFmpeg(),
      writeFifo(videos, { loop, loopCount }, resumeState),
    ]);
    resumeState = null;  // resume only on the first cycle

    if (ffmpegCode !== 0 && autoRollover) {
      warn(`Rollover cycle ${cycle} failed (ffmpeg exit ${ffmpegCode}) — retrying in ${RETRY_DELAY_MS} ms`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    if (ffmpegCode !== 0) {
      info(`Stream complete — ffmpeg exit code: ${ffmpegCode}`);
      process.exit(1);
    }

    if (!autoRollover) {
      info('Stream complete — ffmpeg exit code: 0');
      process.exit(0);
    }

    info(`Rollover cycle ${cycle} complete — restarting in ${ROLLOVER_DELAY_MS} ms`);
    await sleep(ROLLOVER_DELAY_MS);
  }
})();

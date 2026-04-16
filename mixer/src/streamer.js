'use strict';

/**
 * Mixer - music channel HLS streamer
 *
 * Plays a directory of MP3 files as a continuous live HLS channel.
 * Uses a lavfi color source (or a static background image) as the video layer
 * so no browser or input video is needed.
 *
 * Endpoints
 * ─────────────────────────────────────────────────
 *  GET /               HLS.js web player with now-playing ticker
 *  GET /stream.m3u8    Live HLS playlist
 *  GET /seg_*.ts       MPEG-TS segments
 *  GET /now            JSON now-playing (current track, position, next track)
 *  GET /xmltv          XMLTV guide  (?hours=1-24, default 4)
 *  GET /xmltv.xml      Alias for /xmltv
 *  GET /channels.m3u   M3U tuner  (Jellyfin / Plex / Channels DVR)
 *  GET /playlist.m3u   Alias for /channels.m3u
 *  GET /health         JSON health check
 */

const { spawn, execFileSync } = require('node:child_process');
const fs                      = require('node:fs');
const path                    = require('node:path');
const http                    = require('node:http');
const { escHtml, escXML, buildAudioList } = require('../../shared/utils');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const CFG = {
  port:           +(process.env.PORT            || 8080),
  hlsDir:           process.env.HLS_DIR         || '/tmp/hls',
  musicDir:         process.env.MUSIC_DIR       || '/music',
  shuffleMusic:     process.env.SHUFFLE_MUSIC?.toLowerCase() === 'true',
  audioSource:      process.env.AUDIO_SOURCE?.toLowerCase() || 'mp3',
  audioUrl:         process.env.AUDIO_URL       || '',
  audioVolume:     +(process.env.AUDIO_VOLUME   || 1.0),
  channelId:        process.env.CHANNEL_ID      || 'mixer',
  channelName:      process.env.CHANNEL_NAME    || 'Mixer',
  channelNumber:    process.env.CHANNEL_NUMBER  || '1',
  channelIcon:      process.env.CHANNEL_ICON    || '',
  hlsSeg:          +(process.env.HLS_SEG        || 6),
  hlsSize:         +(process.env.HLS_SIZE       || 10),
  resolution:       process.env.RESOLUTION      || '1280:720',
  frameRate:       +(process.env.FRAME_RATE     || 1),
  videoBitrate:     process.env.VIDEO_BITRATE   || '200k',
  audioBitrate:     process.env.AUDIO_BITRATE   || '128k',
  bgColor:          process.env.BG_COLOR        || '0x000000',
  bgImage:          process.env.BG_IMAGE        || '',
};

const [VW, VH]  = CFG.resolution.split(':').map(Number);
const AUDIO_LIST = path.join(CFG.hlsDir, 'audio_list.txt');

// Default duration (seconds) used when ffprobe cannot read a file.
const DEFAULT_TRACK_DURATION = 180;

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

const ts    = () => new Date().toISOString();
const info  = (...a) => console.log( `${ts()} INFO `, ...a);
const warn  = (...a) => console.warn( `${ts()} WARN `, ...a);
const error = (...a) => console.error(`${ts()} ERROR`, ...a);

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let ffmpegProc = null;
let readyTimer = null;
let isReady    = false;
let tracks     = [];   // [{ path, title, duration }]
let startMs    = 0;    // epoch ms when the current ffmpeg session began

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a human-readable title from a file path.
 * Strips directory and extension, replaces hyphens/underscores with spaces,
 * and collapses whitespace. Returns an empty string when no usable stem remains.
 *
 * @param {string} filePath
 * @returns {string}
 */
function normalizeTitle(filePath) {
  const ext  = path.extname(filePath);
  const base = path.basename(filePath, ext);
  // Dotfiles (e.g. ".mp3") have an empty ext but a leading-dot base.
  // Strip the leading dot so they do not produce a title like ".mp3".
  const stem = base.startsWith('.') ? base.slice(1) : base;
  return stem
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Given the track list, the ms timestamp when playback started, and the
 * current ms timestamp, return the track that is currently playing along
 * with position/remaining/next metadata.
 *
 * Returns null when tracks is empty or total duration is zero.
 *
 * @param {Array<{path:string,title:string,duration:number}>} trackList
 * @param {number} playbackStartMs  Epoch ms when ffmpeg was started
 * @param {number} nowMs            Current epoch ms
 * @returns {{ track, nextTrack, position, remaining, startedAt, endsAt } | null}
 */
function findCurrentTrack(trackList, playbackStartMs, nowMs) {
  if (!trackList || trackList.length === 0) return null;

  const totalDur = trackList.reduce((s, t) => s + t.duration, 0);
  if (totalDur <= 0) return null;

  const elapsedSec  = Math.max(0, (nowMs - playbackStartMs) / 1000);
  const posInLoop   = elapsedSec % totalDur;
  const loopStartMs = playbackStartMs + (Math.floor(elapsedSec / totalDur) * totalDur * 1000);

  let acc = 0;
  for (let i = 0; i < trackList.length; i++) {
    const t = trackList[i];
    if (posInLoop < acc + t.duration) {
      const trackStartMs = loopStartMs + acc * 1000;
      const trackEndMs   = trackStartMs + t.duration * 1000;
      return {
        track:     t,
        nextTrack: trackList[(i + 1) % trackList.length],
        position:  posInLoop - acc,
        remaining: t.duration - (posInLoop - acc),
        startedAt: new Date(trackStartMs).toISOString(),
        endsAt:    new Date(trackEndMs).toISOString(),
      };
    }
    acc += t.duration;
  }

  return null;
}

/**
 * Build the /now response object.
 *
 * @param {Array}  trackList
 * @param {number} playbackStartMs
 * @param {number} nowMs
 * @param {string} host  request Host header (e.g. "localhost:8080")
 * @returns {object}
 */
function buildNowResponse(trackList, playbackStartMs, nowMs, host) {
  const result = findCurrentTrack(trackList, playbackStartMs, nowMs);

  if (!result) {
    return {
      current: null,
      next:    null,
      stream:  `http://${host}/stream.m3u8`,
    };
  }

  const { track, nextTrack, position, remaining, startedAt, endsAt } = result;
  const progress = track.duration > 0
    ? Math.round((position / track.duration) * 10000) / 10000
    : 0;

  return {
    current: {
      title:       track.title,
      seriesTitle: '',
      subTitle:    '',
      episodeNum:  '',
      description: track.title,
      duration:    track.duration,
      position:    Math.round(position  * 10) / 10,
      remaining:   Math.round(remaining * 10) / 10,
      progress,
      startedAt,
      endsAt,
    },
    next: nextTrack
      ? { title: nextTrack.title, duration: nextTrack.duration }
      : null,
    stream: `http://${host}/stream.m3u8`,
  };
}

/**
 * Build the XMLTV XML string for this channel.
 * Reports 1-hour "Live Music" blocks for simplicity and guide-app compatibility.
 *
 * @param {string} channelId
 * @param {string} channelName
 * @param {string} channelIcon
 * @param {string} host   request Host header
 * @param {number} hours  guide window (1-24)
 * @returns {string}
 */
function buildXMLTV(channelId, channelName, channelIcon, host, hours) {
  const h       = Math.min(24, Math.max(1, hours));
  const now     = new Date();
  const iconUrl = channelIcon || `http://${host}/`;
  const fmtDate = d => d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

  let xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv>\n` +
    `<channel id="${escXML(channelId)}">\n` +
    `  <display-name>${escXML(channelName)}</display-name>\n`;

  if (channelIcon) {
    xml += `  <icon src="${escXML(iconUrl)}" />\n`;
  }

  xml += `</channel>\n`;

  for (let i = 0; i < h; i++) {
    const start = new Date(now.getTime() + i * 3_600_000);
    const stop  = new Date(start.getTime() + 3_600_000);
    xml +=
      `<programme start="${fmtDate(start)}" stop="${fmtDate(stop)}" channel="${escXML(channelId)}">\n` +
      `  <title lang="en">Live Music</title>\n` +
      `  <desc lang="en">${escXML(channelName)}</desc>\n` +
      (channelIcon ? `  <icon src="${escXML(iconUrl)}" />\n` : '') +
      `  <category lang="en">Music</category>\n` +
      `</programme>\n`;
  }

  return xml + '</tv>\n';
}

/**
 * Build the M3U playlist for this channel.
 *
 * @param {string} channelId
 * @param {string} channelName
 * @param {string} channelNumber
 * @param {string} channelIcon
 * @param {string} host   request Host header
 * @returns {string}
 */
function buildM3U(channelId, channelName, channelNumber, channelIcon, host) {
  const iconAttr = channelIcon ? ` tvg-logo="${escHtml(channelIcon)}"` : '';
  return [
    '#EXTM3U',
    `#EXTINF:-1 tvg-id="${escHtml(channelId)}" tvg-name="${escHtml(channelName)}"` +
      ` tvg-channel-no="${escHtml(channelNumber)}"${iconAttr},${escHtml(channelName)}`,
    `http://${host}/stream.m3u8`,
    '',
  ].join('\n');
}

/**
 * Build the web player HTML page.
 *
 * @param {string} channelName
 * @returns {string}
 */
function buildPlayerHTML(channelName) {
  const n = escHtml(channelName);
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
  <h1>${n}</h1>
  <video id="v" controls autoplay muted playsinline></video>
  <div id="prog-wrap"><div id="prog-bar"></div></div>
  <div id="now">Loading...</div>
  <small>Stream: <code>/stream.m3u8</code> &nbsp;&middot;&nbsp; Guide: <code>/xmltv</code> &nbsp;&middot;&nbsp; Tuner: <code>/channels.m3u</code></small>
  <script>
    (function () {
      var v = document.getElementById('v'), src = '/stream.m3u8';
      if (Hls.isSupported()) {
        var hls = new Hls({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 6, enableWorker: true });
        hls.loadSource(src);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, function () { v.play().catch(function () {}); });
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = src; v.play().catch(function () {});
      } else {
        document.body.innerHTML += '<p style="color:red">HLS not supported in this browser.</p>';
      }

      var nowEl = document.getElementById('now');
      var barEl = document.getElementById('prog-bar');

      function fetchNow() {
        fetch('/now')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d.current) { nowEl.textContent = 'Stream starting...'; return; }
            var pct  = Math.round(d.current.progress * 100);
            var mins = Math.round(d.current.remaining / 60);
            var text = '\u25b6  ' + d.current.title + '  \u00b7  ' + mins + ' min remaining';
            if (d.next) text += '   \u00b7   Up next: ' + d.next.title;
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
// Track loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Probe a single file for its audio duration in seconds using ffprobe.
 * Returns DEFAULT_TRACK_DURATION when the probe fails or the result is invalid.
 *
 * @param {string} filePath
 * @returns {number}
 */
function probeTrackDuration(filePath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { encoding: 'utf8', timeout: 10_000 });
    const d = parseFloat(out.trim());
    return isFinite(d) && d > 0 ? d : DEFAULT_TRACK_DURATION;
  } catch {
    return DEFAULT_TRACK_DURATION;
  }
}

/**
 * Scan the music directory, build the ffconcat playlist, and return the
 * track list with probed durations.
 * Returns an empty array when no files are found.
 *
 * @returns {Array<{path:string,title:string,duration:number}>}
 */
function loadTracks() {
  let files = [];
  try {
    files = fs.readdirSync(CFG.musicDir)
      .filter(f => f.toLowerCase().endsWith('.mp3'))
      .map(f => path.join(CFG.musicDir, f))
      .sort();
  } catch {
    warn(`Cannot read music directory: ${CFG.musicDir}`);
    return [];
  }

  if (files.length === 0) return [];

  if (CFG.shuffleMusic) {
    for (let i = files.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [files[i], files[j]] = [files[j], files[i]];
    }
  }

  info(`Probing ${files.length} track(s)...`);
  const result = files.map(fp => {
    const duration = probeTrackDuration(fp);
    const title    = normalizeTitle(fp);
    return { path: fp, title, duration };
  });
  info(`Loaded ${result.length} track(s)`);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// FFmpeg
// ─────────────────────────────────────────────────────────────────────────────

function buildFfmpegArgs() {
  const gop  = CFG.frameRate * CFG.hlsSeg;
  const args = [];

  // Video source: static background image or lavfi color
  if (CFG.bgImage && fs.existsSync(CFG.bgImage)) {
    args.push('-loop', '1', '-framerate', String(CFG.frameRate), '-i', CFG.bgImage);
  } else {
    args.push(
      '-f', 'lavfi',
      '-i', `color=c=${CFG.bgColor}:size=${VW}x${VH}:rate=${CFG.frameRate}`,
    );
  }

  // Audio source
  const mode = CFG.audioSource;
  if (mode === 'mp3') {
    args.push('-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', AUDIO_LIST);
  } else if (mode === 'http') {
    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', CFG.audioUrl,
    );
  } else {
    // silent fallback
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
  }

  // Volume filter for http mode
  const hasVolume = mode === 'http' && CFG.audioVolume !== 1.0;
  if (hasVolume) {
    args.push(
      '-filter_complex', `[1:a]volume=${CFG.audioVolume}[a]`,
      '-map', '0:v',
      '-map', '[a]',
    );
  } else {
    args.push('-map', '0:v', '-map', '1:a');
  }

  args.push(
    // Video codec - ultrafast + stillimage tune minimizes CPU for a static background
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'stillimage',
    '-b:v', CFG.videoBitrate,
    '-g', String(gop),
    // Audio codec
    '-c:a', 'aac',
    '-b:a', CFG.audioBitrate,
    // HLS output
    '-f', 'hls',
    '-hls_time',              String(CFG.hlsSeg),
    '-hls_list_size',         String(CFG.hlsSize),
    '-hls_flags',             'delete_segments+append_list',
    '-hls_segment_filename',  path.join(CFG.hlsDir, 'seg_%05d.ts'),
    path.join(CFG.hlsDir, 'stream.m3u8'),
  );

  return args;
}

function startFfmpeg() {
  if (ffmpegProc) {
    try { ffmpegProc.kill('SIGKILL'); } catch {}
    ffmpegProc = null;
  }

  startMs = Date.now();
  info(`Starting ffmpeg (audio: ${CFG.audioSource}, tracks: ${tracks.length})`);

  ffmpegProc = spawn('ffmpeg', ['-nostdin', ...buildFfmpegArgs()], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  ffmpegProc.stderr.on('data', chunk => {
    const line = chunk.toString().trim();
    if (line) process.stderr.write(`${ts()} FFMPEG ${line}\n`);
  });

  ffmpegProc.on('error', err => error('ffmpeg spawn error:', err.message));
  ffmpegProc.on('exit', (code, sig) => {
    warn(`ffmpeg exited (code=${code}, signal=${sig}) - restarting in 3s`);
    ffmpegProc = null;
    isReady    = false;
    setTimeout(() => {
      if (!ffmpegProc) startFfmpeg();
    }, 3_000);
  });

  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = setTimeout(() => {
    readyTimer = null;
    isReady    = true;
    info('Stream ready');
  }, CFG.hlsSeg * 2_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Start / stop
// ─────────────────────────────────────────────────────────────────────────────

async function start() {
  fs.mkdirSync(CFG.hlsDir,   { recursive: true });
  fs.mkdirSync(CFG.musicDir, { recursive: true });

  // Clean stale HLS files from a previous run
  try {
    fs.readdirSync(CFG.hlsDir)
      .filter(f => f.endsWith('.ts') || f.endsWith('.m3u8') || f === 'audio_list.txt')
      .forEach(f => { try { fs.unlinkSync(path.join(CFG.hlsDir, f)); } catch {} });
  } catch {}

  const mode = CFG.audioSource;

  if (mode === 'mp3') {
    tracks = loadTracks();
    if (tracks.length === 0) {
      warn('No MP3 files found in music directory - falling back to silent audio');
      CFG.audioSource = 'silent';
    } else {
      // Build the ffconcat playlist that ffmpeg will read
      buildAudioList({
        musicDir: CFG.musicDir,
        shuffle:  CFG.shuffleMusic,
        listPath: AUDIO_LIST,
        info,
        warn,
      });
    }
  } else if (mode === 'http') {
    if (!CFG.audioUrl) {
      warn('AUDIO_SOURCE=http but AUDIO_URL is not set - falling back to silent');
      CFG.audioSource = 'silent';
    } else {
      info(`HTTP audio stream: ${CFG.audioUrl}`);
    }
  }

  startFfmpeg();
}

function stop() {
  info('Shutting down...');
  if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
  if (ffmpegProc) {
    ffmpegProc.removeAllListeners('exit');
    ffmpegProc.kill('SIGTERM');
    ffmpegProc = null;
  }
  isReady = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────────────────

function serveStaticFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

function serve(req, res) {
  const u        = new URL(req.url, 'http://localhost');
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  const host     = req.headers.host || `localhost:${CFG.port}`;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
    });
    res.end();
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (pathname === '/stream.m3u8') {
    serveStaticFile(res, path.join(CFG.hlsDir, 'stream.m3u8'), 'application/vnd.apple.mpegurl');
    return;
  }

  if (/^\/seg_\d+\.ts$/.test(pathname)) {
    serveStaticFile(res, path.join(CFG.hlsDir, path.basename(pathname)), 'video/MP2T');
    return;
  }

  if (pathname === '/channels.m3u' || pathname === '/playlist.m3u') {
    res.writeHead(200, { 'Content-Type': 'application/x-mpegURL' });
    res.end(buildM3U(CFG.channelId, CFG.channelName, CFG.channelNumber, CFG.channelIcon, host));
    return;
  }

  if (pathname === '/xmltv' || pathname === '/xmltv.xml') {
    const hours = parseInt(u.searchParams.get('hours') || '4', 10);
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(buildXMLTV(CFG.channelId, CFG.channelName, CFG.channelIcon, host, hours));
    return;
  }

  if (pathname === '/now') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildNowResponse(tracks, startMs, Date.now(), host)));
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:  'ok',
      uptime:  Math.floor(process.uptime()),
      ready:   isReady,
      tracks:  tracks.length,
      audio:   CFG.audioSource,
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

  if (pathname === '/' || pathname === '/player') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildPlayerHTML(CFG.channelName));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const server = http.createServer(serve);
  server.listen(CFG.port, () => {
    info(`mixer listening on port ${CFG.port}`);
    info(`Music directory: ${CFG.musicDir}`);
    start().catch(err => { error('Startup error:', err.message); process.exit(1); });
  });

  process.on('SIGTERM', () => { stop(); process.exit(0); });
  process.on('SIGINT',  () => { stop(); process.exit(0); });
} else {
  // Exports for unit tests
  module.exports = {
    normalizeTitle,
    findCurrentTrack,
    buildNowResponse,
    buildXMLTV,
    buildM3U,
    buildPlayerHTML,
  };
}

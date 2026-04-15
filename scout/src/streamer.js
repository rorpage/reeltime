'use strict';

/**
 * Scout — generic web-page HLS streamer
 *
 * Opens any URL in a headless Chromium browser, captures screenshots at a
 * configurable frame rate, and pipes them into ffmpeg as a live HLS stream.
 * Exposes the same endpoint set as Reeltime so clients can point at Scout
 * exactly as they would point at a Reeltime channel.
 *
 * Endpoints
 * ─────────────────────────────────────────────────
 *  GET /                Web player  (HLS.js + now-playing ticker)
 *  GET /stream.m3u8     Live HLS playlist
 *  GET /seg_*.ts        MPEG-TS segments
 *  GET /now             Now-playing JSON  (position · uptime · live)
 *  GET /xmltv           XMLTV guide  (?hours=1-24, default 4)
 *  GET /xmltv.xml       Alias for /xmltv
 *  GET /channels.m3u    M3U tuner  (Jellyfin / Plex / Channels DVR)
 *  GET /playlist.m3u    Alias for /channels.m3u
 *  GET /health          JSON health check
 */

const { spawn }   = require('node:child_process');
const fs          = require('node:fs');
const path        = require('node:path');
const http        = require('node:http');
const puppeteer   = require('puppeteer-core');
const { escHtml, escXML, shuffleArray, buildAudioList } = require('../../shared/utils');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const CFG = {
  port:            +(process.env.PORT              || 8080),
  hlsDir:            process.env.HLS_DIR           || '/tmp/hls',
  captureUrl:        process.env.CAPTURE_URL       || '',
  frameRate:        +(process.env.FRAME_RATE        || 1),
  videoBitrate:      process.env.VIDEO_BITRATE     || '1000k',
  audioBitrate:      process.env.AUDIO_BITRATE     || '128k',
  hlsSeg:           +(process.env.HLS_SEG           || 6),
  hlsSize:          +(process.env.HLS_SIZE          || 10),
  resolution:        process.env.RESOLUTION        || '1280:720',
  channelId:         process.env.CHANNEL_ID        || 'scout',
  channelName:       process.env.CHANNEL_NAME      || 'Scout',
  channelIcon:       process.env.CHANNEL_ICON      || '',
  channelNumber:     process.env.CHANNEL_NUMBER    || '1',
  waitUntil:         process.env.WAIT_UNTIL        || 'networkidle2',
  executablePath:    process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  audioSource:       process.env.AUDIO_SOURCE?.toLowerCase() || 'silent',
  audioUrl:          process.env.AUDIO_URL        || '',
  audioVolume:      +(process.env.AUDIO_VOLUME    || 1.0),
  musicDir:          process.env.MUSIC_DIR        || '/music',
  musicVolume:      +(process.env.MUSIC_VOLUME    || 0.5),
  shuffleMusic:      process.env.SHUFFLE_MUSIC?.toLowerCase() === 'true',
  debug:             process.env.DEBUG === '1',
};

// Optional viewport crop — if any crop dimension is provided, all four must be set.
// Defaults to full viewport (no crop).
const CROP_X      = process.env.CROP_X      != null ? +process.env.CROP_X      : null;
const CROP_Y      = process.env.CROP_Y      != null ? +process.env.CROP_Y      : null;
const CROP_WIDTH  = process.env.CROP_WIDTH  != null ? +process.env.CROP_WIDTH  : null;
const CROP_HEIGHT = process.env.CROP_HEIGHT != null ? +process.env.CROP_HEIGHT : null;
const HAS_CROP    = [CROP_X, CROP_Y, CROP_WIDTH, CROP_HEIGHT].every(v => v != null);

if (!CFG.captureUrl) {
  console.error(`${new Date().toISOString()} ERROR CAPTURE_URL is required`);
  process.exit(1);
}

const [VW, VH]  = CFG.resolution.split(':').map(Number);
const GOP        = CFG.frameRate * CFG.hlsSeg;
const AUDIO_LIST = path.join(CFG.hlsDir, 'audio_list.txt');

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

const ts    = () => new Date().toISOString();
const info  = (...a) => console.log( `${ts()} INFO `, ...a);
const warn  = (...a) => console.warn( `${ts()} WARN `, ...a);
const error = (...a) => console.error(`${ts()} ERROR`, ...a);
const debug = (...a) => CFG.debug && console.log(`${ts()} DEBUG`, ...a);

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let ffmpegProc   = null;
let browser      = null;
let page         = null;
let captureTimer = null;
let readyTimer   = null;
let isReady      = false;
let streamStart  = null;   // epoch-ms when ffmpeg first declared ready
let pageTitle    = '';     // <title> of the captured page; falls back to captureUrl

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const waitMs = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// XMLTV
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build XMLTV guide data with hourly programme slots.
 * Always prepends 1 hour of history so the current slot shows up in guides.
 */
function buildXMLTV(host, hours) {
  const h       = Math.min(24, Math.max(1, hours));
  const now     = Date.now();
  const fromMs  = now - 3_600_000;         // 1 h of history
  const toMs    = now + h * 3_600_000;

  const iconUrl  = CFG.channelIcon || '';
  const iconAttr = iconUrl ? `\n    <icon src="${escXML(iconUrl)}"/>` : '';

  // Round down to the nearest hour boundary
  const startHour = new Date(Math.floor(fromMs / 3_600_000) * 3_600_000);

  const toXMLTVDate = ms => {
    const d = new Date(ms);
    return d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  };

  let programmes = '';
  for (let t = startHour.getTime(); t < toMs; t += 3_600_000) {
    const stop = t + 3_600_000;
    programmes += `  <programme start="${toXMLTVDate(t)}" stop="${toXMLTVDate(stop)}" channel="${escXML(CFG.channelId)}">
    <title lang="en">${escXML(CFG.channelName)}</title>
    <desc lang="en">${escXML(pageTitle || CFG.captureUrl)}</desc>
  </programme>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv source-info-name="${escXML(CFG.channelName)}" generator-info-name="scout">
  <channel id="${escXML(CFG.channelId)}">
    <display-name lang="en">${escXML(CFG.channelName)}</display-name>${iconAttr}
  </channel>
${programmes}</tv>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// M3U
// ─────────────────────────────────────────────────────────────────────────────

function buildM3U(host) {
  const iconUrl  = CFG.channelIcon || '';
  const logoAttr = iconUrl ? ` tvg-logo="${escXML(iconUrl)}"` : '';
  return [
    `#EXTM3U x-tvg-url="http://${host}/xmltv"`,
    `#EXTINF:-1 tvg-id="${CFG.channelId}" tvg-name="${CFG.channelName}"${logoAttr}` +
      ` tvg-chno="${CFG.channelNumber}" group-title="Scout",${CFG.channelName}`,
    `http://${host}/stream.m3u8`,
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Web player HTML
// ─────────────────────────────────────────────────────────────────────────────

function buildPlayerHTML() {
  const n = escHtml(CFG.channelName);
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
  <h1>📺 ${n}</h1>
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
            var text = '▶  ' + d.current.title + '  ·  live  ·  ' + mins + ' min remaining';
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
// Browser (Puppeteer)
// ─────────────────────────────────────────────────────────────────────────────

async function initBrowser() {
  if (browser) await browser.close().catch(() => {});
  browser = null;
  page    = null;

  browser = await puppeteer.launch({
    headless: true,
    executablePath: CFG.executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--ignore-certificate-errors',
      `--window-size=${VW},${VH}`,
    ],
    defaultViewport: { width: VW, height: VH },
  });

  page = await browser.newPage();

  info(`Navigating to: ${CFG.captureUrl}`);
  await page.goto(CFG.captureUrl, {
    waitUntil: /** @type {any} */ (CFG.waitUntil),
    timeout: 30_000,
  });

  pageTitle = (await page.title()) || CFG.captureUrl;
  info(`Page title: ${pageTitle}`);
  info('Browser ready');
}

// ─────────────────────────────────────────────────────────────────────────────
// FFmpeg
// ─────────────────────────────────────────────────────────────────────────────

function buildFfmpegArgs() {
  const mode = CFG.audioSource;
  const args = [
    '-y', '-hide_banner',
    '-loglevel', CFG.debug ? 'info' : 'warning',

    // Video input: JPEG frames piped via stdin
    '-f', 'image2pipe',
    '-framerate', String(CFG.frameRate),
    '-i', 'pipe:0',
  ];

  // Audio input (index 1)
  if (mode === 'mp3') {
    args.push('-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', AUDIO_LIST);
  } else if (mode === 'http') {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', CFG.audioUrl);
  } else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
  }

  const hasAudio  = mode === 'mp3' || mode === 'http';
  const vol       = mode === 'mp3' ? CFG.musicVolume : CFG.audioVolume;
  const videoChain = [
    `scale=${VW}:${VH}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    `pad=${VW}:${VH}:(ow-iw)/2:(oh-ih)/2:black`,
    'format=yuv420p',
  ].join(',');
  const filterComplex = hasAudio
    ? `[0:v]${videoChain}[v];[1:a]volume=${vol}[a]`
    : `[0:v]${videoChain}[v]`;

  args.push(
    '-filter_complex', filterComplex,
    '-map', '[v]',
    '-map', hasAudio ? '[a]' : '1:a',

    // Video encoding
    '-c:v',          'libx264',
    '-preset',       'veryfast',
    '-tune',         'zerolatency',
    '-profile:v',    'main',
    '-level:v',      '3.1',
    '-b:v',          CFG.videoBitrate,
    '-maxrate',      CFG.videoBitrate,
    '-bufsize',      '2000k',
    '-g',            String(GOP),
    '-keyint_min',   String(GOP),
    '-sc_threshold', '0',
    '-r',            String(CFG.frameRate),

    // Audio encoding
    '-c:a', 'aac',
    '-b:a', CFG.audioBitrate,
    '-ar',  '44100',
    '-ac',  '2',

    // HLS output
    '-f',                    'hls',
    '-hls_time',             String(CFG.hlsSeg),
    '-hls_list_size',        String(CFG.hlsSize),
    '-hls_flags',            'delete_segments+independent_segments',
    '-hls_segment_type',     'mpegts',
    '-hls_segment_filename', path.join(CFG.hlsDir, 'seg_%06d.ts'),
    path.join(CFG.hlsDir, 'stream.m3u8'),
  );

  return args;
}

function startFfmpeg() {
  if (ffmpegProc) {
    try { ffmpegProc.stdin.destroy(); } catch {}
    ffmpegProc.kill('SIGKILL');
    ffmpegProc = null;
  }

  info('Starting ffmpeg (image2pipe → HLS)…');
  debug(`ffmpeg ${buildFfmpegArgs().join(' ')}`);

  ffmpegProc = spawn('ffmpeg', buildFfmpegArgs(), { stdio: ['pipe', 'ignore', 'pipe'] });

  ffmpegProc.stderr.on('data', chunk => {
    const line = chunk.toString().trim();
    if (!line) return;
    if (CFG.debug) debug(`[ffmpeg] ${line}`);
    else warn(`[ffmpeg] ${line}`);
  });

  ffmpegProc.on('error', err => error('ffmpeg spawn error:', err.message));
  ffmpegProc.on('exit', (code, sig) => {
    warn(`ffmpeg exited (code=${code}, signal=${sig})`);
    ffmpegProc = null;
    isReady    = false;
  });

  // Mark ready after (hlsSeg × 2) seconds — time for at least 2 segments to form
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = setTimeout(() => {
    readyTimer  = null;
    isReady     = true;
    streamStart = streamStart ?? Date.now();
    info('Stream ready');
  }, CFG.hlsSeg * 2_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture loop
// ─────────────────────────────────────────────────────────────────────────────

function startCapture() {
  if (captureTimer) clearInterval(captureTimer);
  const intervalMs = Math.round(1_000 / CFG.frameRate);

  captureTimer = setInterval(async () => {
    if (!ffmpegProc || !page) return;
    try {
      if (page.isClosed()) {
        await initBrowser().catch(e => warn('Browser restart failed:', e.message));
        return;
      }
      const opts = {
        type: /** @type {'jpeg'} */ ('jpeg'),
        quality: 85,
      };
      if (HAS_CROP) {
        opts.clip = { x: CROP_X, y: CROP_Y, width: CROP_WIDTH, height: CROP_HEIGHT };
      }
      const jpeg = await page.screenshot(opts);
      if (ffmpegProc?.stdin?.writable) ffmpegProc.stdin.write(jpeg);
    } catch (err) {
      warn('Capture error:', err.message);
      await initBrowser().catch(e => warn('Browser restart failed:', e.message));
    }
  }, intervalMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Start / stop
// ─────────────────────────────────────────────────────────────────────────────

async function start() {
  fs.mkdirSync(CFG.hlsDir,   { recursive: true });
  fs.mkdirSync(CFG.musicDir, { recursive: true });

  // Remove stale HLS files from a previous run
  const stale = fs.readdirSync(CFG.hlsDir).filter(f => f.endsWith('.ts') || f.endsWith('.m3u8'));
  stale.forEach(f => { try { fs.unlinkSync(path.join(CFG.hlsDir, f)); } catch {} });
  if (stale.length) info(`Cleaned ${stale.length} stale HLS file(s)`);

  if (CFG.audioSource === 'mp3') {
    if (!buildAudioList({ musicDir: CFG.musicDir, shuffle: CFG.shuffleMusic, listPath: AUDIO_LIST, info, warn })) {
      warn('No MP3 files found — falling back to silent audio');
      CFG.audioSource = 'silent';
    }
  } else if (CFG.audioSource === 'http') {
    if (!CFG.audioUrl) {
      warn('AUDIO_SOURCE=http but AUDIO_URL is not set — falling back to silent');
      CFG.audioSource = 'silent';
    } else {
      info(`HTTP audio stream: ${CFG.audioUrl}`);
    }
  }

  await initBrowser();
  startFfmpeg();
  startCapture();
}

async function stop() {
  info('Shutting down…');
  if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
  if (readyTimer)   { clearTimeout(readyTimer);    readyTimer   = null; }
  if (ffmpegProc) {
    try { ffmpegProc.stdin.destroy(); } catch {}
    await waitMs(500);
    if (ffmpegProc) { ffmpegProc.kill('SIGTERM'); ffmpegProc = null; }
  }
  if (browser) { await browser.close().catch(() => {}); browser = null; }
  isReady = false;
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

function startServer() {
  const server = http.createServer((req, res) => {
    const qIdx   = req.url.indexOf('?');
    const url    = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
    const params = new URLSearchParams(qIdx === -1 ? '' : req.url.slice(qIdx + 1));
    const host   = req.headers.host ?? `localhost:${CFG.port}`;

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

    // ── GET /health ────────────────────────────────────────────────────────────
    if (url === '/health') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status:    'ok',
        uptime:    Math.floor(process.uptime()),
        capture: {
          url:       CFG.captureUrl,
          frameRate: CFG.frameRate,
          ready:     isReady,
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

    // ── GET /now ───────────────────────────────────────────────────────────────
    if (url === '/now') {
      if (!isReady || !streamStart) {
        res.writeHead(503, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'starting', message: 'Stream not yet started' }));
        return;
      }
      const upcomingCount = Math.min(120, Math.max(0, +(params.get('upcoming') ?? 0)));
      const nowMs      = Date.now();
      // Snap to the current hour boundary so blocks are always clock-aligned
      const blockStart = Math.floor(nowMs / 3_600_000) * 3_600_000;
      const blockEnd   = blockStart + 3_600_000;
      const position   = (nowMs - blockStart) / 1000;
      const remaining  = (blockEnd - nowMs) / 1000;
      const progress   = Math.round((position / 3600) * 10000) / 10000;

      const makeBlock = () => ({
        title:       CFG.channelName,
        seriesTitle: '',
        subTitle:    '',
        episodeNum:  '',
        description: pageTitle || CFG.captureUrl,
        duration:    3600,
      });

      const upcoming = [];
      for (let i = 1; i <= upcomingCount; i++) {
        const start = blockEnd + (i - 1) * 3_600_000;
        upcoming.push({
          ...makeBlock(),
          startsAt: new Date(start).toISOString(),
          endsAt:   new Date(start + 3_600_000).toISOString(),
        });
      }

      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        current: {
          ...makeBlock(),
          position:  Math.round(position  * 10) / 10,
          remaining: Math.round(remaining * 10) / 10,
          progress,
          startedAt: new Date(blockStart).toISOString(),
          endsAt:    new Date(blockEnd).toISOString(),
        },
        next: {
          title:    CFG.channelName,
          duration: 3600,
          startsAt: new Date(blockEnd).toISOString(),
        },
        ...(upcomingCount > 0 && { upcoming }),
        stream: `http://${host}/stream.m3u8`,
      }));
      return;
    }

    // ── GET /xmltv  (alias: /xmltv.xml) ───────────────────────────────────────
    if (url === '/xmltv' || url === '/xmltv.xml') {
      const hours = Math.min(24, Math.max(1, +(params.get('hours') ?? 4)));
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(buildXMLTV(host, hours));
      return;
    }

    // ── GET /channels.m3u  (alias: /playlist.m3u) ─────────────────────────────
    if (url === '/channels.m3u' || url === '/playlist.m3u') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/x-mpegurl; charset=utf-8' });
      res.end(buildM3U(host));
      return;
    }

    // ── GET /  (alias: /player) — embedded HLS.js web player ──────────────────
    if (url === '/' || url === '/player') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildPlayerHTML());
      return;
    }

    // ── GET /stream.m3u8  and  GET /seg_*.ts — HLS files ──────────────────────
    const file = path.basename(url);
    const ext  = path.extname(file);

    if (!MIME_TYPES[ext]) { res.writeHead(403, CORS); res.end('Forbidden'); return; }

    const rs = fs.createReadStream(path.join(CFG.hlsDir, file));
    rs.on('open',  ()    => { res.writeHead(200, { ...CORS, 'Content-Type': MIME_TYPES[ext] }); rs.pipe(res); });
    rs.on('error', err => {
      if (res.headersSent) return;
      if (err.code === 'ENOENT' && ext === '.m3u8') {
        res.writeHead(503, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'starting', message: 'HLS playlist not generated yet; try again shortly' }));
        return;
      }
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, CORS);
      res.end(err.code === 'ENOENT' ? 'Not Found' : 'Internal Server Error');
    });
  });

  server.on('error', e => error(`HTTP: ${e.message}`));

  server.listen(CFG.port, '0.0.0.0', async () => {
    info('─'.repeat(60));
    info('  Scout ready');
    info('─'.repeat(60));
    info(`  Player      : http://0.0.0.0:${CFG.port}/`);
    info(`  Stream      : http://0.0.0.0:${CFG.port}/stream.m3u8`);
    info(`  Now Playing : http://0.0.0.0:${CFG.port}/now`);
    info(`  XMLTV Guide : http://0.0.0.0:${CFG.port}/xmltv`);
    info(`  M3U Tuner   : http://0.0.0.0:${CFG.port}/channels.m3u`);
    info(`  Health      : http://0.0.0.0:${CFG.port}/health`);
    info('─'.repeat(60));
    info(`  Capturing   : ${CFG.captureUrl}`);
    info(`  Frame rate  : ${CFG.frameRate} fps`);
    info('─'.repeat(60));
    await start();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

startServer();

process.on('SIGTERM', async () => { await stop(); process.exit(0); });
process.on('SIGINT',  async () => { await stop(); process.exit(0); });

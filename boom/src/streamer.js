'use strict';

/**
 * WS4Channels — WeatherStar 4000 HLS streamer
 *
 * Captures the WS4KP weather display via Puppeteer and streams as HLS,
 * compatible with Channels DVR, Jellyfin, Plex, Emby, and xTeVe/Threadfin.
 *
 * Endpoints
 * ─────────────────────────────────────────────────
 *  GET /               Web player  (HLS.js + now-playing ticker)
 *  GET /stream.m3u8    Live HLS playlist
 *  GET /seg_*.ts       MPEG-TS segments
 *  GET /channels.m3u   M3U tuner (Channels DVR / Jellyfin / Plex)
 *  GET /playlist.m3u   Alias for /channels.m3u
 *  GET /xmltv          XMLTV guide  (?hours=1-24, default 4)
 *  GET /xmltv.xml      Alias for /xmltv
 *  GET /guide.xml      Alias for /xmltv
 *  GET /logo/*         Logo image files
 *  GET /now            JSON now-playing  (?upcoming=N)
 *  GET /health         JSON health check
 */

const { spawn } = require('node:child_process');
const fs        = require('node:fs');
const path      = require('node:path');
const http      = require('node:http');
const puppeteer = require('puppeteer-core');
const { escHtml, escXML } = require('../../shared/utils');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const CFG = {
  port:           +(process.env.PORT            || 8080),
  hlsDir:           process.env.HLS_DIR         || '/tmp/hls',
  musicDir:         process.env.MUSIC_DIR       || '/music',
  logoDir:          process.env.LOGO_DIR        || '/logo',
  zipCode:          process.env.ZIP_CODE        || '90210',
  ws4kpHost:        process.env.WS4KP_HOST      || 'localhost',
  ws4kpPort:        process.env.WS4KP_PORT      || '8080',
  frameRate:       +(process.env.FRAME_RATE      || 10),
  videoBitrate:     process.env.VIDEO_BITRATE   || '1000k',
  audioBitrate:     process.env.AUDIO_BITRATE   || '128k',
  musicVolume:     +(process.env.MUSIC_VOLUME    || 0.5),
  shuffleMusic:     process.env.SHUFFLE_MUSIC?.toLowerCase() === 'true',
  hlsSeg:          +(process.env.HLS_SEG         || 2),
  hlsSize:         +(process.env.HLS_SIZE        || 5),
  resolution:       process.env.RESOLUTION      || '1280:720',
  channelId:        process.env.CHANNEL_ID      || 'weatherstar4000',
  channelName:      process.env.CHANNEL_NAME    || 'WeatherStar 4000',
  channelNumber:    process.env.CHANNEL_NUMBER  || '275',
  channelIcon:      process.env.CHANNEL_ICON    || '',
  executablePath:   process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
};

// Screenshot crop region — widescreen WS4KP (WSQS_settings_wide_checkbox=true)
// x=4, y=50 trims chrome UI; 840×470 is the 16:9 weather content area.
const CROP = {
  x:      +(process.env.CROP_X      || 4),
  y:      +(process.env.CROP_Y      || 50),
  width:  +(process.env.CROP_WIDTH  || 840),
  height: +(process.env.CROP_HEIGHT || 470),
};

const WS4KP_URL  = `http://${CFG.ws4kpHost}:${CFG.ws4kpPort}`;
const AUDIO_LIST = path.join(CFG.hlsDir, 'audio_list.txt');
const [VW, VH]   = CFG.resolution.split(':').map(Number);

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

let ffmpegProc   = null;
let browser      = null;
let page         = null;
let captureTimer = null;
let readyTimer   = null;
let isReady      = false;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const waitMs = ms => new Promise(r => setTimeout(r, ms));

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
// Audio list
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan CFG.musicDir for MP3 files and write an ffconcat playlist to AUDIO_LIST.
 * Returns true when at least one file was found, false for silent fallback.
 */
function buildAudioList() {
  let files = [];
  try {
    files = fs.readdirSync(CFG.musicDir)
      .filter(f => f.toLowerCase().endsWith('.mp3'));
  } catch {
    warn(`Cannot read music directory: ${CFG.musicDir}`);
  }

  if (files.length === 0) {
    info('No MP3 files found — audio will be silent');
    return false;
  }

  if (CFG.shuffleMusic) files = shuffleArray(files);
  const lines = files.map(f => `file '${path.join(CFG.musicDir, f)}'`).join('\n');
  fs.writeFileSync(AUDIO_LIST, lines + '\n');
  info(`Loaded ${files.length} music file(s)${CFG.shuffleMusic ? ' (shuffled)' : ''}`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// XMLTV
// ─────────────────────────────────────────────────────────────────────────────

function buildXMLTV(host, hours = 24) {
  const h       = Math.min(24, Math.max(1, hours));
  const now     = new Date();
  const baseUrl = `http://${host}`;
  const iconUrl = CFG.channelIcon || `${baseUrl}/logo/ws4000.png`;
  const fmtDate = d => d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

  let xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv>\n` +
    `<channel id="${escXML(CFG.channelId)}">\n` +
    `  <display-name>${escXML(CFG.channelName)}</display-name>\n` +
    `  <icon src="${escXML(iconUrl)}" />\n` +
    `</channel>\n`;

  for (let i = 0; i < h; i++) {
    const start = new Date(now.getTime() + i * 3_600_000);
    const stop  = new Date(start.getTime() + 3_600_000);
    xml +=
      `<programme start="${fmtDate(start)}" stop="${fmtDate(stop)}" channel="${escXML(CFG.channelId)}">\n` +
      `  <title lang="en">Local Weather</title>\n` +
      `  <desc lang="en">Enjoy your local weather with a touch of nostalgia.</desc>\n` +
      `  <icon src="${escXML(iconUrl)}" />\n` +
      `</programme>\n`;
  }

  return xml + '</tv>\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// M3U
// ─────────────────────────────────────────────────────────────────────────────

function buildM3U(host) {
  const baseUrl = `http://${host}`;
  const iconUrl = CFG.channelIcon || `${baseUrl}/logo/ws4000.png`;
  return [
    '#EXTM3U',
    `#EXTINF:-1 channel-id="${escXML(CFG.channelId)}" tvg-id="${escXML(CFG.channelId)}"` +
      ` tvg-channel-no="${escXML(CFG.channelNumber)}"` +
      ` tvg-logo="${escXML(iconUrl)}"` +
      ` tvc-guide-placeholders="3600"` +
      ` tvc-guide-title="Local Weather"` +
      ` tvc-guide-description="Enjoy your local weather with a touch of nostalgia."` +
      ` tvc-guide-art="${escXML(iconUrl)}",${escXML(CFG.channelName)}`,
    `${baseUrl}/stream.m3u8`,
    '',
  ].join('\n');
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
    defaultViewport: null,
  });

  page = await browser.newPage();
  await page.setViewport({ width: VW, height: VH });

  info(`Navigating to WS4KP: ${WS4KP_URL}`);
  await page.goto(WS4KP_URL, { waitUntil: 'networkidle2', timeout: 30_000 });

  // Enter ZIP code into the location search field
  try {
    const input = await page.waitForSelector(
      'input[placeholder="Zip or City, State"], input',
      { timeout: 5_000 },
    );
    if (input) {
      await input.type(CFG.zipCode, { delay: 100 });
      await waitMs(1_000);
      await page.keyboard.press('ArrowDown');
      await waitMs(500);
      const btn = await page.$('button[type="submit"]');
      if (btn) await btn.click();
      else   { await input.press('Enter'); await waitMs(500); }
      await page.waitForSelector('div.weather-display, #weather-content', { timeout: 30_000 });
    }
  } catch {
    warn('ZIP entry timed out — proceeding with default location');
  }

  info('Browser ready');
}

// ─────────────────────────────────────────────────────────────────────────────
// FFmpeg
// ─────────────────────────────────────────────────────────────────────────────

function buildFfmpegArgs(hasAudio) {
  const args = [
    // Video: JPEG frames piped into stdin
    '-f', 'image2pipe',
    '-framerate', String(CFG.frameRate),
    '-i', 'pipe:0',
  ];

  if (hasAudio) {
    // Audio: looping MP3 concat playlist
    args.push('-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', AUDIO_LIST);
  } else {
    // Audio: silent fallback
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
  }

  const filters = [`[0:v]scale=${VW}:${VH}[v]`];
  if (hasAudio) filters.push(`[1:a]volume=${CFG.musicVolume}[a]`);

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    '-map', hasAudio ? '[a]' : '1:a',
    // Video codec
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-b:v', CFG.videoBitrate,
    '-g', String(CFG.frameRate * CFG.hlsSeg),
    // Audio codec
    '-c:a', 'aac',
    '-b:a', CFG.audioBitrate,
    // HLS output
    '-f', 'hls',
    '-hls_time', String(CFG.hlsSeg),
    '-hls_list_size', String(CFG.hlsSize),
    '-hls_flags', 'delete_segments+append_list',
    '-hls_segment_filename', path.join(CFG.hlsDir, 'seg_%05d.ts'),
    path.join(CFG.hlsDir, 'stream.m3u8'),
  );

  return args;
}

function startFfmpeg(hasAudio) {
  if (ffmpegProc) {
    try { ffmpegProc.stdin.destroy(); } catch {}
    ffmpegProc.kill('SIGKILL');
    ffmpegProc = null;
  }

  info('Starting ffmpeg');
  ffmpegProc = spawn('ffmpeg', buildFfmpegArgs(hasAudio), {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  ffmpegProc.stderr.on('data', chunk => {
    const line = chunk.toString().trim();
    if (line) process.stderr.write(`${ts()} FFMPEG ${line}\n`);
  });

  ffmpegProc.on('error', err => error('ffmpeg spawn error:', err.message));
  ffmpegProc.on('exit', (code, sig) => {
    warn(`ffmpeg exited (code=${code}, signal=${sig})`);
    ffmpegProc = null;
    isReady    = false;
  });

  // Allow time for at least two HLS segments to be written before marking ready
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = setTimeout(() => { readyTimer = null; isReady = true; info('Stream ready'); }, CFG.hlsSeg * 2_000);
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
      if (page.isClosed()) { await initBrowser().catch(e => warn('Browser restart failed:', e.message)); return; }
      const jpeg = await page.screenshot({
        type: 'jpeg',
        quality: 80,
        clip: { x: CROP.x, y: CROP.y, width: CROP.width, height: CROP.height },
      });
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
  fs.mkdirSync(CFG.logoDir,  { recursive: true });

  const hasAudio = buildAudioList();
  await initBrowser();
  startFfmpeg(hasAudio);
  startCapture();
}

async function stop() {
  info('Shutting down…');
  if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
  if (readyTimer)   { clearTimeout(readyTimer);    readyTimer   = null; }
  if (ffmpegProc) {
    // Destroying stdin signals EOF to ffmpeg; follow with SIGTERM for clean HLS flush
    try { ffmpegProc.stdin.destroy(); } catch {}
    await waitMs(500);
    if (ffmpegProc) ffmpegProc.kill('SIGTERM');
    ffmpegProc = null;
  }
  if (browser) { await browser.close().catch(() => {}); browser = null; }
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
  const u        = new URL(req.url, `http://localhost`);
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

  if (/^\/logo\/[^/]+$/.test(pathname)) {
    serveStaticFile(res, path.join(CFG.logoDir, path.basename(pathname)), 'image/png');
    return;
  }

  if (pathname === '/channels.m3u' || pathname === '/playlist.m3u') {
    res.writeHead(200, { 'Content-Type': 'application/x-mpegURL' });
    res.end(buildM3U(host));
    return;
  }

  if (pathname === '/xmltv' || pathname === '/xmltv.xml' || pathname === '/guide.xml') {
    const hours = parseInt(u.searchParams.get('hours') || '4', 10);
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(buildXMLTV(host, hours));
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:  'ok',
      uptime:  Math.floor(process.uptime()),
      capture: {
        ws4kp:  WS4KP_URL,
        ready:  isReady,
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

  if (pathname === '/now') {
    const upcomingCount = Math.min(120, Math.max(0, +(u.searchParams.get('upcoming') ?? 0)));
    const nowMs         = Date.now();
    // Snap to the current hour boundary so blocks are always clock-aligned
    const blockStart    = Math.floor(nowMs / 3_600_000) * 3_600_000;
    const blockEnd      = blockStart + 3_600_000;
    const position      = (nowMs - blockStart) / 1000;
    const remaining     = (blockEnd - nowMs) / 1000;
    const progress      = Math.round((position / 3600) * 10000) / 10000;

    const makeBlock = (startMs) => ({
      title:       'Live Weather',
      seriesTitle: '',
      subTitle:    '',
      episodeNum:  '',
      description: CFG.channelName,
      duration:    3600,
    });

    const upcoming = [];
    for (let i = 1; i <= upcomingCount; i++) {
      const start = blockEnd + (i - 1) * 3_600_000;
      upcoming.push({
        ...makeBlock(start),
        startsAt: new Date(start).toISOString(),
        endsAt:   new Date(start + 3_600_000).toISOString(),
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      current: {
        ...makeBlock(blockStart),
        position:  Math.round(position  * 10) / 10,
        remaining: Math.round(remaining * 10) / 10,
        progress,
        startedAt: new Date(blockStart).toISOString(),
        endsAt:    new Date(blockEnd).toISOString(),
      },
      next: {
        title:    makeBlock(blockEnd).title,
        duration: 3600,
        startsAt: new Date(blockEnd).toISOString(),
      },
      ...(upcomingCount > 0 && { upcoming }),
      stream: `http://${host}/stream.m3u8`,
    }));
    return;
  }

  if (pathname === '/' || pathname === '/player') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildPlayerHTML());
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(serve);

server.listen(CFG.port, async () => {
  info(`boom listening on port ${CFG.port}`);
  info(`WS4KP: ${WS4KP_URL}  ZIP: ${CFG.zipCode}`);
  await start();
});

process.on('SIGTERM', async () => { await stop(); process.exit(0); });
process.on('SIGINT',  async () => { await stop(); process.exit(0); });

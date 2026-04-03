'use strict';

/**
 * Reeltime Director — guide + player aggregator
 *
 * Endpoints
 * ─────────────────────────────────────────────────
 *  GET /                 Dark neon guide UI (all channels)
 *  GET /watch/:id        Embedded HLS.js player for one channel
 *  GET /now              Aggregated now-playing JSON
 *  GET /xmltv            Combined XMLTV from all channels
 *  GET /xmltv.xml        Alias for /xmltv
 *  GET /channels.m3u     Aggregated M3U playlist
 *  GET /playlist.m3u     Alias for /channels.m3u
 *  GET /health           Health JSON
 *  OPTIONS *             CORS preflight
 */

const http  = require('node:http');
const https = require('node:https');
const fs    = require('node:fs');
const path  = require('node:path');
const url   = require('node:url');
const yaml  = require('js-yaml');
const { toSnakeCase: _toSnakeCase, escHtml, escXML } = require('../../actor/src/utils');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS   = 10_000;
const NEON_COLORS        = ['#00d4ff', '#39ff14', '#ff2d78'];
const DEFAULT_PORT       = 10000;
const DEFAULT_CFG_PATH   = '/config/director.config.yaml';
const INDEX_HTML         = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

const ts    = () => new Date().toISOString();
const info  = (...a) => console.log( `${ts()} INFO `, ...a);
const warn  = (...a) => console.warn( `${ts()} WARN `, ...a);
const error = (...a) => console.error(`${ts()} ERROR`, ...a);

// ─────────────────────────────────────────────────────────────────────────────
// Pure utility functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a string to snake_case, falling back to 'director' when empty.
 * Delegates to the shared implementation in actor/src/utils.js.
 */
const toSnakeCase = str => _toSnakeCase(str, 'director');

/** Derive a stable channel id from a channel config object. */
function deriveChannelId(ch) {
  if (ch.id && String(ch.id).trim() !== '') return String(ch.id);
  return toSnakeCase(ch.name);
}

/**
 * Read one reeltime config file and return a Director channel descriptor.
 *
 * @param {string}      absPath      Absolute path to the reeltime config.yaml
 * @param {number}      index        Zero-based position in the configs array
 *                                   (used to assign the default host port 10001+i)
 * @param {string|null} urlOverride  Optional URL override (skips auto-derivation)
 * @returns {{ id, name, icon, url, port, configPath }}
 */
function readChannelConfig(absPath, index, urlOverride) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`Reeltime config not found: ${absPath}`);
  }

  const raw  = yaml.load(fs.readFileSync(absPath, 'utf8'));
  const name = String(raw?.stream?.name || `Channel ${index + 1}`);
  const id   = raw?.stream?.channel_id
    ? String(raw.stream.channel_id)
    : toSnakeCase(name);
  const icon = String(raw?.stream?.icon || '');
  const url  = urlOverride
    ? String(urlOverride).replace(/\/$/, '')
    : `http://reeltime-${id}:8080`;
  const port = 10001 + index;

  return { id, name, icon, url, port, configPath: absPath };
}

/**
 * Load and validate the director YAML config.
 *
 * Config format:
 *   director:
 *     name: "Reeltime Director"   # optional
 *   configs:
 *     - ./channel1.config.yaml    # path relative to this file (or absolute)
 *     - path: ./channel2.config.yaml
 *       url:  http://custom-host:9000   # optional URL override
 *
 * @param {string} filePath  Path to the director config YAML
 * @returns {{ directorName: string, port: number, channels: Array }}
 */
function loadConfig(filePath) {
  const raw = yaml.load(fs.readFileSync(filePath, 'utf8'));

  if (!Array.isArray(raw?.configs) || raw.configs.length === 0) {
    throw new Error('"configs" must be a non-empty array of reeltime config file paths');
  }

  const directorName = String(raw.director?.name || 'Reeltime Director');
  const port         = Number(raw.director?.port  || DEFAULT_PORT);
  const configDir    = path.dirname(path.resolve(filePath));

  const channels = raw.configs.map((entry, i) => {
    const cfgPath    = typeof entry === 'string' ? entry : String(entry.path);
    const urlOverride = typeof entry === 'object' && entry.url ? String(entry.url) : null;
    const absPath    = path.isAbsolute(cfgPath) ? cfgPath : path.resolve(configDir, cfgPath);
    return readChannelConfig(absPath, i, urlOverride);
  });

  return { directorName, port, channels };
}

/**
 * Generate a docker-compose YAML string for the full Director stack.
 *
 * The generated file:
 *  - runs the Director container on its configured port
 *  - runs one `reeltime-{id}` container per channel, each on port 10001+i
 *  - mounts every config file into the Director container at /config/{basename}
 *  - mounts each channel config into its own reeltime container at /config/config.yaml
 *
 * Relative volume paths are computed from the director config file's directory
 * so the output is correct when written next to the director config.
 *
 * @param {string} directorConfigPath  Path to director.config.yaml
 * @returns {string}  Complete docker-compose YAML
 */
function generateCompose(directorConfigPath) {
  const cfg    = loadConfig(directorConfigPath);
  const cfgDir = path.dirname(path.resolve(directorConfigPath));

  /** Make a path relative to cfgDir, prefixed with ./ */
  function rel(absPath) {
    const r = path.relative(cfgDir, absPath);
    return r.startsWith('..') ? absPath : `./${r}`;
  }

  const dirCfgRel  = rel(path.resolve(directorConfigPath));
  const dirCfgBase = path.basename(directorConfigPath);

  const lines = [
    '# This file is generated from director.config.yaml by running:',
    '#   node director/src/director.js generate > docker-compose.director.yml',
    `# Director : http://localhost:${cfg.port}`,
  ];

  cfg.channels.forEach(ch => {
    lines.push(`# ${ch.name.padEnd(16)} (reeltime-${ch.id}): http://localhost:${ch.port}`);
  });

  // ── director service ──────────────────────────────────────────────────────
  lines.push(
    '',
    'services:',
    '',
    '  director:',
    '    build:',
    '      context: .',
    '      dockerfile: director/Dockerfile',
    '    container_name: reeltime-director',
    '    restart: unless-stopped',
    '    ports:',
    `      - "${cfg.port}:10000"`,
    '    volumes:',
    `      - ${dirCfgRel}:/config/${dirCfgBase}:ro`,
  );

  cfg.channels.forEach(ch => {
    const chRel  = rel(ch.configPath);
    const chBase = path.basename(ch.configPath);
    lines.push(`      - ${chRel}:/config/${chBase}:ro`);
  });

  lines.push(
    '    environment:',
    `      PORT:            "${cfg.port}"`,
    `      DIRECTOR_CONFIG: "/config/${dirCfgBase}"`,
    '    depends_on:',
  );
  cfg.channels.forEach(ch => lines.push(`      - reeltime-${ch.id}`));

  lines.push(
    '    healthcheck:',
    `      test:         ["CMD", "wget", "-qO", "/dev/null", "http://localhost:${cfg.port}/health"]`,
    '      interval:     30s',
    '      timeout:      10s',
    '      start_period: 30s',
    '      retries:      3',
  );

  // ── reeltime services ─────────────────────────────────────────────────────
  cfg.channels.forEach(ch => {
    const chRel = rel(ch.configPath);
    lines.push(
      '',
      `  reeltime-${ch.id}:`,
      '    build:',
      '      context: ./actor',
      `    container_name: reeltime-${ch.id}`,
      '    restart: unless-stopped',
      '    ports:',
      `      - "${ch.port}:8080"`,
      '    volumes:',
      `      - ${chRel}:/config/config.yaml:ro`,
      '    environment:',
      '      PORT:             "8080"',
      '      HLS_SEG:          "${HLS_SEG:-6}"',
      '      HLS_SIZE:         "${HLS_SIZE:-10}"',
      '      RESOLUTION:       "${RESOLUTION:-1280:720}"',
      '      VIDEO_BITRATE:    "${VIDEO_BITRATE:-2000k}"',
      '      AUDIO_BITRATE:    "${AUDIO_BITRATE:-128k}"',
      '      FRAMERATE:        "${FRAMERATE:-30}"',
      '      FFMPEG_THREADS:   "${FFMPEG_THREADS:-0}"',
      '      PASSES_PER_CYCLE: "${PASSES_PER_CYCLE:-3}"',
      '    healthcheck:',
      '      test:         ["CMD", "wget", "-qO", "/dev/null", "http://localhost:8080/health"]',
      '      interval:     30s',
      '      timeout:      10s',
      '      start_period: 90s',
      '      retries:      3',
    );
  });

  return lines.join('\n') + '\n';
}

/**
 * Build an aggregated M3U playlist for all channels.
 * @param {Array}  channels
 * @param {string} host  — request Host header value
 * @returns {string}
 */
function buildAggregatedM3U(channels, host) {
  const lines = [`#EXTM3U x-tvg-url="http://${host}/xmltv"`];
  for (const ch of channels) {
    lines.push(
      `#EXTINF:-1 tvg-id="${escHtml(ch.id)}" tvg-name="${escHtml(ch.name)}",${escHtml(ch.name)}`,
      `${ch.url}/stream.m3u8`,
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Build the aggregated /now response object.
 * @param {string} directorName
 * @param {Array}  channels
 * @param {Map}    channelCache
 * @returns {{ name: string, channels: Array }}
 */
function buildAggregatedNow(directorName, channels, channelCache) {
  return {
    name: directorName,
    channels: channels.map(ch => {
      const cached = channelCache.get(ch.id) || {};
      return {
        id:     ch.id,
        name:   ch.name,
        url:    ch.url,
        now:    cached.now    ?? null,
        online: cached.online ?? false,
      };
    }),
  };
}

/**
 * Build the /health response object.
 * @param {Array} channels
 * @param {Map}   channelCache
 * @returns {object}
 */
function buildHealthResponse(channels, channelCache) {
  return {
    status:  'ok',
    uptime:  process.uptime(),
    channels: channels.map(ch => {
      const cached = channelCache.get(ch.id) || {};
      return {
        id:     ch.id,
        name:   ch.name,
        url:    ch.url,
        online: cached.online ?? false,
      };
    }),
  };
}

/**
 * Build the player page HTML for a single channel.
 * @param {{ id: string, name: string, url: string }} channel
 * @param {string} neonColor
 * @returns {string}
 */
function buildPlayerHTML(channel, neonColor) {
  const streamUrl = `${channel.url}/stream.m3u8`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(channel.name)} — Reeltime Director</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #080a0f;
      color: #dde4f0;
      font-family: 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    a { color: inherit; text-decoration: none; }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      gap: 20px;
      padding: 14px 24px;
      background: #0f1117;
      border-bottom: 1px solid #1c2033;
    }
    .back-link {
      font-size: 0.9rem;
      color: #8892a4;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: color 0.15s;
    }
    .back-link:hover { color: #dde4f0; }
    .channel-name {
      font-size: 1.2rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      color: ${neonColor};
      text-shadow: 0 0 8px ${neonColor}88;
    }

    /* Player */
    .player-wrap {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 24px;
      gap: 16px;
    }
    video {
      width: 100%;
      max-width: 960px;
      border-radius: 6px;
      background: #000;
      border: 1px solid #1c2033;
    }

    /* Now-playing */
    .now-playing {
      width: 100%;
      max-width: 960px;
      background: #0f1117;
      border: 1px solid #1c2033;
      border-radius: 6px;
      padding: 14px 18px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .now-title {
      font-size: 1rem;
      font-weight: 600;
      color: #dde4f0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .now-meta { font-size: 0.8rem; color: #8892a4; }
    .progress-wrap {
      height: 4px;
      background: #1c2033;
      border-radius: 2px;
      overflow: hidden;
    }
    .progress-bar {
      height: 100%;
      background: ${neonColor};
      border-radius: 2px;
      transition: width 0.4s;
    }
    .now-next { font-size: 0.82rem; color: #5a6278; }
    .now-next .label { color: #3a4258; }

    /* Footer */
    .footer {
      border-top: 1px solid #1c2033;
      padding: 12px 24px;
      font-size: 0.78rem;
      color: #3a4258;
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }
    .footer a { color: #5a6278; }
    .footer a:hover { color: #dde4f0; }
  </style>
</head>
<body>
  <header class="header">
    <a href="/" class="back-link">&#8592; Guide</a>
    <div class="channel-name">${escHtml(channel.name)}</div>
  </header>

  <main class="player-wrap">
    <video id="video" controls autoplay muted></video>

    <div class="now-playing">
      <div class="now-title" id="now-title">Loading&hellip;</div>
      <div class="progress-wrap">
        <div class="progress-bar" id="progress-bar" style="width:0%"></div>
      </div>
      <div class="now-meta" id="now-meta"></div>
      <div class="now-next" id="now-next"></div>
    </div>
  </main>

  <footer class="footer">
    <span>Stream: <a href="${escHtml(streamUrl)}">${escHtml(streamUrl)}</a></span>
    <a href="/">&#8592; Back to guide</a>
  </footer>

  <script>
    (function () {
      const video     = document.getElementById('video');
      const streamUrl = ${JSON.stringify(streamUrl)};
      const channelId = ${JSON.stringify(channel.id)};

      if (Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = streamUrl;
        video.addEventListener('loadedmetadata', () => video.play().catch(() => {}));
      }

      function updateNow() {
        fetch('/now')
          .then(r => r.json())
          .then(data => {
            const ch = (data.channels || []).find(c => c.id === channelId);
            if (!ch || !ch.now) return;
            const now = ch.now;
            document.getElementById('now-title').textContent = now.title || '—';
            const pct = now.progress != null ? Math.round(now.progress * 100) : 0;
            document.getElementById('progress-bar').style.width = pct + '%';
            const rem = now.remaining != null ? Math.ceil(now.remaining / 60) : 0;
            document.getElementById('now-meta').textContent = pct + '% \u2014 ' + rem + ' min remaining';
            const nextTitle = (now.next || '—');
            document.getElementById('now-next').innerHTML =
              '<span class="label">Next:</span> ' +
              nextTitle.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          })
          .catch(() => {});
      }

      updateNow();
      setInterval(updateNow, 5000);
    })();
  </script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP fetch helper (node:http / node:https, no external deps)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a URL and parse the response body as JSON.
 * @param {string} rawUrl
 * @returns {Promise<any>}
 */
function fetchJson(rawUrl) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(rawUrl);
    const adapter = parsed.protocol === 'https:' ? https : http;

    const req = adapter.get(rawUrl, { timeout: 5000 }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${rawUrl}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try   { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error for ${rawUrl}: ${e.message}`)); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${rawUrl}`)); });
    req.on('error', reject);
  });
}

/**
 * Fetch a URL and return the raw response body as a string.
 * @param {string} rawUrl
 * @returns {Promise<{ body: string, contentType: string }>}
 */
function fetchText(rawUrl) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(rawUrl);
    const adapter = parsed.protocol === 'https:' ? https : http;

    const req = adapter.get(rawUrl, { timeout: 8000 }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${rawUrl}`));
      }
      let body = '';
      const contentType = res.headers['content-type'] || '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ body, contentType }));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${rawUrl}`)); });
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel poller
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll /now and /health for each channel; update the cache.
 * @param {Array} channels
 * @param {Map}   channelCache
 */
async function pollChannels(channels, channelCache) {
  await Promise.allSettled(
    channels.map(async ch => {
      try {
        const [nowData, healthData] = await Promise.all([
          fetchJson(`${ch.url}/now`),
          fetchJson(`${ch.url}/health`),
        ]);
        channelCache.set(ch.id, {
          online: true,
          now:    nowData,
          health: healthData,
          lastOk: Date.now(),
        });
      } catch (e) {
        const prev = channelCache.get(ch.id) || {};
        channelCache.set(ch.id, { ...prev, online: false });
      }
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CORS helper
// ─────────────────────────────────────────────────────────────────────────────

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─────────────────────────────────────────────────────────────────────────────
// Request router
// ─────────────────────────────────────────────────────────────────────────────

function createRequestHandler(directorName, channels, channelCache) {
  return async function handleRequest(req, res) {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const parsed   = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const host     = req.headers.host || `localhost:${DEFAULT_PORT}`;

    // GET /
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(INDEX_HTML);
    }

    // GET /watch/:channelId
    const watchMatch = pathname.match(/^\/watch\/([^/]+)$/);
    if (req.method === 'GET' && watchMatch) {
      const channelId = decodeURIComponent(watchMatch[1]);
      const ch        = channels.find(c => c.id === channelId);
      if (!ch) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Channel not found');
      }
      const neon = NEON_COLORS[channels.indexOf(ch) % NEON_COLORS.length];
      const html = buildPlayerHTML(ch, neon);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // GET /now
    if (req.method === 'GET' && pathname === '/now') {
      const body = JSON.stringify(buildAggregatedNow(directorName, channels, channelCache));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(body);
    }

    // GET /health
    if (req.method === 'GET' && pathname === '/health') {
      const body = JSON.stringify(buildHealthResponse(channels, channelCache));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(body);
    }

    // GET /xmltv  /xmltv.xml
    if (req.method === 'GET' && (pathname === '/xmltv' || pathname === '/xmltv.xml')) {
      try {
        const results = await Promise.allSettled(
          channels.map(ch => fetchText(`${ch.url}/xmltv`)),
        );
        const merged = mergeXmltvDocuments(channels, results);
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        return res.end(merged);
      } catch (e) {
        error('XMLTV proxy error:', e.message);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        return res.end('XMLTV proxy error');
      }
    }

    // GET /channels.m3u  /playlist.m3u
    if (req.method === 'GET' && (pathname === '/channels.m3u' || pathname === '/playlist.m3u')) {
      const m3u = buildAggregatedM3U(channels, host);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(m3u);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// XMLTV merger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge XMLTV documents from multiple channels into one combined document.
 * Extracts <channel> and <programme> elements from each document and wraps
 * them in a single <tv> root.
 */
function mergeXmltvDocuments(channels, settledResults) {
  const channelBlocks   = [];
  const programmeBlocks = [];

  settledResults.forEach((result, i) => {
    if (result.status !== 'fulfilled') return;
    const { body } = result.value;
    const ch = channels[i];
    if (!body) return;

    // Extract <channel ...>...</channel> blocks (tempered greedy to avoid ReDoS)
    const chMatches = body.match(/<channel(?:(?!<\/channel>)[\s\S])*<\/channel>/g) || [];
    channelBlocks.push(...chMatches);

    // Extract <programme ...>...</programme> blocks (tempered greedy to avoid ReDoS)
    const progMatches = body.match(/<programme(?:(?!<\/programme>)[\s\S])*<\/programme>/g) || [];
    programmeBlocks.push(...progMatches);

    // If no channel block found, synthesise a minimal one
    if (chMatches.length === 0) {
      channelBlocks.push(
        `<channel id="${escXML(ch.id)}"><display-name>${escXML(ch.name)}</display-name></channel>`,
      );
    }
  });

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
    '<tv generator-info-name="reeltime-director">',
    ...channelBlocks,
    ...programmeBlocks,
    '</tv>',
  ];

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const cfgPath = process.env.DIRECTOR_CONFIG || DEFAULT_CFG_PATH;

  let cfg;
  try {
    cfg = loadConfig(cfgPath);
  } catch (e) {
    error(`Failed to load config (${cfgPath}): ${e.message}`);
    process.exit(1);
  }

  const port         = Number(process.env.PORT) || cfg.port || DEFAULT_PORT;
  const directorName = cfg.directorName;
  const channels     = cfg.channels;
  const channelCache = new Map();

  info(`Starting ${directorName} — ${channels.length} channel(s) on port ${port}`);

  // Initial poll then recurring interval
  pollChannels(channels, channelCache).catch(e => warn('Initial poll error:', e.message));
  setInterval(() => {
    pollChannels(channels, channelCache).catch(e => warn('Poll error:', e.message));
  }, POLL_INTERVAL_MS);

  const server = http.createServer(createRequestHandler(directorName, channels, channelCache));

  server.listen(port, () => {
    info(`Listening on http://0.0.0.0:${port}`);
  });

  process.on('SIGTERM', () => { server.close(); process.exit(0); });
  process.on('SIGINT',  () => { server.close(); process.exit(0); });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports (for testing) — only when not the entry-point
// ─────────────────────────────────────────────────────────────────────────────

if (require.main !== module) {
  module.exports = {
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
    fetchJson,
    pollChannels,
    mergeXmltvDocuments,
  };
} else if (process.argv[2] === 'generate') {
  // ── CLI: generate docker-compose ──────────────────────────────────────────
  // Usage: node src/director.js generate [path/to/director.config.yaml]
  const cfgPath = process.argv[3] || process.env.DIRECTOR_CONFIG || DEFAULT_CFG_PATH;
  try {
    process.stdout.write(generateCompose(cfgPath));
  } catch (e) {
    error(`generate failed: ${e.message}`);
    process.exit(1);
  }
} else {
  main();
}

'use strict';

/**
 * Reeltime Director - guide + player aggregator
 *
 * Endpoints
 * ─────────────────────────────────────────────────
 *  GET /                 Dark neon guide UI (all channels)
 *  GET /watch/:id        Embedded HLS.js player for one channel
 *  GET /channels         Channel list JSON (for usher / API consumers)
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
const { toSnakeCase: _toSnakeCase, escHtml, escXML } = require('../../shared/utils');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS   = 10_000;
const NEON_COLORS        = ['#00d4ff', '#39ff14', '#ff2d78'];
const DEFAULT_PORT       = 10000;
// Default internal container port per channel type
const INTERNAL_PORT      = { reel: 8080, scout: 8080, boom: 8080, mixer: 8080 };
const DEFAULT_CFG_PATH   = '/config/director.config.yaml';
const INDEX_HTML         = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const FAVICON_SVG        = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\uD83D\uDCFA</text></svg>";

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
 * Delegates to the shared implementation in shared/utils.js.
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
function readChannelConfig(absPath, index, urlOverride, volumes) {
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

  const description = String(raw?.stream?.description || '');

  return { id, name, icon, description, url, port, channelNum: index + 1, type: 'reel', environment: {}, volumes: volumes || [], configPath: absPath };
}

/**
 * Build a channel descriptor from an inline director.config.yaml entry.
 * Used for scout/boom channels that have no config file of their own.
 *
 * Inline entry shape:
 *   - name:        "WeatherStar 4000"
 *     type:        boom          # required: boom | scout | mixer
 *     id:          weather       # optional; derived from name if omitted
 *     icon:        "https://..."
 *     description: "..."
 *     url:         "http://..."  # optional URL override
 *     environment:               # passed verbatim to the container
 *       ZIP_CODE: "10001"
 *
 * @param {object} entry   Raw YAML entry object
 * @param {number} index   Zero-based position (used for port assignment)
 * @returns channel descriptor
 */
function parseInlineChannel(entry, index) {
  const type        = String(entry.type || 'reel').toLowerCase();
  const name        = String(entry.name || `Channel ${index + 1}`);
  const id          = entry.id ? String(entry.id) : toSnakeCase(name);
  const icon        = String(entry.icon        || '');
  const description = String(entry.description || '');

  // External channels point directly at an existing stream URL - no container needed.
  if (type === 'external') {
    if (!entry.url) {
      throw new Error(`External channel "${name}" requires a "url" field`);
    }
    const resolvedUrl = String(entry.url).replace(/\/$/, '');
    return { id, name, icon, description, url: resolvedUrl, port: null, channelNum: index + 1, type, isExternal: true, environment: {}, volumes: [], configPath: null };
  }

  const environment = (entry.environment && typeof entry.environment === 'object')
    ? entry.environment : {};
  const volumes = (Array.isArray(entry.volumes)) ? entry.volumes.map(String) : [];
  const internalPort = INTERNAL_PORT[type] ?? 8080;
  const resolvedUrl  = entry.url
    ? String(entry.url).replace(/\/$/, '')
    : `http://reeltime-${id}:${internalPort}`;
  const port = 10001 + index;

  return { id, name, icon, description, url: resolvedUrl, port, channelNum: index + 1, type, environment, volumes, configPath: null };
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
    // Inline spec (scout / boom): object with a `type` field and no `path`
    if (typeof entry === 'object' && entry !== null && entry.type && !entry.path) {
      return parseInlineChannel(entry, i);
    }
    // File-based (reel): bare string path  OR  { path, url, volumes }
    const cfgPath     = typeof entry === 'string' ? entry : String(entry.path);
    const urlOverride = typeof entry === 'object' && entry.url ? String(entry.url) : null;
    const volumes     = (typeof entry === 'object' && Array.isArray(entry.volumes)) ? entry.volumes.map(String) : [];
    const absPath     = path.isAbsolute(cfgPath) ? cfgPath : path.resolve(configDir, cfgPath);
    return readChannelConfig(absPath, i, urlOverride, volumes);
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
function generateCompose(directorConfigPath, useImages = false) {
  const cfg    = loadConfig(directorConfigPath);
  const cfgDir = path.dirname(path.resolve(directorConfigPath));

  /** Make a path relative to cfgDir, prefixed with ./ (always forward slashes) */
  function rel(absPath) {
    const r = path.relative(cfgDir, absPath).replace(/\\/g, '/');
    return r.startsWith('..') ? absPath : `./${r}`;
  }

  /**
   * Emit volume lines for a channel's extra volumes array.
   * Absolute host paths pass through unchanged; relative paths are resolved from cfgDir.
   */
  function pushVolumes(volumes) {
    volumes.forEach(vol => {
      const colonIdx = vol.indexOf(':');
      const hostRaw  = colonIdx === -1 ? vol : vol.slice(0, colonIdx);
      const rest     = colonIdx === -1 ? '' : vol.slice(colonIdx);
      const outHost  = path.isAbsolute(hostRaw)
        ? hostRaw
        : rel(path.resolve(cfgDir, hostRaw));
      lines.push(`      - ${outHost}${rest}`);
    });
  }

  const dirCfgRel  = rel(path.resolve(directorConfigPath));
  const dirCfgBase = path.basename(directorConfigPath);

  const generateCmd = useImages
    ? 'node director/src/director.js mark director.config.yaml'
    : 'node director/src/director.js mark director.config.yaml --build';

  const lines = [
    '# This file is generated from director.config.yaml by running:',
    `#   ${generateCmd}`,
    `# Director : http://localhost:${cfg.port}`,
  ];

  cfg.channels.forEach(ch => {
    if (ch.isExternal) {
      lines.push(`# ${ch.name.padEnd(16)} (external): ${ch.url}  [external - not managed by this compose]`);
    } else {
      lines.push(`# ${ch.name.padEnd(16)} (reeltime-${ch.id}): http://localhost:${ch.port}  [${ch.type}]`);
    }
  });

  // ── director service ──────────────────────────────────────────────────────
  lines.push(
    '',
    'services:',
    '',
    '  director:',
  );

  if (useImages) {
    lines.push('    image: ghcr.io/rorpage/reeltime-director:latest');
  } else {
    lines.push(
      '    build:',
      '      context: .',
      '      dockerfile: director/Dockerfile',
    );
  }

  lines.push(
    '    container_name: reeltime-director',
    '    restart: unless-stopped',
    '    ports:',
    `      - "${cfg.port}:${DEFAULT_PORT}"`,
    '    volumes:',
    `      - ${dirCfgRel}:/config/${dirCfgBase}:ro`,
  );

  cfg.channels.filter(ch => ch.configPath).forEach(ch => {
    const chRel = rel(ch.configPath);
    // Preserve subdirectory structure so the path inside /config matches what
    // director.config.yaml references when resolved from /config/.
    const relFromCfgDir = path.relative(cfgDir, path.resolve(ch.configPath));
    const containerSubPath = relFromCfgDir.startsWith('..')
      ? path.basename(ch.configPath)          // outside cfgDir - fall back to basename
      : relFromCfgDir.replace(/\\/g, '/');
    lines.push(`      - ${chRel}:/config/${containerSubPath}:ro`);
  });

  lines.push(
    '    environment:',
    `      PORT:            "${DEFAULT_PORT}"`,
    `      DIRECTOR_CONFIG: "/config/${dirCfgBase}"`,
  );
  const managedChannels = cfg.channels.filter(ch => !ch.isExternal);
  if (managedChannels.length > 0) {
    lines.push('    depends_on:');
    managedChannels.forEach(ch => lines.push(`      - reeltime-${ch.id}`));
  }

  lines.push(
    '    healthcheck:',
    `      test:         ["CMD", "wget", "-qO", "/dev/null", "http://localhost:${DEFAULT_PORT}/health"]`,
    '      interval:     30s',
    '      timeout:      10s',
    '      start_period: 30s',
    '      retries:      3',
  );

  // ── channel services ──────────────────────────────────────────────────────
  cfg.channels.forEach(ch => {
    // External channels are not managed by this compose file - no service block emitted.
    if (ch.isExternal) return;

    const internalPort = INTERNAL_PORT[ch.type] ?? 8080;
    lines.push('', `  reeltime-${ch.id}:`);

    if (ch.type === 'reel') {
      // ── reel ──────────────────────────────────────────────────────────────
      const chFile   = path.resolve(ch.configPath);
      const chDirRel = rel(path.dirname(chFile));
      const chBase   = path.basename(chFile);

      if (useImages) {
        lines.push('    image: ghcr.io/rorpage/reeltime:latest');
      } else {
        lines.push('    build:', '      context: .', '      dockerfile: reel/Dockerfile');
      }

      lines.push(
        `    container_name: reeltime-${ch.id}`,
        '    restart: unless-stopped',
        '    ports:',
        `      - "${ch.port}:${internalPort}"`,
        '    volumes:',
        `      - ${chDirRel}:/config`,
      );

      // Extra user-specified volumes
      if (ch.volumes && ch.volumes.length > 0) pushVolumes(ch.volumes);

      lines.push(
        '    environment:',
        `      PORT:             "${internalPort}"`,
        `      CONFIG_PATH:      "/config/${chBase}"`,
        '      # 604800 s = 7 days; prevents stale state from being applied after a long downtime',
        '      STATE_MAX_AGE_SEC: "${STATE_MAX_AGE_SEC:-604800}"',
        '      HLS_SEG:          "${HLS_SEG:-6}"',
        '      HLS_SIZE:         "${HLS_SIZE:-10}"',
        '      RESOLUTION:       "${RESOLUTION:-1280:720}"',
        '      VIDEO_BITRATE:    "${VIDEO_BITRATE:-2000k}"',
        '      AUDIO_BITRATE:    "${AUDIO_BITRATE:-128k}"',
        '      FRAMERATE:        "${FRAMERATE:-30}"',
        '      FFMPEG_THREADS:   "${FFMPEG_THREADS:-0}"',
        '      PASSES_PER_CYCLE: "${PASSES_PER_CYCLE:-3}"',
      );

    } else {
      // ── scout / boom ──────────────────────────────────────────────────────
      if (useImages) {
        lines.push(`    image: ghcr.io/rorpage/reeltime-${ch.type}:latest`);
      } else {
        lines.push('    build:', '      context: .', `      dockerfile: ${ch.type}/Dockerfile`);
      }

      lines.push(
        `    container_name: reeltime-${ch.id}`,
        '    restart: unless-stopped',
        '    ports:',
        `      - "${ch.port}:${internalPort}"`,
      );

      if (ch.volumes && ch.volumes.length > 0) {
        lines.push('    volumes:');
        pushVolumes(ch.volumes);
      }

      lines.push(
        '    environment:',
        `      PORT:           "${internalPort}"`,
        `      CHANNEL_ID:     "${ch.id}"`,
        `      CHANNEL_NAME:   "${ch.name}"`,
        `      CHANNEL_NUMBER: "${ch.channelNum}"`,
      );

      // User-supplied env vars from the inline spec
      Object.entries(ch.environment).forEach(([k, v]) => {
        lines.push(`      ${k}: "${v}"`);
      });
    }

    lines.push(
      '    healthcheck:',
      `      test:         ["CMD", "wget", "-qO", "/dev/null", "http://localhost:${internalPort}/health"]`,
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
 * @param {string} host  - request Host header value (e.g. "192.168.1.5:9999")
 * @returns {string}
 */
function channelStreamUrl(ch, hostname) {
  if (ch.isExternal) return ch.url;
  return hostname
    ? `http://${hostname}:${ch.port}/stream.m3u8`
    : `${ch.url}/stream.m3u8`;
}

function buildAggregatedM3U(channels, host) {
  const hostname = host.split(':')[0];
  const lines = [`#EXTM3U x-tvg-url="http://${host}/xmltv"`];
  for (const ch of channels) {
    lines.push(
      `#EXTINF:-1 tvg-id="${escHtml(ch.id)}" tvg-name="${escHtml(ch.name)}",${escHtml(ch.name)}`,
      channelStreamUrl(ch, hostname),
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Build the /channels JSON response - a flat list of channels with stream URLs.
 * @param {Array}  channels
 * @param {string} hostname  Director hostname visible to the client (for stream URLs)
 * @returns {Array}
 */
function buildChannelList(channels, hostname) {
  return channels.map(ch => {
    const entry = {
      id:         ch.id,
      number:     ch.channelNum,
      name:       ch.name,
      stream_url: channelStreamUrl(ch, hostname),
    };
    if (ch.icon) entry.logo_url = ch.icon;
    return entry;
  });
}

/**
 * Build the aggregated /now response object.
 * @param {string} directorName
 * @param {Array}  channels
 * @param {Map}    channelCache
 * @param {string} [hostname]  Director hostname visible to the browser (for stream URLs)
 * @returns {{ name: string, channels: Array }}
 */
function buildAggregatedNow(directorName, channels, channelCache, hostname) {
  return {
    name: directorName,
    channels: channels.map(ch => {
      let rawNow;
      let online;
      if (ch.isExternal) {
        rawNow = { current: { title: ch.name, description: ch.description || '' } };
        online = true;
      } else {
        const cached = channelCache.get(ch.id) || {};
        // Strip internal `stream` field from the polled now object
        rawNow = cached.now ? (({ stream: _s, ...rest }) => rest)(cached.now) : null;
        online = cached.online ?? false;
      }
      const entry = {
        id:         ch.id,
        name:       ch.name,
        channelNum: ch.channelNum,
        port:       ch.port,
        stream:     channelStreamUrl(ch, hostname),
        now:        rawNow,
        online,
      };
      return entry;
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
        online: ch.isExternal ? true : (cached.online ?? false),
      };
    }),
  };
}

/**
 * Build the player page HTML for a single channel.
 * @param {{ id: string, name: string, url: string }} channel
 * @param {string} neonColor
 * @param {string} [externalBase]  External base URL (host:port) visible to the browser.
 *                                 Falls back to channel.url when not provided.
 * @returns {string}
 */
function buildPlayerHTML(channel, neonColor, externalBase) {
  const streamUrl = `${externalBase || channel.url}/stream.m3u8`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(channel.name)} - Reeltime TV Guide</title>
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
      color: #00d4ff;
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
      background: #39ff14;
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
            const now  = ch.now;
            const curr = now.current || {};
            document.getElementById('now-title').textContent = curr.title || '-';
            const pct = curr.progress != null ? Math.round(curr.progress * 100) : 0;
            document.getElementById('progress-bar').style.width = pct + '%';
            const rem = curr.remaining != null ? Math.ceil(curr.remaining / 60) : 0;
            document.getElementById('now-meta').textContent = pct + '% \u2014 ' + rem + ' min remaining';
            const nextTitle = (now.next && now.next.title) || '-';
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
// Channel view page  /channel/:id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the static HTML for the /channel/:id detail page.
 * Client-side JS polls the reel's /now endpoint directly.
 *
 * @param {object} channel
 * @param {string} externalBase  http://hostname:port  (browser-accessible)
 * @returns {string}
 */
function buildChannelHTML(channel, externalBase) {
  const nowUrl = `${externalBase}/now?upcoming=20`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(channel.name)} - Reeltime TV Guide</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #080a0f; color: #dde4f0;
      font-family: 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh; display: flex; flex-direction: column;
    }
    a { color: inherit; text-decoration: none; }

    /* Header */
    .header {
      display: flex; align-items: center; gap: 16px;
      padding: 14px 24px; background: #0f1117;
      border-bottom: 1px solid #1c2033; flex-shrink: 0;
    }
    .back-link { font-size: 0.9rem; color: #8892a4; display: flex; align-items: center; gap: 6px; transition: color 0.15s; }
    .back-link:hover { color: #dde4f0; }
    .header-ch { display: flex; flex-direction: column; gap: 2px; }
    .header-chnum { font-size: 0.68rem; color: #39ff14; font-weight: 600; letter-spacing: 0.08em; }
    .header-chname { font-size: 1.2rem; font-weight: 700; color: #00d4ff; }
    .watch-btn {
      margin-left: auto; padding: 6px 16px;
      border: 1px solid #ff2d78; border-radius: 4px;
      font-size: 0.82rem; color: #ff2d78; font-weight: 600;
      transition: background 0.15s;
    }
    .watch-btn:hover { background: #ff2d7822; }

    /* Content */
    .content { flex: 1; max-width: 800px; width: 100%; margin: 0 auto; padding: 28px 24px; display: flex; flex-direction: column; gap: 28px; }

    /* Channel description */
    .ch-desc { font-size: 0.9rem; color: #8892a4; line-height: 1.6; }

    /* Card */
    .card { background: #0f1117; border: 1px solid #1c2033; border-radius: 8px; padding: 20px; }
    .card-label { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.1em; color: #5a6278; text-transform: uppercase; margin-bottom: 12px; }

    /* Now playing */
    .now-ep { font-size: 1.05rem; font-weight: 700; color: #00d4ff; margin-bottom: 4px; }
    .now-series { font-size: 0.85rem; color: #8892a4; margin-bottom: 12px; }
    .now-times { font-size: 0.8rem; color: #5a6278; margin-bottom: 10px; font-variant-numeric: tabular-nums; }
    .progress-wrap { height: 5px; background: #1c2033; border-radius: 3px; overflow: hidden; margin-bottom: 10px; }
    .progress-fill { height: 100%; background: #39ff14; border-radius: 3px; transition: width 0.5s; }
    .now-pct { font-size: 0.78rem; color: #5a6278; margin-bottom: 12px; }
    .now-desc { font-size: 0.85rem; color: #6a7588; line-height: 1.6; }

    /* Upcoming list */
    .up-list { display: flex; flex-direction: column; gap: 0; }
    .up-item {
      display: grid; grid-template-columns: 90px 1fr auto;
      gap: 12px; align-items: start;
      padding: 10px 0; border-bottom: 1px solid #1c2033;
    }
    .up-item:last-child { border-bottom: none; }
    .up-time { font-size: 0.78rem; color: #5a6278; font-variant-numeric: tabular-nums; padding-top: 2px; }
    .up-ep { font-size: 0.85rem; font-weight: 600; color: #00d4ff; }
    .up-series { font-size: 0.75rem; color: #8892a4; margin-top: 2px; }
    .up-dur { font-size: 0.75rem; color: #5a6278; white-space: nowrap; padding-top: 2px; }

    /* Footer */
    .footer { border-top: 1px solid #1c2033; padding: 12px 24px; font-size: 0.78rem; color: #3a4258; display: flex; gap: 16px; flex-wrap: wrap; flex-shrink: 0; }
    .footer a { color: #5a6278; }
    .footer a:hover { color: #dde4f0; }
  </style>
</head>
<body>
  <header class="header">
    <a href="/" class="back-link">&#8592; Guide</a>
    <div class="header-ch">
      <div class="header-chnum">CH&nbsp;${escHtml(String(channel.channelNum))}</div>
      <div class="header-chname">${escHtml(channel.name)}</div>
    </div>
    <a href="/watch/${encodeURIComponent(channel.id)}" class="watch-btn">&#9654;&nbsp;Watch</a>
  </header>

  <div class="content">
    ${channel.description ? `<div class="ch-desc">${escHtml(channel.description)}</div>` : ''}

    <div class="card" id="now-card">
      <div class="card-label">Now Playing</div>
      <div class="now-ep" id="now-ep">-</div>
      <div class="now-series" id="now-series"></div>
      <div class="now-times" id="now-times"></div>
      <div class="progress-wrap"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
      <div class="now-pct" id="now-pct"></div>
      <div class="now-desc" id="now-desc"></div>
    </div>

    <div class="card">
      <div class="card-label">Coming Up</div>
      <div class="up-list" id="up-list"></div>
    </div>
  </div>

  <footer class="footer">
    <a href="/channels.m3u">channels.m3u</a>
    <a href="/xmltv">XMLTV guide</a>
    <a href="/health">health</a>
  </footer>

  <script>
    (function () {
      var NOW_URL = ${JSON.stringify(nowUrl)};

      function esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      }

      function fmtTime(ms) {
        var d = new Date(ms), h = d.getHours(), m = d.getMinutes();
        var ap = h >= 12 ? 'PM' : 'AM';
        h = h % 12; if (h === 0) h = 12;
        return h + ':' + String(m).padStart(2,'0') + '\\u00a0' + ap;
      }

      function fmtDur(secs) {
        var h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
        return h > 0 ? h + 'h ' + m + 'm' : m + ' min';
      }

      function update(data) {
        var curr = data.current;
        if (!curr) return;

        // Episode label: episodeNum · title, or series, or plain title
        var epLabel = [curr.episodeNum, (curr.seriesTitle && curr.title !== curr.seriesTitle) ? curr.title : (curr.subTitle || '')].filter(Boolean).join(' \\u00b7 ') || curr.seriesTitle || curr.title;
        document.getElementById('now-ep').textContent     = epLabel || '-';
        document.getElementById('now-series').textContent = (curr.seriesTitle && curr.title !== curr.seriesTitle) ? curr.seriesTitle : '';

        var startMs = new Date(curr.startedAt).getTime();
        var endMs   = new Date(curr.endsAt).getTime();
        var pct     = Math.max(0, Math.min(100, (Date.now() - startMs) / (endMs - startMs) * 100));
        document.getElementById('progress-fill').style.width = pct.toFixed(1) + '%';

        var rem = Math.max(0, Math.ceil((endMs - Date.now()) / 60000));
        document.getElementById('now-times').textContent = fmtTime(startMs) + ' \\u2013 ' + fmtTime(endMs);
        document.getElementById('now-pct').textContent   = Math.round(pct) + '%  \\u2014  ' + rem + ' min remaining';
        document.getElementById('now-desc').textContent  = curr.description || '';

        var upArr = data.upcoming || [];
        var rows = upArr.map(function (ep) {
          var epLine = [ep.episodeNum, (ep.seriesTitle && ep.title !== ep.seriesTitle) ? ep.title : (ep.subTitle || '')].filter(Boolean).join(' \\u00b7 ') || ep.seriesTitle || ep.title;
          var seriesLine = (ep.seriesTitle && ep.title !== ep.seriesTitle) ? ep.seriesTitle : '';
          return '<div class="up-item">'
            + '<div class="up-time">' + esc(fmtTime(new Date(ep.startsAt).getTime())) + '</div>'
            + '<div><div class="up-ep">' + esc(epLine) + '</div>'
            + (seriesLine ? '<div class="up-series">' + esc(seriesLine) + '</div>' : '')
            + '</div>'
            + '<div class="up-dur">' + esc(fmtDur(ep.duration)) + '</div>'
            + '</div>';
        });
        document.getElementById('up-list').innerHTML = rows.join('') || '<div style="color:#5a6278;font-size:0.85rem">No upcoming data</div>';
      }

      function poll() {
        fetch(NOW_URL)
          .then(function (r) { return r.json(); })
          .then(update)
          .catch(function () {});
      }

      poll();
      setInterval(poll, 5000);
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
  // External channels have no container to poll - mark them permanently online.
  channels.filter(ch => ch.isExternal).forEach(ch => {
    channelCache.set(ch.id, { online: true, now: null, lastOk: Date.now() });
  });

  await Promise.allSettled(
    channels.filter(ch => !ch.isExternal).map(async ch => {
      try {
        const [nowData, healthData] = await Promise.all([
          fetchJson(`${ch.url}/now?upcoming=120`),
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

    // GET /favicon.ico - serve an emoji SVG favicon
    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      return res.end(FAVICON_SVG);
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
      const neon         = NEON_COLORS[channels.indexOf(ch) % NEON_COLORS.length];
      const hostname     = host.split(':')[0];
      const externalBase = `http://${hostname}:${ch.port}`;
      const html         = buildPlayerHTML(ch, neon, externalBase);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // GET /channel/:channelId
    const channelMatch = pathname.match(/^\/channel\/([^/]+)$/);
    if (req.method === 'GET' && channelMatch) {
      const channelId = decodeURIComponent(channelMatch[1]);
      const ch        = channels.find(c => c.id === channelId);
      if (!ch) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Channel not found');
      }
      const hostname     = host.split(':')[0];
      const externalBase = `http://${hostname}:${ch.port}`;
      const html         = buildChannelHTML(ch, externalBase);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // GET /channels
    if (req.method === 'GET' && pathname === '/channels') {
      const hostname = host.split(':')[0];
      const body = JSON.stringify(buildChannelList(channels, hostname));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(body);
    }

    // GET /now
    if (req.method === 'GET' && pathname === '/now') {
      const hostname = host.split(':')[0];
      const body = JSON.stringify(buildAggregatedNow(directorName, channels, channelCache, hostname));
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
 * External channels are synthesized directly - no HTTP fetch is made for them.
 */
function mergeXmltvDocuments(channels, settledResults) {
  const channelBlocks   = [];
  const programmeBlocks = [];

  /** Format a Date as an XMLTV timestamp: YYYYMMDDHHmmss +0000 */
  function xmltvDate(dt) {
    return new Date(dt).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  }

  settledResults.forEach((result, i) => {
    const ch = channels[i];

    // Synthesize XMLTV blocks for external channels - they have no /xmltv endpoint.
    if (ch.isExternal) {
      const iconAttr = ch.icon ? ` <icon src="${escXML(ch.icon)}" />` : '';
      channelBlocks.push(
        `<channel id="${escXML(ch.id)}"><display-name>${escXML(ch.name)}</display-name>${iconAttr}</channel>`,
      );
      const start = xmltvDate(Date.now());
      const end   = xmltvDate(Date.now() + 24 * 60 * 60 * 1000);
      const desc  = ch.description ? `<desc lang="en">${escXML(ch.description)}</desc>` : '';
      programmeBlocks.push(
        `<programme start="${start}" stop="${end}" channel="${escXML(ch.id)}">` +
        `<title lang="en">${escXML(ch.name)}</title>${desc}</programme>`,
      );
      return;
    }

    if (result.status !== 'fulfilled') return;
    const { body } = result.value;
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

  info(`Starting ${directorName} - ${channels.length} channel(s) on port ${port}`);

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
// Exports (for testing) - only when not the entry-point
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
    channelStreamUrl,
    buildAggregatedM3U,
    buildChannelList,
    buildPlayerHTML,
    buildAggregatedNow,
    buildHealthResponse,
    fetchJson,
    pollChannels,
    mergeXmltvDocuments,
  };
} else if (process.argv[2] === 'mark' || process.argv[2] === 'generate') {
  // ── CLI: mark (write compose file to disk) ────────────────────────────────
  // Usage: node src/director.js mark [path/to/director.config.yaml] [--build]
  //   --build  emit build: directives (from source) instead of pre-built images (default)
  // 'generate' is a legacy alias that writes to stdout instead of a file.
  const args      = process.argv.slice(3);
  const useImages = !args.includes('--build');
  const cfgPath   = args.find(a => !a.startsWith('-')) || process.env.DIRECTOR_CONFIG || DEFAULT_CFG_PATH;
  try {
    const output = generateCompose(cfgPath, useImages);
    if (process.argv[2] === 'generate') {
      process.stdout.write(output);
    } else {
      const outPath = path.join(path.dirname(path.resolve(cfgPath)), 'docker-compose.director.yml');
      fs.writeFileSync(outPath, output, 'utf8');
      process.stderr.write(`Created: docker-compose.director.yml\n`);
      process.stderr.write(`Run:     docker compose -f docker-compose.director.yml up -d\n`);
    }
  } catch (e) {
    error(`mark failed: ${e.message}`);
    process.exit(1);
  }
} else {
  main();
}

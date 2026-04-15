# ─────────────────────────────────────────────────────────────────────────────
# Boom — WeatherStar 4000 HLS Streamer
#
# Requires a running WS4KP instance (https://github.com/netbymatt/ws4kp)
# with the widescreen flag set:  WSQS_settings_wide_checkbox=true
#
# Build:  docker build -t boom -f boom/Dockerfile .
# Run:    docker run -p 9798:9798 \
#           -e ZIP_CODE=63101 \
#           -e WS4KP_HOST=192.168.1.100 \
#           -e WS4KP_PORT=8080 \
#           boom
#
# M3U:    http://localhost:9798/channels.m3u
# XMLTV:  http://localhost:9798/xmltv
# Health: http://localhost:9798/health
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim

# ── System dependencies ───────────────────────────────────────────────────────
#   ffmpeg        — encode captured frames as HLS
#   chromium      — headless browser for Puppeteer (system-managed, no download)
#   wget          — used by the HEALTHCHECK instruction
#   fonts-*       — font rendering for the weather display page
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        wget \
        chromium \
        fonts-liberation \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcups2 \
        libdrm2 \
        libgbm1 \
        libnspr4 \
        libnss3 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

# ── Application ───────────────────────────────────────────────────────────────
WORKDIR /app

# Tell puppeteer-core which Chromium binary to use (system-installed above)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY boom/package.json boom/package-lock.json ./
RUN npm ci --only=production && npm cache clean --force

COPY boom/src/ ./boom/src/
COPY shared/ ./shared/
COPY boom/music/ /music/

# ── Runtime directories ───────────────────────────────────────────────────────
#   /tmp/hls  — HLS segments + playlist (written at runtime)
#   /music    — default MP3s baked in; override by mounting your own directory
#   /logo     — mount logo PNG files here (optional)
RUN mkdir -p /tmp/hls /music /logo

# ── Environment defaults ──────────────────────────────────────────────────────
ENV PORT=9798 \
    HLS_DIR=/tmp/hls \
    MUSIC_DIR=/music \
    LOGO_DIR=/logo \
    ZIP_CODE=90210 \
    WS4KP_HOST=localhost \
    WS4KP_PORT=8080 \
    FRAME_RATE=10 \
    VIDEO_BITRATE=1000k \
    AUDIO_BITRATE=128k \
    MUSIC_VOLUME=0.5 \
    AUDIO_SOURCE=mp3 \
    AUDIO_VOLUME=1.0 \
    SHUFFLE_MUSIC=false \
    HLS_SEG=2 \
    HLS_SIZE=5 \
    RESOLUTION=1280:720 \
    CHANNEL_ID=weatherstar4000 \
    CHANNEL_NAME="WeatherStar 4000" \
    CHANNEL_NUMBER=275 \
    NODE_ENV=production

EXPOSE 9798

# ── Health check ──────────────────────────────────────────────────────────────
#   start_period allows time for Puppeteer to launch and ffmpeg to produce
#   the first two HLS segments (2 × HLS_SEG seconds).
HEALTHCHECK --interval=30s \
            --timeout=10s \
            --start-period=60s \
            --retries=3 \
    CMD wget -qO /dev/null http://localhost:${PORT}/health || exit 1

CMD ["node", "boom/src/streamer.js"]

# ─────────────────────────────────────────────────────────────────────────────
# Scout — web-page HLS streamer
#
# Captures any URL in a headless Chromium browser and streams it as HLS.
# Exposes the same endpoint set as Reeltime.
#
# Build:  docker build -t scout scout/
# Run:    docker run -p 8080:8080 \
#           -e CAPTURE_URL=http://myapp:8080 \
#           -e CHANNEL_NAME="My Channel" \
#           scout
#
# Player:  http://localhost:8080/
# Stream:  http://localhost:8080/stream.m3u8
# Tuner:   http://localhost:8080/channels.m3u
# Guide:   http://localhost:8080/xmltv
# Health:  http://localhost:8080/health
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim

# ── System dependencies ───────────────────────────────────────────────────────
#   ffmpeg         — encode captured frames as HLS
#   chromium       — headless browser for Puppeteer (system-managed, no download)
#   wget           — used by the HEALTHCHECK instruction
#   fonts-*        — font rendering for web pages
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

COPY package.json package-lock.json ./
RUN npm ci --only=production && npm cache clean --force

COPY src/ ./src/

# ── Runtime directories ───────────────────────────────────────────────────────
#   /tmp/hls  — HLS segments + playlist (written at runtime)
RUN mkdir -p /tmp/hls

# ── Environment defaults ──────────────────────────────────────────────────────
#   CAPTURE_URL is required and has no default — the container will exit
#   immediately if it is not set.
ENV PORT=8080 \
    HLS_DIR=/tmp/hls \
    FRAME_RATE=1 \
    VIDEO_BITRATE=1000k \
    AUDIO_BITRATE=128k \
    HLS_SEG=6 \
    HLS_SIZE=10 \
    RESOLUTION=1280:720 \
    CHANNEL_ID=scout \
    CHANNEL_NAME=Scout \
    CHANNEL_NUMBER=1 \
    WAIT_UNTIL=networkidle2 \
    NODE_ENV=production

EXPOSE 8080

# ── Health check ──────────────────────────────────────────────────────────────
#   start_period gives time for Chromium to load the page and ffmpeg to
#   produce the first HLS segments (frame rate is low so this takes longer).
HEALTHCHECK --interval=30s \
            --timeout=10s \
            --start-period=120s \
            --retries=3 \
    CMD wget -qO /dev/null http://localhost:${PORT}/health || exit 1

CMD ["node", "src/streamer.js"]

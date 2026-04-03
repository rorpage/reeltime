# ─────────────────────────────────────────────────────────────────────────────
# Reeltime
#
# Stream local or remote video files with ffmpeg in an IPTV-compatible format!
#
# Build:  docker build -t reeltime .
# Run:    docker run -p 8080:8080 \
#           -v $(pwd)/config.yaml:/config/config.yaml:ro \
#           reeltime
#
# Player:  http://localhost:8080/
# Stream:  http://localhost:8080/stream.m3u8
# Health:  http://localhost:8080/health
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-alpine

# ── System dependencies ───────────────────────────────────────────────────────
#   ffmpeg         — transcoding, MPEG-TS muxing, HLS segmenting
#   wget           — used by the HEALTHCHECK instruction
#   ca-certificates — TLS certificates for HTTPS video sources
#   tzdata         — correct timestamps in logs
RUN apk add --no-cache \
        ffmpeg \
        wget \
        ca-certificates \
        tzdata

# ── Application ───────────────────────────────────────────────────────────────
WORKDIR /app

COPY package.json ./
RUN npm install --only=production && npm cache clean --force

COPY src/ ./src/

# ── Runtime directories ───────────────────────────────────────────────────────
#   /tmp/hls  — HLS segments + playlist (written at runtime)
#   /config   — mount your config.yaml here (read-only)
RUN mkdir -p /tmp/hls /config

# ── Environment defaults ──────────────────────────────────────────────────────
#   All values can be overridden with  -e KEY=value  or in docker-compose.yml
ENV CONFIG_PATH=/config/config.yaml \
    HLS_DIR=/tmp/hls \
    PORT=8080 \
    HLS_SEG=6 \
    HLS_SIZE=10 \
    PASSES_PER_CYCLE=3 \
    RESOLUTION=1280:720 \
    VIDEO_BITRATE=2000k \
    AUDIO_BITRATE=128k \
    FRAMERATE=30 \
    NODE_ENV=production

EXPOSE 8080

# ── Health check ──────────────────────────────────────────────────────────────
#   start_period allows time for the first HLS segments to be generated
#   before Docker starts evaluating health.
HEALTHCHECK --interval=30s \
            --timeout=10s \
            --start-period=90s \
            --retries=3 \
    CMD wget -qO /dev/null http://localhost:${PORT}/health || exit 1

CMD ["node", "src/streamer.js"]

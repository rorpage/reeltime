# ─────────────────────────────────────────────────────────────────────────────
# Mixer - Music Channel HLS Streamer
#
# Streams a directory of MP3 files as a continuous live HLS channel.
#
# Build:  docker build -t mixer -f mixer/Dockerfile .
# Run:    docker run -p 8080:8080 \
#           -v /path/to/music:/music:ro \
#           -e CHANNEL_NAME="My Music" \
#           mixer
#
# Player:  http://localhost:8080/
# Stream:  http://localhost:8080/stream.m3u8
# Tuner:   http://localhost:8080/channels.m3u
# Guide:   http://localhost:8080/xmltv
# Health:  http://localhost:8080/health
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-alpine

# ── System dependencies ───────────────────────────────────────────────────────
#   ffmpeg         — encode audio + static background as HLS
#   wget           — used by the HEALTHCHECK instruction
RUN apk add --no-cache \
        ffmpeg \
        wget

# ── Application ───────────────────────────────────────────────────────────────
WORKDIR /app

COPY mixer/package.json mixer/package-lock.json ./
RUN npm ci --only=production && npm cache clean --force

COPY mixer/src/ ./mixer/src/
COPY shared/    ./shared/

# ── Runtime directories ───────────────────────────────────────────────────────
#   /tmp/hls  - HLS segments + playlist (written at runtime)
#   /music    - mount your MP3 files here
RUN mkdir -p /tmp/hls /music

# ── Environment defaults ──────────────────────────────────────────────────────
ENV PORT=8080 \
    HLS_DIR=/tmp/hls \
    MUSIC_DIR=/music \
    SHUFFLE_MUSIC=false \
    AUDIO_SOURCE=mp3 \
    AUDIO_VOLUME=1.0 \
    CHANNEL_ID=mixer \
    CHANNEL_NAME=Mixer \
    CHANNEL_NUMBER=1 \
    HLS_SEG=6 \
    HLS_SIZE=10 \
    RESOLUTION=1280:720 \
    FRAME_RATE=1 \
    VIDEO_BITRATE=200k \
    AUDIO_BITRATE=128k \
    BG_COLOR=0x000000 \
    NODE_ENV=production

EXPOSE 8080

# ── Health check ──────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s \
            --timeout=10s \
            --start-period=30s \
            --retries=3 \
    CMD wget -qO /dev/null http://localhost:${PORT}/health || exit 1

CMD ["node", "mixer/src/streamer.js"]

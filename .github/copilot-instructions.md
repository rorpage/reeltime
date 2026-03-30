# Reeltime — Copilot Instructions

## What this project is
Reeltime is a self-hosted continuous HLS video streamer built with
Node.js and ffmpeg. It reads a YAML playlist and streams videos
in a continuous loop as an HLS (m3u8) stream.

## Key architecture decisions
- Single ffmpeg process fed by a named FIFO (ffconcat format)
- The FIFO writer is time-paced using QUEUE_AHEAD_SECS (default 10)
- A wall-clock schedule[] array is the source of truth for /now and /xmltv
- getScheduleWindow() extrapolates future entries beyond the FIFO write head
- NO multi-process normaliser + encoder split — one ffmpeg does everything
- NO PassThrough stream bridge — the FIFO IS the bridge

## Code style
- Node.js built-ins only (no Express, no external HTTP frameworks)
- CommonJS (require/module.exports), Node 20+
- Named constants for all magic numbers
- All async work uses async/await, not callbacks
- Errors are logged with timestamp prefix: YYYY-MM-DDTHH:mm:ss.sssZ LEVEL

## Endpoints (never remove these)
GET /               HLS.js web player + now-playing ticker
GET /stream.m3u8    Live HLS playlist
GET /seg_*.ts       MPEG-TS segments
GET /now            JSON: position, remaining, progress, next video
GET /xmltv          XMLTV guide  (?hours=1-24)
GET /xmltv.xml      Alias for /xmltv
GET /channels.m3u   M3U tuner  (Jellyfin / Plex / Emby)
GET /health         JSON health check

## Config shape (config.yaml)
stream:
  name:       string   # display name
  channel_id: string   # stable XMLTV id, URL-safe
  loop:       boolean  # default true
  loop_count: number   # -1 = infinite

videos:
  - title:       string
    url:         string   # http/https/rtmp/file
    duration:    number   # seconds
    description: string   # optional, for XMLTV
    category:    string   # optional, for XMLTV

## Environment variables
CONFIG_PATH      /config/config.yaml
HLS_DIR          /tmp/hls
FIFO_PATH        /tmp/playlist.ffconcat
PORT             8080
HLS_SEG          6        (seconds per segment)
HLS_SIZE         10       (playlist window)
RESOLUTION       1280:720
VIDEO_BITRATE    2000k
AUDIO_BITRATE    128k
FRAMERATE        30
FFMPEG_THREADS   0        (0 = auto)
QUEUE_AHEAD_SECS 10
DEBUG            0

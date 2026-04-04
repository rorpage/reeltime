# Boom

A Dockerized companion service for [Reeltime](https://github.com/rorpage/reeltime)
that streams the [WeatherStar 4000 Plus (WS4KP)](https://github.com/netbymatt/ws4kp)
weather display as a live HLS channel — compatible with Channels DVR, Jellyfin,
Plex, Emby, xTeVe, Threadfin, and any IPTV player that supports M3U/XMLTV.

## How it works

1. A headless Chromium browser (Puppeteer) loads the WS4KP weather display and
   enters your ZIP code.
2. Screenshots are taken at a configurable frame rate and piped into ffmpeg as a
   JPEG image stream.
3. ffmpeg mixes the video with looping MP3 background music and outputs HLS
   segments to disk.
4. A lightweight Node.js HTTP server serves the M3U playlist, XMLTV guide, HLS
   stream, and health endpoint.

## Prerequisites

- Docker installed
- A running [WS4KP](https://github.com/netbymatt/ws4kp) container with
  widescreen mode enabled:

```bash
docker run -d \
  --name ws4kp \
  --restart unless-stopped \
  -p 8080:8080 \
  -e WSQS_settings_wide_checkbox=true \
  ghcr.io/netbymatt/ws4kp:latest
```

## Quick start (docker compose)

```bash
# Copy and edit the environment file
cp boom/.env.example .env

# Edit .env — set WS4KP_HOST and ZIP_CODE at minimum
# Then start the stack
docker compose up -d boom
```

## Manual run

```bash
docker run -d \
  --name boom \
  --restart unless-stopped \
  --memory="1096m" \
  --cpus="1.0" \
  -p 9798:9798 \
  -e ZIP_CODE=63101 \
  -e WS4KP_HOST=192.168.1.100 \
  -e WS4KP_PORT=8080 \
  ghcr.io/rorpage/reeltime-boom:latest
```

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /stream.m3u8` | Live HLS playlist |
| `GET /channels.m3u` | M3U tuner (Channels DVR / Jellyfin / Plex) |
| `GET /playlist.m3u` | Alias for `/channels.m3u` |
| `GET /xmltv` | XMLTV guide (`?hours=1-24`, default 24) |
| `GET /xmltv.xml` | Alias for `/xmltv` |
| `GET /guide.xml` | Alias for `/xmltv` |
| `GET /health` | JSON health check |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9798` | HTTP port |
| `ZIP_CODE` | `90210` | ZIP code (or city/state) for weather location |
| `WS4KP_HOST` | `localhost` | Host running the WS4KP container |
| `WS4KP_PORT` | `8080` | Port for WS4KP |
| `FRAME_RATE` | `10` | Screenshot capture rate (fps) |
| `RESOLUTION` | `1280:720` | Output video resolution |
| `VIDEO_BITRATE` | `1000k` | ffmpeg video bitrate |
| `AUDIO_BITRATE` | `128k` | ffmpeg audio bitrate |
| `MUSIC_VOLUME` | `0.5` | Background music volume (0.0–1.0) |
| `SHUFFLE_MUSIC` | `false` | Randomise MP3 playback order |
| `HLS_SEG` | `2` | Seconds per HLS segment |
| `HLS_SIZE` | `5` | Playlist window (number of segments) |
| `CHANNEL_ID` | `weatherstar4000` | Stable XMLTV/M3U channel ID |
| `CHANNEL_NAME` | `WeatherStar 4000` | Display name |
| `CHANNEL_NUMBER` | `275` | Channel number in M3U |
| `CHANNEL_ICON` | *(auto)* | URL to channel icon (defaults to `/logo/ws4000.png`) |
| `CROP_X` | `4` | Screenshot crop — left offset |
| `CROP_Y` | `50` | Screenshot crop — top offset |
| `CROP_WIDTH` | `840` | Screenshot crop — width |
| `CROP_HEIGHT` | `470` | Screenshot crop — height |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Chromium binary path |

## Background music

Mount a directory of MP3 files to `/music` inside the container. All `.mp3` files
found are used; if none are found the stream will have silent audio.

```yaml
volumes:
  - ./music:/music:ro
```

Set `SHUFFLE_MUSIC=true` to randomise playback order on each startup.

## Logo

Mount a PNG file to `/logo/ws4000.png` to provide a custom channel icon, or set
`CHANNEL_ICON` to an external URL.

```yaml
volumes:
  - ./logo:/logo:ro
```

## Resource requirements

- RAM: ~850 MB (Chromium + ffmpeg + Node.js)
- CPU: 1 core recommended (`--cpus="1.0"`)

For hardware-accelerated encoding, override the encoding options via environment
variables or modify `docker-compose.yml` to pass `--device=/dev/dri` (Intel QSV)
or `--gpus all` (NVIDIA NVENC).

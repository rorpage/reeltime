# Scout

A Dockerized companion service for [Reeltime](https://github.com/rorpage/reeltime)
that captures **any web page** as a live HLS stream using Puppeteer and ffmpeg.
Point it at a dashboard, status display, weather app, or any browser-renderable
URL — Scout streams it continuously over HLS.

Scout exposes the same endpoint set as Reeltime, so it works out of the box with
Channels DVR, Jellyfin, Plex, Emby, and any M3U/XMLTV-aware client.

## How it works

1. A headless Chromium browser (Puppeteer) opens `CAPTURE_URL`.
2. Screenshots are taken at `FRAME_RATE` fps and piped into ffmpeg as a JPEG
   image stream.
3. ffmpeg encodes the frames as HLS segments.
4. A Node.js HTTP server (no Express) serves the stream and all companion
   endpoints.

## Quick start (docker compose)

```bash
# Copy and edit the environment file
cp scout/.env.example .env

# Set CAPTURE_URL and any other options, then start
docker compose up -d scout
```

## Manual run

```bash
docker run -d \
  --name scout \
  --restart unless-stopped \
  --memory="1G" \
  --cpus="1.0" \
  -p 8080:8080 \
  -e CAPTURE_URL=http://192.168.1.100:8080 \
  -e CHANNEL_NAME="My Dashboard" \
  ghcr.io/rorpage/reeltime-scout:latest
```

## Endpoints

All endpoints match Reeltime exactly.

| Endpoint | Description |
|---|---|
| `GET /` | Embedded HLS.js web player with now-playing ticker |
| `GET /stream.m3u8` | Live HLS playlist |
| `GET /seg_*.ts` | MPEG-TS segments |
| `GET /now` | JSON: current title, uptime, live status |
| `GET /xmltv` | XMLTV guide (`?hours=1-24`, default 4) |
| `GET /xmltv.xml` | Alias for `/xmltv` |
| `GET /channels.m3u` | M3U tuner (Channels DVR / Jellyfin / Plex) |
| `GET /playlist.m3u` | Alias for `/channels.m3u` |
| `GET /health` | JSON health check |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CAPTURE_URL` | *(required)* | URL to capture — container exits if unset |
| `PORT` | `8080` | HTTP port |
| `FRAME_RATE` | `1` | Screenshot capture rate (fps) |
| `RESOLUTION` | `1280:720` | Output video resolution |
| `VIDEO_BITRATE` | `1000k` | ffmpeg video bitrate |
| `AUDIO_BITRATE` | `128k` | ffmpeg audio bitrate (silent track) |
| `HLS_SEG` | `6` | Seconds per HLS segment |
| `HLS_SIZE` | `10` | Playlist window (number of segments) |
| `CHANNEL_ID` | `scout` | Stable XMLTV/M3U channel ID |
| `CHANNEL_NAME` | `Scout` | Display name |
| `CHANNEL_NUMBER` | `1` | Channel number in M3U |
| `CHANNEL_ICON` | *(none)* | URL to channel icon |
| `WAIT_UNTIL` | `networkidle2` | Puppeteer navigation wait condition |
| `CROP_X` | *(none)* | Screenshot crop — left offset |
| `CROP_Y` | *(none)* | Screenshot crop — top offset |
| `CROP_WIDTH` | *(none)* | Screenshot crop — width |
| `CROP_HEIGHT` | *(none)* | Screenshot crop — height |
| `DEBUG` | `0` | Set to `1` for verbose ffmpeg and capture logs |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Chromium binary path |

## Viewport crop

By default Scout captures the full `RESOLUTION` viewport. Set all four crop
variables to focus on a specific region (e.g., trim browser chrome):

```bash
-e CROP_X=4 -e CROP_Y=50 -e CROP_WIDTH=840 -e CROP_HEIGHT=470
```

## Frame rate

`FRAME_RATE=1` (one screenshot per second) is appropriate for slowly-updating
pages like dashboards and weather displays. Increase it for smoother motion:

| Content type | Suggested `FRAME_RATE` |
|---|---|
| Static dashboard / weather display | 1–2 |
| Animated charts / map tiles | 5–10 |
| Interactive UI demos | 15–30 |

Higher frame rates increase CPU usage. Keep `VIDEO_BITRATE` and `FRAME_RATE`
proportional to avoid quality loss.

## Resource requirements

- RAM: ~850 MB (Chromium + ffmpeg + Node.js)
- CPU: 1 core (at `FRAME_RATE=1`; increase for higher frame rates)

## `/now` response

Since Scout captures a live, continuous stream there is no "next" item and no
fixed duration:

```json
{
  "current": {
    "title":     "My Dashboard",
    "duration":  null,
    "position":  3601.2,
    "remaining": 0,
    "progress":  1,
    "startedAt": "2024-01-01T00:00:00.000Z",
    "endsAt":    null
  },
  "next":   null,
  "stream": "http://host/stream.m3u8"
}
```

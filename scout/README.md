# 🧢 Scout

A Dockerized companion service for [Reeltime](https://github.com/rorpage/reeltime)
that captures **any web page** as a live HLS stream using Puppeteer and ffmpeg.
Point it at a dashboard, status display, weather app, or any browser-renderable
URL - Scout streams it continuously over HLS, compatible with Channels DVR,
Jellyfin, Plex, Emby, and any M3U/XMLTV-aware client.

## Running

### Prebuilt image

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

### Build from source

Run from the **repo root**:

```bash
docker build -t scout -f scout/Dockerfile .
docker run -p 8080:8080 \
  -e CAPTURE_URL=http://192.168.1.100:8080 \
  -e CHANNEL_NAME="My Dashboard" \
  scout
```

## Endpoints

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

## Using with Director

Scout integrates with [Reeltime Director](../director/README.md) as an inline channel - no config file needed. Add it to `director.config.yaml`:

```yaml
configs:
  - ./channels/my_reel_channel/config.yaml   # existing reel channel

  - name:        "My Dashboard"
    type:        scout
    description: "Live dashboard capture"
    environment:
      CAPTURE_URL: "https://example.com/dashboard"
      FRAME_RATE:  "2"
```

Then re-run `mark` to regenerate your compose file.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CAPTURE_URL` | *(required)* | URL to capture - container exits if unset |
| `PORT` | `8080` | HTTP port |
| `FRAME_RATE` | `1` | Screenshot capture rate (fps) |
| `RESOLUTION` | `1280:720` | Output video resolution |
| `VIDEO_BITRATE` | `1000k` | ffmpeg video bitrate |
| `AUDIO_BITRATE` | `128k` | ffmpeg audio bitrate |
| `AUDIO_SOURCE` | `silent` | Audio mode: `silent`, `mp3`, or `http` |
| `AUDIO_URL` | *(none)* | HTTP audio stream URL (required when `AUDIO_SOURCE=http`) |
| `AUDIO_VOLUME` | `1.0` | Volume for `http` mode (0.0–1.0) |
| `MUSIC_DIR` | `/music` | Directory of MP3 files for `mp3` mode |
| `MUSIC_VOLUME` | `0.5` | Volume for `mp3` mode (0.0–1.0) |
| `SHUFFLE_MUSIC` | `false` | Randomize MP3 playback order |
| `HLS_SEG` | `6` | Seconds per HLS segment |
| `HLS_SIZE` | `10` | Playlist window (number of segments) |
| `CHANNEL_ID` | `scout` | Stable XMLTV/M3U channel ID |
| `CHANNEL_NAME` | `Scout` | Display name |
| `CHANNEL_NUMBER` | `1` | Channel number in M3U |
| `CHANNEL_ICON` | *(none)* | URL to channel icon |
| `WAIT_UNTIL` | `networkidle2` | Puppeteer navigation wait condition |
| `CROP_X` | *(none)* | Screenshot crop - left offset |
| `CROP_Y` | *(none)* | Screenshot crop - top offset |
| `CROP_WIDTH` | *(none)* | Screenshot crop - width |
| `CROP_HEIGHT` | *(none)* | Screenshot crop - height |
| `DEBUG` | `0` | Set to `1` for verbose ffmpeg and capture logs |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Chromium binary path |

## Viewport crop

By default Scout captures the full `RESOLUTION` viewport. Set all four crop
variables to focus on a specific region (e.g., trim browser chrome):

```bash
-e CROP_X=4 -e CROP_Y=50 -e CROP_WIDTH=840 -e CROP_HEIGHT=470
```

## Audio

By default Scout outputs a silent audio track. To add audio, set `AUDIO_SOURCE`:

- **`mp3`** - loop MP3 files; mount a directory to `/music`: `-v ./music:/music:ro`
- **`http`** - pull from an HTTP stream; set `AUDIO_URL` to the stream URL

## Frame rate

`FRAME_RATE=1` is appropriate for slowly-updating pages. Increase for smoother motion:

| Content type | Suggested `FRAME_RATE` |
|---|---|
| Static dashboard / weather display | 1–2 |
| Animated charts / map tiles | 5–10 |
| Interactive UI demos | 15–30 |

Higher frame rates increase CPU usage proportionally.

## Resource requirements

- RAM: ~850 MB (Chromium + ffmpeg + Node.js)
- CPU: 1 core (at `FRAME_RATE=1`; scale up for higher frame rates)

## `/now` response

Returns clock-aligned 1-hour blocks using `CHANNEL_NAME` as the title and the
captured page's `<title>` as the description. Supports `?upcoming=N` for
Director's guide window.

```json
{
  "current": {
    "title":       "My Dashboard",
    "description": "My Dashboard - Live View",
    "duration":    3600,
    "position":    742.3,
    "remaining":   2857.7,
    "progress":    0.2062,
    "startedAt":   "2026-04-08T17:00:00.000Z",
    "endsAt":      "2026-04-08T18:00:00.000Z"
  },
  "next": {
    "title":    "My Dashboard",
    "duration": 3600,
    "startsAt": "2026-04-08T18:00:00.000Z"
  },
  "stream": "http://host/stream.m3u8"
}
```

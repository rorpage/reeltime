# ⚡ Boom

A Dockerized companion service for [Reeltime](https://github.com/rorpage/reeltime)
that streams the [WeatherStar 4000 Plus (WS4KP)](https://github.com/netbymatt/ws4kp)
weather display as a live HLS channel - compatible with Channels DVR, Jellyfin,
Plex, Emby, xTeVe, Threadfin, and any IPTV player that supports M3U/XMLTV.

## Prerequisites

A running [WS4KP](https://github.com/netbymatt/ws4kp) container with widescreen
mode enabled:

```bash
docker run -d \
  --name ws4kp \
  --restart unless-stopped \
  -p 8080:8080 \
  -e WSQS_settings_wide_checkbox=true \
  ghcr.io/netbymatt/ws4kp:latest
```

## Running

### Prebuilt image

```bash
docker run -d \
  --name boom \
  --restart unless-stopped \
  --memory="1096m" \
  --cpus="1.0" \
  -p 9798:9798 \
  -e ZIP_CODE=63101 \
  -e WS4KP_HOST=192.168.1.100 \
  ghcr.io/rorpage/reeltime-boom:latest
```

### Build from source

Run from the **repo root**:

```bash
docker build -t boom -f boom/Dockerfile .
docker run -p 9798:9798 \
  -e ZIP_CODE=63101 \
  -e WS4KP_HOST=192.168.1.100 \
  boom
```

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Embedded HLS.js web player with now-playing ticker |
| `GET /stream.m3u8` | Live HLS playlist |
| `GET /now` | JSON now-playing - 1-hour "Live Weather" blocks (`?upcoming=N`) |
| `GET /channels.m3u` | M3U tuner (Channels DVR / Jellyfin / Plex) |
| `GET /playlist.m3u` | Alias for `/channels.m3u` |
| `GET /xmltv` | XMLTV guide (`?hours=1-24`, default 4) |
| `GET /xmltv.xml` | Alias for `/xmltv` |
| `GET /guide.xml` | Alias for `/xmltv` |
| `GET /health` | JSON health check |

## Using with Director

Boom integrates with [Reeltime Director](../director/README.md) as an inline channel - no config file needed. Add it to `director.config.yaml`:

```yaml
configs:
  - ./channels/my_reel_channel/config.yaml   # existing reel channel

  - name:        "WeatherStar 4000"
    type:        boom
    description: "Live retro weather display"
    environment:
      ZIP_CODE:   "90210"
      WS4KP_HOST: "ws4kp"     # name of the ws4kp service in your compose
      WS4KP_PORT: "8080"
```

Then re-run `mark` to regenerate your compose file. Director will show 1-hour
"Live Weather" blocks in the guide with a live progress bar.

> **Note:** The `ws4kp` service itself is not managed by Director. Add it to
> your `docker-compose.director.yml` manually, or run it separately.

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
| `AUDIO_SOURCE` | `mp3` | Audio mode: `mp3`, `http`, or `silent` |
| `AUDIO_URL` | *(none)* | HTTP audio stream URL (required when `AUDIO_SOURCE=http`) |
| `AUDIO_VOLUME` | `1.0` | Volume for `http` mode (0.0–1.0) |
| `MUSIC_VOLUME` | `0.5` | Volume for `mp3` mode (0.0–1.0) |
| `SHUFFLE_MUSIC` | `false` | Randomize MP3 playback order |
| `HLS_SEG` | `2` | Seconds per HLS segment |
| `HLS_SIZE` | `5` | Playlist window (number of segments) |
| `CHANNEL_ID` | `weatherstar4000` | Stable XMLTV/M3U channel ID |
| `CHANNEL_NAME` | `WeatherStar 4000` | Display name |
| `CHANNEL_NUMBER` | `275` | Channel number in M3U |
| `CHANNEL_ICON` | *(auto)* | URL to channel icon (defaults to `/logo/ws4000.png`) |
| `CROP_X` | `4` | Screenshot crop - left offset |
| `CROP_Y` | `50` | Screenshot crop - top offset |
| `CROP_WIDTH` | `840` | Screenshot crop - width |
| `CROP_HEIGHT` | `470` | Screenshot crop - height |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Chromium binary path |

## Audio

Default MP3s are baked into the image and play on startup. Mount your own
directory to override them:

```bash
-v ./music:/music:ro
```

For an HTTP audio stream instead, set `AUDIO_SOURCE=http` and `AUDIO_URL` to
the stream URL. Set `AUDIO_SOURCE=silent` to disable audio entirely.

## Logo

Mount a PNG file to `/logo/ws4000.png` to provide a custom channel icon, or set
`CHANNEL_ICON` to an external URL:

```bash
-v ./logo:/logo:ro
```

## Resource requirements

- RAM: ~850 MB (Chromium + ffmpeg + Node.js)
- CPU: 1 core recommended (`--cpus="1.0"`)

For hardware-accelerated encoding, pass `--device=/dev/dri` (Intel QSV) or
`--gpus all` (NVIDIA NVENC) and override the encoding options via environment
variables.

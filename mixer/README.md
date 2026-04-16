# 🎵 Mixer

A Dockerized music channel streamer for [Reeltime](https://github.com/rorpage/reeltime).
Plays a directory of MP3 files as a continuous live HLS channel - compatible with Channels DVR,
Jellyfin, Plex, Emby, xTeVe, Threadfin, and any IPTV player that supports M3U/XMLTV.

No browser required. Mixer pairs a lavfi color source (or a static background image) with your
music directory and encodes everything as HLS using ffmpeg.

---

## Requirements

- Docker (for the containerized path)
- A directory of `.mp3` files
- ffmpeg and Node.js 22+ (for local development only)

If your music library contains files in other formats (M4A, FLAC, OGG, etc.), use the
[convert-audio](../tools/convert-audio/README.md) tool to convert them to MP3 first.

---

## Running

### Prebuilt image

```bash
docker run -d \
  --name mixer \
  --restart unless-stopped \
  -p 8080:8080 \
  -v /path/to/your/music:/music:ro \
  -e CHANNEL_NAME="My Music" \
  ghcr.io/rorpage/reeltime-mixer:latest
```

### Build from source

Run from the **repo root**:

```bash
docker build -t mixer -f mixer/Dockerfile .
docker run -p 8080:8080 \
  -v /path/to/your/music:/music:ro \
  -e CHANNEL_NAME="My Music" \
  mixer
```

---

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Embedded HLS.js web player with now-playing ticker |
| `GET /stream.m3u8` | Live HLS playlist |
| `GET /now` | JSON now-playing - current track, position, remaining, next track |
| `GET /channels.m3u` | M3U tuner (Channels DVR / Jellyfin / Plex) |
| `GET /playlist.m3u` | Alias for `/channels.m3u` |
| `GET /xmltv` | XMLTV guide (`?hours=1-24`, default 4) |
| `GET /xmltv.xml` | Alias for `/xmltv` |
| `GET /health` | JSON health check |

---

## Using with Director

Mixer integrates with [Reeltime Director](../director/README.md) as an inline channel - no config
file needed. Add it to `director.config.yaml`:

```yaml
configs:
  - ./channels/my_reel_channel/config.yaml

  - name:        "My Music"
    type:        mixer
    description: "Background music channel"
    volumes:
      - /path/to/your/music:/music:ro
    environment:
      MUSIC_DIR:    "/music"
      SHUFFLE_MUSIC: "true"
```

Then re-run `mark` to regenerate your compose file.

---

## Track titles

Mixer derives the display title from each filename by stripping the path and extension, then
replacing hyphens and underscores with spaces. For example:

| Filename | Title shown in /now |
|---|---|
| `01-Dreams.mp3` | `01 Dreams` |
| `the_chain.mp3` | `the chain` |
| `Song Title.mp3` | `Song Title` |

---

## Background video

Mixer produces a full HLS stream (video + audio) for compatibility with all IPTV clients. The
video layer is a solid color by default (black). You can change it or replace it with a static
image:

**Solid color background:**

```bash
-e BG_COLOR=0x1a1a2e   # deep navy
```

**Static background image:**

```bash
-v ./artwork/cover.jpg:/bg/cover.jpg:ro \
-e BG_IMAGE=/bg/cover.jpg
```

Any common image format supported by ffmpeg works (JPEG, PNG, etc.).

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `MUSIC_DIR` | `/music` | Directory containing `.mp3` files |
| `SHUFFLE_MUSIC` | `false` | Randomize playback order |
| `AUDIO_SOURCE` | `mp3` | Audio mode: `mp3`, `http`, or `silent` |
| `AUDIO_URL` | *(none)* | HTTP audio stream URL (required when `AUDIO_SOURCE=http`) |
| `AUDIO_VOLUME` | `1.0` | Volume multiplier for `http` mode (0.0-2.0) |
| `CHANNEL_ID` | `mixer` | Stable XMLTV/M3U channel ID |
| `CHANNEL_NAME` | `Mixer` | Display name |
| `CHANNEL_NUMBER` | `1` | Channel number in M3U |
| `CHANNEL_ICON` | *(none)* | URL to channel icon |
| `RESOLUTION` | `1280:720` | Output video resolution |
| `FRAME_RATE` | `1` | Video frame rate (1 fps is fine for a static background) |
| `VIDEO_BITRATE` | `200k` | ffmpeg video bitrate |
| `AUDIO_BITRATE` | `128k` | ffmpeg audio bitrate |
| `BG_COLOR` | `0x000000` | Background color (hex) - used when `BG_IMAGE` is not set |
| `BG_IMAGE` | *(none)* | Path to a static background image inside the container |
| `HLS_SEG` | `6` | Seconds per HLS segment |
| `HLS_SIZE` | `10` | Playlist window (number of segments) |

---

## Audio modes

**MP3 directory (default):**

Mount a directory of `.mp3` files to `/music` and set `AUDIO_SOURCE=mp3` (the default).
Mixer probes each file with `ffprobe` at startup to get its duration, then tracks playback
position so `/now` always shows the correct song and remaining time.

**HTTP audio stream:**

Set `AUDIO_SOURCE=http` and `AUDIO_URL` to any HTTP/Icecast stream. The `/now` endpoint will
report the stream as "Live Music" blocks in this mode.

**Silent:**

Set `AUDIO_SOURCE=silent` to produce a video-only stream with no audio.

---

## /now response

```json
{
  "current": {
    "title":     "01 Dreams",
    "duration":  214,
    "position":  45.2,
    "remaining": 168.8,
    "progress":  0.2112,
    "startedAt": "2026-04-16T23:15:00.000Z",
    "endsAt":    "2026-04-16T23:18:34.000Z"
  },
  "next": {
    "title":    "02 The Chain",
    "duration": 271
  },
  "stream": "http://localhost:8080/stream.m3u8"
}
```

---

## Resource requirements

Mixer uses a 1 fps static video layer (`-tune stillimage`) which keeps CPU usage very low
compared to a live video capture service like Scout or Boom.

- RAM: ~50 MB (ffmpeg + Node.js)
- CPU: minimal - well under 0.1 core on modern hardware at default settings

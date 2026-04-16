# Reeltime

A self-hosted continuous HLS video streaming suite.

| Service | Description |
|---------|-------------|
| **[🎥 Reel](reel/README.md)** | Playlist-driven HLS streamer - loops a YAML video playlist as a live m3u8 feed |
| **[🧢 Scout](scout/README.md)** | Web-page capture streamer - turns any URL into a live HLS channel |
| **[⚡ Boom](boom/README.md)** | WeatherStar 4000 streamer - captures WS4KP as a live retro weather channel |
| **[🎵 Mixer](mixer/README.md)** | Music channel streamer - plays a directory of MP3 files as a live HLS channel |
| **[🎬 Director](director/README.md)** | Multi-channel guide - aggregates Reel, Scout, Boom, and Mixer into one TV guide UI, XMLTV, and M3U |

**Just want to get running?** See the [Director quick start](director/README.md) - all you need is Docker.

**Single channel only?** See the [Reel](reel/README.md), [Scout](scout/README.md), [Boom](boom/README.md), or [Mixer](mixer/README.md) quick starts.

---

## Quick Setup (no clone required)

All you need is Docker. Everything runs from pre-built images on GHCR.

### 1. Create a working directory

```bash
mkdir reeltime && cd reeltime
mkdir -p channels/my_channel
```

### 2. Create a channel config

`channels/my_channel/config.yaml`:

```yaml
stream:
  name: "My Channel"
  loop: true
  loop_count: -1

videos:
  - title: "My Video"
    url: "https://example.com/video.mp4"
    duration: 3600
```

### 3. Create director.config.yaml

```yaml
director:
  name: "My Reeltime"

configs:
  - ./channels/my_channel/config.yaml
```

Want to add a web-page capture channel? Add Scout:

```yaml
configs:
  - ./channels/my_channel/config.yaml

  - name:        "My Dashboard"
    type:        scout
    description: "Live dashboard capture"
    environment:
      CAPTURE_URL: "https://example.com/dashboard"
```

Want a weather channel too? Add Boom (requires a running [WS4KP](https://github.com/netbymatt/ws4kp) container):

```yaml
configs:
  - ./channels/my_channel/config.yaml

  - name:        "WeatherStar 4000"
    type:        boom
    description: "Live retro weather"
    environment:
      ZIP_CODE:   "90210"
      WS4KP_HOST: "ws4kp"
      WS4KP_PORT: "8080"
```

Want a music channel? Add Mixer (mount a directory of MP3 files):

```yaml
configs:
  - ./channels/my_channel/config.yaml

  - name:        "My Music"
    type:        mixer
    description: "Background music"
    volumes:
      - /path/to/your/music:/music:ro
    environment:
      MUSIC_DIR:    "/music"
      SHUFFLE_MUSIC: "true"
```

### 4. Generate the compose file

```bash
docker run --rm \
  -v "$(pwd):/data" \
  --entrypoint node \
  ghcr.io/rorpage/reeltime-director:latest \
  /app/director/src/director.js mark /data/director.config.yaml
```

This writes `docker-compose.director.yml` into your working directory.

### 5. Start everything

```bash
docker compose -f docker-compose.director.yml up -d
```

| Service | URL |
|---------|-----|
| TV Guide | http://localhost:10000 |
| My Channel | http://localhost:10001 |
| WeatherStar 4000 | http://localhost:10002 |

Open the TV Guide in your browser. Add `http://localhost:10000/channels.m3u` and
`http://localhost:10000/xmltv` to Jellyfin, Plex, Channels DVR, or any
M3U/XMLTV-compatible app.

---

For more options - multiple reel channels, Scout web-page capture, custom ports,
and state persistence - see the [Director README](director/README.md).

---

## Tools

Utilities in the `tools/` folder for working with content.

| Tool | Description |
|------|-------------|
| [archive-org-import](tools/archive-org-import/README.md) | Import Archive.org content into a Reeltime config - single items or bulk season/episode ranges |
| [convert-audio](tools/convert-audio/README.md) | Convert non-MP3 audio files to MP3 for use with Mixer or Boom music directories |
| [convert-mkv](tools/convert-mkv/README.md) | Pre-transcode MKV files to H.264 MP4 to prevent buffering when streaming x265/10-bit sources |
| [merge-configs](tools/merge-configs/README.md) | Merge an Archive.org config (real URLs, durations) with a TVmaze config (clean metadata) into one, keyed on episode number |
| [tvmaze-import](tools/tvmaze-import/README.md) | Generate a Reeltime config scaffold from TVmaze episode data - fills in all metadata, leaving URL fields for you to complete |

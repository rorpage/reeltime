# 🎬 Director

Reeltime Director aggregates [Reel](../reel/README.md), [Scout](../scout/README.md), and [Boom](../boom/README.md) channels into a single TV guide. Point it at your channel configs and it gives you a dark neon guide UI, per-channel detail pages, an embedded player, XMLTV, M3U, and a health endpoint - no cloning required, just Docker.

---

## Quick Start

All you need is Docker.

### 1. Create a working directory

```bash
mkdir reeltime && cd reeltime
mkdir -p channels/channel1 channels/channel2
```

### 2. Create channel config files

Create `channels/channel1/config.yaml` and `channels/channel2/config.yaml`. A minimal example:

```yaml
stream:
  name: "Channel 1"
  loop: true
  loop_count: -1

videos:
  - title: "My Video"
    url: "https://example.com/video.mp4"
    duration: 3600
```

See [reel/config.example.yaml](../reel/config.example.yaml) for all available fields.

### 3. Create director.config.yaml

```yaml
director:
  name: "My Reeltime Director"

configs:
  - ./channels/channel1/config.yaml
  - ./channels/channel2/config.yaml
```

### 4. Mark - generate the compose file

```bash
docker run --rm \
  -v "$(pwd):/data" \
  --entrypoint node \
  ghcr.io/rorpage/reeltime-director:latest \
  /app/director/src/director.js mark /data/director.config.yaml
```

This writes `docker-compose.director.yml` into your working directory.

### 5. Action - start everything

```bash
docker compose -f docker-compose.director.yml up -d
docker compose -f docker-compose.director.yml logs -f
```

| Service    | URL                        |
|------------|----------------------------|
| Director   | http://localhost:10000      |
| Channel 1  | http://localhost:10001      |
| Channel 2  | http://localhost:10002      |

Ports are assigned sequentially (10001, 10002, …) in the order channels appear in `director.config.yaml`.

---

## Adding More Channels

1. Create the new channel directory and config (e.g. `channels/channel3/config.yaml`).
2. Add it to `director.config.yaml`:
   ```yaml
   configs:
     - ./channels/channel1/config.yaml
     - ./channels/channel2/config.yaml
     - ./channels/channel3/config.yaml   # ← new
   ```
3. Re-mark and restart:
   ```bash
   docker run --rm -v "$(pwd):/data" --entrypoint node \
     ghcr.io/rorpage/reeltime-director:latest \
     /app/director/src/director.js mark /data/director.config.yaml

   docker compose -f docker-compose.director.yml up -d
   ```

No manual port assignment, no editing the compose file by hand.

---

## Configuration

`director.config.yaml` format:

```yaml
director:
  name: "Reeltime Director"   # display name shown in the guide UI
  # port: 10000               # optional; overridden by PORT env var

configs:
  # ── Reel channels — point to a config.yaml file ──────────────────────────
  - ./channels/channel1/config.yaml
  - ./channels/channel2/config.yaml

  # Optional URL override (useful for remote hosts or non-standard ports):
  # - path: ./channels/channel3/config.yaml
  #   url:  http://my-other-host:9000

  # ── Scout / Boom channels — inline spec, no config file needed ───────────
  # - name:        "WeatherStar 4000"
  #   type:        boom
  #   description: "Live retro weather display"
  #   environment:
  #     ZIP_CODE:   "90210"
  #     WS4KP_HOST: "ws4kp"
  #     WS4KP_PORT: "8080"

  # - name:        "My Dashboard"
  #   type:        scout
  #   environment:
  #     CAPTURE_URL: "https://example.com/dashboard"
```

### Reel channel fields

| Field               | Required              | Description                                                                     |
|---------------------|-----------------------|---------------------------------------------------------------------------------|
| `configs[]`         | **Yes**               | Path to a Reeltime `config.yaml` (string or object with `path`)                 |
| `configs[].path`    | **Yes** (object form) | Path to a Reeltime config                                                        |
| `configs[].url`     | No                    | URL override (default: `http://reeltime-<id>:8080`)                             |

> Director derives each channel's `id` from `stream.channel_id` (if set) or by converting `stream.name` to `snake_case`. The Docker service name is `reeltime-{id}`.

### Scout / Boom inline fields

| Field                | Required   | Description                                              |
|----------------------|------------|----------------------------------------------------------|
| `name`               | **Yes**    | Channel display name                                     |
| `type`               | **Yes**    | `scout` or `boom`                                        |
| `id`                 | No         | Stable channel id (derived from `name` if omitted)       |
| `description`        | No         | Shown on the channel detail page                         |
| `url`                | No         | URL override (default: `http://reeltime-<id>:8080`)      |
| `environment`        | No         | Key/value env vars passed verbatim to the container      |

### Director fields

| Field           | Required | Description                                                    |
|-----------------|----------|----------------------------------------------------------------|
| `director.name` | No       | UI display name (default: `"Reeltime Director"`)               |
| `director.port` | No       | HTTP port (default: `10000`, overridden by `PORT` env var)     |

---

## State Persistence

Each reel container writes its playback state to `<configDir>/state.<channel_id>_reeltime.json`. With the volume mounts produced by `mark`, the state file for Channel 1 will be at `./channel1/state.channel_1_reeltime.json` on the host and survives container restarts.

---

## HTTP Endpoints

| Method  | Path            | Description                                                       |
|---------|-----------------|-------------------------------------------------------------------|
| GET     | `/`             | Dark neon guide UI - all channels, auto-refreshes every 5 s      |
| GET     | `/watch/:id`    | Embedded HLS.js player for the channel with the given id         |
| GET     | `/now`          | Aggregated now-playing JSON for all channels                     |
| GET     | `/xmltv`        | Combined XMLTV guide (merged from all channels)                  |
| GET     | `/xmltv.xml`    | Alias for `/xmltv`                                               |
| GET     | `/channels.m3u` | Aggregated M3U playlist (one entry per channel)                  |
| GET     | `/playlist.m3u` | Alias for `/channels.m3u`                                        |
| GET     | `/health`       | JSON: `{ status, uptime, channels: [{ id, name, online }] }`     |
| OPTIONS | `*`             | CORS preflight                                                   |

<details>
<summary>/now response shape</summary>

```json
{
  "name": "Reeltime Director",
  "channels": [
    {
      "id": "channel_1",
      "name": "Channel 1",
      "channelNum": 1,
      "port": 10001,
      "stream": "http://192.168.1.x:10001/stream.m3u8",
      "now": {
        "current": {
          "title": "Episode Title",
          "seriesTitle": "My Series",
          "subTitle": "",
          "episodeNum": "S01E03",
          "description": "In this episode...",
          "duration": 3600,
          "position": 120.5,
          "remaining": 3479.5,
          "progress": 0.0335,
          "startedAt": "2026-04-07T17:43:06.590Z",
          "endsAt": "2026-04-07T18:43:06.590Z"
        },
        "upcoming": [
          {
            "title": "Next Episode Title",
            "seriesTitle": "My Series",
            "subTitle": "",
            "episodeNum": "S01E04",
            "description": "In the next episode...",
            "duration": 3600,
            "startsAt": "2026-04-07T18:43:06.590Z",
            "endsAt": "2026-04-07T19:43:06.590Z"
          }
        ]
      },
      "online": true
    }
  ]
}
```

</details>

---

## Environment Variables

| Variable          | Default                        | Description                          |
|-------------------|--------------------------------|--------------------------------------|
| `DIRECTOR_CONFIG` | `/config/director.config.yaml` | Path to the YAML configuration file  |
| `PORT`            | `10000`                        | HTTP port the Director server listens on |

---

<details>
<summary>Development</summary>

### From source

```bash
# 1. Clone and copy config files
cp director/director.config.example.yaml director.config.yaml
cp reel/config.example.yaml channel1.config.yaml
cp reel/config.example.yaml channel2.config.yaml

# 2. Edit each channel config, then edit director.config.yaml to list them

# 3. Mark
npm run mark

# 4. Action
docker compose -f docker-compose.director.yml up --build
```

### Local (no Docker)

```bash
cd director
npm install
DIRECTOR_CONFIG=./director.config.yaml PORT=10000 npm start
```

### `mark` command

`mark` writes `docker-compose.director.yml` next to your config. Re-run it whenever you add, remove, or rename channels.

```bash
# From the project root (installs deps automatically):
npm run mark

# Or directly (after npm install --prefix director):
node director/src/director.js mark director.config.yaml           # pre-built images (default)
node director/src/director.js mark director.config.yaml --build   # build from source
```

### Tests

```bash
cd director && npm test
```

</details>

<details>
<summary>Architecture Notes</summary>

- **Config derivation** - at startup, Director reads each Reeltime config file once and caches the channel metadata (name, id, icon). The Docker service URL is deterministically derived as `http://reeltime-<id>:8080`, matching the names produced by `mark`.
- **Channel polling** - Director polls each channel's `/now` and `/health` endpoints every **10 seconds**. Results are stored in an in-memory `Map` keyed by channel id and served from cache on every request.
- **XMLTV proxy** - On each `/xmltv` request, Director fetches `/xmltv` from all channels concurrently and merges the resulting `<channel>` and `<programme>` elements into a single `<tv>` document.
- **M3U aggregation** - `buildAggregatedM3U` constructs the playlist entirely from config; no upstream fetch is needed.
- **No external HTTP framework** - routing uses a simple `if`/`match` handler built on `node:http`. CORS headers are added to every response.
- **Dark neon UI** - a static `index.html` served from `director/src/public/`; client-side JS fetches `/now` every 5 s and updates all channel cards in place, keeping a live clock in the top-right corner.

</details>

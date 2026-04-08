# Reeltime Director

## What is Director?

Reeltime Director is a companion service that aggregates multiple [Reeltime](../README.md) HLS stream instances into a single, unified guide. It provides a dark neon guide UI, an embedded player, combined XMLTV and M3U outputs, and a health endpoint — all without modifying any individual Reeltime instance.

---

## Features

- **Config-file driven** — point Director at your existing Reeltime `config.yaml` files; it reads channel names, IDs, and icons directly from them
- **Auto-naming** — Docker container/service names and internal URLs are derived automatically from each channel's `stream.name`
- **`generate` command** — prints a ready-to-use `docker-compose.director.yml` to stdout from your config in one step
- **Dark neon guide UI** — channel cards with live progress bars, now-playing info, and next-up, auto-refreshing every 5 seconds
- **Embedded HLS.js player** — per-channel player page with live now-playing ticker (polls every 5 s)
- **Combined XMLTV** — proxies and merges `/xmltv` from every channel into one document for Jellyfin / Plex / Emby
- **Aggregated M3U** — single `/channels.m3u` with one entry per channel
- **Health endpoint** — JSON summary of director uptime and per-channel online status
- **Zero dependencies beyond `js-yaml`** — uses only Node.js built-ins for HTTP

---

## Quick Start (Docker Compose — from source)

```bash
# 1. Copy config files
cp director/director.config.example.yaml director.config.yaml
cp reel/config.example.yaml channel1.config.yaml
cp reel/config.example.yaml channel2.config.yaml

# 2. Edit each channel config (stream.name is how Director names the channel)
#    channel1.config.yaml  → first Reeltime playlist
#    channel2.config.yaml  → second Reeltime playlist

# 3. Edit director.config.yaml to list your channel config files
#    (see Configuration section below)

# 4. Generate the compose file (installs director deps automatically)
npm run generate > docker-compose.director.yml

# 5. Start the stack
docker compose -f docker-compose.director.yml up --build
```

| Service    | URL                        |
|------------|----------------------------|
| Director   | http://localhost:10000      |
| Channel 1  | http://localhost:10001      |
| Channel 2  | http://localhost:10002      |

Ports are assigned sequentially (10001, 10002, …) in the order channels appear in `director.config.yaml`.

---

## Quick Start (Home Server — pre-built images)

If you don't want to clone the repository, you can use the pre-built images from the GitHub Container Registry.

### 1. Create a working directory

```bash
mkdir reeltime && cd reeltime
mkdir channel1 channel2
```

### 2. Create channel config files

Create `channel1/config.yaml` and `channel2/config.yaml`. A minimal example:

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

### 3. Create director.config.yaml

```yaml
director:
  name: "My Reeltime Director"
  port: 10000

configs:
  - ./channel1/config.yaml
  - ./channel2/config.yaml
```

### 4. Create docker-compose.yml

```yaml
services:

  director:
    image: ghcr.io/rorpage/reeltime-director:latest
    container_name: reeltime-director
    restart: unless-stopped
    ports:
      - "10000:10000"
    volumes:
      - ./director.config.yaml:/config/director.config.yaml:ro
      - ./channel1/config.yaml:/config/channel1_config.yaml:ro
      - ./channel2/config.yaml:/config/channel2_config.yaml:ro
    environment:
      PORT: "10000"
      DIRECTOR_CONFIG: "/config/director.config.yaml"
    depends_on:
      - reeltime-channel_1
      - reeltime-channel_2

  reeltime-channel_1:
    image: ghcr.io/rorpage/reeltime:latest
    container_name: reeltime-channel_1
    restart: unless-stopped
    ports:
      - "10001:8080"
    volumes:
      - ./channel1:/config
    environment:
      PORT: "8080"
      CONFIG_PATH: "/config/config.yaml"
      STATE_MAX_AGE_SEC: "604800"

  reeltime-channel_2:
    image: ghcr.io/rorpage/reeltime:latest
    container_name: reeltime-channel_2
    restart: unless-stopped
    ports:
      - "10002:8080"
    volumes:
      - ./channel2:/config
    environment:
      PORT: "8080"
      CONFIG_PATH: "/config/config.yaml"
      STATE_MAX_AGE_SEC: "604800"
```

> **Note:** The service names (`reeltime-channel_1`, `reeltime-channel_2`) must match the `channel_id` derived from each channel's `stream.name` in snake_case. If your `stream.name` is `"Channel 1"` the derived id is `channel_1`, so the service is `reeltime-channel_1`. Set `stream.channel_id` explicitly in your channel config if you want a predictable id.
>
> The director config references config files at `/config/channel1_config.yaml` and `/config/channel2_config.yaml` inside the container. Update the `configs:` paths in `director.config.yaml` to match those mounted paths:
> ```yaml
> configs:
>   - /config/channel1_config.yaml
>   - /config/channel2_config.yaml
> ```

### 5. Start the stack

```bash
docker compose up -d
docker compose logs -f
```

> **Tip:** If you have Node.js installed locally, you can use the `generate` command instead of writing the compose file by hand:
> ```bash
> docker run --rm \
>   -v "$(pwd)/director.config.yaml:/data/director.config.yaml:ro" \
>   -v "$(pwd)/channel1/config.yaml:/data/channel1/config.yaml:ro" \
>   -v "$(pwd)/channel2/config.yaml:/data/channel2/config.yaml:ro" \
>   --entrypoint node \
>   ghcr.io/rorpage/reeltime-director:latest \
>   /app/director/src/director.js generate /data/director.config.yaml \
>   > docker-compose.director.yml
> ```
> Then edit the generated file to replace `build:` / `context:` / `dockerfile:` with `image:` for each service.

### State persistence

Each reel container writes its playback state to `<configDir>/state.<channel_id>_reeltime.json`. With the volume mounts above (`./channel1:/config`), the state file for Channel 1 will be created at `./channel1/state.channel_1_reeltime.json` on the host and will survive container restarts and recreation.

---

## Quick Start (Local)

```bash
cd director
npm install
# create/edit a local director.config.yaml (see Configuration below)
DIRECTOR_CONFIG=./director.config.yaml PORT=10000 npm start
```

---

## Configuration

Edit `director.config.yaml` (copy from `director.config.example.yaml`):

```yaml
director:
  name: "Reeltime Director"   # display name shown in the guide UI
  # port: 10000               # optional; overridden by PORT env var

configs:
  # Paths to Reeltime config.yaml files (relative to this file, or absolute).
  # Director reads stream.name, stream.channel_id, and stream.icon from each.
  - ./channel1.config.yaml
  - ./channel2.config.yaml

  # Optional: override the URL if the instance is not on the default Docker URL:
  # - path: ./channel3.config.yaml
  #   url:  http://my-other-host:9000
```

| Field               | Required | Description                                                                       |
|---------------------|----------|-----------------------------------------------------------------------------------|
| `director.name`     | No       | UI display name (default: `"Reeltime Director"`)                                  |
| `director.port`     | No       | HTTP port (default: `10000`, overridden by `PORT` env var)                        |
| `configs[]`         | **Yes**  | List of paths to Reeltime `config.yaml` files                                     |
| `configs[].path`    | **Yes*** | Path to a Reeltime config (when using the object form)                            |
| `configs[].url`     | No       | URL override (default: `http://reeltime-<id>:8080` derived from `stream.name`)   |

> Director derives each channel's `id` from `stream.channel_id` (if set) or by converting `stream.name` to `snake_case`. The Docker service name is `reeltime-{id}`.

---

## `generate` Command

After editing `director.config.yaml`, regenerate `docker-compose.director.yml` whenever you add, remove, or rename channels:

```bash
# From the project root — installs director dependencies automatically:
npm run generate > docker-compose.director.yml

# Or manually from inside director/ (after npm install):
npm install
node src/director.js generate ../director.config.yaml > ../docker-compose.director.yml

# Or without the root npm wrapper (from project root, after dependencies are installed):
node director/src/director.js generate director.config.yaml > docker-compose.director.yml
```

The generated file includes:
- A `director` service with correct volume mounts for the director config and all channel configs
- One `reeltime-{id}` service per channel with the right port, volume mount, and health check
- `depends_on` so the director waits for all channels to start

---

## Environment Variables

| Variable          | Default                          | Description                                      |
|-------------------|----------------------------------|--------------------------------------------------|
| `DIRECTOR_CONFIG` | `/config/director.config.yaml`   | Path to the YAML configuration file              |
| `PORT`            | `10000`                          | HTTP port the Director server listens on         |

---

## HTTP Endpoints

| Method | Path              | Description                                                        |
|--------|-------------------|--------------------------------------------------------------------|
| GET    | `/`               | Dark neon guide UI — all channels, auto-refreshes every 5 s       |
| GET    | `/watch/:id`      | Embedded HLS.js player for the channel with the given id          |
| GET    | `/now`            | Aggregated now-playing JSON for all channels                      |
| GET    | `/xmltv`          | Combined XMLTV guide (merged from all channels)                   |
| GET    | `/xmltv.xml`      | Alias for `/xmltv`                                                |
| GET    | `/channels.m3u`   | Aggregated M3U playlist (one entry per channel)                   |
| GET    | `/playlist.m3u`   | Alias for `/channels.m3u`                                         |
| GET    | `/health`         | JSON: `{ status, uptime, channels: [{ id, name, url, online }] }` |
| OPTIONS| `*`               | CORS preflight                                                    |

### `/now` response shape

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
          "title": "Video Title",
          "duration": 3600,
          "position": 120.5,
          "remaining": 3479.5,
          "progress": 0.0335,
          "startedAt": "2026-04-07T17:43:06.590Z",
          "endsAt": "2026-04-07T18:43:06.590Z"
        },
        "next": {
          "title": "Next Video Title",
          "duration": 3600,
          "startsAt": "2026-04-07T18:43:06.590Z"
        }
      },
      "online": true
    }
  ]
}
```

---

## Adding More Channels

1. Create a new Reeltime `config.yaml` (e.g. `channel3.config.yaml`) with the channel's playlist.
2. Add it to `director.config.yaml`:
   ```yaml
   configs:
     - ./channel1.config.yaml
     - ./channel2.config.yaml
     - ./channel3.config.yaml   # ← new
   ```
3. Regenerate the compose file:
   ```bash
   node director/src/director.js generate director.config.yaml > docker-compose.director.yml
   ```
4. Restart the stack:
   ```bash
   docker compose -f docker-compose.director.yml up --build
   ```

That's it — no manual port assignment, no editing the compose file by hand.

---

## Tests

```bash
cd director
npm test
# or
node --test src/director.test.js
```

All tests use `node:test` and `node:assert/strict` — no external testing libraries required.

---

## Architecture Notes

- **Config derivation** — at startup, Director reads each Reeltime config file once and caches the channel metadata (name, id, icon). The Docker service URL is deterministically derived as `http://reeltime-<id>:8080`, matching the names produced by `generate`.
- **Channel polling** — Director polls each channel's `/now` and `/health` endpoints every **10 seconds**. Results are stored in an in-memory `Map` keyed by channel id and served from cache on every request.
- **XMLTV proxy** — On each `/xmltv` request, Director fetches `/xmltv` from all channels concurrently and merges the resulting `<channel>` and `<programme>` elements into a single `<tv>` document.
- **M3U aggregation** — `buildAggregatedM3U` constructs the playlist entirely from config; no upstream fetch is needed.
- **No external HTTP framework** — routing uses a simple `if`/`match` handler built on `node:http`. CORS headers are added to every response.
- **Dark neon UI** — a static `index.html` served from `director/src/public/`; client-side JS fetches `/now` every 5 s and updates all channel cards in place, keeping a live clock in the top-right corner.


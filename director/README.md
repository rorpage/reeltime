# Reeltime Director

## What is Director?

Reeltime Director is a companion service that aggregates multiple [Reeltime](../README.md) HLS stream instances into a single, unified guide. It provides a dark neon guide UI, an embedded player, combined XMLTV and M3U outputs, and a health endpoint — all without modifying any individual Reeltime instance.

---

## Features

- **Config-file driven** — point Director at your existing Reeltime `config.yaml` files; it reads channel names, IDs, and icons directly from them
- **Auto-naming** — Docker container/service names and internal URLs are derived automatically from each channel's `stream.name`
- **`generate` command** — prints a ready-to-use `docker-compose.director.yml` to stdout from your config in one step
- **Dark neon guide UI** — channel cards with live progress bars, now-playing info, and next-up, auto-refreshing every 30 seconds
- **Embedded HLS.js player** — per-channel player page with live now-playing ticker (polls every 5 s)
- **Combined XMLTV** — proxies and merges `/xmltv` from every channel into one document for Jellyfin / Plex / Emby
- **Aggregated M3U** — single `/channels.m3u` with one entry per channel
- **Health endpoint** — JSON summary of director uptime and per-channel online status
- **Zero dependencies beyond `js-yaml`** — uses only Node.js built-ins for HTTP

---

## Quick Start (Docker Compose)

```bash
# 1. Copy config files
cp director/director.config.example.yaml director.config.yaml
cp config.example.yaml channel1.config.yaml
cp config.example.yaml channel2.config.yaml

# 2. Edit each channel config (stream.name is how Director names the channel)
#    channel1.config.yaml  → first Reeltime playlist
#    channel2.config.yaml  → second Reeltime playlist

# 3. Edit director.config.yaml to list your channel config files
#    (see Configuration section below)

# 4. Generate the compose file
node director/src/director.js generate > docker-compose.director.yml

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
# From the project root:
node director/src/director.js generate > docker-compose.director.yml

# Or using the npm script (from inside director/):
DIRECTOR_CONFIG=../director.config.yaml npm run generate > ../docker-compose.director.yml
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
| GET    | `/`               | Dark neon guide UI — all channels, auto-refreshes every 30 s      |
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
  "channels": [
    {
      "id": "channel_1",
      "name": "Channel 1",
      "url": "http://reeltime-channel_1:8080",
      "now": { "title": "...", "progress": 0.42, "remaining": 1200, "next": "..." },
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
   node director/src/director.js generate > docker-compose.director.yml
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
- **Dark neon UI** — rendered server-side from cached poll state; the browser only runs a clock updater and a 30-second `location.reload()`.


# Reeltime Director

## What is Director?

Reeltime Director is a companion service that aggregates multiple [Reeltime](../README.md) HLS stream instances into a single, unified guide. It provides a dark neon guide UI, an embedded player, combined XMLTV and M3U outputs, and a health endpoint — all without modifying any individual Reeltime instance.

---

## Features

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

# 2. Edit each config to taste
#    director.config.yaml  → director name + channel URLs
#    channel1.config.yaml  → first Reeltime playlist
#    channel2.config.yaml  → second Reeltime playlist

# 3. Start the stack
docker compose -f docker-compose.director.yml up --build
```

| Service    | URL                        |
|------------|----------------------------|
| Director   | http://localhost:10000      |
| Channel 1  | http://localhost:10001      |
| Channel 2  | http://localhost:10002      |

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

channels:
  - name: "Channel 1"         # required — display name
    # id: "channel_1"         # optional — stable id; auto-derived from name
    url: "http://reeltime-1:8080"   # required — base URL of the Reeltime instance

  - name: "Channel 2"
    url: "http://reeltime-2:8080"
```

| Field               | Required | Description                                                        |
|---------------------|----------|--------------------------------------------------------------------|
| `director.name`     | No       | UI display name (default: `"Reeltime Director"`)                   |
| `director.port`     | No       | HTTP port (default: `10000`, overridden by `PORT` env var)         |
| `channels[].name`   | **Yes**  | Human-readable channel name                                        |
| `channels[].url`    | **Yes**  | Base URL of the Reeltime instance (no trailing slash)              |
| `channels[].id`     | No       | Stable identifier; auto-derived from `name` as `snake_case` if absent |

---

## Environment Variables

| Variable          | Default                          | Description                                      |
|-------------------|----------------------------------|--------------------------------------------------|
| `DIRECTOR_CONFIG` | `/config/director.config.yaml`   | Path to the YAML configuration file              |
| `PORT`            | `10000`                          | HTTP port the Director server listens on         |

---

## HTTP Endpoints

| Method | Path              | Description                                                     |
|--------|-------------------|-----------------------------------------------------------------|
| GET    | `/`               | Dark neon guide UI — all channels, auto-refreshes every 30 s   |
| GET    | `/watch/:id`      | Embedded HLS.js player for channel with the given id           |
| GET    | `/now`            | Aggregated now-playing JSON for all channels                   |
| GET    | `/xmltv`          | Combined XMLTV guide (merged from all channels)                |
| GET    | `/xmltv.xml`      | Alias for `/xmltv`                                             |
| GET    | `/channels.m3u`   | Aggregated M3U playlist (one entry per channel)                |
| GET    | `/playlist.m3u`   | Alias for `/channels.m3u`                                      |
| GET    | `/health`         | JSON: `{ status, uptime, channels: [{ id, name, url, online }] }` |
| OPTIONS| `*`               | CORS preflight                                                 |

### `/now` response shape

```json
{
  "channels": [
    {
      "id": "channel_1",
      "name": "Channel 1",
      "url": "http://reeltime-1:8080",
      "now": { "title": "...", "progress": 0.42, "remaining": 1200, "next": "..." },
      "online": true
    }
  ]
}
```

---

## Adding More Channels

1. Add an entry to `director.config.yaml`:
   ```yaml
   - name: "Channel 3"
     url: "http://reeltime-3:8080"
   ```
2. Start another Reeltime instance on the next port (e.g. `10003`) with its own playlist config.
3. In `docker-compose.director.yml`, add a `reeltime-3` service following the same pattern as `reeltime-1` / `reeltime-2`.
4. Restart the Director (it re-reads config on startup).

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

- **Channel polling** — Director polls each channel's `/now` and `/health` endpoints every **10 seconds**. Results are stored in an in-memory `Map` keyed by channel id and served from cache on every request.
- **XMLTV proxy** — On each `/xmltv` request, Director fetches `/xmltv` from all channels concurrently and merges the resulting `<channel>` and `<programme>` elements into a single `<tv>` document.
- **M3U aggregation** — `buildAggregatedM3U` constructs the playlist entirely from config; no upstream fetch is needed.
- **No external HTTP framework** — routing uses a simple `if`/`match` handler built on `node:http`. CORS headers are added to every response.
- **Dark neon UI** — rendered server-side from cached poll state; the browser only runs a clock updater and a 30-second `location.reload()`.

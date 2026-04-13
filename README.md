# Reeltime

A self-hosted continuous HLS video streaming suite.

| Service | Description |
|---------|-------------|
| **Reel** | Single-channel HLS streamer — loops a YAML playlist as a live m3u8 feed |
| **Director** | Multi-channel guide — aggregates N Reel instances into one UI, XMLTV, and M3U |

**Just want to get running?** See the [Director quick start](director/README.md) — all you need is Docker.

**Single channel only?** See the [Reel quick start](reel/README.md).

---

## Tools

Utilities in the `tools/` folder for working with content.

| Tool | Description |
|------|-------------|
| [archive-org-import](tools/archive-org-import/README.md) | Import Archive.org content into a Reeltime config — single items or bulk season/episode ranges |
| [convert-mkv](tools/convert-mkv/README.md) | Pre-transcode MKV files to H.264 MP4 to prevent buffering when streaming x265/10-bit sources |
| [merge-configs](tools/merge-configs/README.md) | Merge an Archive.org config (real URLs, durations) with a TVmaze config (clean metadata) into one, keyed on episode number |
| [tvmaze-import](tools/tvmaze-import/README.md) | Generate a Reeltime config scaffold from TVmaze episode data — fills in all metadata, leaving URL fields for you to complete |

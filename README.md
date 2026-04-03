# Reeltime

A self-hosted continuous HLS video streaming suite built with Node.js and ffmpeg.

## Services

| Service | Description | Docs |
|---------|-------------|------|
| **Reel** | Single-channel HLS video streamer — reads a YAML playlist and loops it as a live m3u8 feed | [reel/README.md](reel/README.md) |
| **Director** | Multi-channel guide aggregator — combines N Reel instances into a single guide UI, XMLTV feed, and M3U tuner | [director/README.md](director/README.md) |

## Quick Start (single channel)

See [reel/README.md](reel/README.md).

## Quick Start (multi-channel with Director)

See [director/README.md](director/README.md).

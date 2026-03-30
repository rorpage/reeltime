# Reeltime

Reeltime is a self-hosted continuous HLS video streamer built with Node.js and ffmpeg.
It reads a YAML playlist and streams videos in a continuous loop as a live m3u8 feed.

## Features

- Single ffmpeg process fed by a named FIFO using ffconcat.
- Infinite mode uses bounded prefill plus automatic rollover/retry.
- Built-in web player with now-playing ticker and progress bar.
- XMLTV output for Live TV integrations.
- M3U tuner endpoint for Jellyfin, Plex (via xTeve/Threadfin), Emby, and Kodi.
- Health endpoint with loop and queue state.

## Requirements

- Node.js 20 or newer for local development.
- ffmpeg installed locally if running outside Docker.
- Docker and Docker Compose if running containerized.

Notes:
- Docker image currently uses Node 22 Alpine.
- package.json engine is set to Node >= 20.

## Quick Start (Docker Compose)

1. Copy the sample config:

	cp config.example.yaml config.yaml

2. Edit config.yaml with your video URLs and durations.

3. Start the service:

	docker compose up --build

4. Open:

- Player: http://localhost:8080/
- Stream: http://localhost:8080/stream.m3u8
- Health: http://localhost:8080/health

## Quick Start (Local)

1. Install dependencies:

	npm install

2. Copy config and edit it:

	cp config.example.yaml config.yaml

3. Set environment variables (optional) and start:

	CONFIG_PATH=./config.yaml npm start

On Windows PowerShell:

	$env:CONFIG_PATH = ".\\config.yaml"
	npm start

## Configuration

Main config file: config.yaml

Structure:

stream:
- name: display name
- channel_id: stable URL-safe channel id used by XMLTV/M3U
- loop: true or false
- loop_count: -1 for infinite, or N for finite loops

videos:
- title: display title
- url: source URL (http/https/rtmp/file)
- duration: seconds to queue for each clip
- description: optional XMLTV description
- category: optional XMLTV category

See full example in config.example.yaml.

## Environment Variables

- CONFIG_PATH (default /config/config.yaml)
- HLS_DIR (default /tmp/hls)
- FIFO_PATH (default /tmp/playlist.ffconcat)
- PORT (default 8080)
- HLS_SEG (default 6)
- HLS_SIZE (default 10)
- RESOLUTION (default 1280:720)
- VIDEO_BITRATE (default 2000k)
- AUDIO_BITRATE (default 128k)
- FRAMERATE (default 30)
- FFMPEG_THREADS (default 0, auto)
- FOREVER_PASSES (default 100, batch size per rollover cycle when loop_count is -1)
- DEBUG (set to 1 for verbose logs)

## HTTP Endpoints

- GET / : HLS.js web player with now-playing ticker
- GET /stream.m3u8 : live HLS playlist (returns 503 JSON while starting/retrying)
- GET /seg_*.ts : MPEG-TS segments
- GET /now : JSON now-playing status and next item
- GET /xmltv : XMLTV guide (supports ?hours=1-24, default 4)
- GET /xmltv.xml : alias for /xmltv
- GET /channels.m3u : M3U tuner file
- GET /playlist.m3u : alias for /channels.m3u
- GET /health : health, uptime, and loop state

## Jellyfin/Plex/Emby Setup

Use these URLs:

- M3U tuner: http://<host>:8080/channels.m3u
- XMLTV guide: http://<host>:8080/xmltv

The generated M3U includes x-tvg-url pointing to /xmltv to simplify setup.

## Docker

Build and run directly:

docker build -t reeltime .
docker run -p 8080:8080 -v $(pwd)/config.yaml:/config/config.yaml:ro reeltime

On Windows PowerShell:

docker run -p 8080:8080 -v ${PWD}/config.yaml:/config/config.yaml:ro reeltime

## Development Notes

- Runtime HLS output is written to /tmp/hls.
- The schedule model is wall-clock aligned and used by both /now and /xmltv.
- Infinite mode pre-fills ffconcat input in batches and auto-restarts cycles.
- Logging is timestamped in ISO-8601 UTC format.

## License

Unlicense

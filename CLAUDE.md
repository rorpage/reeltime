# Reeltime - Claude Instructions

## Writing style

- **US English** throughout - code, comments, docs, YAML, scripts, responses. Use "behavior" not "behaviour", "color" not "colour", "initialize" not "initialise", etc.
- **No em dashes** — use ` - ` (space, hyphen, space) as a separator. Never use `—` or `--` as a prose separator.
- **No emojis** unless the user explicitly asks for them.

## Git behavior

- **Never stage or commit** unless the user explicitly asks. Make the file changes and stop.
- Never use `--no-verify` or skip hooks unless explicitly asked.

## Project overview

Reeltime is a self-hosted continuous HLS video streaming suite:

- **Reel** (`reel/`) - single-channel HLS streamer; loops a YAML playlist as a live m3u8 feed
- **Scout** (`scout/`) - generic web-page HLS streamer; captures any URL via Puppeteer + ffmpeg as a live channel
- **Boom** (`boom/`) - WeatherStar 4000 HLS streamer; captures the WS4KP weather display as a retro weather channel
- **Director** (`director/`) - multi-channel guide; aggregates Reel, Scout, and Boom instances into one UI, XMLTV, and M3U

## Shared utilities

`shared/utils.js` contains utilities used by Reel, Scout, Boom, and Director, and is also imported by tools:

- `toSnakeCase(str, fallback)` - converts a string to snake_case
- `escHtml(s)` - HTML-escapes a string for output
- `escXML(s)` - XML-escapes a string for output
- `stripHtml(s)` - strips HTML tags and decodes entities from a string
- `shuffleArray(arr)` - Fisher-Yates shuffle; returns a new array, does not mutate the input
- `buildAudioList({ musicDir, shuffle, listPath, info, warn })` - scans a directory for MP3 files, writes an ffconcat playlist, returns true if files were found

When writing tools or scripts that need these functions, require from `shared/utils.js` rather than reimplementing.

## Tools

Standalone utilities live in `tools/`. Each has its own subfolder with a README.

| Tool | What it does |
|---|---|
| `tools/convert-mkv/` | Pre-transcode MKV files to H.264 MP4 to prevent buffering on x265/10-bit sources |
| `tools/archive-org-import/` | Import Archive.org content into a Reeltime config - single items or bulk season/episode ranges |
| `tools/tvmaze-import/` | Generate a Reeltime config scaffold from TVmaze episode data |
| `tools/merge-configs/` | Merge an Archive.org config (URLs, durations) with a TVmaze config (clean metadata), keyed on episode number |

## Config shape (config.yaml)

```yaml
stream:
  name:        string   # display name
  icon:        string   # optional XMLTV channel icon URL
  channel_id:  string   # optional; defaults to stream.name in snake_case
  loop:        boolean  # default true
  loop_count:  number   # -1 = infinite

videos:
  - title:        string
    series_title: string   # optional XMLTV series/program title
    sub_title:    string   # optional XMLTV episode subtitle
    episode_num:  string   # optional XMLTV onscreen episode number (e.g. S01E07)
    date:         string   # optional XMLTV date (YYYYMMDD or YYYY)
    url:          string   # http/https/rtmp/file
    icon:         string   # optional XMLTV programme icon URL
    duration:     number   # seconds
    description:  string   # optional, for XMLTV
    category:     string   # optional, for XMLTV
```

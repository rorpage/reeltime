# archive-org-import

Two tools for bulk-importing Archive.org content into a Reeltime playlist config.

---

## Why

[Archive.org](https://archive.org) hosts a large library of legally free content - classic TV series, films, documentaries, and other public domain material. These tools let you import a whole series from Archive.org directly into a `config.yaml` without writing entries by hand.

---

## Tools

### archive_to_config.js

Fetches a single Archive.org item, finds its video files, and appends them as YAML entries to a Reeltime config.

What it does:

- Fetches the Archive.org metadata API for the given identifier
- Filters to video files (.mp4, .mkv, .webm, etc.), preferring MP4 over MKV when both exist for the same episode
- Probes each video's real duration via `ffprobe` (or falls back to archive metadata with `--no-probe`)
- Infers episode numbers from filenames and metadata (SnnEnn or NxNN format)
- Cleans up episode titles by stripping the show name prefix and episode markers
- Sets the stream `icon` from the item's thumbnail if not already present in the config
- Skips URLs already present in the config (safe to re-run)

### import_archive_range.sh

A bash wrapper around `archive_to_config.js` that loops over a season/episode range using a template identifier pattern.

---

## Requirements

- Node.js 20+
- `ffprobe` on your PATH (or pass `--no-probe` to skip duration probing)
- A Reeltime `config.yaml` to append to

---

## Usage

### Single item

```bash
node tools/archive-org-import/archive_to_config.js \
  --item https://archive.org/details/my-show-identifier
```

Or just pass the identifier directly (no full URL needed):

```bash
node tools/archive-org-import/archive_to_config.js --item my-show-identifier
```

### Range of episodes

Use `import_archive_range.sh` when Archive.org has one item per episode and the identifiers follow a predictable pattern with `{season}` and `{episode}` placeholders:

```bash
bash tools/archive-org-import/import_archive_range.sh \
  --template "my-show-s{season}e{episode}-bluray-1080p" \
  --season-start 1 --season-end 2 \
  --episode-start 1 --episode-end 24
```

### Dry run

Pass `--dry-run` to see what would be added without touching the config:

```bash
bash tools/archive-org-import/import_archive_range.sh \
  --template "my-show-s{season}e{episode}-bluray-1080p" \
  --season-start 1 --season-end 1 \
  --episode-start 1 --episode-end 6 \
  --dry-run
```

---

## Options

### archive_to_config.js

| Option | Default | Description |
|---|---|---|
| `--item <url-or-id>` | required | Archive.org URL or identifier |
| `--config <path>` | `./config.yaml` | Path to the Reeltime config to append to |
| `--category <name>` | `Series` | XMLTV category for imported entries |
| `--no-probe` | off | Skip `ffprobe` and use archive metadata durations |
| `--dry-run` | off | Show what would be added without writing |

### import_archive_range.sh

| Option | Default | Description |
|---|---|---|
| `--template <value>` | required | Identifier template with `{season}` and `{episode}` |
| `--season-start <n>` | required | First season number |
| `--season-end <n>` | required | Last season number (inclusive) |
| `--episode-start <n>` | required | First episode number per season |
| `--episode-end <n>` | required | Last episode number per season (inclusive) |
| `--config <path>` | `./config.yaml` | Path to the Reeltime config |
| `--category <name>` | `Series` | XMLTV category for imported entries |
| `--pad <n>` | `2` | Zero-pad width for season/episode numbers |
| `--no-probe` | off | Pass `--no-probe` through to the JS helper |
| `--dry-run` | off | Pass `--dry-run` through to the JS helper |
| `--node <path>` | `node` | Node executable (if not on PATH) |

---

## Notes

- **Re-running is safe.** Both tools deduplicate by URL - entries already in the config are skipped every time.
- **--no-probe is faster** but archive metadata durations can be inaccurate. Use it for a quick preview or when `ffprobe` is unavailable; remove it for a final import.
- **Episode numbering** is inferred from the archive identifier and filename. If Archive.org filenames don't follow SnnEnn or NxNN conventions, the `episode_num` field will be left blank.
- **Icon** is set once on the stream block from the item thumbnail. If your config already has an icon it will not be overwritten.
- The `series_title` in each entry is taken from the `stream.name` in your config. Set that before importing.

---

## Requirements

- `ffmpeg` / `ffprobe` must be installed and on your PATH (unless using `--no-probe`)
- Node.js 20+
- Bash 4.0+ (standard on Linux; on macOS install via `brew install bash`)

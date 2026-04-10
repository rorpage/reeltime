# tvmaze-import

Generates a Reeltime-compatible playlist config from a TV show's episode data via the [TVmaze public API](https://www.tvmaze.com/api).

---

## Why

Setting up a new channel for a TV series means creating a YAML entry for every episode - title, episode number, air date, description, icon, duration. This tool fetches all of that from TVmaze and writes a ready-to-use config scaffold in one command. The only thing left to fill in is the `url` for each episode.

---

## What it does

- Searches TVmaze by show name (or fetches directly by TVmaze ID)
- Pulls every episode across all seasons, or just one season with `--season`
- Writes a complete `config.yaml` with the `stream:` block and a `videos:` entry per episode
- Leaves the `url` field blank with a `# TODO` comment on each entry
- Output filename defaults to `<show-slug>.yaml` (e.g. `brooklyn-nine-nine.yaml`)

---

## Requirements

- Node.js 18+ (uses built-in `fetch` - no npm dependencies needed)
- Internet access to reach `api.tvmaze.com`

---

## Usage

```bash
node tools/tvmaze-import/tvmaze_import.js "<show name>"
node tools/tvmaze-import/tvmaze_import.js --id <tvmaze_id>
```

**Search by name:**
```bash
node tools/tvmaze-import/tvmaze_import.js "Brooklyn Nine-Nine"
```

**Fetch a single season:**
```bash
node tools/tvmaze-import/tvmaze_import.js "Brooklyn Nine-Nine" --season 2
```

**Fetch by TVmaze ID (skips search, more reliable):**
```bash
node tools/tvmaze-import/tvmaze_import.js --id 49
```

**Specify output filename:**
```bash
node tools/tvmaze-import/tvmaze_import.js --id 49 --season 2 --output brooklyn-nine-nine-s02.yaml
```

Find a show's TVmaze ID in its page URL — for example `https://www.tvmaze.com/shows/49/brooklyn-nine-nine` has ID `49`.

---

## Options

| Option | Description |
|---|---|
| `"<show name>"` | Search TVmaze by name (returns best match) |
| `--id <n>` | Fetch show directly by TVmaze ID (mutually exclusive with name search) |
| `--season <n>` | Only include episodes from this season |
| `--output <file>` | Output filename (default: `<show-slug>.yaml` or `<show-slug>-s<nn>.yaml`) |

---

## Output format

The generated YAML is a valid Reeltime config with `url` fields left blank:

```yaml
stream:
  name:       "Brooklyn Nine-Nine"
  icon:       "https://static.tvmaze.com/..."
  loop:       true
  loop_count: -1

videos:
  - title:        "Pilot"
    series_title: "Brooklyn Nine-Nine"
    sub_title:    "Pilot"
    episode_num:  "S01E01"
    date:         "20130917"
    url:          ""  # TODO: replace with actual video URL
    icon:         "https://static.tvmaze.com/..."
    duration:     1320
    description:  "Detective Jake Peralta..."
    category:     "Series"
```

Once you have the config, fill in each `url` with the path to your video file or stream URL, then point a Reel instance at the file.

---

## Tests

```bash
node --test tools/tvmaze-import/tvmaze_import.test.js
```

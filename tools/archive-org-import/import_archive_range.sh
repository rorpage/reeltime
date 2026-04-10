#!/usr/bin/env bash

set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HELPER="$SCRIPT_DIR/archive_to_config.js"

usage() {
  cat <<'EOF'
Usage:
  bash tools/archive-org-import/import_archive_range.sh \
    --template "my-show-s{season}e{episode}-bluray-1080p" \
    --season-start 1 --season-end 4 --episode-start 1 --episode-end 24 [options]

Required:
  --template <value>       Archive identifier or URL template. Must include {season} and {episode}.
  --season-start <n>       Starting season number.
  --season-end <n>         Ending season number (inclusive).
  --episode-start <n>      Starting episode number per season.
  --episode-end <n>        Ending episode number per season (inclusive).

Optional:
  --config <path>          Config YAML path (default: ./config.yaml)
  --category <name>        Category for imported videos (default: Series)
  --dry-run                Do not write config, just show what would be added
  --no-probe               Skip ffprobe and use archive metadata durations
  --pad <n>                Zero-pad width for season/episode (default: 2)
  --node <path>            Node executable (default: node)
  --help                   Show this help

Examples:
  bash tools/archive-org-import/import_archive_range.sh \
    --template "my-show-s{season}e{episode}-bluray-1080p" \
    --season-start 1 --season-end 1 --episode-start 1 --episode-end 22

  bash tools/archive-org-import/import_archive_range.sh \
    --template "https://archive.org/details/my-show-s{season}e{episode}-bluray-1080p" \
    --season-start 1 --season-end 1 --episode-start 1 --episode-end 22 --dry-run
EOF
}

TEMPLATE=""
SEASON_START=""
SEASON_END=""
EPISODE_START=""
EPISODE_END=""
CONFIG_PATH="$ROOT_DIR/config.yaml"
CATEGORY="Series"
DRY_RUN=0
NO_PROBE=0
PAD=2
NODE_BIN="node"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --template)
      TEMPLATE="${2:-}"
      shift 2
      ;;
    --season-start)
      SEASON_START="${2:-}"
      shift 2
      ;;
    --season-end)
      SEASON_END="${2:-}"
      shift 2
      ;;
    --episode-start)
      EPISODE_START="${2:-}"
      shift 2
      ;;
    --episode-end)
      EPISODE_END="${2:-}"
      shift 2
      ;;
    --config)
      CONFIG_PATH="${2:-}"
      shift 2
      ;;
    --category)
      CATEGORY="${2:-}"
      shift 2
      ;;
    --pad)
      PAD="${2:-}"
      shift 2
      ;;
    --node)
      NODE_BIN="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --no-probe)
      NO_PROBE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$TEMPLATE" || -z "$SEASON_START" || -z "$SEASON_END" || -z "$EPISODE_START" || -z "$EPISODE_END" ]]; then
  echo "Missing required arguments." >&2
  usage
  exit 1
fi

if [[ "$TEMPLATE" != *"{season}"* || "$TEMPLATE" != *"{episode}"* ]]; then
  echo "Template must contain both {season} and {episode} placeholders." >&2
  exit 1
fi

if ! [[ "$SEASON_START" =~ ^[0-9]+$ && "$SEASON_END" =~ ^[0-9]+$ && "$EPISODE_START" =~ ^[0-9]+$ && "$EPISODE_END" =~ ^[0-9]+$ && "$PAD" =~ ^[0-9]+$ ]]; then
  echo "Season/episode bounds and pad must be non-negative integers." >&2
  exit 1
fi

if (( SEASON_START > SEASON_END )); then
  echo "season-start must be <= season-end" >&2
  exit 1
fi
if (( EPISODE_START > EPISODE_END )); then
  echo "episode-start must be <= episode-end" >&2
  exit 1
fi

if [[ ! -f "$HELPER" ]]; then
  echo "Helper not found: $HELPER" >&2
  exit 1
fi

attempts=0
ok=0
skipped=0

for (( season=SEASON_START; season<=SEASON_END; season++ )); do
  printf -v s "%0${PAD}d" "$season"

  for (( episode=EPISODE_START; episode<=EPISODE_END; episode++ )); do
    printf -v e "%0${PAD}d" "$episode"

    item="${TEMPLATE//\{season\}/$s}"
    item="${item//\{episode\}/$e}"

    attempts=$((attempts + 1))
    echo "[$attempts] importing s${s}e${e}: $item"

    cmd=("$NODE_BIN" "$HELPER" --item "$item" --config "$CONFIG_PATH" --category "$CATEGORY")
    if (( DRY_RUN == 1 )); then
      cmd+=(--dry-run)
    fi
    if (( NO_PROBE == 1 )); then
      cmd+=(--no-probe)
    fi

    if "${cmd[@]}"; then
      ok=$((ok + 1))
    else
      skipped=$((skipped + 1))
      echo "  -> skipped (missing item, network issue, or parse error)"
    fi
  done
done

echo
echo "Done. attempts=$attempts succeeded=$ok skipped=$skipped"

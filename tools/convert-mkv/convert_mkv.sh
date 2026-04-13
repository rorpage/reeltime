#!/usr/bin/env bash
set -euo pipefail

# Convert MKV files to reeltime-compatible H.264 MP4s.
# Recursively finds every .mkv file under the given directory and converts it
# in place, writing a .mp4 alongside the original.
#
# Usage: ./convert_mkv.sh <directory>
#   directory: root folder to search (required)
#
# The original MKV is left untouched. Already-converted files are skipped.

if [[ $# -eq 0 ]]; then
  echo "Usage: $(basename "$0") <directory>" >&2
  exit 1
fi

BASE_DIR="$1"
PASS=0
FAIL=0
SKIP=0

if [[ ! -d "$BASE_DIR" ]]; then
  echo "Error: directory not found: $BASE_DIR" >&2
  exit 1
fi

while IFS= read -r -d '' mkv; do
  mp4="${mkv%.mkv}.mp4"

  if [[ -f "$mp4" ]]; then
    echo "[SKIP] Already exists: $mp4"
    ((SKIP++)) || true
    continue
  fi

  # Use SnnEnn as the title if the filename contains one, otherwise use the stem
  stem="$(basename "${mkv%.mkv}")"
  if [[ "$mkv" =~ (S[0-9]+E[0-9]+) ]]; then
    title="${BASH_REMATCH[1]}"
  else
    title="$stem"
  fi

  echo ""
  echo "[CONVERTING] $mkv"

  if ffmpeg -i "$mkv" \
      -map 0:v:0 \
      -map 0:a:0 \
      -map_metadata -1 \
      -metadata title="$title" \
      -c:v libx264 \
      -preset fast \
      -crf 28 \
      -maxrate 2000k \
      -bufsize 4000k \
      -pix_fmt yuv420p \
      -c:a aac \
      -b:a 128k \
      -movflags +faststart \
      "$mp4"; then
    echo "[DONE] $mp4"
    ((PASS++)) || true
  else
    echo "[FAIL] Conversion failed for: $mkv" >&2
    rm -f "$mp4"
    ((FAIL++)) || true
  fi

done < <(find "$BASE_DIR" -type f -iname "*.mkv" -print0 | sort -z)

echo ""
echo "────────────────────────────────"
echo "Converted: $PASS  Skipped: $SKIP  Failed: $FAIL"

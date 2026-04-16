#!/usr/bin/env bash
set -euo pipefail

# Convert non-MP3 audio files to reeltime-compatible MP3s.
# Recursively finds every supported audio file under the given directory and
# converts it to MP3 alongside the original, matching the source bitrate.
#
# Supported formats: .m4a .aac .flac .ogg .opus .wma .wav .aiff .aif
#
# Usage: ./convert_audio.sh <directory>
#   directory: root folder to search (required)
#
# The original file is left untouched. Already-converted files are skipped.

AUDIO_EXTS=("m4a" "aac" "flac" "ogg" "opus" "wma" "wav" "aiff" "aif")
DEFAULT_BITRATE=192
LOSSLESS_BITRATE=320

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

# Build find expression for all supported extensions
find_args=()
first=true
for ext in "${AUDIO_EXTS[@]}"; do
  if $first; then
    find_args+=(-iname "*.${ext}")
    first=false
  else
    find_args+=(-o -iname "*.${ext}")
  fi
done

# Detect bitrate in kbps for a given file.
# Lossless formats always get LOSSLESS_BITRATE (320k).
# Lossy formats: probe stream bit_rate, fall back to format bit_rate, then DEFAULT_BITRATE.
get_bitrate_kbps() {
  local file="$1"
  local ext="${file##*.}"
  ext="${ext,,}"

  if [[ "$ext" == "flac" || "$ext" == "wav" || "$ext" == "aiff" || "$ext" == "aif" ]]; then
    echo "$LOSSLESS_BITRATE"
    return
  fi

  local bps
  bps=$(ffprobe -v error -select_streams a:0 \
    -show_entries stream=bit_rate \
    -of default=noprint_wrappers=1:nokey=1 \
    "$file" 2>/dev/null || true)

  if [[ -z "$bps" || "$bps" == "N/A" || "$bps" == "0" ]]; then
    bps=$(ffprobe -v error \
      -show_entries format=bit_rate \
      -of default=noprint_wrappers=1:nokey=1 \
      "$file" 2>/dev/null || true)
  fi

  if [[ -z "$bps" || "$bps" == "N/A" || "$bps" == "0" ]]; then
    echo "$DEFAULT_BITRATE"
    return
  fi

  local kbps=$(( bps / 1000 ))
  if (( kbps < 32  )); then kbps=32;  fi
  if (( kbps > 320 )); then kbps=320; fi

  echo "$kbps"
}

while IFS= read -r -d '' audio; do
  mp3="${audio%.*}.mp3"

  if [[ -f "$mp3" ]]; then
    echo "[SKIP] Already exists: $mp3"
    ((SKIP++)) || true
    continue
  fi

  bitrate=$(get_bitrate_kbps "$audio")

  echo ""
  echo "[CONVERTING] $audio  (${bitrate}k)"

  if ffmpeg -nostdin -i "$audio" \
      -vn \
      -c:a libmp3lame \
      -b:a "${bitrate}k" \
      -map_metadata 0 \
      -id3v2_version 3 \
      "$mp3"; then
    echo "[DONE] $mp3"
    ((PASS++)) || true
  else
    echo "[FAIL] Conversion failed for: $audio" >&2
    rm -f "$mp3"
    ((FAIL++)) || true
  fi

done < <(find "$BASE_DIR" -type f \( "${find_args[@]}" \) -print0 | sort -z)

echo ""
echo "────────────────────────────────"
echo "Converted: $PASS  Skipped: $SKIP  Failed: $FAIL"

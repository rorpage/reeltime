# 🔀 convert-mkv

Converts MKV files to reeltime-compatible H.264 MP4s.

---

## Why is this needed?

Reeltime re-encodes every source video to H.264 in real time as it streams. This works well for most files, but certain MKV encodings can cause the stream to stutter or buffer every few seconds.

The two most common culprits are:

**1. HEVC / x265 video (especially 10-bit)**
Modern BluRay and web releases are often encoded with x265, which is far more efficient than x264 but also far more expensive to decode. When Reeltime's FFmpeg pipeline has to decode x265 10-bit and re-encode to x264 simultaneously, it can fall behind real time. This shows up in the container logs as:

```
Resumed reading at pts 43.172 with rate 1.050 after a lag of 45.794s
```

And on the player side as buffering every 6-10 seconds.

**2. MKV container with metadata at the end of the file**
MKV files don't guarantee where the seek index (Cues element) sits. When it's at the end of the file, FFmpeg has to seek to the end to read it before it can decode the first frame. With the `-re` (real-time) flag that Reeltime uses, this seek time is counted as lag.

**The fix in both cases** is to pre-convert the file to a well-structured H.264 MP4 with the metadata at the front (`faststart`). The source file becomes cheap and fast to decode, and the container is immediately readable. Reeltime's re-encode then runs comfortably in real time with no buffering.

---

## What the script does

- Recursively finds every `.mkv` file under the given directory
- Converts it to `.mp4` alongside the original (original is never modified)
- Skips files that have already been converted
- Strips all existing metadata and sets a clean title

**FFmpeg arguments explained:**

| Argument | Why |
|---|---|
| `-map 0:v:0 -map 0:a:0` | Take only the first video and audio track, dropping subtitles and extra audio that can't go into MP4 |
| `-c:v libx264 -preset fast` | Re-encode to H.264, which is fast to decode in real time |
| `-crf 28` | Quality level - produces files roughly the same size as the original x265 at acceptable quality. Since Reeltime re-encodes again at its configured bitrate, the source doesn't need to be pristine |
| `-maxrate 2000k -bufsize 4000k` | Cap bitrate spikes on complex scenes - matches Reeltime's default output bitrate so there's no benefit in the source exceeding it |
| `-pix_fmt yuv420p` | Force 8-bit color. Required when the source is 10-bit (x265 10-bit decoded frames are incompatible with standard libx264 builds) |
| `-c:a aac -b:a 128k` | Convert audio to AAC. Reeltime re-encodes audio too, so 128k is plenty for the intermediate file |
| `-map_metadata -1` | Strip all source metadata (title, encoder tags, comments) |
| `-movflags +faststart` | Move the MP4 index (moov atom) to the front of the file so FFmpeg can start decoding immediately without seeking |

---

## Usage

```bash
chmod +x convert_mkv.sh
./convert_mkv.sh /path/to/your/videos
```

The script will walk the entire directory tree. You can point it at a single season folder or a whole library root - it handles any depth.

**Example - single season:**
```bash
./convert_mkv.sh /videos/Brooklyn-Nine-Nine/S01
```

**Example - whole series:**
```bash
./convert_mkv.sh /videos/Brooklyn-Nine-Nine
```

**Example - entire library:**
```bash
./convert_mkv.sh /videos
```

Output MP4s are written alongside the source MKVs:
```
S01/
  Brooklyn.Nine-Nine.S01E01.720p.BluRay.x265.mkv     <- untouched
  Brooklyn.Nine-Nine.S01E01.720p.BluRay.x265.mp4     <- created by this script
  Brooklyn.Nine-Nine.S01E02.720p.BluRay.x265.mkv
  Brooklyn.Nine-Nine.S01E02.720p.BluRay.x265.mp4
```

Once converted, point your Reeltime config at the `.mp4` files instead of the `.mkv` files.

---

## Re-running safely

Already-converted files are skipped automatically, so you can re-run the script at any time - for example after adding new episodes to the library.

---

## Requirements

- `ffmpeg` must be installed and on your `PATH`
- Bash 4.0+ (standard on Linux; on macOS install via `brew install bash`)

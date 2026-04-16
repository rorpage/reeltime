# convert-audio

Converts non-MP3 audio files to reeltime-compatible MP3s.

---

## Why is this needed?

Boom and any Reel channel that uses background music expects `.mp3` files in its music directory. If your music library contains files in other formats - M4A (iTunes downloads, Apple Music exports), AAC, FLAC, OGG, Opus, WMA, or WAV - this script converts them to MP3 in one pass so you can drop the output folder straight into your config.

---

## What the script does

- Recursively finds every supported audio file under the given directory
- Probes each file with `ffprobe` to detect its original bitrate
- Converts it to MP3 alongside the original (original is never modified)
- Skips files that have already been converted
- Preserves all metadata tags (artist, album, title, track number, etc.)

**Supported source formats:**

| Extension | Format |
|---|---|
| `.m4a` | AAC in MPEG-4 container (iTunes / Apple Music) |
| `.aac` | Raw AAC bitstream |
| `.flac` | FLAC lossless |
| `.ogg` | Vorbis in OGG container |
| `.opus` | Opus in OGG container |
| `.wma` | Windows Media Audio |
| `.wav` | PCM / WAV |
| `.aiff` / `.aif` | AIFF lossless |

---

## Bitrate matching

For **lossy sources** (M4A, AAC, OGG, Opus, WMA), the script reads the original audio stream bitrate via `ffprobe` and passes it directly to libmp3lame. For example, a 256 kbps M4A becomes a 256 kbps MP3. If `ffprobe` cannot determine the bitrate, the script falls back to 192 kbps.

For **lossless sources** (FLAC, WAV, AIFF), there is no meaningful "original bitrate" to match - the source is uncompressed. These are always converted at 320 kbps, the highest standard MP3 bitrate.

**FFmpeg arguments explained:**

| Argument | Why |
|---|---|
| `-vn` | Skip any embedded video/artwork streams so only the audio track is processed |
| `-c:a libmp3lame` | Encode to MP3 using the LAME encoder |
| `-b:a <kbps>k` | Target bitrate, matched to the source (or 320k for lossless) |
| `-map_metadata 0` | Copy all tags (artist, album, title, etc.) from the source to the MP3 |
| `-id3v2_version 3` | Write ID3v2.3 tags, which have the broadest player compatibility |

---

## Usage

```bash
chmod +x convert_audio.sh
./convert_audio.sh /path/to/your/music
```

The script walks the entire directory tree. You can point it at a single album folder or a whole library root.

**Example - single album:**
```bash
./convert_audio.sh /music/Fleetwood-Mac/Rumours
```

**Example - whole artist:**
```bash
./convert_audio.sh /music/Fleetwood-Mac
```

**Example - entire library:**
```bash
./convert_audio.sh /music
```

Output MP3s are written alongside the source files:
```
Rumours/
  01-Dreams.flac       <- untouched
  01-Dreams.mp3        <- created by this script  (320k)
  02-The-Chain.m4a     <- untouched
  02-The-Chain.mp3     <- created by this script  (256k)
```

Once converted, point your Boom or Reel music directory at the folder containing the new MP3s.

---

## Re-running safely

Already-converted files are skipped automatically, so you can re-run the script at any time - for example after adding new tracks to the library.

---

## Requirements

- `ffmpeg` and `ffprobe` must be installed and on your `PATH`
- Bash 4.0+ (standard on Linux; on macOS install via `brew install bash`)

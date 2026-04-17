# 🎟️ usher

IR remote control for the movie stack. Reads button presses from a hardware IR receiver (or keyboard), queries **director** for the channel list, and tunes **mpv** to the right HLS stream - with a fade-in/fade-out channel banner overlay so it feels like a real TV.

Runs as a systemd service on the Pi. Starts at boot, fills the screen, and is ready before you pick up the remote.

---

## Features

- **Channel surfing** - CH▲ / CH▼ or type a number to jump directly
- **Digit buffering** - press `4`, `2` → waits → tunes CH 42 (just like a real remote)
- **Channel banner** - gold-accented Tkinter overlay fades in on tune, auto-dismisses after a few seconds
- **Keyboard input** - full control from a keyboard when running interactively; disabled automatically when running as a service
- **mpv IPC** - pause, volume, and mute are piped directly to the player over a Unix socket
- **OSD fallback** - if no display is available for the overlay, falls back to mpv's on-screen display
- **Auto IR detection** - scans `/dev/input/event*` for a receiver so you usually don't need to configure anything
- **Director cache** - channel list is cached locally so a director blip doesn't kill the remote

---

## Requirements

| Requirement | Notes |
|---|---|
| Raspberry Pi (any model) | Tested on Pi 4 |
| **Raspberry Pi OS with Desktop** | The full desktop image is required - Lite won't work as mpv and Tkinter both need a display server |
| IR receiver wired to GPIO | GPIO17 by default; keyboard works without one |
| `mpv` | Installed by `install.sh` |
| Python 3.10+ | Installed by `install.sh` |
| Running **director** container | Reachable at `http://director:8080` by default |

---

## Installation

Clone the repo onto your Pi, then run the installer from the `usher/` directory:

```bash
cd usher
chmod +x install.sh
./install.sh
```

The installer will:

1. Add the `gpio-ir` device tree overlay to `/boot/firmware/config.txt`
2. Install `mpv`, `python3-tk`, `ir-keytable`, and `fonts-dejavu-core` via apt
3. Create a Python virtualenv and install the package
4. Install and enable the `usher.service` systemd unit

> **Note:** If the IR overlay was not already present, a reboot is required before the receiver will be detected.

### Custom GPIO pin

The installer defaults to GPIO17. To use a different pin:

```bash
IR_PIN=18 ./install.sh
```

### Linux-only dependency

`evdev` (the IR input library) is Linux-only and is not installed as a default dependency. The installer handles this automatically via:

```bash
pip install -e ".[linux]"
```

---

## Boot behavior

usher is installed as a systemd service that starts automatically with the graphical session (`graphical-session.target`). On boot:

1. The Pi starts its desktop environment
2. systemd launches usher
3. mpv opens full-screen (`--no-border --geometry=100%x100%+0+0`) - the screen is taken over immediately
4. The channel banner overlay sits on top, fading in whenever you change channel

To prevent usher from starting at boot:

```bash
sudo systemctl disable usher
```

---

## Configuration

Edit `config.yaml` before starting the service:

```yaml
director:
  url: "http://director:8080"   # director container address
  timeout: 5.0
  cache_ttl: 300                # seconds to cache the channel list

ir:
  # device: "/dev/input/event0" # pin a specific device, or leave commented for auto-detect
  digit_timeout: 1.5            # seconds to wait before committing typed digits
  keyboard_enabled: true        # active when running in a terminal; ignored by systemd service

stream:
  player: "mpv"
  player_args:
    - "--no-border"
    - "--geometry=100%x100%+0+0"
    # - "--audio-device=alsa/plughw:CARD=vc4hdmi"  # uncomment to pin HDMI audio
  ipc_socket: "/tmp/usher-mpv.sock"

overlay:
  enabled: true
  display_secs: 4.0             # how long the banner stays on screen
  position: "bottom"            # "bottom" or "top"
  font_family: "DejaVu Sans"
```

---

## Usage

### As a service (normal use)

```bash
sudo systemctl start usher
sudo systemctl status usher
journalctl -u usher -f
```

### From the command line

```bash
# Run interactively (keyboard input active)
./venv/bin/usher

# Enable debug logging
./venv/bin/usher --verbose

# Print the channel list from director and exit
./venv/bin/usher --list-channels

# Use a custom config file
./venv/bin/usher --config /path/to/config.yaml
```

---

## Remote control mapping

### IR remote

| Button | Action |
|---|---|
| `0`–`9` | Buffer digits → tune to channel after timeout |
| `OK` / `ENTER` | Tune immediately using buffered digits |
| `CH▲` / `CH▼` / `▲` / `▼` | Surf up / down through channels |
| `PAUSE` / `PLAY/PAUSE` | Toggle pause |
| `STOP` | Stop playback |
| `POWER` | Stop playback if playing; start first channel if stopped |
| `INFO` / `SCREEN` / `DISPLAY` | Show channel banner for current channel |
| `MUTE` | Toggle mute |
| `VOL+` / `VOL-` | Adjust volume by 5 |

> **Note:** The `POWER` button does not shut down the Pi. It toggles playback on and off, mirroring what a TV remote's power button does to the picture.

### Keyboard (interactive mode only)

Keyboard input is active when running in a terminal and disabled automatically when running as the systemd service.

| Key | Action |
|---|---|
| `↑` / `k` | Channel up |
| `↓` / `j` | Channel down |
| `0`–`9` | Digit input |
| `Enter` | Tune immediately using buffered digits |
| `Space` | Toggle pause |
| `s` | Stop playback |
| `m` | Toggle mute |
| `+` / `=` | Volume up |
| `-` | Volume down |
| `i` | Show channel banner |
| `q` / `Esc` | Stop playback if playing; start first channel if stopped |

---

## How it works

```
IR receiver (GPIO)   Keyboard (TTY)
        │                  │
     evdev              raw stdin
        └────────┬─────────┘
                 │
          UsherController
               │
               ├─► DirectorClient ──► GET /channels  (director container)
               ├─► Streamer        ──► mpv subprocess + IPC socket
               └─► ChannelOverlay  ──► Tkinter banner (daemon thread)
```

Button presses from IR and keyboard are merged into a single event queue and dispatched by `UsherController`. Channel data is fetched from the director API and cached. Playback is managed by spawning `mpv` with an HLS URL and communicating with it over its JSON IPC socket.

---

## Troubleshooting

**No IR device detected**
- Check your wiring (GPIO17 by default, 3.3V, GND, and signal)
- Confirm the overlay is active: `ls /dev/input/event*` before and after reboot
- Run `ir-keytable` to verify the device is registered
- Pin the device manually in `config.yaml` if auto-detection fails

**Overlay not showing**
- Ensure `DISPLAY=:0` is set in the service environment
- Set `overlay.enabled: false` in `config.yaml` to use the mpv OSD fallback instead

**Director not reachable**
- Confirm the director container is running: `docker ps | grep director`
- Check the `url` in `config.yaml` matches how the Pi can reach the container
- Run `usher --list-channels` to test the connection directly

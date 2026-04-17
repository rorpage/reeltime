from __future__ import annotations

import logging
from pathlib import Path
from typing import AsyncIterator, Optional

logger = logging.getLogger(__name__)

try:
    import evdev
    from evdev import InputDevice, categorize, ecodes
    EVDEV_AVAILABLE = True
except ImportError:
    EVDEV_AVAILABLE = False
    logger.warning("evdev not installed -IR input disabled")


IR_KEY_MAP: dict[str, tuple[str, object]] = {
    "KEY_0": ("digit", 0), "KEY_1": ("digit", 1), "KEY_2": ("digit", 2),
    "KEY_3": ("digit", 3), "KEY_4": ("digit", 4), "KEY_5": ("digit", 5),
    "KEY_6": ("digit", 6), "KEY_7": ("digit", 7), "KEY_8": ("digit", 8),
    "KEY_9": ("digit", 9),
    "KEY_CHANNELUP":   ("nav", "up"),
    "KEY_CHANNELDOWN": ("nav", "down"),
    "KEY_UP":          ("nav", "up"),
    "KEY_DOWN":        ("nav", "down"),
    "KEY_NEXT":        ("nav", "up"),
    "KEY_PREVIOUS":    ("nav", "down"),
    "KEY_OK":        ("action", "select"),
    "KEY_ENTER":     ("action", "select"),
    "KEY_STOP":      ("action", "stop"),
    "KEY_PAUSE":     ("action", "pause"),
    "KEY_PLAYPAUSE": ("action", "playpause"),
    "KEY_POWER":     ("action", "power"),
    "KEY_POWER2":    ("action", "power"),
    "KEY_INFO":      ("action", "info"),
    "KEY_SCREEN":    ("action", "info"),
    "KEY_DISPLAY":   ("action", "info"),
    "KEY_MUTE":       ("volume", "mute"),
    "KEY_VOLUMEUP":   ("volume", "up"),
    "KEY_VOLUMEDOWN": ("volume", "down"),
}

KB_KEY_MAP: dict[str, tuple[str, object]] = {
    "KEY_UP":   ("nav", "up"),
    "KEY_DOWN": ("nav", "down"),
    "KEY_K":    ("nav", "up"),
    "KEY_J":    ("nav", "down"),
    "KEY_0": ("digit", 0), "KEY_1": ("digit", 1), "KEY_2": ("digit", 2),
    "KEY_3": ("digit", 3), "KEY_4": ("digit", 4), "KEY_5": ("digit", 5),
    "KEY_6": ("digit", 6), "KEY_7": ("digit", 7), "KEY_8": ("digit", 8),
    "KEY_9": ("digit", 9),
    "KEY_ENTER":  ("action", "select"),
    "KEY_SPACE":  ("action", "playpause"),
    "KEY_S":      ("action", "stop"),
    "KEY_I":      ("action", "info"),
    "KEY_Q":      ("action", "power"),
    "KEY_ESC":    ("action", "power"),
    "KEY_EQUAL":  ("volume", "up"),
    "KEY_KPPLUS": ("volume", "up"),
    "KEY_MINUS":  ("volume", "down"),
    "KEY_M":      ("volume", "mute"),
}

_IR_KEYWORDS = ("ir", "remote", "lirc", "mceusb", "streamzap", "devinput")


def find_ir_device() -> Optional[str]:
    if not EVDEV_AVAILABLE:
        return None
    for path in sorted(Path("/dev/input").glob("event*")):
        try:
            dev = InputDevice(str(path))
            if any(kw in dev.name.lower() for kw in _IR_KEYWORDS):
                logger.info("Auto-detected IR device: '%s' at %s", dev.name, path)
                return str(path)
        except Exception:
            continue
    logger.warning(
        "No IR device auto-detected. "
        "Set ir.device in config.yaml or check your wiring / overlay."
    )
    return None


def find_keyboard_device() -> Optional[str]:
    """Find a physical keyboard in /dev/input by checking for letter key capability."""
    if not EVDEV_AVAILABLE:
        return None
    for path in sorted(Path("/dev/input").glob("event*")):
        try:
            dev = InputDevice(str(path))
            keys = dev.capabilities().get(ecodes.EV_KEY, [])
            if ecodes.KEY_A in keys and ecodes.KEY_Z in keys:
                logger.info("Auto-detected keyboard: '%s' at %s", dev.name, path)
                return str(path)
        except Exception:
            continue
    return None


async def _evdev_stream(
    device_path: str, key_map: dict, label: str
) -> AsyncIterator[tuple[str, object]]:
    device = InputDevice(device_path)
    logger.info("Listening on '%s' (%s)", device.name, device_path)

    async for event in device.async_read_loop():
        if event.type != ecodes.EV_KEY:
            continue
        key_event = categorize(event)
        if key_event.keystate != key_event.key_up:
            continue

        key_code = key_event.keycode
        if isinstance(key_code, list):
            key_code = key_code[0]

        if key_code in key_map:
            action_type, action_value = key_map[key_code]
            logger.debug("%s %-20s → (%s, %s)", label, key_code, action_type, action_value)
            yield action_type, action_value
        else:
            logger.debug("%s unmapped key: %s", label, key_code)


async def ir_event_stream(device_path: str) -> AsyncIterator[tuple[str, object]]:
    """Async generator - yields (action_type, value) on key-up events from an IR receiver."""
    if not EVDEV_AVAILABLE:
        raise RuntimeError("evdev is not installed: pip install evdev")
    async for event in _evdev_stream(device_path, IR_KEY_MAP, "IR"):
        yield event


async def keyboard_evdev_stream(device_path: str) -> AsyncIterator[tuple[str, object]]:
    """Async generator - yields (action_type, value) on key-up events from a keyboard."""
    if not EVDEV_AVAILABLE:
        raise RuntimeError("evdev is not installed: pip install evdev")
    async for event in _evdev_stream(device_path, KB_KEY_MAP, "KB"):
        yield event

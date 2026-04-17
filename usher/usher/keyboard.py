from __future__ import annotations

import asyncio
import logging
import sys
import threading
from typing import AsyncIterator

logger = logging.getLogger(__name__)

KEYBOARD_AVAILABLE = sys.stdin.isatty()

# Key sequence → (action_type, value)
_KEY_MAP: dict[str, tuple[str, object]] = {
    # Navigation -arrow keys and vim-style
    "\x1b[A": ("nav", "up"),
    "\x1b[B": ("nav", "down"),
    "k":       ("nav", "up"),
    "j":       ("nav", "down"),
    # Digits
    "0": ("digit", 0), "1": ("digit", 1), "2": ("digit", 2),
    "3": ("digit", 3), "4": ("digit", 4), "5": ("digit", 5),
    "6": ("digit", 6), "7": ("digit", 7), "8": ("digit", 8),
    "9": ("digit", 9),
    # Actions
    "\r":   ("action", "select"),
    "\n":   ("action", "select"),
    " ":    ("action", "playpause"),
    "s":    ("action", "stop"),
    "i":    ("action", "info"),
    "q":    ("action", "power"),
    "\x1b": ("action", "power"),   # standalone Escape
    "\x03": ("action", "quit"),    # Ctrl+C in raw mode (no SIGINT generated)
    # Volume
    "+":    ("volume", "up"),
    "=":    ("volume", "up"),
    "-":    ("volume", "down"),
    "m":    ("volume", "mute"),
}


async def keyboard_event_stream() -> AsyncIterator[tuple[str, object]]:
    """Async generator -yields (action_type, value) from keyboard input."""
    if not KEYBOARD_AVAILABLE:
        logger.warning("stdin is not a TTY -keyboard input disabled")
        return

    loop = asyncio.get_event_loop()
    queue: asyncio.Queue[tuple[str, object]] = asyncio.Queue()
    stop = threading.Event()

    thread = threading.Thread(
        target=_reader_thread,
        args=(loop, queue, stop),
        daemon=True,
        name="usher-keyboard",
    )
    thread.start()
    logger.info(
        "Keyboard input active  "
        "(arrows/jk=ch, 0-9=digit, space=pause, m=mute, ±=vol, i=info, q=power, Ctrl+C=quit)"
    )

    try:
        while True:
            yield await queue.get()
    finally:
        stop.set()


def _reader_thread(
    loop: asyncio.AbstractEventLoop,
    queue: asyncio.Queue,
    stop: threading.Event,
) -> None:
    try:
        if sys.platform == "win32":
            _read_windows(loop, queue, stop)
        else:
            _read_unix(loop, queue, stop)
    except Exception as exc:
        logger.error("Keyboard reader crashed: %s", exc)


def _read_unix(
    loop: asyncio.AbstractEventLoop,
    queue: asyncio.Queue,
    stop: threading.Event,
) -> None:
    import select
    import termios
    import tty

    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        while not stop.is_set():
            if not select.select([sys.stdin], [], [], 0.1)[0]:
                continue
            ch = sys.stdin.read(1)
            if not ch:
                break

            if ch == "\x1b":
                # Peek for a CSI sequence (arrow keys etc.)
                if select.select([sys.stdin], [], [], 0.05)[0]:
                    ch2 = sys.stdin.read(1)
                    if ch2 == "[" and select.select([sys.stdin], [], [], 0.05)[0]:
                        ch3 = sys.stdin.read(1)
                        key = f"\x1b[{ch3}"
                    else:
                        key = "\x1b"
                else:
                    key = "\x1b"
            else:
                key = ch

            _emit(key, loop, queue)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def _read_windows(
    loop: asyncio.AbstractEventLoop,
    queue: asyncio.Queue,
    stop: threading.Event,
) -> None:
    import msvcrt
    import time

    while not stop.is_set():
        if not msvcrt.kbhit():
            time.sleep(0.05)
            continue
        ch = msvcrt.getwch()
        if ch in ("\x00", "\xe0"):
            # Extended key -read the scan code
            ch2 = msvcrt.getwch()
            _WIN_EXTENDED = {"H": "\x1b[A", "P": "\x1b[B"}
            key = _WIN_EXTENDED.get(ch2, "")
        else:
            key = ch
        if key:
            _emit(key, loop, queue)


def _emit(
    key: str,
    loop: asyncio.AbstractEventLoop,
    queue: asyncio.Queue,
) -> None:
    if key in _KEY_MAP:
        action = _KEY_MAP[key]
        logger.debug("KEY %-12r → %s", key, action)
        asyncio.run_coroutine_threadsafe(queue.put(action), loop)
    else:
        logger.debug("KEY unmapped: %r", key)

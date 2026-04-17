from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from typing import Optional

logger = logging.getLogger(__name__)

_MPV_DEFAULTS = [
    "--no-terminal",
    "--really-quiet",
    "--demuxer-lavf-format=hls",
]

_VLC_DEFAULTS = ["--no-osd", "--intf", "dummy"]


class Streamer:
    """
    Manages a media-player subprocess.
    When player == "mpv", connects to its JSON IPC socket for
    pause, volume, and OSD fallback support.
    """

    def __init__(
        self,
        player: str = "mpv",
        extra_args: Optional[list[str]] = None,
        ipc_socket: str = "/tmp/usher-mpv.sock",
    ) -> None:
        self.player     = player
        self.extra_args = extra_args or []
        self._ipc_path  = ipc_socket
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._current_url: Optional[str] = None
        self._ipc_writer: Optional[asyncio.StreamWriter] = None
        self._paused    = False

        if not shutil.which(player):
            raise RuntimeError(
                f"Player '{player}' not found. "
                f"Install it:  sudo apt install {player}"
            )

    @property
    def is_playing(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    @property
    def is_paused(self) -> bool:
        return self._paused

    @property
    def current_url(self) -> Optional[str]:
        return self._current_url

    async def play(self, url: str, label: str = "") -> None:
        await self.stop()
        logger.info("▶  %s%s", f"[{label}]  " if label else "", url)

        if self.player == "mpv" and os.path.exists(self._ipc_path):
            os.unlink(self._ipc_path)

        self._proc = await asyncio.create_subprocess_exec(
            *self._build_cmd(url),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        self._current_url = url
        self._paused      = False
        asyncio.ensure_future(self._watch())

        if self.player == "mpv":
            await self._connect_ipc()

    async def stop(self) -> None:
        self._close_ipc()
        if self._proc and self._proc.returncode is None:
            logger.info("⏹  Stopping")
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                self._proc.kill()
        self._proc        = None
        self._current_url = None
        self._paused      = False

    async def toggle_pause(self) -> bool:
        if not self.is_playing:
            return False
        await self._cmd("cycle", "pause")
        self._paused = not self._paused
        return self._paused

    async def adjust_volume(self, delta: int) -> None:
        await self._cmd("add", "volume", delta)

    async def set_volume(self, level: int) -> None:
        await self._cmd("set_property", "volume", max(0, min(100, level)))

    async def toggle_mute(self) -> None:
        await self._cmd("cycle", "mute")

    async def show_osd(self, line1: str, line2: str = "", ms: int = 4000) -> None:
        """ASS-styled OSD fallback when the Tkinter overlay is unavailable."""
        ff  = "DejaVu Sans"
        top = rf"{{\an1\fn{ff}\fs46\b1\c&H18C5F5&\bord2\shad1}}" + line1
        bot = rf"{{\an1\fn{ff}\fs22\b0\c&H00FFFFFF&\bord1\shad0}}" + line2 if line2 else ""
        text = top + (r"\N" + bot if bot else "")
        await self._cmd("show-text", text, ms)

    def _build_cmd(self, url: str) -> list[str]:
        if self.player == "mpv":
            base = [*_MPV_DEFAULTS, f"--input-ipc-server={self._ipc_path}"]
        elif self.player in ("vlc", "cvlc"):
            base = _VLC_DEFAULTS
        else:
            base = []
        return [self.player, *base, *self.extra_args, url]

    async def _connect_ipc(self, retries: int = 25, delay: float = 0.12) -> None:
        for _ in range(retries):
            await asyncio.sleep(delay)
            if self._proc and self._proc.returncode is not None:
                return
            if not os.path.exists(self._ipc_path):
                continue
            try:
                _, writer = await asyncio.open_unix_connection(self._ipc_path)
                self._ipc_writer = writer
                logger.debug("Connected to mpv IPC at %s", self._ipc_path)
                return
            except OSError:
                continue
        logger.warning("Could not connect to mpv IPC socket (%s)", self._ipc_path)

    def _close_ipc(self) -> None:
        if self._ipc_writer:
            try:
                self._ipc_writer.close()
            except Exception:
                pass
            self._ipc_writer = None

    async def _cmd(self, *args: object) -> None:
        if not self._ipc_writer or self.player != "mpv":
            return
        try:
            payload = json.dumps({"command": list(args)}) + "\n"
            self._ipc_writer.write(payload.encode())
            await self._ipc_writer.drain()
        except (OSError, ConnectionResetError) as exc:
            logger.debug("IPC write failed: %s", exc)
            self._close_ipc()

    async def _watch(self) -> None:
        proc = self._proc
        if not proc:
            return
        _, stderr = await proc.communicate()
        rc = proc.returncode
        if rc not in (0, -15):
            msg = stderr.decode().strip() if stderr else "(no output)"
            logger.warning("Player exited unexpectedly (rc=%d): %s", rc, msg)
        if self._proc is proc:
            self._close_ipc()
            self._proc        = None
            self._current_url = None
            self._paused      = False

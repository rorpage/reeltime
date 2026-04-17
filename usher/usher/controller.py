from __future__ import annotations

import asyncio
import logging
from typing import Optional

from .config import Config
from .director import Channel, DirectorClient
from .ir import find_ir_device, ir_event_stream
from .keyboard import KEYBOARD_AVAILABLE, keyboard_event_stream
from .overlay import ChannelOverlay
from .streamer import Streamer

logger = logging.getLogger(__name__)


class UsherController:
    """
    Central brain: IR events → director API → media player + overlay.

    Digit buffering (mirrors real TV remotes):
      Press 4           → wait → tune CH 4
      Press 4, 2        → wait → tune CH 42
      Press 4, 2, OK    → immediate tune CH 42
      CH▲ / CH▼         → immediate tune, flushes any pending digits
      INFO              → show banner for the current channel
    """

    def __init__(self, config: Config) -> None:
        self.config   = config
        self.director = DirectorClient(
            base_url=config.director.url,
            timeout=config.director.timeout,
            cache_ttl=config.director.cache_ttl,
        )
        self.streamer = Streamer(
            player=config.stream.player,
            extra_args=config.stream.player_args,
            ipc_socket=config.stream.ipc_socket,
        )
        self.overlay = ChannelOverlay(config.overlay)

        self._current: Optional[Channel]    = None
        self._digit_buf: list[int]           = []
        self._digit_task: Optional[asyncio.Task] = None
        self._running = False

    async def run(self) -> None:
        self._running = True

        device = self.config.ir.device or find_ir_device()
        kb_enabled = self.config.ir.keyboard_enabled and KEYBOARD_AVAILABLE

        if not device and not kb_enabled:
            logger.error(
                "No input source available. Either:\n"
                "  • Wire an IR receiver to GPIO17 and add "
                "'dtoverlay=gpio-ir,gpio_pin=17' to /boot/firmware/config.txt, or\n"
                "  • Run interactively in a terminal with keyboard_enabled: true"
            )
            return

        channels = await self.director.get_channels()
        if channels:
            logger.info(
                "Ready - %d channels.  Tuning to CH%d %s",
                len(channels), channels[0].number, channels[0].name,
            )
            await self._play(channels[0])
        else:
            logger.warning("director returned no channels - check that service.")

        logger.info("usher is ready.")

        async for action_type, value in self._merged_event_stream(device):
            if not self._running:
                break
            await self._dispatch(action_type, value)

    async def _merged_event_stream(self, device: Optional[str]):
        """Yields events from IR and/or keyboard, whichever are available."""
        queue: asyncio.Queue[tuple[str, object]] = asyncio.Queue()
        tasks = []

        if device:
            async def _pump_ir() -> None:
                async for event in ir_event_stream(device):
                    await queue.put(event)
            tasks.append(asyncio.create_task(_pump_ir()))

        if self.config.ir.keyboard_enabled and KEYBOARD_AVAILABLE:
            async def _pump_kb() -> None:
                async for event in keyboard_event_stream():
                    await queue.put(event)
            tasks.append(asyncio.create_task(_pump_kb()))

        try:
            while self._running:
                yield await queue.get()
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def shutdown(self) -> None:
        logger.info("Shutting down usher…")
        self._running = False
        self._reset_digits()
        self.overlay.dismiss()
        await self.streamer.stop()
        await self.director.close()

    async def _dispatch(self, action_type: str, value: object) -> None:
        match action_type:
            case "digit":
                await self._on_digit(int(value))
            case "nav":
                await self._on_nav(str(value))
            case "action":
                await self._on_action(str(value))
            case "volume":
                await self._on_volume(str(value))

    async def _on_digit(self, digit: int) -> None:
        self._digit_buf.append(digit)
        preview_num = int("".join(str(d) for d in self._digit_buf))
        self.overlay.show_channel(preview_num, "…", status="Enter channel number")
        self._cancel_digit_task()
        self._digit_task = asyncio.ensure_future(
            self._commit_digits_after(self.config.ir.digit_timeout)
        )

    async def _commit_digits_after(self, delay: float) -> None:
        await asyncio.sleep(delay)
        if self._digit_buf:
            number = int("".join(str(d) for d in self._digit_buf))
            self._digit_buf.clear()
            await self._tune_to_number(number)

    def _cancel_digit_task(self) -> None:
        if self._digit_task and not self._digit_task.done():
            self._digit_task.cancel()
        self._digit_task = None

    def _reset_digits(self) -> None:
        self._digit_buf.clear()
        self._cancel_digit_task()

    async def _on_nav(self, direction: str) -> None:
        self._reset_digits()
        if not self._current:
            channels = await self.director.get_channels()
            if channels:
                await self._play(channels[0])
            return
        delta = 1 if direction == "up" else -1
        ch = await self.director.get_adjacent(self._current.number, delta)
        if ch:
            await self._play(ch)

    async def _on_action(self, action: str) -> None:
        match action:
            case "stop":
                self._reset_digits()
                self.overlay.dismiss()
                await self.streamer.stop()
                self._current = None

            case "power":
                if self.streamer.is_playing:
                    self._reset_digits()
                    self.overlay.dismiss()
                    await self.streamer.stop()
                    self._current = None
                else:
                    await self._on_nav("up")

            case "select":
                if self._digit_buf:
                    number = int("".join(str(d) for d in self._digit_buf))
                    self._reset_digits()
                    await self._tune_to_number(number)

            case "pause" | "playpause":
                if self.streamer.is_playing and self._current:
                    paused = await self.streamer.toggle_pause()
                    status = "⏸  Paused" if paused else ""
                    self.overlay.show_channel(
                        self._current.number, self._current.name, status=status
                    )

            case "info":
                if self._current:
                    self.overlay.show_channel(
                        self._current.number, self._current.name
                    )
                elif not self.streamer.is_playing:
                    self.overlay.show_channel(
                        0, "No channel selected", status="Press CH▲ to start"
                    )

            case "quit":
                await self.shutdown()

    async def _on_volume(self, direction: str) -> None:
        match direction:
            case "up":
                await self.streamer.adjust_volume(5)
            case "down":
                await self.streamer.adjust_volume(-5)
            case "mute":
                await self.streamer.toggle_mute()

    async def _tune_to_number(self, number: int) -> None:
        ch = await self.director.get_channel_by_number(number)
        if ch:
            await self._play(ch)
        else:
            logger.warning("CH%d not found", number)
            self.overlay.show_channel(
                number, "Not Found", status="Channel not available"
            )

    async def _play(self, channel: Channel) -> None:
        self._current = channel
        logger.info("📺  CH%d  %s", channel.number, channel.name)
        self.overlay.show_channel(channel.number, channel.name, status="Loading…")
        await self.streamer.play(channel.stream_url, channel.name)
        if self.overlay.available:
            self.overlay.show_channel(channel.number, channel.name)
        else:
            await self.streamer.show_osd(f"CH {channel.number}", channel.name)

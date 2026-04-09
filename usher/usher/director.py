from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


@dataclass
class Channel:
    id: str
    number: int
    name: str
    stream_url: str
    logo_url: Optional[str] = None


class DirectorClient:
    """Thin async client for the director container's channel API."""

    def __init__(self, base_url: str, timeout: float = 5.0, cache_ttl: int = 300):
        self.base_url = base_url.rstrip("/")
        self.cache_ttl = cache_ttl
        self._client = httpx.AsyncClient(timeout=timeout)
        self._channels: list[Channel] = []
        self._fetched_at: float = 0.0

    async def get_channels(self, force: bool = False) -> list[Channel]:
        now = time.monotonic()
        if not force and self._channels and (now - self._fetched_at) < self.cache_ttl:
            return self._channels

        try:
            resp = await self._client.get(f"{self.base_url}/channels")
            resp.raise_for_status()
            self._channels = sorted(
                (
                    Channel(
                        id=ch["id"],
                        number=ch["number"],
                        name=ch["name"],
                        stream_url=ch["stream_url"],
                        logo_url=ch.get("logo_url"),
                    )
                    for ch in resp.json()
                ),
                key=lambda c: c.number,
            )
            self._fetched_at = now
            logger.info("Loaded %d channels from director", len(self._channels))

        except httpx.HTTPError as exc:
            logger.error("Could not fetch channels from director: %s", exc)

        return self._channels

    async def get_channel_by_number(self, number: int) -> Optional[Channel]:
        return next(
            (ch for ch in await self.get_channels() if ch.number == number), None
        )

    async def get_adjacent(self, current_number: int, direction: int) -> Optional[Channel]:
        channels = await self.get_channels()
        if not channels:
            return None
        numbers = [ch.number for ch in channels]
        try:
            idx = numbers.index(current_number)
        except ValueError:
            return channels[0]
        return channels[(idx + direction) % len(channels)]

    async def close(self) -> None:
        await self._client.aclose()

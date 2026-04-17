from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import yaml


@dataclass
class OverlayConfig:
    enabled: bool = True
    display_secs: float = 4.0
    fade_steps: int = 15
    fade_interval_ms: int = 20
    position: str = "bottom"
    window_alpha: float = 0.92
    font_family: str = "DejaVu Sans"


@dataclass
class DirectorConfig:
    url: str = "http://director:8080"
    timeout: float = 5.0
    cache_ttl: int = 300


@dataclass
class IRConfig:
    device: Optional[str] = None
    digit_timeout: float = 1.5
    keyboard_enabled: bool = True


@dataclass
class StreamConfig:
    player: str = "mpv"
    player_args: list[str] = field(default_factory=list)
    ipc_socket: str = "/tmp/usher-mpv.sock"


@dataclass
class Config:
    director: DirectorConfig = field(default_factory=DirectorConfig)
    ir: IRConfig = field(default_factory=IRConfig)
    stream: StreamConfig = field(default_factory=StreamConfig)
    overlay: OverlayConfig = field(default_factory=OverlayConfig)

    @classmethod
    def load(cls, path: str) -> Config:
        p = Path(path)
        if not p.exists():
            return cls()

        with open(p) as f:
            data = yaml.safe_load(f) or {}

        cfg = cls()

        if d := data.get("director"):
            cfg.director = DirectorConfig(
                url=d.get("url", cfg.director.url),
                timeout=d.get("timeout", cfg.director.timeout),
                cache_ttl=d.get("cache_ttl", cfg.director.cache_ttl),
            )

        if i := data.get("ir"):
            cfg.ir = IRConfig(
                device=i.get("device"),
                digit_timeout=i.get("digit_timeout", cfg.ir.digit_timeout),
                keyboard_enabled=i.get("keyboard_enabled", cfg.ir.keyboard_enabled),
            )

        if s := data.get("stream"):
            cfg.stream = StreamConfig(
                player=s.get("player", cfg.stream.player),
                player_args=s.get("player_args", cfg.stream.player_args),
                ipc_socket=s.get("ipc_socket", cfg.stream.ipc_socket),
            )

        if o := data.get("overlay"):
            cfg.overlay = OverlayConfig(
                enabled=o.get("enabled", cfg.overlay.enabled),
                display_secs=o.get("display_secs", cfg.overlay.display_secs),
                fade_steps=o.get("fade_steps", cfg.overlay.fade_steps),
                fade_interval_ms=o.get("fade_interval_ms", cfg.overlay.fade_interval_ms),
                position=o.get("position", cfg.overlay.position),
                window_alpha=o.get("window_alpha", cfg.overlay.window_alpha),
                font_family=o.get("font_family", cfg.overlay.font_family),
            )

        return cfg

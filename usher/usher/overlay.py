from __future__ import annotations

import logging
import os
import queue
import threading
import tkinter as tk
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .config import OverlayConfig

logger = logging.getLogger(__name__)

_BG     = "#0d0d0d"
_ACCENT = "#f5c518"
_TEXT   = "#ffffff"
_DIM    = "#999999"
_SEP    = "#2e2e2e"

_BANNER_H = 120
_PAD_X    = 44
_NUM_W    = 116


class ChannelOverlay:
    """
    Fade-in / fade-out channel banner overlay.

    Visual layout (bottom of screen):

      ╔═══════════════════════════════════════════════════════════════╗
      ║▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  (3 px IMDb-gold line)  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓║
      ║  CH  ┃                                                       ║
      ║   7  ┃  DISCOVERY CHANNEL                                   ║
      ║      ┃  Loading…                                             ║
      ╚═══════════════════════════════════════════════════════════════╝

    All public methods are thread-safe (called from asyncio).
    """

    def __init__(self, config: "OverlayConfig") -> None:
        self.config = config
        self._q: queue.Queue = queue.Queue()
        self._root: Optional[tk.Tk] = None
        self._canvas: Optional[tk.Canvas] = None
        self._ids: dict[str, int] = {}
        self._hide_job: Optional[str] = None
        self._alpha: float = 0.0
        self._fading: Optional[str] = None
        self.available: bool = False

        if config.enabled:
            t = threading.Thread(
                target=self._tk_thread, daemon=True, name="usher-overlay"
            )
            t.start()

    def show_channel(self, number: int, name: str, status: str = "") -> None:
        self._send("show", number=number, name=name, status=status)

    def update_status(self, status: str) -> None:
        self._send("status", status=status)

    def dismiss(self) -> None:
        self._send("hide")

    def _send(self, kind: str, **kw) -> None:
        if self.config.enabled:
            self._q.put((kind, kw))

    def _tk_thread(self) -> None:
        os.environ.setdefault("DISPLAY", ":0")
        try:
            self._root = tk.Tk()
            self._build_window()
            self._build_canvas()
            self.available = True
            logger.info("Overlay ready on %s", self.config.position)
            self._pump()
            self._root.mainloop()
        except tk.TclError as exc:
            logger.warning(
                "Overlay unavailable (no display?): %s  "
                "Set overlay.enabled: false in config.yaml to silence this.",
                exc,
            )
        except Exception:
            logger.exception("Overlay thread crashed")

    def _build_window(self) -> None:
        r  = self._root
        sw = r.winfo_screenwidth()
        sh = r.winfo_screenheight()
        y  = sh - _BANNER_H if self.config.position == "bottom" else 0
        r.withdraw()
        r.overrideredirect(True)
        r.wm_attributes("-topmost", True)
        r.wm_attributes("-alpha", 0.0)
        r.configure(bg=_BG)
        r.geometry(f"{sw}x{_BANNER_H}+0+{y}")

    def _build_canvas(self) -> None:
        r  = self._root
        sw = r.winfo_screenwidth()
        ff = self.config.font_family

        c = tk.Canvas(r, bg=_BG, highlightthickness=0, width=sw, height=_BANNER_H)
        c.pack(fill="both", expand=True)

        c.create_line(0, 0, sw, 0, fill=_ACCENT, width=3)

        c.create_text(
            _PAD_X, 28, text="CH",
            anchor="w", font=(ff, 11, "bold"), fill=_ACCENT,
        )

        self._ids["num"] = c.create_text(
            _PAD_X, 75, text="",
            anchor="w", font=(ff, 46, "bold"), fill=_ACCENT,
        )

        sep_x = _PAD_X + _NUM_W
        c.create_line(sep_x, 16, sep_x, _BANNER_H - 16, fill=_SEP, width=1)

        name_x = sep_x + 22

        self._ids["name"] = c.create_text(
            name_x, 52, text="",
            anchor="w", font=(ff, 30, "bold"), fill=_TEXT,
        )

        self._ids["status"] = c.create_text(
            name_x, 88, text="",
            anchor="w", font=(ff, 15), fill=_DIM,
        )

        self._canvas = c

    def _pump(self) -> None:
        try:
            while True:
                kind, kw = self._q.get_nowait()
                if kind == "show":
                    self._do_show(kw["number"], kw["name"], kw.get("status", ""))
                elif kind == "status":
                    self._set_status(kw.get("status", ""))
                elif kind == "hide":
                    self._cancel_hide()
                    self._start_fade("out")
        except queue.Empty:
            pass

        if self._root:
            self._root.after(40, self._pump)

    def _do_show(self, number: int, name: str, status: str) -> None:
        if not self._canvas:
            return
        c = self._canvas
        c.itemconfig(self._ids["num"],    text=str(number))
        c.itemconfig(self._ids["name"],   text=name.upper())
        c.itemconfig(self._ids["status"], text=status)
        self._cancel_hide()
        if self._fading == "out" or self._alpha < self.config.window_alpha:
            self._start_fade("in")
        else:
            self._schedule_hide()

    def _set_status(self, status: str) -> None:
        if self._canvas:
            self._canvas.itemconfig(self._ids["status"], text=status)

    def _start_fade(self, direction: str) -> None:
        self._fading = direction
        if direction == "in":
            self._root.deiconify()
        self._step_fade()

    def _step_fade(self) -> None:
        if not self._root or not self._fading:
            return

        step = self.config.window_alpha / self.config.fade_steps

        if self._fading == "in":
            self._alpha = min(self.config.window_alpha, self._alpha + step)
        else:
            self._alpha = max(0.0, self._alpha - step)

        self._root.wm_attributes("-alpha", self._alpha)

        reached_target = (
            (self._fading == "in"  and self._alpha >= self.config.window_alpha)
            or
            (self._fading == "out" and self._alpha <= 0.0)
        )

        if not reached_target:
            self._root.after(self.config.fade_interval_ms, self._step_fade)
        elif self._fading == "in":
            self._fading = None
            self._schedule_hide()
        else:
            self._fading = None
            self._root.withdraw()
            self._alpha = 0.0

    def _schedule_hide(self) -> None:
        ms = int(self.config.display_secs * 1000)
        self._hide_job = self._root.after(ms, lambda: self._start_fade("out"))

    def _cancel_hide(self) -> None:
        if self._hide_job:
            self._root.after_cancel(self._hide_job)
            self._hide_job = None

"""Linux/X11 backend: ``xdotool`` (XTEST) on the harness's display (#4935).

XTEST events go to the focused window of ``$DISPLAY``, so every key and pointer
event is *global*: :class:`~.base.OsInput` refuses it outside a GitHub runner or
the explicit opt-in, and checks before each one that the focused window's
``_NET_WM_PID`` is the intended PID. On CI the display is the private Xvfb
``xvfb-run`` starts, which nothing but the test instance and its helpers use.

Xvfb runs no window manager, so activation cannot ask one
(``_NET_ACTIVE_WINDOW``); it raises the window and sets the X input focus
directly, which is what a WM does on a click or Alt+Tab.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import Callable, Optional, Sequence

from .base import GlobalInjectionRefused, OsInput, OsInputUnavailable, OsWindow, global_injection_allowed

#: Portable key name → X keysym.
KEYSYMS = {
    "enter": "Return",
    "escape": "Escape",
    "tab": "Tab",
    "space": "space",
    "backspace": "BackSpace",
    "delete": "Delete",
    "home": "Home",
    "end": "End",
    "up": "Up",
    "down": "Down",
    "left": "Left",
    "right": "Right",
    "caps_lock": "Caps_Lock",
    "grave": "grave",
    "'": "apostrophe",
    "`": "grave",
    "/": "slash",
    "\\": "backslash",
    "-": "minus",
    "=": "equal",
    "[": "bracketleft",
    "]": "bracketright",
    ";": "semicolon",
    ",": "comma",
    ".": "period",
    "+": "plus",
    " ": "space",
}

#: Portable modifier name → xdotool modifier keysym.
MODIFIER_KEYSYMS = {
    "ctrl": "ctrl",
    "shift": "shift",
    "alt": "alt",
    "altgr": "ISO_Level3_Shift",
    "cmd": "super",
    "super": "super",
}

Runner = Callable[[Sequence[str]], str]


def keysym(key: str) -> str:
    """The X keysym for a portable key name or character."""
    if key in KEYSYMS:
        return KEYSYMS[key]
    if len(key) == 1 and key.isalnum():
        return key
    if key.startswith("f") and key[1:].isdigit():
        return key.upper()
    # Already a keysym (``dead_acute``, ``EuroSign``) — pass it through.
    return key


def combo_keysyms(mods: Sequence[str], key: str) -> str:
    """xdotool's ``mod+mod+key`` form of a parsed combo."""
    return "+".join([*(MODIFIER_KEYSYMS[m] for m in mods), keysym(key)])


def _default_runner(argv: Sequence[str]) -> str:
    try:
        result = subprocess.run(list(argv), capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError) as exc:
        raise OsInputUnavailable(f"{argv[0]} failed to run: {exc}") from exc
    if result.returncode != 0:
        raise OsInputUnavailable(
            f"{' '.join(argv)} exited {result.returncode}: {result.stderr.strip()}"
        )
    return result.stdout


class LinuxOsInput(OsInput):
    """``xdotool`` on the current X display."""

    is_global = True
    scale_is_device_pixel_ratio = True
    #: Pause between synthesized keys, so the webview sees distinct events.
    KEY_DELAY_MS = "40"

    def __init__(self, pid: int, *, run: Optional[Runner] = None, **kwargs) -> None:
        super().__init__(pid, **kwargs)
        self._run = run or _default_runner

    @staticmethod
    def unavailable_reason() -> Optional[str]:
        if not os.environ.get("DISPLAY"):
            return "no X display ($DISPLAY is unset); OS input needs X11 (Xvfb on CI)"
        if shutil.which("xdotool") is None:
            return "xdotool is not installed (apt install xdotool)"
        return None

    def _xdo(self, *args: str) -> str:
        return self._run(["xdotool", *args])

    # ── Windows ──────────────────────────────────────────────────────────────
    def _windows(self, pid: int) -> list[OsWindow]:
        try:
            ids = self._xdo("search", "--onlyvisible", "--pid", str(pid)).split()
        except OsInputUnavailable:
            return []  # xdotool search exits 1 when nothing matches
        windows = []
        for wid in ids:
            geo = self._geometry(wid)
            if geo is not None and geo[2] > 1 and geo[3] > 1:
                windows.append(OsWindow(int(wid), pid, *geo))
        return windows

    def _geometry(self, wid: str) -> Optional[tuple[int, int, int, int]]:
        try:
            out = self._xdo("getwindowgeometry", "--shell", wid)
        except OsInputUnavailable:
            return None
        values = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
        try:
            return tuple(int(values[k]) for k in ("X", "Y", "WIDTH", "HEIGHT"))  # type: ignore[return-value]
        except (KeyError, ValueError):
            return None

    def _frontmost_pid(self) -> Optional[int]:
        try:
            wid = self._xdo("getwindowfocus").strip()
            return int(self._xdo("getwindowpid", wid).strip())
        except (OsInputUnavailable, ValueError):
            return None

    def _activate(self, window: OsWindow) -> None:
        wid = str(window.handle)
        try:
            self._xdo("windowactivate", "--sync", wid)
        except OsInputUnavailable:
            # No window manager (bare Xvfb): raise + focus directly.
            self._xdo("windowraise", wid)
            self._xdo("windowfocus", "--sync", wid)

    # ── Keys ─────────────────────────────────────────────────────────────────
    def _key(self, pid: int, mods: Sequence[str], key: str) -> None:
        self._xdo("key", "--delay", self.KEY_DELAY_MS, combo_keysyms(mods, key))

    def _key_state(self, pid: int, key: str, down: bool) -> None:
        name = MODIFIER_KEYSYMS.get(key, keysym(key))
        self._xdo("keydown" if down else "keyup", name)

    def _type(self, pid: int, text: str) -> None:
        lines = text.split("\n")
        for i, line in enumerate(lines):
            if line:
                self._xdo("type", "--delay", self.KEY_DELAY_MS, "--", line)
            if i < len(lines) - 1:
                self._xdo("key", "Return")

    # ── Pointer ──────────────────────────────────────────────────────────────
    def _pointer_move(self, pid: int, x: int, y: int) -> None:
        self._xdo("mousemove", "--sync", str(x), str(y))

    def _pointer_button(self, pid: int, button: str, down: bool) -> None:
        number = {"left": "1", "middle": "2", "right": "3"}[button]
        self._xdo("mousedown" if down else "mouseup", number)

    # ── Keyboard layout (Xvfb only) ──────────────────────────────────────────
    def current_layout(self) -> tuple[str, str]:
        """``(layout, variant)`` of the X keyboard map."""
        out = self._run(["setxkbmap", "-query"])
        values = {
            k.strip(): v.strip() for k, v in (l.split(":", 1) for l in out.splitlines() if ":" in l)
        }
        return values.get("layout", "us"), values.get("variant", "")

    def set_layout(self, layout: str, variant: str = "") -> None:
        """Switch the display's keyboard map, e.g. ``("us", "intl")`` or ``("de", "")``.

        Display-wide, so it is held to the same rule as global input.
        """
        if not global_injection_allowed(self._env):
            raise GlobalInjectionRefused("changing the X keyboard map is refused outside CI")
        argv = ["setxkbmap", "-layout", layout]
        if variant:
            argv += ["-variant", variant]
        self._run(argv)

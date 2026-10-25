"""macOS backend: Quartz events and Apple events, aimed by PID (#4935).

- **Keys** go through ``CGEventPostToPid``: the event is delivered to the test
  instance's process only, whatever is frontmost, so key input is *not* global.
  The target's own keyboard layout turns the virtual keycode into a character
  (Option+E then E → é on the ABC/US layout).
- **Pointer** events have no per-PID route that WKWebView honours, so they are
  posted at the HID tap (``CGEventPost``) — global, and held to the base class'
  GitHub-runner/opt-in rule and frontmost-PID check.
- **Apple events** (reopen, quit, quit-for-logout) are addressed with
  ``typeKernelProcessID`` — the PID, never an app name or bundle id.

Posting events needs the Accessibility (TCC) permission for the process running
the harness; :meth:`MacOsInput.unavailable_reason` reports when it is missing.
"""

from __future__ import annotations

import re
import subprocess
import time
from typing import Any, Optional, Sequence

from .base import OsInput, OsInputUnavailable, OsWindow
from .keymap import mac_keycode, us_key_for_char

#: ``CGEventFlags`` per portable modifier.
FLAGS = {
    "shift": 0x00020000,
    "ctrl": 0x00040000,
    "alt": 0x00080000,
    "altgr": 0x00080000,
    "cmd": 0x00100000,
    "super": 0x00100000,
}
#: Windows below this ``kCGWindowLayer`` are app windows (0 normal, 3 floating).
MAX_APP_WINDOW_LAYER = 20
#: ``kCGEventFlagMaskAlphaShift`` — Caps Lock engaged.
CAPS_LOCK_FLAG = 0x00010000

#: Apple event four-char codes.
K_CORE_EVENT_CLASS = "aevt"
K_AE_REOPEN = "rapp"
K_AE_QUIT = "quit"
K_AE_QUIT_REASON = "why?"
K_AE_LOG_OUT = "logo"


def fourcc(code: str) -> int:
    """A four-char code as the big-endian integer Apple event APIs take."""
    data = code.encode("mac_roman")
    if len(data) != 4:
        raise ValueError(f"four-char code must be 4 bytes: {code!r}")
    return int.from_bytes(data, "big")


def combo_flags(mods: Sequence[str], caps_lock: bool = False) -> int:
    flags = 0
    for mod in mods:
        flags |= FLAGS[mod]
    return flags | (CAPS_LOCK_FLAG if caps_lock else 0)


class MacOsInput(OsInput):
    """Quartz/AppKit through pyobjc."""

    is_global = False
    scale_is_device_pixel_ratio = False
    KEY_DELAY = 0.03

    def __init__(self, pid: int, **kwargs: Any) -> None:
        super().__init__(pid, **kwargs)
        import Quartz  # noqa: PLC0415 — macOS-only dependency

        self._q = Quartz
        self._buttons_down: set[str] = set()
        #: Report Caps Lock as engaged on every key event (see :meth:`caps_lock`).
        self.caps_lock_engaged = False

    @staticmethod
    def unavailable_reason() -> Optional[str]:
        try:
            import Quartz  # noqa: F401, PLC0415
        except ImportError:
            return "pyobjc (Quartz) is not installed in the harness environment"
        try:
            from ApplicationServices import AXIsProcessTrusted  # noqa: PLC0415
        except ImportError:
            return None
        if not AXIsProcessTrusted():
            return (
                "the harness process lacks the macOS Accessibility permission "
                "(System Settings > Privacy & Security > Accessibility)"
            )
        return None

    # ── Windows ──────────────────────────────────────────────────────────────
    def _window_list(self) -> list[dict]:
        q = self._q
        options = q.kCGWindowListOptionOnScreenOnly | q.kCGWindowListExcludeDesktopElements
        return list(q.CGWindowListCopyWindowInfo(options, q.kCGNullWindowID) or [])

    def _windows(self, pid: int) -> list[OsWindow]:
        windows = []
        for info in self._window_list():
            if int(info.get("kCGWindowOwnerPID", -1)) != pid:
                continue
            # The test window is pinned always-on-top under the bridge (#957),
            # i.e. a floating level (3); menus, the Dock and the menu bar sit at
            # 20 and above.
            if not 0 <= int(info.get("kCGWindowLayer", 0)) < MAX_APP_WINDOW_LAYER:
                continue
            bounds = info.get("kCGWindowBounds") or {}
            w, h = int(bounds.get("Width", 0)), int(bounds.get("Height", 0))
            if w <= 1 or h <= 1:
                continue
            windows.append(
                OsWindow(
                    int(info.get("kCGWindowNumber", 0)),
                    pid,
                    int(bounds.get("X", 0)),
                    int(bounds.get("Y", 0)),
                    w,
                    h,
                    str(info.get("kCGWindowName") or ""),
                )
            )
        return windows

    def _frontmost_pid(self) -> Optional[int]:
        # The *active* application (the one keys go to), as Launch Services
        # reports it. Window order cannot answer this: the always-on-top test
        # window stays in front even while another app is active.
        try:
            asn = subprocess.run(
                ["lsappinfo", "front"], capture_output=True, text=True, timeout=5
            ).stdout.strip()
            out = subprocess.run(
                ["lsappinfo", "info", "-only", "pid", asn],
                capture_output=True,
                text=True,
                timeout=5,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            return None
        match = re.search(r'"pid"\s*=\s*(\d+)', out)
        return int(match.group(1)) if match else None

    def _screen_size(self) -> tuple[int, int]:
        bounds = self._q.CGDisplayBounds(self._q.CGMainDisplayID())
        return int(bounds.size.width), int(bounds.size.height)

    def _activate(self, window: OsWindow) -> None:
        from AppKit import (  # noqa: PLC0415
            NSApplicationActivateAllWindows,
            NSApplicationActivateIgnoringOtherApps,
            NSRunningApplication,
        )

        app = NSRunningApplication.runningApplicationWithProcessIdentifier_(window.pid)
        if app is None:
            raise OsInputUnavailable(f"no running application with PID {window.pid}")
        app.activateWithOptions_(
            NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps
        )
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if self._frontmost_pid() == window.pid:
                return
            time.sleep(0.1)
        # Newer macOS ignores activation requests from a background process;
        # the reopen Apple event makes the app activate itself.
        self.send_apple_event(window.pid, K_CORE_EVENT_CLASS, K_AE_REOPEN)

    # ── Keys ─────────────────────────────────────────────────────────────────
    def _post_key(self, pid: int, keycode: int, down: bool, flags: int) -> None:
        q = self._q
        event = q.CGEventCreateKeyboardEvent(None, keycode, down)
        q.CGEventSetFlags(event, flags | (CAPS_LOCK_FLAG if self.caps_lock_engaged else 0))
        q.CGEventPostToPid(pid, event)
        time.sleep(self.KEY_DELAY)

    def _key(self, pid: int, mods: Sequence[str], key: str) -> None:
        if key == "caps_lock":
            self.caps_lock_engaged = not self.caps_lock_engaged
            self._post_flags_changed(pid, mac_keycode("caps_lock"))
            return
        flags = combo_flags(mods)
        code = mac_keycode(key)
        self._post_key(pid, code, True, flags)
        self._post_key(pid, code, False, flags)

    def _post_flags_changed(self, pid: int, keycode: int) -> None:
        q = self._q
        event = q.CGEventCreateKeyboardEvent(None, keycode, True)
        q.CGEventSetType(event, q.kCGEventFlagsChanged)
        q.CGEventSetFlags(event, CAPS_LOCK_FLAG if self.caps_lock_engaged else 0)
        q.CGEventPostToPid(pid, event)
        time.sleep(self.KEY_DELAY)

    def _key_state(self, pid: int, key: str, down: bool) -> None:
        self._post_key(pid, mac_keycode(key), down, 0)

    def key_repeat(self, key: str, count: int, *, interval: float = 0.035) -> None:
        """Hold ``key``: one key-down, ``count`` autorepeat key-downs, one key-up.

        Autorepeat events carry ``kCGKeyboardEventAutorepeat``, which is what
        AppKit's press-and-hold (accent picker) reacts to.
        """
        target = self._before_key(None)
        q = self._q
        code = mac_keycode(key)
        self._post_key(target, code, True, 0)
        for _ in range(count):
            event = q.CGEventCreateKeyboardEvent(None, code, True)
            q.CGEventSetIntegerValueField(event, q.kCGKeyboardEventAutorepeat, 1)
            q.CGEventPostToPid(target, event)
            time.sleep(interval)
        self._post_key(target, code, False, 0)

    def _type(self, pid: int, text: str) -> None:
        for char in text:
            mapped = us_key_for_char(char)
            if mapped is None:
                self._post_unicode(pid, char)
                continue
            key, shift = mapped
            flags = FLAGS["shift"] if shift else 0
            code = mac_keycode(key)
            self._post_key(pid, code, True, flags)
            self._post_key(pid, code, False, flags)

    def _post_unicode(self, pid: int, char: str) -> None:
        q = self._q
        for down in (True, False):
            event = q.CGEventCreateKeyboardEvent(None, 0, down)
            q.CGEventKeyboardSetUnicodeString(event, len(char.encode("utf-16-le")) // 2, char)
            q.CGEventPostToPid(pid, event)
            time.sleep(self.KEY_DELAY)

    # ── Pointer ──────────────────────────────────────────────────────────────
    def _post_mouse(self, kind: int, x: int, y: int, button: int) -> None:
        q = self._q
        event = q.CGEventCreateMouseEvent(None, kind, (x, y), button)
        q.CGEventSetIntegerValueField(event, q.kCGMouseEventClickState, self.click_state)
        q.CGEventPost(q.kCGHIDEventTap, event)
        time.sleep(0.01)

    def _pointer_move(self, pid: int, x: int, y: int) -> None:
        q = self._q
        self._last = (x, y)
        if "left" in self._buttons_down:
            self._post_mouse(q.kCGEventLeftMouseDragged, x, y, q.kCGMouseButtonLeft)
        elif "right" in self._buttons_down:
            self._post_mouse(q.kCGEventRightMouseDragged, x, y, q.kCGMouseButtonRight)
        else:
            self._post_mouse(q.kCGEventMouseMoved, x, y, q.kCGMouseButtonLeft)

    def _pointer_button(self, pid: int, button: str, down: bool) -> None:
        q = self._q
        x, y = getattr(self, "_last", (0, 0))
        kinds = {
            ("left", True): (q.kCGEventLeftMouseDown, q.kCGMouseButtonLeft),
            ("left", False): (q.kCGEventLeftMouseUp, q.kCGMouseButtonLeft),
            ("right", True): (q.kCGEventRightMouseDown, q.kCGMouseButtonRight),
            ("right", False): (q.kCGEventRightMouseUp, q.kCGMouseButtonRight),
        }
        kind, number = kinds[(button, down)]
        (self._buttons_down.add if down else self._buttons_down.discard)(button)
        self._post_mouse(kind, x, y, number)

    # ── Apple events by PID ──────────────────────────────────────────────────
    def send_apple_event(
        self, pid: int, event_class: str, event_id: str, *, quit_reason: Optional[str] = None
    ) -> None:
        """Send a core Apple event to ``pid`` (``typeKernelProcessID``), no reply.

        ``("aevt", "rapp")`` is the Dock-icon click (reopen), ``("aevt",
        "quit")`` the Dock's Quit and AppleScript ``quit``; ``quit_reason="logo"``
        makes it the quit loginwindow sends at Log Out.
        """
        from Foundation import NSAppleEventDescriptor  # noqa: PLC0415

        target_pid = self._check_target(pid)
        target = NSAppleEventDescriptor.descriptorWithProcessIdentifier_(target_pid)
        event = NSAppleEventDescriptor.appleEventWithEventClass_eventID_targetDescriptor_returnID_transactionID_(
            fourcc(event_class), fourcc(event_id), target, -1, 0
        )
        if quit_reason is not None:
            event.setParamDescriptor_forKeyword_(
                NSAppleEventDescriptor.descriptorWithTypeCode_(fourcc(quit_reason)),
                fourcc(K_AE_QUIT_REASON),
            )
        # kAENoReply = 1; the app may quit before it could answer.
        _reply, error = event.sendEventWithOptions_timeout_error_(1, 10.0, None)
        if error is not None:
            raise OsInputUnavailable(f"Apple event {event_class}/{event_id} to PID {pid}: {error}")

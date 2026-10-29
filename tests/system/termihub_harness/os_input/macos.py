"""macOS backend: Quartz events and Apple events, aimed by PID (#4935).

- **Keys** go through ``CGEventPostToPid``: the event is delivered to the test
  instance's process only, whatever is frontmost, so key input is *not* global.
  The target's own keyboard layout turns the virtual keycode into a character
  (Option+E then E → é on the ABC/US layout).
- **Pointer** events have no per-PID route that WKWebView honours, so they are
  posted at the HID tap (``CGEventPost``) — global, and held to the base class'
  GitHub-runner/opt-in rule and frontmost-PID check. So are **autorepeat**
  key-downs (:meth:`MacOsInput.key_repeat`): AppKit drops them on the PID route.
- **Apple events** (reopen, quit, quit-for-logout) are addressed with
  ``typeKernelProcessID`` — the PID, never an app name or bundle id.

Posting events needs the Accessibility (TCC) permission for the process running
the harness; :meth:`MacOsInput.unavailable_reason` reports when it is missing.
"""

from __future__ import annotations

import re
import subprocess
import time
from typing import Any, Iterable, Optional, Sequence

from .base import OsInput, OsInputUnavailable, OsWindow, parse_combo
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
        #: Modifiers held with :meth:`key_down`, stamped on pointer events too.
        self._held_mods: set[str] = set()
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
        while self._frontmost_pid() != window.pid and time.monotonic() < deadline:
            time.sleep(0.1)
        if self._frontmost_pid() != window.pid:
            # Newer macOS ignores activation requests from a background process;
            # the reopen Apple event makes the app activate itself.
            self.send_apple_event(window.pid, K_CORE_EVENT_CLASS, K_AE_REOPEN)
        # Activation alone fronts the app's *last* key window. With several
        # windows of one PID, raise the chosen one through Accessibility (#4979).
        # Best effort, like the base class' frontmost-window wait: a caller that
        # needs proof checks the window's own focus.
        if len(self._windows(window.pid)) > 1:
            self._ax_raise(window)

    # ── Accessibility (one window of several) ────────────────────────────────
    @staticmethod
    def _ax_frame(element: Any) -> Optional[tuple[int, int, int, int]]:
        """``(x, y, width, height)`` of an AX window, top-left global points."""
        from ApplicationServices import (  # noqa: PLC0415
            AXUIElementCopyAttributeValue,
            AXValueGetValue,
            kAXPositionAttribute,
            kAXSizeAttribute,
            kAXValueCGPointType,
            kAXValueCGSizeType,
        )

        err, pos = AXUIElementCopyAttributeValue(element, kAXPositionAttribute, None)
        err2, size = AXUIElementCopyAttributeValue(element, kAXSizeAttribute, None)
        if err or err2 or pos is None or size is None:
            return None
        ok, point = AXValueGetValue(pos, kAXValueCGPointType, None)
        ok2, extent = AXValueGetValue(size, kAXValueCGSizeType, None)
        if not (ok and ok2):
            return None
        return (
            int(round(point.x)),
            int(round(point.y)),
            int(round(extent.width)),
            int(round(extent.height)),
        )

    @staticmethod
    def _frame_of(window: OsWindow) -> tuple[int, int, int, int]:
        return window.x, window.y, window.width, window.height

    def _ax_window_for(self, window: OsWindow) -> Any:
        """The AX element of ``window`` (matched by its frame), or ``None``."""
        from ApplicationServices import (  # noqa: PLC0415
            AXUIElementCopyAttributeValue,
            AXUIElementCreateApplication,
            kAXWindowsAttribute,
        )

        app = AXUIElementCreateApplication(window.pid)
        err, elements = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, None)
        if err or not elements:
            return None
        matches = [e for e in elements if self._ax_frame(e) == self._frame_of(window)]
        # Two windows with the very same frame cannot be told apart by frame.
        return matches[0] if len(matches) == 1 else None

    def _ax_raise(self, window: OsWindow) -> bool:
        """Make ``window`` its app's main (and so key) window and raise it.

        False when no single Accessibility window matches its frame.
        """
        from ApplicationServices import (  # noqa: PLC0415
            AXUIElementPerformAction,
            AXUIElementSetAttributeValue,
            kAXMainAttribute,
            kAXRaiseAction,
        )

        element = self._ax_window_for(window)
        if element is None:
            return False
        AXUIElementSetAttributeValue(element, kAXMainAttribute, True)
        AXUIElementPerformAction(element, kAXRaiseAction)
        return True

    def _frontmost_window(self) -> Optional[int]:
        """The focused window of the active app, matched to its CG window number."""
        from ApplicationServices import (  # noqa: PLC0415
            AXUIElementCopyAttributeValue,
            AXUIElementCreateApplication,
            kAXFocusedWindowAttribute,
        )

        pid = self._frontmost_pid()
        if pid is None:
            return None
        app = AXUIElementCreateApplication(pid)
        err, focused = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, None)
        if err or focused is None:
            return None
        frame = self._ax_frame(focused)
        matches = [w.handle for w in self._windows(pid) if self._frame_of(w) == frame]
        return matches[0] if len(matches) == 1 else None

    # ── Native dialogs (a sheet on one of the PID's windows) ─────────────────
    def native_dialog_open(self, baseline: Iterable[int], pid: Optional[int] = None) -> bool:
        """A new window of ``pid``, or an Accessibility sheet on one of its windows.

        An ``NSSavePanel`` run for a window is a sheet: it may not show up as a
        window of its own in the CG window list, but the app's Accessibility tree
        (looked up by PID) lists it as an ``AXSheet`` child of that window.
        """
        return super().native_dialog_open(baseline, pid) or self._ax_sheet_open(
            self._check_target(pid)
        )

    @staticmethod
    def _ax_sheet_open(pid: int) -> bool:
        from ApplicationServices import (  # noqa: PLC0415
            AXUIElementCopyAttributeValue,
            AXUIElementCreateApplication,
            kAXChildrenAttribute,
            kAXRoleAttribute,
            kAXWindowsAttribute,
        )

        app = AXUIElementCreateApplication(pid)
        err, windows = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, None)
        if err or not windows:
            return False
        for window in windows:
            err, children = AXUIElementCopyAttributeValue(window, kAXChildrenAttribute, None)
            if err or not children:
                continue
            for child in children:
                err, role = AXUIElementCopyAttributeValue(child, kAXRoleAttribute, None)
                if not err and role == "AXSheet":
                    return True
        return False

    def dialog_key(self, combo: str) -> None:
        """Press ``combo`` at the HID tap, for the app's ``NSSavePanel`` sheet.

        The save panel's content is served out of process (the AppKit open and
        save panel service), so a key posted to the app's PID never reaches its
        fields: Escape left the sheet open on the CI runner (#4982). At the HID
        tap the key goes to the key window, the sheet, as a typed key does.
        Global: GitHub runner or opt-in, the test instance frontmost before
        every event.
        """
        mods, key = parse_combo(combo)
        self._hid_key(mac_keycode(key), combo_flags(mods))

    def dialog_type(self, text: str) -> None:
        """Type ASCII ``text`` at the HID tap (see :meth:`dialog_key`)."""
        for char in text:
            mapped = us_key_for_char(char)
            if mapped is None:
                raise ValueError(f"cannot type {char!r} at the HID tap")
            key, shift = mapped
            self._hid_key(mac_keycode(key), FLAGS["shift"] if shift else 0)

    def _hid_key(self, keycode: int, flags: int) -> None:
        target = self._check_target(None)
        q = self._q
        for down in (True, False):
            self._require_global(target)
            event = q.CGEventCreateKeyboardEvent(None, keycode, down)
            q.CGEventSetFlags(event, flags)
            q.CGEventPost(q.kCGHIDEventTap, event)
            time.sleep(self.KEY_DELAY)

    def describe_focus(self) -> str:
        """Role, subrole and value of the test instance's focused UI element (read-only)."""
        from ApplicationServices import (  # noqa: PLC0415
            AXUIElementCopyAttributeValue,
            AXUIElementCreateApplication,
            kAXFocusedUIElementAttribute,
        )

        app = AXUIElementCreateApplication(self.pid)
        err, element = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, None)
        if err or element is None:
            return f"no focused element (AX error {err})"
        parts = []
        for name in ("AXRole", "AXSubrole", "AXTitle", "AXValue"):
            err, value = AXUIElementCopyAttributeValue(element, name, None)
            if not err and value is not None:
                parts.append(f"{name}={str(value)[:80]!r}")
        return " ".join(parts) or "a focused element without attributes"

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
        # A key posted to the PID does not change the HID modifier state, so a
        # held modifier is stamped on the HID pointer events by hand: Cmd held
        # over a click is a Cmd-click, as with a real held key.
        if key in FLAGS:
            (self._held_mods.add if down else self._held_mods.discard)(key)
        self._post_key(pid, mac_keycode(key), down, combo_flags(sorted(self._held_mods)))

    def key_repeat(
        self, key: str, count: int, *, interval: float = 0.035, delay: float = 0.5
    ) -> None:
        """Hold ``key``: one key-down, ``count`` autorepeat key-downs, one key-up.

        Autorepeat key-downs carry ``kCGKeyboardEventAutorepeat``, which is what
        AppKit's press-and-hold (accent picker) swallows while it is enabled.
        ``delay`` mirrors the system's initial repeat delay.

        These go through the **HID tap**, so they are global (GitHub runner or
        opt-in, the test instance frontmost before every event). The PID route
        does not work for them (#4980): AppKit drops every autorepeat key-down
        posted with ``CGEventPostToPid``, in a plain ``NSTextView`` as much as in
        WKWebView and whatever ``ApplePressAndHoldEnabled`` says. Posted at the
        HID tap they arrive as ``isARepeat`` key-downs, and press-and-hold
        swallows them exactly as it swallows a held physical key (CI probe runs
        40223402586 and 40225119750). The system never synthesises repeats for a
        posted key-down held down, so each repeat is posted explicitly.
        """
        target = self._check_target(None)
        q = self._q
        code = mac_keycode(key)

        def post(down: bool, repeat: bool = False) -> None:
            self._require_global(target)
            event = q.CGEventCreateKeyboardEvent(None, code, down)
            q.CGEventSetFlags(event, CAPS_LOCK_FLAG if self.caps_lock_engaged else 0)
            if repeat:
                q.CGEventSetIntegerValueField(event, q.kCGKeyboardEventAutorepeat, 1)
            q.CGEventPost(q.kCGHIDEventTap, event)

        post(True)
        try:
            time.sleep(delay)
            for _ in range(count):
                post(True, repeat=True)
                time.sleep(interval)
        finally:
            # Always release: a key left down at the HID level outlives the test.
            event = q.CGEventCreateKeyboardEvent(None, code, False)
            q.CGEventPost(q.kCGHIDEventTap, event)
            time.sleep(self.KEY_DELAY)

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
        if self._held_mods:
            q.CGEventSetFlags(event, combo_flags(sorted(self._held_mods)))
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

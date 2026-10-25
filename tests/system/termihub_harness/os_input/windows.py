"""Windows backend: ``SendInput`` into a foreground window found by PID (#4935).

``SendInput`` feeds the system input queue, which delivers to the foreground
window — so every event is *global*. The window is found by enumerating
top-level windows and matching ``GetWindowThreadProcessId`` to the PID (never
a title or class name), and before each event the base class checks that the
foreground window belongs to that PID.

The harness process is made per-monitor DPI aware so window rectangles and
cursor positions are physical pixels, matching ``devicePixelRatio`` scaling.
"""

from __future__ import annotations

import ctypes
import time
from ctypes import wintypes
from typing import Any, Optional, Sequence

from .base import (
    GlobalInjectionRefused,
    OsInput,
    OsInputUnavailable,
    OsWindow,
    global_injection_allowed,
)
from .keymap import us_key_for_char, win_vk

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MOUSE_FLAGS = {
    ("left", True): 0x0002,
    ("left", False): 0x0004,
    ("right", True): 0x0008,
    ("right", False): 0x0010,
    ("middle", True): 0x0020,
    ("middle", False): 0x0040,
}
#: Keys that need ``KEYEVENTF_EXTENDEDKEY`` (arrows, navigation, AltGr).
EXTENDED_VKS = {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0xA5}
KEYEVENTF_EXTENDEDKEY = 0x0001


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT), ("padding", ctypes.c_byte * 32)]


class _INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


class _GUITHREADINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("hwndActive", wintypes.HWND),
        ("hwndFocus", wintypes.HWND),
        ("hwndCapture", wintypes.HWND),
        ("hwndMenuOwner", wintypes.HWND),
        ("hwndMoveSize", wintypes.HWND),
        ("hwndCaret", wintypes.HWND),
        ("rcCaret", wintypes.RECT),
    ]


#: Smaller visible top-level windows are helper stubs, not app windows.
MIN_WINDOW_SIZE = 64

#: Keyboard layout ids (KLID) for :meth:`WindowsOsInput.set_layout`.
KLID_US_INTERNATIONAL = "00020409"
WM_INPUTLANGCHANGEREQUEST = 0x0050


def modifier_vks(mods: Sequence[str]) -> list[int]:
    """Virtual-key codes for the modifiers of a combo (``cmd`` → the Windows key)."""
    return [win_vk(m) for m in mods]


class WindowsOsInput(OsInput):
    """``user32`` through ctypes."""

    is_global = True
    scale_is_device_pixel_ratio = True
    KEY_DELAY = 0.03

    def __init__(self, pid: int, **kwargs: Any) -> None:
        super().__init__(pid, **kwargs)
        self._user32 = ctypes.WinDLL("user32", use_last_error=True)
        try:
            # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
            self._user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except (AttributeError, OSError):
            pass
        self._user32.GetForegroundWindow.restype = wintypes.HWND

    @staticmethod
    def unavailable_reason() -> Optional[str]:
        return None

    # ── Windows ──────────────────────────────────────────────────────────────
    def _window_pid(self, hwnd: int) -> int:
        pid = wintypes.DWORD()
        self._user32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(pid))
        return pid.value

    def _windows(self, pid: int) -> list[OsWindow]:
        found: list[OsWindow] = []
        user32 = self._user32

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def visit(hwnd, _lparam):
            if not user32.IsWindowVisible(hwnd) or self._window_pid(hwnd) != pid:
                return True
            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            width, height = rect.right - rect.left, rect.bottom - rect.top
            # Skip tool/message stubs (16x16); a second app window may be owned
            # by the first, so ownership is no filter.
            if width > MIN_WINDOW_SIZE and height > MIN_WINDOW_SIZE:
                found.append(OsWindow(int(hwnd), pid, rect.left, rect.top, width, height))
            return True

        user32.EnumWindows(visit, 0)
        return found

    def _frontmost_pid(self) -> Optional[int]:
        hwnd = self._user32.GetForegroundWindow()
        return self._window_pid(hwnd) if hwnd else None

    def _frontmost_window(self) -> Optional[int]:
        hwnd = self._user32.GetForegroundWindow()
        return int(hwnd) if hwnd else None

    def _screen_size(self) -> tuple[int, int]:
        return self._user32.GetSystemMetrics(0), self._user32.GetSystemMetrics(1)

    def _activate(self, window: OsWindow) -> None:
        user32 = self._user32
        hwnd = wintypes.HWND(window.handle)
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        # The foreground lock only lets the foreground thread hand focus on;
        # attach to it for the switch instead of injecting a key to unlock it.
        foreground = user32.GetForegroundWindow()
        fg_thread = user32.GetWindowThreadProcessId(foreground, None) if foreground else 0
        own_thread = ctypes.windll.kernel32.GetCurrentThreadId()
        attached = bool(fg_thread) and fg_thread != own_thread
        if attached:
            user32.AttachThreadInput(own_thread, fg_thread, True)
        try:
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
        finally:
            if attached:
                user32.AttachThreadInput(own_thread, fg_thread, False)

    # ── Input plumbing ───────────────────────────────────────────────────────
    @staticmethod
    def _key_input(vk: int, up: bool, *, unicode: Optional[str] = None) -> _INPUT:
        flags = KEYEVENTF_KEYUP if up else 0
        scan = 0
        if unicode is not None:
            flags |= KEYEVENTF_UNICODE
            scan, vk = ord(unicode), 0
        elif vk in EXTENDED_VKS:
            flags |= KEYEVENTF_EXTENDEDKEY
        return _INPUT(INPUT_KEYBOARD, _INPUTUNION(ki=_KEYBDINPUT(vk, scan, flags, 0, 0)))

    def _send(self, inputs: Sequence[_INPUT]) -> None:
        array = (_INPUT * len(inputs))(*inputs)
        sent = self._user32.SendInput(len(inputs), array, ctypes.sizeof(_INPUT))
        if sent != len(inputs):
            raise OsInputUnavailable(f"SendInput injected {sent}/{len(inputs)} events")
        time.sleep(self.KEY_DELAY)

    # ── Keys ─────────────────────────────────────────────────────────────────
    def _key(self, pid: int, mods: Sequence[str], key: str) -> None:
        mod_vks = modifier_vks(mods)
        vk = win_vk(key)
        downs = [self._key_input(m, False) for m in mod_vks] + [self._key_input(vk, False)]
        ups = [self._key_input(vk, True)] + [self._key_input(m, True) for m in reversed(mod_vks)]
        self._send(downs + ups)

    def _key_state(self, pid: int, key: str, down: bool) -> None:
        self._send([self._key_input(win_vk(key), not down)])

    def _type(self, pid: int, text: str) -> None:
        for char in text:
            mapped = us_key_for_char(char)
            if mapped is not None and mapped[0] in ("enter", "tab"):
                self._key(pid, [], mapped[0])
                continue
            self._send([self._key_input(0, False, unicode=char), self._key_input(0, True, unicode=char)])

    # ── Keyboard layout ──────────────────────────────────────────────────────
    def _focused_hwnd(self) -> Optional[int]:
        """The focused window of the foreground thread (WebView2's input window)."""
        user32 = self._user32
        foreground = user32.GetForegroundWindow()
        if not foreground:
            return None
        info = _GUITHREADINFO(cbSize=ctypes.sizeof(_GUITHREADINFO))
        thread = user32.GetWindowThreadProcessId(foreground, None)
        if user32.GetGUIThreadInfo(thread, ctypes.byref(info)) and info.hwndFocus:
            return int(info.hwndFocus)
        return int(foreground)

    def set_layout(self, klid: str) -> int:
        """Switch the focused window's input language to ``klid``; return the old HKL.

        Asks the focused window itself (``WM_INPUTLANGCHANGEREQUEST``), as the
        language bar does, after loading the layout. The focused window must
        belong to the test instance (checked like any global input).
        """
        if not global_injection_allowed(self._env):
            raise GlobalInjectionRefused("changing the keyboard layout is refused outside CI")
        self._require_global(self.pid)
        user32 = self._user32
        user32.LoadKeyboardLayoutW.restype = ctypes.c_void_p
        user32.GetKeyboardLayout.restype = ctypes.c_void_p
        hkl = user32.LoadKeyboardLayoutW(klid, 1)  # KLF_ACTIVATE
        if not hkl:
            raise OsInputUnavailable(f"keyboard layout {klid} could not be loaded")
        return self.post_layout(hkl)

    def post_layout(self, hkl: int) -> int:
        """Ask the focused window to use ``hkl``; return the HKL it had."""
        user32 = self._user32
        target = self._focused_hwnd()
        if target is None:
            raise OsInputUnavailable("no focused window to switch the layout of")
        previous = user32.GetKeyboardLayout(user32.GetWindowThreadProcessId(target, None))
        user32.PostMessageW(wintypes.HWND(target), WM_INPUTLANGCHANGEREQUEST, 0, ctypes.c_void_p(hkl))
        time.sleep(0.5)
        return int(previous or 0)

    # ── Pointer ──────────────────────────────────────────────────────────────
    def _pointer_move(self, pid: int, x: int, y: int) -> None:
        if not self._user32.SetCursorPos(x, y):
            raise OsInputUnavailable(f"SetCursorPos({x}, {y}) failed")
        time.sleep(0.01)

    def _pointer_button(self, pid: int, button: str, down: bool) -> None:
        flags = MOUSE_FLAGS[(button, down)]
        self._send([_INPUT(INPUT_MOUSE, _INPUTUNION(mi=_MOUSEINPUT(0, 0, 0, flags, 0, 0)))])

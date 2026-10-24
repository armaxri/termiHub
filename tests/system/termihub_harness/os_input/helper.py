"""A throwaway "other app" window for focus grades (#4935).

Focus checks need a second application to switch to: type into it, click away
to it, put it in front of termiHub. :class:`HelperWindow` launches a tiny GUI
process the harness owns (so its PID is known and allowed), which prints every
key it receives as a JSON line on stdout — proof that input went *there* and
not to the test instance.

macOS uses AppKit through pyobjc (already a harness dependency there); Linux
and Windows use Tk. The interpreter is the harness's own when it has tkinter,
else the system ``python3`` (apt ``python3-tk`` on the CI image).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import threading
import time
from typing import Optional

from .base import OsInputUnavailable

_TK_SCRIPT = r"""
import json, sys, tkinter as tk
x, y, w, h = (int(v) for v in sys.argv[1:5])
root = tk.Tk()
root.title("termihub-os-input-helper")
root.geometry(f"{w}x{h}+{x}+{y}")
text = tk.Text(root)
text.pack(fill="both", expand=True)
text.focus_set()
def on_key(event):
    print(json.dumps({"key": event.keysym, "char": event.char}), flush=True)
root.bind_all("<Key>", on_key)
root.after(200, lambda: print(json.dumps({"ready": True}), flush=True))
root.mainloop()
"""

_APPKIT_SCRIPT = r"""
import json, sys
from AppKit import (NSApplication, NSApplicationActivationPolicyRegular, NSBackingStoreBuffered,
                    NSEvent, NSKeyDownMask, NSMakeRect, NSScreen, NSTextView, NSWindow)
x, y, w, h = (int(v) for v in sys.argv[1:5])
app = NSApplication.sharedApplication()
app.setActivationPolicy_(NSApplicationActivationPolicyRegular)
screen_h = NSScreen.mainScreen().frame().size.height
win = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
    NSMakeRect(x, screen_h - y - h, w, h), 15, NSBackingStoreBuffered, False)
win.setTitle_("termihub-os-input-helper")
view = NSTextView.alloc().initWithFrame_(NSMakeRect(0, 0, w, h))
win.setContentView_(view)
win.makeKeyAndOrderFront_(None)
win.makeFirstResponder_(view)
def on_key(event):
    print(json.dumps({"key": event.keyCode(), "char": event.characters() or ""}), flush=True)
    return event
NSEvent.addLocalMonitorForEventsMatchingMask_handler_(NSKeyDownMask, on_key)
print(json.dumps({"ready": True}), flush=True)
app.activateIgnoringOtherApps_(True)
app.run()
"""


def _has_tkinter(python: str) -> bool:
    try:
        result = subprocess.run(
            [python, "-c", "import tkinter"], capture_output=True, timeout=20
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def helper_command(geometry: tuple[int, int, int, int]) -> list[str]:
    """The argv that starts the helper window at ``(x, y, width, height)``."""
    args = [str(v) for v in geometry]
    if sys.platform == "darwin":
        return [sys.executable, "-c", _APPKIT_SCRIPT, *args]
    for python in (sys.executable, shutil.which("python3")):
        if python and _has_tkinter(python):
            return [python, "-c", _TK_SCRIPT, *args]
    raise OsInputUnavailable(
        "no Python with tkinter for the helper window (apt install python3-tk)"
    )


class HelperWindow:
    """A harness-owned GUI window that records the keys it receives."""

    def __init__(self, geometry: tuple[int, int, int, int] = (40, 40, 360, 220)) -> None:
        self.geometry = geometry
        self._proc: Optional[subprocess.Popen[str]] = None
        self._lines: list[dict] = []
        self._ready = threading.Event()
        self._lock = threading.Lock()

    @property
    def pid(self) -> int:
        if self._proc is None:
            raise RuntimeError("helper window not started")
        return self._proc.pid

    def start(self, timeout: float = 30.0) -> "HelperWindow":
        self._proc = subprocess.Popen(
            helper_command(self.geometry),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        threading.Thread(target=self._pump, daemon=True).start()
        if not self._ready.wait(timeout):
            output = self.output()
            self.close()
            raise OsInputUnavailable(f"helper window did not start within {timeout}s: {output}")
        return self

    def _pump(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        for raw in self._proc.stdout:
            try:
                line = json.loads(raw)
            except ValueError:
                line = {"log": raw.rstrip()}
            with self._lock:
                self._lines.append(line)
            if line.get("ready"):
                self._ready.set()

    def output(self) -> list[dict]:
        with self._lock:
            return list(self._lines)

    def typed(self) -> str:
        """Every character the helper received, in order."""
        return "".join(line.get("char", "") for line in self.output() if "char" in line)

    def wait_typed(self, text: str, timeout: float = 10.0) -> str:
        deadline = time.monotonic() + timeout
        while text not in self.typed():
            if time.monotonic() >= deadline:
                raise AssertionError(f"helper never received {text!r}; got {self.typed()!r}")
            time.sleep(0.1)
        return self.typed()

    def close(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)

    def __enter__(self) -> "HelperWindow":
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.close()

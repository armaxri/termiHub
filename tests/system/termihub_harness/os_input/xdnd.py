"""Real X11 drag-and-drop partners for the test instance (#4936).

Tauri hands an OS file drop to the page only after the native layer accepted
it: on Linux the WebKitGTK window is an XDND drop target, and a row dragged out
of the file browser becomes a GTK drag *source* (the ``drag`` crate). To drive
both halves for real, the harness starts tiny GTK windows of its own:

- :class:`XdndSource` offers a fixed list of files as ``text/uri-list`` — the
  "file manager" a user drags files *from* onto termiHub;
- :class:`XdndTarget` accepts ``text/uri-list`` drops, reports every URI it
  received and copies the dropped files into its own folder — the "file
  manager" a user drags rows *to*.

Each prints JSON lines on stdout (``ready`` with its PID, then ``drag-begin``,
``data-get``, ``motion``, ``drop`` …) so a grade can tell what the other side
saw. The pointer is moved with the PID-checked :mod:`.linux` backend, so the
partners' PIDs must be allowed on the :class:`~.base.OsInput` first. They run
on the system ``python3`` with PyGObject (apt ``python3-gi`` and
``gir1.2-gtk-3.0`` on the CI image); X11 only — Wayland has no XTEST.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Iterable, Mapping, Optional, Sequence
from urllib.parse import unquote, urlparse

from .base import OsInput, OsInputUnavailable, OsWindow, drag_path

_GTK_SCRIPT = r"""
import json, os, shutil, sys
from urllib.parse import quote, unquote, urlparse
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk

mode = sys.argv[1]
x, y, w, h = (int(v) for v in sys.argv[2:6])
args = sys.argv[6:]

def say(**kw):
    print(json.dumps(kw), flush=True)

win = Gtk.Window(title=f"thub-xdnd-{mode}")
win.set_wmclass(f"thubxdnd{os.getpid()}", f"thubxdnd{os.getpid()}")
win.set_default_size(w, h)
win.move(x, y)
win.set_keep_above(True)
box = Gtk.EventBox()
box.add(Gtk.Label(label=f"xdnd {mode}"))
win.add(box)
win.connect("destroy", Gtk.main_quit)

if mode == "source":
    uris = ["file://" + quote(os.path.abspath(p)) for p in args]
    box.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, [], Gdk.DragAction.COPY)
    box.drag_source_add_uri_targets()
    box.connect("drag-begin", lambda *_: say(event="drag-begin"))
    def on_get(_w, _ctx, data, _info, _time):
        data.set_uris(uris)
        say(event="data-get", uris=uris)
    box.connect("drag-data-get", on_get)
    box.connect("drag-end", lambda *_: say(event="drag-end"))
    box.connect("drag-failed", lambda _w, _c, result: say(event="drag-failed", result=int(result)) or False)
else:
    dest = args[0]
    box.drag_dest_set(Gtk.DestDefaults.ALL, [], Gdk.DragAction.COPY)
    box.drag_dest_add_uri_targets()
    seen = {"motion": False}
    def on_motion(*_):
        if not seen["motion"]:
            seen["motion"] = True
            say(event="motion")
        return False
    box.connect("drag-motion", on_motion)
    box.connect("drag-leave", lambda *_: seen.update(motion=False))
    def on_received(_w, ctx, _x, _y, data, _info, time_):
        uris = list(data.get_uris() or [])
        if not uris:
            uris = [u for u in (data.get_text() or "").splitlines() if u.strip()]
        copied = []
        for uri in uris:
            src = unquote(urlparse(uri.strip()).path)
            target = os.path.join(dest, os.path.basename(src.rstrip("/")))
            try:
                if os.path.isdir(src):
                    shutil.copytree(src, target)
                else:
                    shutil.copy2(src, target)
                copied.append(target)
            except OSError as exc:
                say(event="copy-error", uri=uri, error=str(exc))
        say(event="drop", uris=uris, copied=copied)
    box.connect("drag-data-received", on_received)

def ready():
    say(ready=True, pid=os.getpid())
    return False

win.show_all()
GLib.timeout_add(300, ready)
Gtk.main()
"""

#: The interpreters tried for the GTK partner, in order: the distro Python
#: (where apt's PyGObject lives) before whatever ``python3`` is first on PATH.
_PYTHON_CANDIDATES = ("/usr/bin/python3", "python3")


def _has_gtk(python: str) -> bool:
    probe = "import gi; gi.require_version('Gtk', '3.0'); from gi.repository import Gtk"
    try:
        result = subprocess.run([python, "-c", probe], capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def gtk_python() -> str:
    """A Python with PyGObject + GTK 3, or raise :class:`OsInputUnavailable`."""
    for candidate in _PYTHON_CANDIDATES:
        python = candidate if os.path.isabs(candidate) else shutil.which(candidate)
        if python and os.path.exists(python) and _has_gtk(python):
            return python
    raise OsInputUnavailable(
        "no Python with PyGObject/GTK 3 for the XDND partner windows "
        "(apt install python3-gi gir1.2-gtk-3.0)"
    )


def unavailable_reason() -> Optional[str]:
    """Why this host cannot run the XDND partners, or ``None`` when it can."""
    if not sys.platform.startswith("linux"):
        return "real XDND drags are X11-only (Linux)"
    if not os.environ.get("DISPLAY"):
        return "no X display ($DISPLAY is unset)"
    if os.environ.get("WAYLAND_DISPLAY"):
        return "a Wayland session: XTEST cannot drive a native drag there"
    try:
        gtk_python()
    except OsInputUnavailable as exc:
        return str(exc)
    return None


def partner_command(
    python: str, mode: str, geometry: Sequence[int], args: Iterable[str]
) -> list[str]:
    """The argv that starts one partner window (``mode`` is source or target)."""
    if mode not in ("source", "target"):
        raise ValueError(f"unknown XDND partner mode {mode!r}")
    return [python, "-c", _GTK_SCRIPT, mode, *(str(int(v)) for v in geometry), *args]


#: GTK scaling knobs a scaled-display lane (#4997) sets for the test instance.
SCALE_ENV = ("GDK_SCALE", "GDK_DPI_SCALE")


def partner_env(env: Optional[Mapping[str, str]] = None) -> dict[str, str]:
    """The partner's environment: the harness's, minus GTK scaling (#4997).

    The partner stands in for another app at scale 1, so its ``geometry`` stays
    in X screen pixels even when the test instance runs under ``GDK_SCALE=2``
    (GTK would otherwise place and size it in logical pixels, off-screen).
    """
    base = dict(os.environ if env is None else env)
    for name in SCALE_ENV:
        base.pop(name, None)
    return base


def uri_paths(uris: Iterable[str]) -> list[str]:
    """Local paths of ``file://`` URIs (percent-encoded or raw, as the ``drag`` crate sends)."""
    return [unquote(urlparse(uri.strip()).path) for uri in uris if uri.strip()]


class _Partner:
    """A harness-owned partner window process reporting JSON lines.

    GTK here; :mod:`.native_dnd` reuses it for the AppKit and Win32 partners by
    overriding :meth:`command`.
    """

    mode = ""
    #: What the partner is, for messages.
    kind = "XDND"

    def __init__(self, geometry: Sequence[int], args: Sequence[str]) -> None:
        self.geometry = tuple(int(v) for v in geometry)
        self._args = list(args)
        self._proc: Optional[subprocess.Popen[str]] = None
        self._lines: list[dict] = []
        self._lock = threading.Lock()
        self._ready = threading.Event()
        self._pid: Optional[int] = None

    @property
    def pid(self) -> int:
        if self._pid is None:
            raise RuntimeError(f"{self.kind} {self.mode} window not started")
        return self._pid

    def command(self) -> list[str]:
        """The argv that starts this partner's window process."""
        return partner_command(gtk_python(), self.mode, self.geometry, self._args)

    def start(self, timeout: float = 30.0) -> "_Partner":
        argv = self.command()
        self._proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=partner_env(),
        )
        threading.Thread(target=self._pump, daemon=True).start()
        if not self._ready.wait(timeout):
            output = self.output()
            self.close()
            raise OsInputUnavailable(f"{self.kind} {self.mode} window did not start: {output}")
        return self

    def _pump(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        for raw in self._proc.stdout:
            try:
                line = json.loads(raw)
            except ValueError:
                line = {"log": raw.rstrip()}
            if not isinstance(line, dict):
                line = {"log": raw.rstrip()}
            with self._lock:
                self._lines.append(line)
            if line.get("ready"):
                self._pid = int(line.get("pid") or self._proc.pid)
                self._ready.set()

    def output(self) -> list[dict]:
        with self._lock:
            return list(self._lines)

    def events(self, name: str) -> list[dict]:
        return [line for line in self.output() if line.get("event") == name]

    def wait_event(self, name: str, timeout: float = 15.0) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            found = self.events(name)
            if found:
                return found[-1]
            if time.monotonic() >= deadline:
                raise AssertionError(
                    f"{self.kind} {self.mode} window never reported {name!r}; saw {self.output()}"
                )
            time.sleep(0.1)

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

    def __enter__(self) -> "_Partner":
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.close()


class XdndSource(_Partner):
    """A window that drags ``paths`` (as ``text/uri-list``) when pressed and moved."""

    mode = "source"

    def __init__(self, paths: Iterable[Path | str], geometry: Sequence[int]) -> None:
        super().__init__(geometry, [str(p) for p in paths])


class XdndTarget(_Partner):
    """A window that accepts file drops and copies the dropped files into ``dest``."""

    mode = "target"

    def __init__(self, dest: Path | str, geometry: Sequence[int]) -> None:
        self.dest = Path(dest)
        super().__init__(geometry, [str(self.dest)])

    def dropped_paths(self) -> list[str]:
        """Local paths of every URI dropped so far."""
        return [p for line in self.events("drop") for p in uri_paths(line.get("uris", []))]


def free_region(
    screen: tuple[int, int], window: OsWindow, size: tuple[int, int], margin: int = 20
) -> tuple[int, int]:
    """Top-left of a ``size`` box on ``screen`` that does not overlap ``window``.

    Tries right of, below, left of and above the window, in that order; raises
    when none fits (the window covers too much of the screen).
    """
    (sw, sh), (w, h) = screen, size
    top = max(0, min(window.y, sh - h))
    left = max(0, min(window.x, sw - w))
    candidates = [
        (window.x + window.width + margin, top),
        (left, window.y + window.height + margin),
        (window.x - margin - w, top),
        (left, window.y - margin - h),
    ]
    for x, y in candidates:
        if x >= 0 and y >= 0 and x + w <= sw and y + h <= sh:
            return x, y
    raise OsInputUnavailable(f"no {w}x{h} space beside window {window} on a {sw}x{sh} screen")


def native_drag(
    osi: OsInput,
    start: tuple[float, float],
    waypoints: Sequence[tuple[float, float]],
    *,
    hover: float = 1.0,
    steps: int = 25,
    on_hover: Optional[Callable[[int], None]] = None,
) -> None:
    """Press at ``start``, travel through ``waypoints`` and release at the last one.

    A native drag only advances on pointer motion: GTK begins it after the
    press moves past its threshold, and XDND sends a position to the window
    under the pointer only on a move. So the pointer first leaves ``start`` by
    a few pixels, then glides to each waypoint and *wiggles* there for
    ``hover`` seconds — long enough for the drop target to answer, or for the
    app to start its own native drag (an IPC round-trip). ``on_hover(i)`` runs
    once per wiggle at waypoint ``i``, e.g. to probe the app's hover state.
    The button is always released, even when a move was refused.
    """
    osi.pointer_move(*start)
    osi.pointer_button(True)
    time.sleep(0.2)
    try:
        here = start
        nudge = (start[0] + 12, start[1] + 12)
        for point in drag_path(here, nudge, 4):
            osi.pointer_move(*point)
            time.sleep(0.03)
        here = nudge
        for index, target in enumerate(waypoints):
            for point in drag_path(here, target, steps):
                osi.pointer_move(*point)
                time.sleep(0.03)
            here = target
            deadline = time.monotonic() + hover
            tick = 0
            while time.monotonic() < deadline:
                dx = (-2, 2, 0, 1)[tick % 4]
                osi.pointer_move(target[0] + dx, target[1] + dx)
                if on_hover is not None:
                    on_hover(index)
                tick += 1
                time.sleep(0.05)
            osi.pointer_move(*target)
            time.sleep(0.1)
    finally:
        osi._pointer_button(osi._check_target(None), "left", False)  # noqa: SLF001

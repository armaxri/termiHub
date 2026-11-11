"""Second-client readers for the app's Linux clipboard owners (#5170).

The app owns the host clipboard with **delayed rendering** when it copies a
remote desktop's files to the host (``src-tauri/src/linux_clipboard``): an X11
``CLIPBOARD`` selection owner and a native Wayland ``wlr-data-control`` source.
Neither moves a byte on copy; the files are fetched only when another client
pastes. The display-lane suite ``test_linux_clipboard_owner.py`` grades that from
the outside, the way a file manager would: a **second client process**
(``xclip`` under X11, ``wl-paste`` / ``wl-copy`` under Wayland) lists the
targets, pastes each one, and takes the clipboard over.

Everything runs against servers this module starts itself, so a local run never
reads or replaces the developer's real clipboard:

* :class:`PrivateXvfb` — an Xvfb on a free display chosen by the server
  (``-displayfd``), for the app's window and its X11 selection owner;
* :class:`HeadlessSway` — a headless wlroots compositor (sway implements
  ``wlr-data-control``; weston does not) on a private ``XDG_RUNTIME_DIR``.

The payload parsers and the skip decision are pure, and the command lines are
built by small functions taking an injectable runner, so all of it is
unit-tested without a display in ``tests/test_linux_clipboard_clients.py``.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Optional, Sequence
from urllib.parse import unquote, urlsplit

#: The targets the app's owners promise for copied files, in their order.
FILE_TARGETS = (
    "text/uri-list",
    "x-special/gnome-copied-files",
    "x-special/mate-copied-files",
)

#: The tools the X11 grade needs (also declared to the tool preflight).
X11_TOOLS = ("Xvfb", "xclip")
#: The tools the Wayland grade needs on top of :data:`X11_TOOLS`.
WAYLAND_TOOLS = ("sway", "wl-paste", "wl-copy")

#: How long one second-client read may take before the grade fails. A broken
#: owner that never answers must fail the test, not hang the lane.
READ_TIMEOUT = 20.0

#: The mock backend stages fetch ``n`` under ``.../fetch-<n>/<name>``.
_FETCH_DIR_RE = re.compile(r"^fetch-(\d+)$")

Runner = Callable[..., subprocess.CompletedProcess]


def skip_reason(
    tools: Sequence[str],
    *,
    platform: str = sys.platform,
    which: Callable[[str], Optional[str]] = shutil.which,
) -> Optional[str]:
    """Why this host cannot run a clipboard-owner grade, or ``None``.

    The owners are Linux-only. A missing tool on Linux is reported too, but the
    lanes never reach that skip: the tool preflight stops a CI session first.
    """
    if not platform.startswith("linux"):
        return "the Linux clipboard owners are Linux-only"
    missing = [tool for tool in tools if which(tool) is None]
    if missing:
        return f"clipboard second-client tools not on PATH: {', '.join(missing)}"
    return None


# ── payload parsing (pure) ──────────────────────────────────────────────────


def parse_uri_list(data: bytes) -> list[str]:
    """The URIs of a ``text/uri-list`` payload (RFC 2483).

    Lines are CRLF-terminated; ``#`` lines are comments. A bare-LF payload is
    rejected, because the app promises CRLF and a reader that only accepts CRLF
    would otherwise see one long line.
    """
    text = data.decode("utf-8")
    if text and not text.endswith("\r\n"):
        raise ValueError(f"text/uri-list is not CRLF-terminated: {text!r}")
    lines = text.split("\r\n")[:-1] if text else []
    for line in lines:
        if "\n" in line or "\r" in line:
            raise ValueError(f"stray line break inside a text/uri-list line: {line!r}")
    return [line for line in lines if line and not line.startswith("#")]


def parse_copied_files(data: bytes) -> tuple[str, list[str]]:
    """``(operation, uris)`` of an ``x-special/gnome-copied-files`` payload.

    The first line is the operation (``copy`` or ``cut``), then one URI per
    ``\\n``-separated line, with no trailing newline.
    """
    text = data.decode("utf-8")
    if "\r" in text:
        raise ValueError(f"copied-files payload must be LF-separated: {text!r}")
    if text.endswith("\n"):
        raise ValueError(f"copied-files payload has a trailing newline: {text!r}")
    operation, *uris = text.split("\n")
    if operation not in ("copy", "cut"):
        raise ValueError(f"copied-files payload starts with {operation!r}, not copy/cut")
    return operation, uris


def file_uri_path(uri: str) -> Path:
    """The local path a ``file://`` URI names, percent-decoded as UTF-8."""
    parts = urlsplit(uri)
    if parts.scheme != "file":
        raise ValueError(f"not a file URI: {uri!r}")
    if parts.netloc not in ("", "localhost"):
        raise ValueError(f"file URI names a remote host: {uri!r}")
    return Path(unquote(parts.path, encoding="utf-8", errors="strict"))


def fetch_number(path: Path) -> Optional[int]:
    """The mock backend's fetch sequence number of a staged file, or ``None``."""
    match = _FETCH_DIR_RE.match(path.parent.name)
    return int(match.group(1)) if match else None


# ── second clients ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ClipboardRead:
    """What one second-client paste returned."""

    ok: bool
    data: bytes
    stderr: str


def _read(argv: Sequence[str], env: Mapping[str, str], run: Runner) -> ClipboardRead:
    done = run(
        list(argv),
        env=dict(env),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=READ_TIMEOUT,
    )
    stderr = done.stderr.decode("utf-8", "replace") if done.stderr else ""
    return ClipboardRead(done.returncode == 0, done.stdout or b"", stderr)


def _base_env(**overrides: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
    env.update(overrides)
    return env


def xclip_argv(display: str, target: str) -> list[str]:
    """``xclip`` reading ``target`` from ``display``'s ``CLIPBOARD``."""
    return ["xclip", "-display", display, "-selection", "clipboard", "-t", target, "-o"]


def xclip_read(display: str, target: str, *, run: Runner = subprocess.run) -> ClipboardRead:
    """Paste ``target`` from ``display``'s ``CLIPBOARD`` as a second client."""
    return _read(xclip_argv(display, target), _base_env(DISPLAY=display), run)


def xclip_targets(display: str, *, run: Runner = subprocess.run) -> Optional[list[str]]:
    """The ``TARGETS`` the ``CLIPBOARD`` owner advertises, or ``None`` with no owner."""
    read = xclip_read(display, "TARGETS", run=run)
    if not read.ok:
        return None
    return [line for line in read.data.decode("utf-8", "replace").splitlines() if line]


def xclip_take(display: str, text: str) -> subprocess.Popen:
    """Become the ``CLIPBOARD`` owner with ``text``, as another app copying would.

    ``-quiet`` keeps xclip in the foreground until another client takes the
    selection; the caller terminates it when done.
    """
    proc = subprocess.Popen(
        ["xclip", "-display", display, "-selection", "clipboard", "-quiet", "-i"],
        env=_base_env(DISPLAY=display),
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    assert proc.stdin is not None
    proc.stdin.write(text.encode("utf-8"))
    proc.stdin.close()
    return proc


def wl_env(socket: Path) -> dict[str, str]:
    """The environment of a Wayland client of the compositor at ``socket``."""
    return _base_env(WAYLAND_DISPLAY=str(socket), XDG_RUNTIME_DIR=str(socket.parent))


def wl_paste_argv(*args: str) -> list[str]:
    return ["wl-paste", "--no-newline", *args]


def wl_paste(socket: Path, *args: str, run: Runner = subprocess.run) -> ClipboardRead:
    """Run ``wl-paste --no-newline <args>`` against the compositor at ``socket``."""
    return _read(wl_paste_argv(*args), wl_env(socket), run)


def wl_types(socket: Path, *, run: Runner = subprocess.run) -> Optional[list[str]]:
    """The MIME types the selection offers, or ``None`` when nothing is copied."""
    read = wl_paste(socket, "--list-types", run=run)
    if not read.ok:
        return None
    return [line for line in read.data.decode("utf-8", "replace").splitlines() if line]


def wl_take(socket: Path, text: str) -> subprocess.Popen:
    """Become the Wayland selection with ``text``, as another app copying would.

    ``--foreground`` keeps wl-copy attached until another client replaces the
    selection; the caller terminates it when done.
    """
    return subprocess.Popen(
        ["wl-copy", "--foreground", "--type", "text/plain", text],
        env=wl_env(socket),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def stop(proc: Optional[subprocess.Popen], timeout: float = 10.0) -> None:
    """Terminate ``proc`` (SIGTERM, then SIGKILL) if it is still running."""
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=timeout)


# ── private display servers ──────────────────────────────────────────────────


class PrivateXvfb:
    """An Xvfb on a display number the server picks itself (``-displayfd``).

    Stopped with SIGTERM so it removes its ``/tmp/.X11-unix`` socket: a later
    step (the Wayland-only lane) requires that directory to be empty.
    """

    def __init__(self, size: str = "1280x1024x24", startup_timeout: float = 20.0) -> None:
        self.proc = subprocess.Popen(
            ["Xvfb", "-displayfd", "1", "-nolisten", "tcp", "-screen", "0", size],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        assert self.proc.stdout is not None
        line = _read_line(self.proc.stdout, startup_timeout)
        number = line.strip()
        if not number.isdigit():
            stop(self.proc)
            raise RuntimeError(f"Xvfb reported no display number (got {line!r})")
        self.display = f":{number}"

    def close(self) -> None:
        stop(self.proc)


def _read_line(stream, timeout: float) -> str:
    """One line from a child's pipe, bounded so a stuck server fails fast."""
    import selectors

    sel = selectors.DefaultSelector()
    sel.register(stream, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    buf = b""
    try:
        while not buf.endswith(b"\n"):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not sel.select(remaining):
                break
            chunk = os.read(stream.fileno(), 64)
            if not chunk:
                break
            buf += chunk
    finally:
        sel.close()
    return buf.decode("ascii", "replace")


class HeadlessSway:
    """A headless sway (wlroots, implements ``wlr-data-control``).

    Runs on a private ``XDG_RUNTIME_DIR`` with no X server, input devices or
    GPU. :attr:`socket` is the absolute path of its Wayland socket, usable as
    ``WAYLAND_DISPLAY`` by any client.
    """

    def __init__(self, startup_timeout: float = 20.0) -> None:
        self.runtime_dir = Path(tempfile.mkdtemp(prefix="thub-sway-"))
        self.runtime_dir.chmod(0o700)
        config = self.runtime_dir / "sway.conf"
        config.write_text("", encoding="utf-8")
        self.log = self.runtime_dir / "sway.log"
        env = _base_env(
            XDG_RUNTIME_DIR=str(self.runtime_dir),
            WLR_BACKENDS="headless",
            WLR_RENDERER="pixman",
            WLR_LIBINPUT_NO_DEVICES="1",
        )
        with self.log.open("wb") as log:
            self.proc = subprocess.Popen(
                ["sway", "--config", str(config)],
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        deadline = time.monotonic() + startup_timeout
        while True:
            socket = next(
                (
                    p
                    for p in sorted(self.runtime_dir.iterdir())
                    if p.name.startswith("wayland-") and not p.name.endswith(".lock")
                ),
                None,
            )
            if socket is not None:
                self.socket = socket
                return
            if self.proc.poll() is not None or time.monotonic() > deadline:
                text = self.log.read_text(errors="replace") if self.log.exists() else ""
                self.close()
                raise RuntimeError(f"headless sway created no Wayland socket:\n{text[-4000:]}")
            time.sleep(0.05)

    def close(self) -> None:
        stop(self.proc)
        shutil.rmtree(self.runtime_dir, ignore_errors=True)

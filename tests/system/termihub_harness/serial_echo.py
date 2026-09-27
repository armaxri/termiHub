"""Host-side virtual serial port + echo fixture (``socat`` PTY pair).

The app runs host-native, so live serial I/O needs a serial device the *host*
can open. ``socat`` provides one: it links two pseudo-terminals back to back,
so bytes written to one end come out of the other. :class:`SerialEchoPair`
starts that pair and runs a small **echo loop** on the ``device`` end in a
background thread; the app is pointed at the ``app_port`` end and sees every
byte it sends echoed straight back — the behaviour of a loopback serial device.

Killing the ``socat`` process (:meth:`SerialEchoPair.kill_socat`) tears both
PTY masters down, which the app's serial reader observes as a lost port — the
live half of the lost-port disconnect notification (#1824, MT-SER-10).

This replaces the logic that previously lived only in ``scripts/test-system.sh``
/ ``scripts/test-system-linux.sh`` (#3682). The PTY links live in a fresh
private temp directory per instance, so parallel checkouts and xdist workers
never share a port. Teardown only ever signals the ``socat`` process *this*
instance started (by PID, via its :class:`subprocess.Popen` handle).

``socat`` is POSIX-only: on Windows, or when ``socat`` is not on ``PATH``,
:meth:`SerialEchoPair.start` raises :class:`SerialEchoUnavailable` so the
dependent suite skips cleanly.
"""

from __future__ import annotations

import errno
import os
import select
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional

#: How long to wait for ``socat`` to create both PTY links.
PTY_READY_TIMEOUT = 10.0


class SerialEchoUnavailable(RuntimeError):
    """``socat`` virtual serial ports cannot be provided on this host."""


def socat_path() -> Optional[str]:
    """The ``socat`` binary to use, or ``None`` when unavailable (incl. Windows)."""
    if sys.platform == "win32":
        return None
    return shutil.which("socat")


class SerialEchoPair:
    """A ``socat`` PTY pair with an echo loop on one end.

    Use as a context manager (or call :meth:`start` / :meth:`stop`)::

        with SerialEchoPair() as pair:
            connect_app_to(pair.app_port)   # every byte sent is echoed back

    ``app_port`` is the device path the app connects to; ``device_port`` is the
    other end, driven by the echo thread.
    """

    def __init__(self, *, echo: bool = True) -> None:
        self._echo = echo
        self._dir: Optional[Path] = None
        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._fd: Optional[int] = None
        self.app_port = ""
        self.device_port = ""

    # -- lifecycle -----------------------------------------------------------
    def __enter__(self) -> "SerialEchoPair":
        self.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()

    @property
    def socat_pid(self) -> Optional[int]:
        """PID of the ``socat`` process this instance started (``None`` if none)."""
        return self._proc.pid if self._proc is not None else None

    def socat_alive(self) -> bool:
        """Whether this instance's ``socat`` process is still running."""
        return self._proc is not None and self._proc.poll() is None

    def start(self) -> None:
        """Spawn ``socat`` and (if enabled) the echo loop; wait for both PTYs."""
        socat = socat_path()
        if socat is None:
            raise SerialEchoUnavailable(
                "socat is not available (not installed, or Windows host)"
            )
        # A short private directory keeps the links unique per instance while
        # staying well under any path-length limit.
        self._dir = Path(tempfile.mkdtemp(prefix="th-serial-"))
        self.app_port = str(self._dir / "app")
        self.device_port = str(self._dir / "dev")
        try:
            self._proc = subprocess.Popen(
                [
                    socat,
                    f"pty,raw,echo=0,link={self.app_port}",
                    f"pty,raw,echo=0,link={self.device_port}",
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self._wait_for_links()
            if self._echo:
                self._fd = os.open(self.device_port, os.O_RDWR | os.O_NOCTTY)
                self._thread = threading.Thread(
                    target=self._echo_loop,
                    args=(self._fd,),
                    name="serial-echo",
                    daemon=True,
                )
                self._thread.start()
        except BaseException:
            self.stop()
            raise

    def _wait_for_links(self) -> None:
        deadline = time.monotonic() + PTY_READY_TIMEOUT
        while time.monotonic() < deadline:
            if os.path.exists(self.app_port) and os.path.exists(self.device_port):
                return
            if self._proc is not None and self._proc.poll() is not None:
                raise SerialEchoUnavailable(
                    f"socat exited early (code {self._proc.returncode})"
                )
            time.sleep(0.05)
        raise SerialEchoUnavailable(
            f"socat did not create the PTY pair within {PTY_READY_TIMEOUT:.0f}s"
        )

    def _echo_loop(self, fd: int) -> None:
        """Write every byte read from the device end straight back.

        Exits when asked to stop or when the PTY goes away (``socat`` killed:
        ``read`` returns EOF or raises ``EIO``).
        """
        while not self._stop.is_set():
            try:
                ready, _, _ = select.select([fd], [], [], 0.1)
                if not ready:
                    continue
                data = os.read(fd, 1024)
                if not data:
                    return
                view = memoryview(data)
                while view:
                    written = os.write(fd, view)
                    view = view[written:]
            except OSError as exc:
                if exc.errno == errno.EINTR:
                    continue
                return
            except ValueError:  # fd closed under us during teardown
                return

    def kill_socat(self, timeout: float = 5.0) -> None:
        """Kill this instance's ``socat`` (simulates the device vanishing).

        Only the process this instance spawned is signalled — never anything
        found by name — so sibling fixtures and other checkouts are untouched.
        """
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=timeout)

    def stop(self) -> None:
        """Tear everything down; safe to call repeatedly and after :meth:`kill_socat`."""
        self._stop.set()
        self.kill_socat()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None
        if self._dir is not None:
            shutil.rmtree(self._dir, ignore_errors=True)
            self._dir = None

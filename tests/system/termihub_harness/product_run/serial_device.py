"""A virtual serial device for the product run's unattended serial leg (#5536).

``socat`` makes a pseudo-terminal pair; the app opens one end through a
symlink at a **fixed path in the run dir** (so an "unplug" and "replug" keeps
the port name, like a USB adapter that comes back as the same device), and a
small responder thread plays the device on the other end:

* every byte is echoed back (a device with echo on; CR becomes CR LF), so
  typed text appears only if it really went over the port;
* a finished line ``ID?`` is answered with :data:`DEVICE_ID`, ``AT`` with
  ``OK``; the lines received are kept in :attr:`VirtualSerialDevice.lines`;
* :meth:`VirtualSerialDevice.say` writes unsolicited output (device to app).

:meth:`unplug` kills this object's ``socat`` (the app sees the port vanish) and
:meth:`replug` starts a new pair at the same path. Only the ``socat`` process
this object started is ever signalled. POSIX only: without ``socat``,
:class:`SerialUnavailable` says why.

The line handling (:func:`respond`) is pure and unit-tested in the normal lane
(``tests/test_product_run_phase3_machinery.py``).
"""

from __future__ import annotations

import errno
import os
import select
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

DEVICE_ID = "PR-SERIAL-DEVICE v1"
READY_TIMEOUT = 10.0


class SerialUnavailable(RuntimeError):
    """No virtual serial pair can be made here (the reason is the message)."""


def respond(line: str) -> Optional[str]:
    """The device's answer to one received line, or ``None``."""
    command = line.strip().upper()
    if command == "ID?":
        return DEVICE_ID
    if command == "AT":
        return "OK"
    return None


class VirtualSerialDevice:
    """The run's virtual serial port + device; see the module docstring."""

    def __init__(self, link_dir: Path) -> None:
        if sys.platform == "win32":
            raise SerialUnavailable("virtual serial pairs need POSIX pseudo-terminals (socat)")
        socat = shutil.which("socat")
        if socat is None:
            raise SerialUnavailable("socat is not installed, so no virtual serial pair")
        self._socat = socat
        self.link_dir = link_dir
        self.app_port = str(link_dir / "ttyPR0")
        self._device_link = str(link_dir / "ttyPR0-device")
        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._fd: Optional[int] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self.lines: list[str] = []
        self.received = bytearray()
        self.plugs = 0

    # ── lifecycle ────────────────────────────────────────────────────────────
    def start(self) -> "VirtualSerialDevice":
        self.link_dir.mkdir(parents=True, exist_ok=True)
        for link in (self.app_port, self._device_link):
            if os.path.islink(link):
                os.unlink(link)
        self._proc = subprocess.Popen(
            [
                self._socat,
                f"pty,raw,echo=0,link={self.app_port}",
                f"pty,raw,echo=0,link={self._device_link}",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + READY_TIMEOUT
        while not (os.path.exists(self.app_port) and os.path.exists(self._device_link)):
            if self._proc.poll() is not None:
                raise SerialUnavailable(f"socat exited early (code {self._proc.returncode})")
            if time.monotonic() > deadline:
                self.unplug()
                raise SerialUnavailable("socat did not create the pseudo-terminal pair")
            time.sleep(0.05)
        self._fd = os.open(self._device_link, os.O_RDWR | os.O_NOCTTY)
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="pr-serial-device", daemon=True)
        self._thread.start()
        self.plugs += 1
        return self

    def unplug(self) -> None:
        """The adapter is pulled: the pair goes away under the app."""
        self._stop.set()
        proc, self._proc = self._proc, None
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None

    def replug(self) -> None:
        """The adapter comes back at the same port path."""
        self.unplug()
        self.start()

    def stop(self) -> None:
        self.unplug()
        shutil.rmtree(self.link_dir, ignore_errors=True)

    @property
    def plugged(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    # ── device side ──────────────────────────────────────────────────────────
    def say(self, text: str) -> None:
        """Unsolicited output from the device (CR LF terminated)."""
        if self._fd is None:
            raise SerialUnavailable("the device is unplugged")
        os.write(self._fd, (text + "\r\n").encode())

    def _loop(self) -> None:
        fd = self._fd
        line = bytearray()
        while not self._stop.is_set() and fd is not None:
            try:
                ready, _, _ = select.select([fd], [], [], 0.1)
                if not ready:
                    continue
                data = os.read(fd, 1024)
            except OSError as exc:
                if exc.errno == errno.EINTR:
                    continue
                return
            except ValueError:
                return
            if not data:
                return
            out = bytearray()
            for byte in data:
                with self._lock:
                    self.received.append(byte)
                if byte in (13, 10):
                    if byte == 13:
                        out += b"\r\n"
                    if line or byte == 13:
                        text = line.decode("utf-8", "replace")
                        line.clear()
                        with self._lock:
                            self.lines.append(text)
                        answer = respond(text)
                        if answer is not None:
                            out += (answer + "\r\n").encode()
                    continue
                line.append(byte)
                out.append(byte)
            try:
                os.write(fd, bytes(out))
            except OSError:
                return

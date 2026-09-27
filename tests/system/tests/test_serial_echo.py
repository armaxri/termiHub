"""Machinery tests for the host ``socat`` serial echo fixture (no app needed).

These run in the fast ``not integration`` group: they drive
:class:`~termihub_harness.SerialEchoPair` directly — the PTY pair appears, bytes
written to the app end come back, killing ``socat`` reads as a lost port on the
app end, and teardown leaves no process or link behind. They skip where
``socat`` is unavailable, exactly like the live serial suite does.
"""

from __future__ import annotations

import errno
import os
import select
import time

import pytest

from termihub_harness import SerialEchoPair, SerialEchoUnavailable
from termihub_harness import serial_echo

needs_socat = pytest.mark.skipif(
    serial_echo.socat_path() is None, reason="socat not available on this host"
)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _read_until(fd: int, needle: bytes, timeout: float = 5.0) -> bytes:
    buf = b""
    deadline = time.monotonic() + timeout
    while needle not in buf and time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            buf += os.read(fd, 1024)
    return buf


def test_start_raises_unavailable_without_socat(monkeypatch):
    """No socat (or Windows) → SerialEchoUnavailable, so the suite can skip."""
    monkeypatch.setattr(serial_echo, "socat_path", lambda: None)
    with pytest.raises(SerialEchoUnavailable):
        SerialEchoPair().start()


def test_socat_path_is_none_on_windows(monkeypatch):
    monkeypatch.setattr(serial_echo.sys, "platform", "win32")
    assert serial_echo.socat_path() is None


@needs_socat
def test_pair_creates_both_ptys_and_echoes():
    with SerialEchoPair() as pair:
        assert os.path.exists(pair.app_port)
        assert os.path.exists(pair.device_port)
        assert pair.socat_alive()
        fd = os.open(pair.app_port, os.O_RDWR | os.O_NOCTTY)
        try:
            os.write(fd, b"SERIAL_ECHO_TEST\r")
            assert b"SERIAL_ECHO_TEST" in _read_until(fd, b"SERIAL_ECHO_TEST")
        finally:
            os.close(fd)


@needs_socat
def test_each_instance_gets_its_own_ports():
    with SerialEchoPair() as a, SerialEchoPair() as b:
        assert a.app_port != b.app_port
        assert a.socat_pid != b.socat_pid


@needs_socat
def test_kill_socat_reads_as_a_lost_port_on_the_app_end():
    """The disconnect the live test relies on: the app end hits EOF / EIO."""
    with SerialEchoPair() as pair:
        fd = os.open(pair.app_port, os.O_RDWR | os.O_NOCTTY)
        try:
            pid = pair.socat_pid
            pair.kill_socat()
            assert not pair.socat_alive()
            assert pid is not None and not _pid_alive(pid)
            ready, _, _ = select.select([fd], [], [], 5.0)
            assert ready, "app end never became readable after socat died"
            try:
                data = os.read(fd, 1024)
            except OSError as exc:
                assert exc.errno == errno.EIO
            else:
                assert data == b""
        finally:
            os.close(fd)


@needs_socat
def test_stop_leaves_no_process_or_links():
    pair = SerialEchoPair()
    pair.start()
    pid = pair.socat_pid
    app_port = pair.app_port
    pair.stop()
    pair.stop()  # idempotent
    assert pid is not None and not _pid_alive(pid)
    assert not os.path.exists(app_port)
    assert not os.path.exists(os.path.dirname(app_port))

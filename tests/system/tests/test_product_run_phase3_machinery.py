"""The automations / agent / serial / telnet phase's own fixtures, without an app (#5536).

Runs in the normal (per-PR) lane; the product run itself is hand-triggered.
The telnet server and the virtual serial device are exercised for real over a
socket and a pseudo-terminal pair where the platform has them.
"""

from __future__ import annotations

import os
import select
import shutil
import socket
import sys
import time
from pathlib import Path

import pytest

from termihub_harness.product_run.serial_device import DEVICE_ID, VirtualSerialDevice, respond
from termihub_harness.product_run.telnet_server import (
    DO,
    IAC,
    OPT_NAWS,
    OPT_TTYPE,
    PROMPT,
    SB,
    SE,
    TTYPE_IS,
    WILL,
    IacFilter,
    TelnetServer,
    parse_naws,
    parse_ttype,
)

posix = pytest.mark.skipif(sys.platform == "win32", reason="POSIX pseudo-terminals only")


# ── IAC parsing ──────────────────────────────────────────────────────────────
def _filter():
    commands, subnegs = [], []
    return IacFilter(lambda v, o: commands.append((v, o)), subnegs.append), commands, subnegs


def test_iac_filter_separates_data_commands_and_subnegotiation():
    f, commands, subnegs = _filter()
    data = f.feed(b"ab" + bytes([IAC, WILL, OPT_NAWS, IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE]) + b"c")
    assert data == b"abc"
    assert commands == [(WILL, OPT_NAWS)]
    assert subnegs == [bytes([OPT_NAWS, 0, 80, 0, 24])]


def test_iac_filter_keeps_state_across_reads_and_unescapes_255():
    f, commands, subnegs = _filter()
    assert f.feed(bytes([IAC])) == b""
    assert f.feed(bytes([DO])) == b""
    assert f.feed(bytes([OPT_TTYPE, IAC, IAC])) == bytes([255])
    assert commands == [(DO, OPT_TTYPE)]
    f.feed(bytes([IAC, SB, OPT_NAWS, 0, IAC]))
    f.feed(bytes([IAC, 0, 24, IAC, SE]))  # IAC IAC inside SB is a literal 255
    assert subnegs == [bytes([OPT_NAWS, 0, 255, 0, 24])]


def test_parse_naws_and_ttype():
    assert parse_naws(bytes([OPT_NAWS, 0, 117, 0, 34])) == (117, 34)
    assert parse_naws(bytes([OPT_NAWS, 0, 117])) is None
    assert parse_ttype(bytes([OPT_TTYPE, TTYPE_IS]) + b"xterm-256color") == "xterm-256color"
    assert parse_ttype(bytes([OPT_TTYPE, 1])) is None


# ── the telnet server over a real socket ─────────────────────────────────────
def _read(sock: socket.socket, until: bytes, timeout: float = 10.0) -> bytes:
    buf = b""
    deadline = time.monotonic() + timeout
    while until not in buf and time.monotonic() < deadline:
        ready, _, _ = select.select([sock], [], [], 0.2)
        if ready:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
    assert until in buf, f"{until!r} not in {buf!r}"
    return buf


@posix
def test_telnet_server_negotiates_logs_in_and_runs_a_shell(tmp_path: Path):
    with TelnetServer(tmp_path / "home", username="u", password="p") as srv:
        sock = socket.create_connection(("127.0.0.1", srv.port), timeout=10)
        try:
            _read(sock, b"login: ")
            sock.sendall(bytes([IAC, WILL, OPT_NAWS, IAC, SB, OPT_NAWS, 0, 100, 0, 30, IAC, SE]))
            sock.sendall(bytes([IAC, WILL, OPT_TTYPE]))
            _read(sock, bytes([IAC, SB, OPT_TTYPE, 1, IAC, SE]))
            sock.sendall(bytes([IAC, SB, OPT_TTYPE, TTYPE_IS]) + b"vt220" + bytes([IAC, SE]))
            sock.sendall(b"u\r\n")
            _read(sock, b"Password: ")
            sock.sendall(b"wrong\r\n")
            _read(sock, b"Login incorrect")
            sock.sendall(b"u\r\n")
            _read(sock, b"Password: ")
            sock.sendall(b"p\r\n")
            _read(sock, PROMPT.encode())
            sock.sendall(b"stty size; echo T=$TERM H=$HOME\r\n")
            out = _read(sock, b"H=" + str(tmp_path / "home").encode())
            assert b"30 100" in out
            assert b"T=vt220" in out
            session = srv.latest()
            assert session.naws == [(100, 30)] and session.ttype == "vt220"
            assert session.logins == [("u", False), ("u", True)]
            assert b"wrong" not in out
            assert srv.drop_all() == 1
            sock.settimeout(5)
            while sock.recv(4096):  # drain what was in flight; EOF = the server closed
                pass
        finally:
            sock.close()
    assert session.closed


# ── the virtual serial device ────────────────────────────────────────────────
def test_device_answers():
    assert respond("ID?") == DEVICE_ID
    assert respond(" at ") == "OK"
    assert respond("hello") is None


@posix
@pytest.mark.skipif(shutil.which("socat") is None, reason="socat not installed")
def test_virtual_serial_device_talks_and_replugs_at_the_same_path(tmp_path: Path):
    device = VirtualSerialDevice(tmp_path / "serial").start()

    def talk(data: bytes, until: bytes) -> bytes:
        fd = os.open(device.app_port, os.O_RDWR | os.O_NOCTTY)
        try:
            os.write(fd, data)
            buf = b""
            deadline = time.monotonic() + 5
            while until not in buf and time.monotonic() < deadline:
                if select.select([fd], [], [], 0.2)[0]:
                    buf += os.read(fd, 1024)
            return buf
        finally:
            os.close(fd)

    try:
        assert DEVICE_ID.encode() in talk(b"ID?\r", DEVICE_ID.encode())
        port = device.app_port
        device.unplug()
        assert not device.plugged
        device.replug()
        assert device.app_port == port and device.plugs == 2
        assert b"OK" in talk(b"AT\r", b"OK")
        assert device.lines == ["ID?", "AT"]
    finally:
        device.stop()

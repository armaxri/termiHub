"""Unit tests for the product run's scripted VNC server (#5537), normal lane."""

from __future__ import annotations

import socket
import struct
import time

import pytest

from termihub_harness.product_run.vnc_server import (
    DEFAULT_FORMAT,
    PixelFormat,
    ScriptedVncServer,
    encode_pixel,
    parse_pixel_format,
    quadrant_at,
    raw_rect,
)


def test_default_format_round_trips():
    fmt = parse_pixel_format(DEFAULT_FORMAT)
    assert fmt == PixelFormat()


def test_colour_map_format_is_refused():
    data = struct.pack(">BBBBHHHBBB3x", 8, 8, 0, 0, 0, 0, 0, 0, 0, 0)
    with pytest.raises(ValueError):
        parse_pixel_format(data)


@pytest.mark.parametrize(
    ("fmt", "rgb", "want"),
    [
        (PixelFormat(), (255, 0, 0), bytes([0, 0, 255, 0])),
        (PixelFormat(big_endian=True), (255, 0, 0), bytes([0, 255, 0, 0])),
        # RGB565, little endian: red = 0xf800.
        (
            PixelFormat(16, 16, False, True, 31, 63, 31, 11, 5, 0),
            (255, 0, 0),
            bytes([0x00, 0xF8]),
        ),
    ],
)
def test_encode_pixel(fmt, rgb, want):
    assert encode_pixel(rgb, fmt) == want


def test_quadrants():
    assert quadrant_at(0, 0, 100, 80) == "top-left"
    assert quadrant_at(50, 0, 100, 80) == "top-right"
    assert quadrant_at(10, 40, 100, 80) == "bottom-left"
    assert quadrant_at(99, 79, 100, 80) == "bottom-right"


def test_raw_rect_paints_each_quadrant():
    fmt = PixelFormat()
    data = raw_rect(0, 0, 4, 2, width=4, height=2, fmt=fmt)
    assert struct.unpack(">HHHHi", data[:12]) == (0, 0, 4, 2, 0)
    body = data[12:]
    assert len(body) == 4 * 2 * 4
    red, green = encode_pixel((255, 0, 0), fmt), encode_pixel((0, 255, 0), fmt)
    assert body[:16] == red * 2 + green * 2


def _recv(sock: socket.socket, size: int) -> bytes:
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        assert chunk, "server hung up"
        data += chunk
    return data


def test_handshake_frame_and_input_events():
    server = ScriptedVncServer(width=8, height=4)
    try:
        with socket.create_connection(("127.0.0.1", server.port), timeout=5) as sock:
            assert _recv(sock, 12) == b"RFB 003.008\n"
            sock.sendall(b"RFB 003.008\n")
            assert _recv(sock, 2) == bytes([1, 1])
            sock.sendall(bytes([1]))
            assert _recv(sock, 4) == struct.pack(">I", 0)
            sock.sendall(bytes([1]))
            w, h = struct.unpack(">HH", _recv(sock, 4))
            assert (w, h) == (8, 4)
            _recv(sock, 16)
            (name_len,) = struct.unpack(">I", _recv(sock, 4))
            _recv(sock, name_len)
            sock.sendall(struct.pack(">BxH", 2, 1) + struct.pack(">i", 0))
            sock.sendall(struct.pack(">BBHHHH", 3, 0, 0, 0, 8, 4))
            header = _recv(sock, 4)
            assert struct.unpack(">BxH", header) == (0, 1)
            _recv(sock, 12 + 8 * 4 * 4)
            sock.sendall(struct.pack(">BB2xI", 4, 1, 0x61))
            sock.sendall(struct.pack(">BBHH", 5, 1, 3, 2))
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                events = server.events()
                if any(e.startswith("pointer") for e in events):
                    break
                time.sleep(0.05)
        events = server.events()
        assert "key #1 0x61 down" in events
        assert "pointer #1 1 3,2" in events
        assert "frame #1 8x4" in events
        assert server.connections() == 1
    finally:
        server.close()

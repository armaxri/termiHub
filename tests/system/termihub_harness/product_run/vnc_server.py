"""A tiny scripted VNC (RFB 3.8) server for the product run's unattended VNC leg (#5537).

The VNC fixtures of the integration lane (``tests/test_vnc.py``) are Linux
containers, and macOS's own Screen Sharing needs an admin switch, so a product
run on a developer Mac had no VNC server to connect to. This one is pure
stdlib, runs unprivileged on a loopback port and stops with the run:

* security type **None** (the app's VNC client accepts it on RFB 3.8),
* a static ``width`` x ``height`` four-quadrant desktop (the colours of
  :data:`~termihub_harness.fixtures.VNC_QUADRANT_COLORS`, so the existing
  canvas grades apply), sent as **Raw** rectangles in whatever true-colour
  pixel format the client asks for (``SetPixelFormat``),
* every key, pointer and clipboard event it receives is recorded, so a grade
  can check that input typed into the canvas reached the server.

It is not a general VNC server: no encodings beyond Raw, no resize, no
authentication. The protocol pieces (:func:`encode_pixel`, :func:`raw_rect`,
:func:`parse_pixel_format`) are pure and unit-tested in the normal lane
(``tests/test_product_run_vnc_server.py``), as is a full handshake against a
socket client.
"""

from __future__ import annotations

import socket
import struct
import threading
import time
from dataclasses import dataclass
from typing import Optional

#: The quadrant colours (TL, TR, BL, BR), as the Docker VNC fixtures paint them.
QUADRANTS: dict[str, tuple[int, int, int]] = {
    "top-left": (255, 0, 0),
    "top-right": (0, 255, 0),
    "bottom-left": (0, 0, 255),
    "bottom-right": (255, 255, 255),
}

#: The server's native format: 32 bpp, depth 24, little endian, true colour, RGB888.
DEFAULT_FORMAT = struct.pack(">BBBBHHHBBB3x", 32, 24, 0, 1, 255, 255, 255, 16, 8, 0)


@dataclass(frozen=True)
class PixelFormat:
    """An RFB ``PIXEL_FORMAT`` (true colour only)."""

    bits_per_pixel: int = 32
    depth: int = 24
    big_endian: bool = False
    true_colour: bool = True
    red_max: int = 255
    green_max: int = 255
    blue_max: int = 255
    red_shift: int = 16
    green_shift: int = 8
    blue_shift: int = 0


def parse_pixel_format(data: bytes) -> PixelFormat:
    """Decode the 16-byte ``PIXEL_FORMAT``; raises ``ValueError`` on a non-true-colour one."""
    if len(data) != 16:
        raise ValueError(f"PIXEL_FORMAT is 16 bytes, got {len(data)}")
    bpp, depth, big, true_colour, rmax, gmax, bmax, rs, gs, bs = struct.unpack(
        ">BBBBHHHBBB3x", data
    )
    if not true_colour:
        raise ValueError("colour-map pixel formats are not supported")
    if bpp not in (8, 16, 32):
        raise ValueError(f"unsupported bits-per-pixel {bpp}")
    return PixelFormat(bpp, depth, bool(big), True, rmax, gmax, bmax, rs, gs, bs)


def encode_pixel(rgb: tuple[int, int, int], fmt: PixelFormat) -> bytes:
    """One pixel of ``rgb`` (8-bit channels) in the client's format."""
    r, g, b = rgb
    value = (
        (r * fmt.red_max // 255) << fmt.red_shift
        | (g * fmt.green_max // 255) << fmt.green_shift
        | (b * fmt.blue_max // 255) << fmt.blue_shift
    )
    size = fmt.bits_per_pixel // 8
    return value.to_bytes(size, "big" if fmt.big_endian else "little")


def quadrant_at(x: int, y: int, width: int, height: int) -> str:
    """Which quadrant framebuffer pixel ``(x, y)`` lies in."""
    horizontal = "left" if x < width // 2 else "right"
    vertical = "top" if y < height // 2 else "bottom"
    return f"{vertical}-{horizontal}"


def raw_rect(
    x: int, y: int, w: int, h: int, *, width: int, height: int, fmt: PixelFormat
) -> bytes:
    """A Raw-encoded rectangle header + pixels of the quadrant desktop."""
    pixels = {name: encode_pixel(rgb, fmt) for name, rgb in QUADRANTS.items()}
    split_x = min(max(width // 2 - x, 0), w)
    rows = []
    for row_y in range(y, y + h):
        vertical = "top" if row_y < height // 2 else "bottom"
        rows.append(
            pixels[f"{vertical}-left"] * split_x + pixels[f"{vertical}-right"] * (w - split_x)
        )
    body = b"".join(rows)
    return struct.pack(">HHHHi", x, y, w, h, 0) + body


class ScriptedVncServer:
    """One loopback RFB server thread; :meth:`close` (or the run's end) stops it."""

    def __init__(self, *, width: int = 1024, height: int = 768, name: str = "termiHub product run"):
        self.width = width
        self.height = height
        self.name = name
        self._events: list[str] = []
        self._lock = threading.Lock()
        self._connections = 0
        self._closed = threading.Event()
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(4)
        self._sock.settimeout(0.5)
        self.port: int = self._sock.getsockname()[1]
        self._thread = threading.Thread(target=self._accept_loop, name="vnc-server", daemon=True)
        self._thread.start()

    # ── reads for the grades ─────────────────────────────────────────────────
    def events(self) -> list[str]:
        with self._lock:
            return list(self._events)

    def connections(self) -> int:
        with self._lock:
            return self._connections

    def _record(self, event: str) -> None:
        with self._lock:
            self._events.append(event)

    # ── lifecycle ────────────────────────────────────────────────────────────
    def close(self) -> None:
        self._closed.set()
        try:
            self._sock.close()
        except OSError:
            pass
        self._thread.join(timeout=5)

    def _accept_loop(self) -> None:
        while not self._closed.is_set():
            try:
                conn, _ = self._sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with self._lock:
                self._connections += 1
                number = self._connections
            threading.Thread(
                target=self._serve, args=(conn, number), name=f"vnc-conn-{number}", daemon=True
            ).start()

    # ── one client ───────────────────────────────────────────────────────────
    def _serve(self, conn: socket.socket, number: int) -> None:
        conn.settimeout(1.0)
        try:
            self._handshake(conn, number)
            self._message_loop(conn, number)
        except (OSError, ConnectionError, ValueError) as exc:
            self._record(f"closed #{number} {type(exc).__name__}: {exc}")
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _recv(self, conn: socket.socket, size: int) -> bytes:
        data = b""
        while len(data) < size:
            if self._closed.is_set():
                raise ConnectionError("server closing")
            try:
                chunk = conn.recv(size - len(data))
            except socket.timeout:
                continue
            if not chunk:
                raise ConnectionError("client hung up")
            data += chunk
        return data

    def _handshake(self, conn: socket.socket, number: int) -> None:
        conn.sendall(b"RFB 003.008\n")
        version = self._recv(conn, 12)
        self._record(f"version #{number} {version.decode('ascii', 'replace').strip()}")
        if version.startswith(b"RFB 003.003"):
            conn.sendall(struct.pack(">I", 1))  # 3.3: the server picks None
        else:
            conn.sendall(bytes([1, 1]))  # one type: None
            chosen = self._recv(conn, 1)[0]
            if chosen != 1:
                raise ValueError(f"client chose security type {chosen}")
            if version.startswith(b"RFB 003.008"):
                conn.sendall(struct.pack(">I", 0))  # SecurityResult OK
        shared = self._recv(conn, 1)[0]
        name = self.name.encode("utf-8")
        conn.sendall(
            struct.pack(">HH", self.width, self.height)
            + DEFAULT_FORMAT
            + struct.pack(">I", len(name))
            + name
        )
        self._record(f"connected #{number} shared={shared}")

    def _message_loop(self, conn: socket.socket, number: int) -> None:
        fmt = parse_pixel_format(DEFAULT_FORMAT)
        sent_full = False
        while not self._closed.is_set():
            kind = self._recv(conn, 1)[0]
            if kind == 0:  # SetPixelFormat
                fmt = parse_pixel_format(self._recv(conn, 19)[3:])
                self._record(f"pixel-format #{number} {fmt.bits_per_pixel}bpp")
            elif kind == 2:  # SetEncodings
                _, count = struct.unpack(">BH", self._recv(conn, 3))
                encodings = struct.unpack(f">{count}i", self._recv(conn, 4 * count))
                self._record(f"encodings #{number} {list(encodings)}")
            elif kind == 3:  # FramebufferUpdateRequest
                incremental, x, y, w, h = struct.unpack(">BHHHH", self._recv(conn, 9))
                x, y = min(x, self.width), min(y, self.height)
                w, h = min(w, self.width - x), min(h, self.height - y)
                if incremental and sent_full:
                    # Nothing changes on this desktop: answer slowly with no rectangles.
                    time.sleep(0.5)
                    conn.sendall(struct.pack(">BxH", 0, 0))
                    continue
                if not sent_full:
                    x, y, w, h = 0, 0, self.width, self.height
                conn.sendall(
                    struct.pack(">BxH", 0, 1)
                    + raw_rect(x, y, w, h, width=self.width, height=self.height, fmt=fmt)
                )
                if not sent_full:
                    self._record(f"frame #{number} {w}x{h}")
                sent_full = True
            elif kind == 4:  # KeyEvent
                down, key = struct.unpack(">B2xI", self._recv(conn, 7))
                self._record(f"key #{number} {key:#x} {'down' if down else 'up'}")
            elif kind == 5:  # PointerEvent
                mask, x, y = struct.unpack(">BHH", self._recv(conn, 5))
                self._record(f"pointer #{number} {mask} {x},{y}")
            elif kind == 6:  # ClientCutText
                (length,) = struct.unpack(">3xI", self._recv(conn, 7))
                text = self._recv(conn, length).decode("latin-1")
                self._record(f"cut-text #{number} {text}")
            else:
                raise ValueError(f"unknown client message type {kind}")


def start_vnc_server(**kwargs) -> Optional[ScriptedVncServer]:
    """A started server, or ``None`` when no loopback port could be bound."""
    try:
        return ScriptedVncServer(**kwargs)
    except OSError:
        return None

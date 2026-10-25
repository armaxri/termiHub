"""Native capture of the test app's own window, located by its PID (#4937).

The bridge ``screenshot`` verb rasterises the DOM, so it never sees what the
GPU actually painted: the xterm WebGL canvas, the inline-image layer, or the
native window before the web view's first paint. This module asks the OS for
the pixels of the window the harness launched instead:

- **Linux (X11 / Xvfb)**: ``xdotool search --onlyvisible --pid`` finds the
  window carrying the app's ``_NET_WM_PID``; ``xwd -silent -id`` dumps it.
- **macOS**: ``CGWindowListCopyWindowInfo`` (through ``ctypes``) lists the
  on-screen windows; the one whose ``kCGWindowOwnerPID`` is the app's is
  captured with ``screencapture -x -o -l <window id> -t bmp``.
- **Windows**: ``EnumWindows`` + ``GetWindowThreadProcessId`` find the app's
  visible top-level window; ``PrintWindow`` with ``PW_CLIENTONLY |
  PW_RENDERFULLCONTENT`` renders its client area (the web view, DirectComposition
  content included) into a DIB, falling back to a copy of the screen under
  the client area when that comes back black.

**Safety.** The window is only ever located by the PID the harness itself
launched — never by an application name, bundle id or window title, which
could match an installed termiHub running on the same machine.

Every capture comes back as a :class:`Frame` of 8-bit RGB pixels in device
pixels. Uncompressed formats (XWD, BMP, a raw DIB) are parsed here so the
harness needs no imaging library; :func:`encode_png` writes evidence files.
The parsers and the PNG writer are pure and unit-tested in the normal lane
(``tests/test_window_capture.py``); the OS paths run in the integration lane.
"""

from __future__ import annotations

import base64
import binascii
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path
from typing import Iterable, NamedTuple, Optional, Sequence

#: How long one OS capture call may take before it counts as unavailable.
_CAPTURE_TIMEOUT = 15.0


class CaptureUnavailable(RuntimeError):
    """The window could not be captured (no tool, no window, no permission)."""


class Rect(NamedTuple):
    """An integer pixel rect: left, top, width, height."""

    x: int
    y: int
    w: int
    h: int

    @property
    def right(self) -> int:
        return self.x + self.w

    @property
    def bottom(self) -> int:
        return self.y + self.h


class Frame:
    """An 8-bit RGB image: ``data`` holds ``width * height * 3`` bytes, row-major."""

    __slots__ = ("width", "height", "data")

    def __init__(self, width: int, height: int, data: bytes) -> None:
        if width <= 0 or height <= 0:
            raise ValueError(f"empty frame {width}x{height}")
        if len(data) != width * height * 3:
            raise ValueError(f"frame data is {len(data)} bytes, want {width * height * 3}")
        self.width = width
        self.height = height
        self.data = bytes(data)

    @classmethod
    def filled(cls, width: int, height: int, rgb: Sequence[int]) -> "Frame":
        """A frame of one solid colour."""
        return cls(width, height, bytes(rgb[:3]) * (width * height))

    def pixel(self, x: int, y: int) -> tuple[int, int, int]:
        """The ``(r, g, b)`` of pixel ``(x, y)``."""
        if not (0 <= x < self.width and 0 <= y < self.height):
            raise IndexError(f"pixel ({x}, {y}) outside {self.width}x{self.height}")
        i = (y * self.width + x) * 3
        d = self.data
        return d[i], d[i + 1], d[i + 2]

    def clip(self, rect: Rect) -> Rect:
        """``rect`` clipped to the frame (may come back empty)."""
        x0, y0 = max(0, rect.x), max(0, rect.y)
        x1, y1 = min(self.width, rect.right), min(self.height, rect.bottom)
        return Rect(x0, y0, max(0, x1 - x0), max(0, y1 - y0))

    def crop(self, rect: Rect) -> "Frame":
        """The pixels inside ``rect`` (clipped to the frame) as a new frame."""
        r = self.clip(rect)
        if r.w == 0 or r.h == 0:
            raise ValueError(f"crop {rect} is outside the {self.width}x{self.height} frame")
        stride = self.width * 3
        rows = (
            self.data[(r.y + y) * stride + r.x * 3 : (r.y + y) * stride + r.right * 3]
            for y in range(r.h)
        )
        return Frame(r.w, r.h, b"".join(rows))

    def pixels(self, rect: Optional[Rect] = None, step: int = 1) -> Iterable[tuple[int, int, int]]:
        """Every ``step``-th pixel (both axes) inside ``rect`` (default: whole frame)."""
        r = self.clip(rect) if rect is not None else Rect(0, 0, self.width, self.height)
        d, w = self.data, self.width
        for y in range(r.y, r.bottom, step):
            base = y * w
            for x in range(r.x, r.right, step):
                i = (base + x) * 3
                yield d[i], d[i + 1], d[i + 2]

    def with_outlines(
        self, rects: Iterable[Rect], rgb: Sequence[int] = (255, 0, 255)
    ) -> "Frame":
        """A copy with a 1-px outline drawn around each rect (failure evidence)."""
        buf = bytearray(self.data)
        colour = bytes(rgb[:3])

        def put(x: int, y: int) -> None:
            if 0 <= x < self.width and 0 <= y < self.height:
                i = (y * self.width + x) * 3
                buf[i : i + 3] = colour

        for r in rects:
            for x in range(r.x - 1, r.right + 1):
                put(x, r.y - 1)
                put(x, r.bottom)
            for y in range(r.y - 1, r.bottom + 1):
                put(r.x - 1, y)
                put(r.right, y)
        return Frame(self.width, self.height, bytes(buf))


# ── Pixel-format conversion ─────────────────────────────────────────────────


def _mask_byte(mask: int, bytes_per_pixel: int, little_endian: bool) -> int:
    """Byte index inside a pixel of an 8-bit-aligned channel ``mask``."""
    for k in range(bytes_per_pixel):
        if mask == 0xFF << (8 * k):
            return k if little_endian else bytes_per_pixel - 1 - k
    raise ValueError(f"unsupported channel mask {mask:#x}")


def _pack_rgb(
    raw: bytes,
    width: int,
    height: int,
    *,
    stride: int,
    bpp: int,
    offsets: tuple[int, int, int],
    bottom_up: bool = False,
) -> Frame:
    """Repack ``bpp``-byte pixels (channel byte ``offsets`` R, G, B) into RGB."""
    need = stride * (height - 1) + width * bpp
    if len(raw) < need:
        raise ValueError(f"pixel data is {len(raw)} bytes, want at least {need}")
    row_bytes = width * bpp
    rows = [raw[y * stride : y * stride + row_bytes] for y in range(height)]
    if bottom_up:
        rows.reverse()
    packed = b"".join(rows)
    out = bytearray(width * height * 3)
    for channel, offset in enumerate(offsets):
        out[channel::3] = packed[offset::bpp]
    return Frame(width, height, bytes(out))


def frame_from_bgra(width: int, height: int, raw: bytes, *, bottom_up: bool = False) -> Frame:
    """A frame from tightly packed 32-bit BGRA/BGRX pixels (a Windows DIB)."""
    return _pack_rgb(
        raw, width, height, stride=width * 4, bpp=4, offsets=(2, 1, 0), bottom_up=bottom_up
    )


def frame_from_rgb_base64(width: int, height: int, rgb: str) -> Frame:
    """Decode a base64 row-major RGB payload (``readTerminalWebglFrame``, #4970)."""
    try:
        data = base64.b64decode(rgb, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError(f"WebGL frame payload is not base64: {exc}") from exc
    return Frame(width, height, data)


def parse_bmp(data: bytes) -> Frame:
    """Parse an uncompressed 24- or 32-bit BMP (``screencapture -t bmp``)."""
    if len(data) < 54 or data[:2] != b"BM":
        raise ValueError("not a BMP file")
    pixel_offset = struct.unpack_from("<I", data, 10)[0]
    header_size = struct.unpack_from("<I", data, 14)[0]
    width, height = struct.unpack_from("<ii", data, 18)
    bpp = struct.unpack_from("<H", data, 28)[0]
    compression = struct.unpack_from("<I", data, 30)[0]
    bottom_up = height > 0
    height = abs(height)
    if bpp not in (24, 32):
        raise ValueError(f"unsupported BMP depth {bpp}")
    bytes_pp = bpp // 8
    offsets = (2, 1, 0)
    if compression == 3:  # BI_BITFIELDS: masks follow a 40-byte header (or sit inside V4/V5)
        r_mask, g_mask, b_mask = struct.unpack_from("<III", data, 54)
        offsets = tuple(_mask_byte(m, bytes_pp, True) for m in (r_mask, g_mask, b_mask))
    elif compression != 0:
        raise ValueError(f"unsupported BMP compression {compression}")
    del header_size
    stride = (width * bpp + 31) // 32 * 4
    return _pack_rgb(
        data[pixel_offset:],
        width,
        height,
        stride=stride,
        bpp=bytes_pp,
        offsets=offsets,  # type: ignore[arg-type]
        bottom_up=bottom_up,
    )


def parse_xwd(data: bytes) -> Frame:
    """Parse an ``xwd`` dump of a TrueColor ZPixmap at 24 or 32 bits per pixel."""
    if len(data) < 100:
        raise ValueError("not an XWD file")
    fields = struct.unpack_from(">25I", data, 0)
    header_size, version, fmt = fields[0], fields[1], fields[2]
    if version != 7:
        # A little-endian header (a non-swapping writer): read it the other way.
        fields = struct.unpack_from("<25I", data, 0)
        header_size, version, fmt = fields[0], fields[1], fields[2]
    if version != 7 or fmt != 2:
        raise ValueError(f"unsupported XWD (version {version}, format {fmt})")
    width, height = fields[4], fields[5]
    byte_order, bits_pp, stride = fields[7], fields[11], fields[12]
    masks = fields[14:17]
    ncolors = fields[19]
    if bits_pp not in (24, 32):
        raise ValueError(f"unsupported XWD depth {bits_pp}")
    bytes_pp = bits_pp // 8
    little = byte_order == 0  # LSBFirst
    offsets = tuple(_mask_byte(m, bytes_pp, little) for m in masks)
    start = header_size + ncolors * 12
    return _pack_rgb(
        data[start:],
        width,
        height,
        stride=stride,
        bpp=bytes_pp,
        offsets=offsets,  # type: ignore[arg-type]
    )


def encode_png(frame: Frame) -> bytes:
    """Encode ``frame`` as an 8-bit RGB PNG (filter 0 rows, zlib-compressed)."""

    def chunk(kind: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(kind + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", crc)

    stride = frame.width * 3
    raw = b"".join(
        b"\x00" + frame.data[y * stride : (y + 1) * stride] for y in range(frame.height)
    )
    header = struct.pack(">IIBBBBB", frame.width, frame.height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def save_png(frame: Frame, path: Path) -> Path:
    """Write ``frame`` to ``path`` as PNG (parents created); return the path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encode_png(frame))
    return path


def contact_sheet(
    frames: Sequence[Frame], *, gap: int = 8, background: Sequence[int] = (128, 128, 128)
) -> Frame:
    """Lay ``frames`` side by side, top-aligned, on a neutral background."""
    if not frames:
        raise ValueError("no frames for the contact sheet")
    width = sum(f.width for f in frames) + gap * (len(frames) + 1)
    height = max(f.height for f in frames) + 2 * gap
    buf = bytearray(bytes(background[:3]) * (width * height))
    x = gap
    for f in frames:
        src_stride = f.width * 3
        for y in range(f.height):
            dst = ((gap + y) * width + x) * 3
            buf[dst : dst + src_stride] = f.data[y * src_stride : (y + 1) * src_stride]
        x += f.width + gap
    return Frame(width, height, bytes(buf))


# ── Mapping the page onto the capture ───────────────────────────────────────


class PageMapping(NamedTuple):
    """Where the web view's CSS-px page sits in a capture."""

    origin_x: float
    origin_y: float
    scale: float

    def rect(self, left: float, top: float, width: float, height: float) -> Rect:
        """A page rect (CSS px) as the device-pixel rect it covers in the capture."""
        x0 = self.origin_x + left * self.scale
        y0 = self.origin_y + top * self.scale
        x1 = self.origin_x + (left + width) * self.scale
        y1 = self.origin_y + (top + height) * self.scale
        return Rect(round(x0), round(y0), round(x1) - round(x0), round(y1) - round(y0))


def map_page(
    frame_width: int,
    frame_height: int,
    *,
    inner_width: float,
    inner_height: float,
    device_pixel_ratio: float,
) -> PageMapping:
    """Locate the page inside a window capture.

    The page fills the window's content area, which sits at the bottom of the
    capture, horizontally centred: a macOS title bar or a GTK menu bar adds
    rows on top, a window border (if any) the same width on the left, right
    and bottom. A client-area capture (Windows) has none of these.
    Raises :class:`CaptureUnavailable` if the capture is smaller than the page.
    """
    page_w = inner_width * device_pixel_ratio
    page_h = inner_height * device_pixel_ratio
    if frame_width + 2 < page_w or frame_height + 2 < page_h:
        raise CaptureUnavailable(
            f"capture {frame_width}x{frame_height} is smaller than the "
            f"{page_w:.0f}x{page_h:.0f} page"
        )
    border = max(0.0, (frame_width - page_w) / 2)
    top = max(0.0, frame_height - page_h - border)
    return PageMapping(border, top, device_pixel_ratio)


# ── OS capture backends ─────────────────────────────────────────────────────


def _run(argv: Sequence[str], *, binary: bool = False) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            list(argv), capture_output=True, timeout=_CAPTURE_TIMEOUT, text=not binary
        )
    except FileNotFoundError as exc:
        raise CaptureUnavailable(f"{argv[0]} is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise CaptureUnavailable(f"{argv[0]} timed out after {_CAPTURE_TIMEOUT}s") from exc


def _linux_window(pid: int) -> str:
    """The id of the largest visible X window whose ``_NET_WM_PID`` is ``pid``."""
    if not os.environ.get("DISPLAY"):
        raise CaptureUnavailable("no X display ($DISPLAY is unset)")
    found = _run(["xdotool", "search", "--onlyvisible", "--pid", str(int(pid))])
    ids = found.stdout.split()
    if not ids:
        raise CaptureUnavailable(f"no visible X window belongs to pid {pid}")
    best, best_area = ids[0], -1
    for wid in ids:
        geo = _run(["xdotool", "getwindowgeometry", "--shell", wid]).stdout
        values = dict(line.split("=", 1) for line in geo.splitlines() if "=" in line)
        area = int(values.get("WIDTH", 0)) * int(values.get("HEIGHT", 0))
        if area > best_area:
            best, best_area = wid, area
    return best


def _capture_linux(pid: int) -> Frame:
    wid = _linux_window(pid)
    dump = _run(["xwd", "-silent", "-id", wid], binary=True)
    if dump.returncode != 0 or not dump.stdout:
        raise CaptureUnavailable(f"xwd failed on window {wid}: {dump.stderr!r}")
    return parse_xwd(dump.stdout)


def _macos_window(pid: int) -> tuple[int, tuple[float, float, float, float]]:
    """The largest on-screen window owned by ``pid``: its number and its bounds.

    Bounds are ``(x, y, width, height)`` in screen points (CoreGraphics).
    """
    import ctypes
    from ctypes import c_bool, c_char_p, c_double, c_int, c_long, c_uint32, c_void_p

    cg = ctypes.cdll.LoadLibrary(
        "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
    )
    cf = ctypes.cdll.LoadLibrary(
        "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
    )
    cg.CGWindowListCopyWindowInfo.restype = c_void_p
    cg.CGWindowListCopyWindowInfo.argtypes = [c_uint32, c_uint32]
    cf.CFArrayGetCount.restype = c_long
    cf.CFArrayGetCount.argtypes = [c_void_p]
    cf.CFArrayGetValueAtIndex.restype = c_void_p
    cf.CFArrayGetValueAtIndex.argtypes = [c_void_p, c_long]
    cf.CFDictionaryGetValue.restype = c_void_p
    cf.CFDictionaryGetValue.argtypes = [c_void_p, c_void_p]
    cf.CFStringCreateWithCString.restype = c_void_p
    cf.CFStringCreateWithCString.argtypes = [c_void_p, c_char_p, c_uint32]
    cf.CFNumberGetValue.restype = c_bool
    cf.CFNumberGetValue.argtypes = [c_void_p, c_int, c_void_p]
    cf.CFRelease.argtypes = [c_void_p]

    utf8 = 0x08000100
    keys = {
        name: cf.CFStringCreateWithCString(None, name.encode(), utf8)
        for name in ("kCGWindowOwnerPID", "kCGWindowNumber", "kCGWindowBounds", "X", "Y", "Width", "Height")
    }

    def number(d: int, key: str) -> Optional[float]:
        ref = cf.CFDictionaryGetValue(d, keys[key])
        if not ref:
            return None
        out = c_double()
        return out.value if cf.CFNumberGetValue(ref, 13, ctypes.byref(out)) else None

    on_screen_only, exclude_desktop = 1, 16
    windows = cg.CGWindowListCopyWindowInfo(on_screen_only | exclude_desktop, 0)
    if not windows:
        raise CaptureUnavailable("CGWindowListCopyWindowInfo returned no window list")
    best: Optional[tuple[int, tuple[float, float, float, float]]] = None
    best_area = -1.0
    try:
        for i in range(cf.CFArrayGetCount(windows)):
            info = cf.CFArrayGetValueAtIndex(windows, i)
            if number(info, "kCGWindowOwnerPID") != pid:
                continue
            bounds = cf.CFDictionaryGetValue(info, keys["kCGWindowBounds"])
            rect = tuple(number(bounds, k) or 0.0 for k in ("X", "Y", "Width", "Height"))
            area = rect[2] * rect[3]
            wid = number(info, "kCGWindowNumber")
            if wid is not None and area > best_area:
                best, best_area = (int(wid), rect), area  # type: ignore[assignment]
    finally:
        cf.CFRelease(windows)
        for ref in keys.values():
            cf.CFRelease(ref)
    if best is None:
        raise CaptureUnavailable(f"no on-screen window belongs to pid {pid}")
    return best


def _capture_macos(pid: int) -> Frame:
    """Capture the window by number, or (``TERMIHUB_MACOS_CAPTURE=region``) the
    screen region under it — the test window is pinned always-on-top."""
    wid, (x, y, w, h) = _macos_window(pid)
    if not shutil.which("screencapture"):
        raise CaptureUnavailable("screencapture is not available")
    if os.environ.get("TERMIHUB_MACOS_CAPTURE") == "region":
        target = ["-R", f"{x:.0f},{y:.0f},{w:.0f},{h:.0f}"]
    else:
        target = ["-o", f"-l{wid}"]
    fd, name = tempfile.mkstemp(suffix=".bmp", prefix="termihub-capture-")
    os.close(fd)
    try:
        done = _run(["screencapture", "-x", *target, "-t", "bmp", name])
        data = Path(name).read_bytes()
        if done.returncode != 0 or not data:
            raise CaptureUnavailable(
                f"screencapture failed on window {wid} (rc {done.returncode}): "
                f"{done.stderr.strip()!r} — is Screen Recording allowed for this terminal?"
            )
        return parse_bmp(data)
    finally:
        try:
            os.unlink(name)
        except OSError:
            pass


def _capture_windows(pid: int) -> Frame:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)  # type: ignore[attr-defined]
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)  # type: ignore[attr-defined]
    # Physical pixels, so the capture matches the page's devicePixelRatio.
    try:
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # per-monitor v2
    except (AttributeError, OSError):
        try:
            user32.SetProcessDPIAware()
        except (AttributeError, OSError):
            pass

    found: list[tuple[int, int]] = []
    enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)  # type: ignore[attr-defined]

    def visit(hwnd: int, _lparam: int) -> bool:
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            rect = wintypes.RECT()
            user32.GetClientRect(hwnd, ctypes.byref(rect))
            found.append((hwnd, (rect.right - rect.left) * (rect.bottom - rect.top)))
        return True

    user32.EnumWindows(enum_proc(visit), 0)
    if not found:
        raise CaptureUnavailable(f"no visible top-level window belongs to pid {pid}")
    hwnd = max(found, key=lambda item: item[1])[0]
    rect = wintypes.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    width, height = rect.right - rect.left, rect.bottom - rect.top
    if width <= 0 or height <= 0:
        raise CaptureUnavailable(f"window {hwnd:#x} of pid {pid} has an empty client area")

    class BitmapInfoHeader(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD),
            ("biWidth", wintypes.LONG),
            ("biHeight", wintypes.LONG),
            ("biPlanes", wintypes.WORD),
            ("biBitCount", wintypes.WORD),
            ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD),
            ("biXPelsPerMeter", wintypes.LONG),
            ("biYPelsPerMeter", wintypes.LONG),
            ("biClrUsed", wintypes.DWORD),
            ("biClrImportant", wintypes.DWORD),
        ]

    screen_dc = user32.GetDC(None)
    mem_dc = gdi32.CreateCompatibleDC(screen_dc)
    bitmap = gdi32.CreateCompatibleBitmap(screen_dc, width, height)
    old = gdi32.SelectObject(mem_dc, bitmap)
    try:

        def read() -> bytes:
            header = BitmapInfoHeader()
            header.biSize = ctypes.sizeof(BitmapInfoHeader)
            header.biWidth = width
            header.biHeight = -height  # top-down
            header.biPlanes = 1
            header.biBitCount = 32
            buf = ctypes.create_string_buffer(width * height * 4)
            rows = gdi32.GetDIBits(mem_dc, bitmap, 0, height, buf, ctypes.byref(header), 0)
            if rows != height:
                raise CaptureUnavailable(f"GetDIBits read {rows} of {height} rows")
            return buf.raw

        pw_clientonly, pw_renderfullcontent = 1, 2
        raw = b""
        if user32.PrintWindow(hwnd, mem_dc, pw_clientonly | pw_renderfullcontent):
            raw = read()
        if not raw or not any(raw[i] for i in range(0, len(raw), 4 * 97)):
            # PrintWindow drew nothing (black): copy the screen under the client
            # area instead — the test window is pinned always-on-top.
            origin = wintypes.POINT(0, 0)
            user32.ClientToScreen(hwnd, ctypes.byref(origin))
            srccopy = 0x00CC0020
            if not gdi32.BitBlt(
                mem_dc, 0, 0, width, height, screen_dc, origin.x, origin.y, srccopy
            ):
                raise CaptureUnavailable("PrintWindow and BitBlt both failed")
            raw = read()
    finally:
        gdi32.SelectObject(mem_dc, old)
        gdi32.DeleteObject(bitmap)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(None, screen_dc)
    return frame_from_bgra(width, height, raw)


def capture_window(pid: int) -> Frame:
    """Capture the largest visible window owned by process ``pid``.

    ``pid`` must be the process the harness launched (``SystemTest.app.pid``).
    Raises :class:`CaptureUnavailable` when the OS tooling is missing, the
    process has no visible window (yet), or the capture fails.
    """
    if pid is None or int(pid) <= 0:
        raise CaptureUnavailable("the app is not running")
    pid = int(pid)
    if sys.platform == "darwin":
        return _capture_macos(pid)
    if sys.platform.startswith("win"):
        return _capture_windows(pid)
    return _capture_linux(pid)

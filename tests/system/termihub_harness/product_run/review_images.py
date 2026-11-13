"""Contact sheets for the product run's UI review (#5538).

A reviewer sees one surface at a glance: every screenshot of that surface,
scaled down and laid out in a grid, in the order the brief lists them (left to
right, top to bottom). Pure stdlib — the harness has no imaging dependency — so
it decodes only what it needs: 8-bit PNGs (RGB / RGBA / grey, non-interlaced),
which covers the harness's own window captures (:func:`~..window_capture.encode_png`,
filter 0, the fast path) and the bridge's DOM screenshots (any row filter).
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path
from typing import Sequence

from ..window_capture import Frame, save_png

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
#: Channels per PNG colour type this decoder reads.
_CHANNELS = {0: 1, 2: 3, 4: 2, 6: 4}


class PngUnsupported(ValueError):
    """A PNG this small decoder does not read (bit depth, palette, interlace)."""


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def _unfilter(kind: int, row: bytearray, prev: bytes, bpp: int) -> None:
    n = len(row)
    if kind == 0:
        return
    if kind == 1:
        for i in range(bpp, n):
            row[i] = (row[i] + row[i - bpp]) & 0xFF
    elif kind == 2:
        for i in range(n):
            row[i] = (row[i] + prev[i]) & 0xFF
    elif kind == 3:
        for i in range(n):
            left = row[i - bpp] if i >= bpp else 0
            row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xFF
    elif kind == 4:
        for i in range(n):
            left = row[i - bpp] if i >= bpp else 0
            up_left = prev[i - bpp] if i >= bpp else 0
            row[i] = (row[i] + _paeth(left, prev[i], up_left)) & 0xFF
    else:
        raise PngUnsupported(f"unknown PNG row filter {kind}")


def _chunks(data: bytes) -> tuple[bytes, bytes]:
    if not data.startswith(PNG_MAGIC):
        raise PngUnsupported("not a PNG")
    pos, header, idat = len(PNG_MAGIC), b"", []
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        payload = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            header = payload
        elif kind == b"IDAT":
            idat.append(payload)
        elif kind == b"IEND":
            break
    if not header:
        raise PngUnsupported("PNG without IHDR")
    return header, zlib.decompress(b"".join(idat))


def decode_png(data: bytes) -> Frame:
    """Decode an 8-bit, non-interlaced PNG into an RGB :class:`Frame` (alpha dropped)."""
    header, raw = _chunks(data)
    width, height, depth, color, _comp, _filt, interlace = struct.unpack(">IIBBBBB", header)
    if depth != 8 or color not in _CHANNELS or interlace:
        raise PngUnsupported(f"PNG depth {depth}, colour type {color}, interlace {interlace}")
    bpp = _CHANNELS[color]
    stride = width * bpp
    rows: list[bytes] = []
    prev = bytes(stride)
    for y in range(height):
        start = y * (stride + 1)
        row = bytearray(raw[start + 1 : start + 1 + stride])
        _unfilter(raw[start], row, prev, bpp)
        prev = bytes(row)
        rows.append(prev)
    pixels = b"".join(rows)
    if color == 2:
        return Frame(width, height, pixels)
    out = bytearray(width * height * 3)
    if color in (0, 4):
        grey = pixels[0::bpp]
        out[0::3], out[1::3], out[2::3] = grey, grey, grey
    else:
        out[0::3], out[1::3], out[2::3] = pixels[0::4], pixels[1::4], pixels[2::4]
    return Frame(width, height, bytes(out))


def downscale(frame: Frame, max_width: int) -> Frame:
    """Nearest-neighbour shrink by an integer factor so the width is ≤ ``max_width``."""
    factor = max(1, math.ceil(frame.width / max_width))
    if factor == 1:
        return frame
    width = len(range(0, frame.width, factor))
    stride = frame.width * 3
    rows = []
    for y in range(0, frame.height, factor):
        line = frame.data[y * stride : (y + 1) * stride]
        out = bytearray(width * 3)
        step = 3 * factor
        out[0::3], out[1::3], out[2::3] = line[0::step], line[1::step], line[2::step]
        rows.append(bytes(out))
    return Frame(width, len(rows), b"".join(rows))


def grid(
    frames: Sequence[Frame],
    *,
    columns: int = 2,
    gap: int = 12,
    background: Sequence[int] = (128, 128, 128),
) -> Frame:
    """Lay ``frames`` out row by row, ``columns`` per row, top-left aligned."""
    if not frames:
        raise ValueError("no frames for the contact sheet")
    columns = max(1, min(columns, len(frames)))
    cell_w = max(f.width for f in frames)
    lines = [frames[i : i + columns] for i in range(0, len(frames), columns)]
    line_h = [max(f.height for f in line) for line in lines]
    width = columns * cell_w + (columns + 1) * gap
    height = sum(line_h) + (len(lines) + 1) * gap
    buf = bytearray(bytes(background[:3]) * (width * height))
    top = gap
    for line, h in zip(lines, line_h):
        left = gap
        for f in line:
            src = f.width * 3
            for y in range(f.height):
                dst = ((top + y) * width + left) * 3
                buf[dst : dst + src] = f.data[y * src : (y + 1) * src]
            left += cell_w + gap
        top += h + gap
    return Frame(width, height, bytes(buf))


def contact_sheet_file(
    shots: Sequence[Path], out: Path, *, thumb_width: int = 640, columns: int = 2
) -> list[str]:
    """Write a contact sheet of ``shots`` to ``out``; returns the shots left out (and why)."""
    frames, skipped = [], []
    for path in shots:
        try:
            frames.append(downscale(decode_png(path.read_bytes()), thumb_width))
        except (OSError, ValueError, zlib.error) as exc:
            skipped.append(f"{path.name}: {exc}")
    if frames:
        save_png(grid(frames, columns=columns), out)
    return skipped

"""Unit tests for the native window capture parsers and helpers (#4937).

The OS capture paths run in the integration lane
(``test_native_capture_grades.py``); these pin the pure parts — the XWD / BMP /
DIB parsers, the PNG writer, the page mapping and the contact sheet — against
synthetic images, so a parser bug never hides as a pixel-grade failure.
"""

from __future__ import annotations

import struct
import zlib

import pytest

from termihub_harness import window_capture as wc
from termihub_harness.window_capture import (
    CaptureUnavailable,
    Frame,
    Rect,
    contact_sheet,
    encode_png,
    frame_from_bgra,
    map_page,
    parse_bmp,
    parse_xwd,
)

RED, GREEN, BLUE, WHITE = (255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255)
#: A 2x2 image: red, green / blue, white.
PIXELS = [[RED, GREEN], [BLUE, WHITE]]


def _expected() -> bytes:
    return b"".join(bytes(p) for row in PIXELS for p in row)


def _bmp(*, bottom_up: bool, bpp: int = 32, bitfields: bool = False) -> bytes:
    width, height = 2, 2
    stride = (width * bpp + 31) // 32 * 4
    rows = []
    for row in PIXELS:
        raw = b"".join(
            bytes((b, g, r, 255)) if bpp == 32 else bytes((b, g, r)) for r, g, b in row
        )
        rows.append(raw + b"\x00" * (stride - len(raw)))
    if bottom_up:
        rows.reverse()
    masks = struct.pack("<III", 0x00FF0000, 0x0000FF00, 0x000000FF) if bitfields else b""
    offset = 14 + 40 + len(masks)
    info = struct.pack(
        "<IiiHHIIiiII",
        40,
        width,
        height if bottom_up else -height,
        1,
        bpp,
        3 if bitfields else 0,
        stride * height,
        0,
        0,
        0,
        0,
    )
    pixels = b"".join(rows)
    head = b"BM" + struct.pack("<IHHI", offset + len(pixels), 0, 0, offset)
    return head + info + masks + pixels


@pytest.mark.parametrize("bottom_up", [True, False])
@pytest.mark.parametrize("bpp", [24, 32])
def test_parse_bmp_reads_both_row_orders_and_depths(bottom_up, bpp):
    frame = parse_bmp(_bmp(bottom_up=bottom_up, bpp=bpp))
    assert (frame.width, frame.height) == (2, 2)
    assert frame.data == _expected()


def test_parse_bmp_honours_bitfield_masks():
    assert parse_bmp(_bmp(bottom_up=True, bitfields=True)).data == _expected()


def test_parse_bmp_rejects_other_files():
    with pytest.raises(ValueError):
        parse_bmp(b"\x89PNG" + b"\x00" * 60)


def _xwd(*, byte_order: int, stride_pad: int = 0, ncolors: int = 0, name: bytes = b"w\x00") -> bytes:
    width, height, bpp = 2, 2, 32
    stride = width * 4 + stride_pad
    header_size = 100 + len(name)
    fields = [
        header_size, 7, 2, 24, width, height, 0, byte_order, 32, byte_order, 32, bpp, stride,
        4, 0xFF0000, 0x00FF00, 0x0000FF, 8, 256, ncolors, width, height, 0, 0, 0,
    ]  # fmt: skip
    header = struct.pack(">25I", *fields) + name
    rows = []
    for row in PIXELS:
        raw = b""
        for r, g, b in row:
            value = (r << 16) | (g << 8) | b
            raw += struct.pack("<I" if byte_order == 0 else ">I", value)
        rows.append(raw + b"\x00" * stride_pad)
    return header + b"\x00" * (12 * ncolors) + b"".join(rows)


@pytest.mark.parametrize("byte_order", [0, 1])
def test_parse_xwd_reads_lsb_and_msb_pixels(byte_order):
    assert parse_xwd(_xwd(byte_order=byte_order)).data == _expected()


def test_parse_xwd_skips_the_colormap_and_row_padding():
    frame = parse_xwd(_xwd(byte_order=0, stride_pad=8, ncolors=3, name=b"termihub\x00"))
    assert frame.data == _expected()


def test_parse_xwd_rejects_a_non_zpixmap():
    data = bytearray(_xwd(byte_order=0))
    data[8:12] = struct.pack(">I", 1)  # XYPixmap
    with pytest.raises(ValueError):
        parse_xwd(bytes(data))


def test_frame_from_bgra_reorders_channels():
    raw = b"".join(bytes((b, g, r, 0)) for row in PIXELS for r, g, b in row)
    assert frame_from_bgra(2, 2, raw).data == _expected()


def test_frame_pixel_crop_and_outline():
    frame = Frame(2, 2, _expected())
    assert frame.pixel(1, 0) == GREEN
    assert frame.crop(Rect(1, 1, 5, 5)).data == bytes(WHITE)
    with pytest.raises(IndexError):
        frame.pixel(2, 0)
    big = Frame.filled(5, 5, (0, 0, 0))
    outlined = big.with_outlines([Rect(2, 2, 1, 1)])
    assert outlined.pixel(1, 1) == (255, 0, 255)
    assert outlined.pixel(2, 2) == (0, 0, 0)


def _png_rgb(png: bytes) -> tuple[int, int, bytes]:
    """Decode the filter-0 RGB PNG :func:`encode_png` writes."""
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, width, height = 8, b"", 0, 0
    while pos < len(png):
        length = struct.unpack(">I", png[pos : pos + 4])[0]
        kind = png[pos + 4 : pos + 8]
        payload = png[pos + 8 : pos + 8 + length]
        crc = struct.unpack(">I", png[pos + 8 + length : pos + 12 + length])[0]
        assert crc == zlib.crc32(kind + payload) & 0xFFFFFFFF
        if kind == b"IHDR":
            width, height = struct.unpack(">II", payload[:8])
            assert payload[8:10] == b"\x08\x02"
        elif kind == b"IDAT":
            idat += payload
        pos += 12 + length
    raw = zlib.decompress(idat)
    stride = width * 3 + 1
    assert all(raw[y * stride] == 0 for y in range(height))
    return width, height, b"".join(raw[y * stride + 1 : (y + 1) * stride] for y in range(height))


def test_encode_png_round_trips_the_pixels(tmp_path):
    frame = Frame(2, 2, _expected())
    assert _png_rgb(encode_png(frame)) == (2, 2, _expected())
    path = wc.save_png(frame, tmp_path / "sub" / "shot.png")
    assert path.read_bytes() == encode_png(frame)


def test_contact_sheet_places_frames_side_by_side():
    a, b = Frame.filled(2, 3, RED), Frame.filled(4, 1, BLUE)
    sheet = contact_sheet([a, b], gap=1, background=(9, 9, 9))
    assert (sheet.width, sheet.height) == (2 + 4 + 3, 3 + 2)
    assert sheet.pixel(1, 1) == RED and sheet.pixel(2, 3) == RED
    assert sheet.pixel(4, 1) == BLUE and sheet.pixel(4, 2) == (9, 9, 9)
    with pytest.raises(ValueError):
        contact_sheet([])


def test_map_page_handles_title_bars_borders_and_client_captures():
    # macOS: a 28 px (x2) title bar on top of a Retina page.
    m = map_page(2560, 1656, inner_width=1280, inner_height=800, device_pixel_ratio=2)
    assert m == (0, 56, 2)
    assert m.rect(10, 20, 5, 5) == Rect(20, 96, 10, 10)
    # A window with a 4 px border all round and a 30 px bar on top.
    assert map_page(1288, 834, inner_width=1280, inner_height=800, device_pixel_ratio=1) == (
        4,
        30,
        1,
    )
    # A client-area capture is the page itself.
    assert map_page(1280, 800, inner_width=1280, inner_height=800, device_pixel_ratio=1) == (
        0,
        0,
        1,
    )
    with pytest.raises(CaptureUnavailable):
        map_page(640, 400, inner_width=1280, inner_height=800, device_pixel_ratio=1)


def test_capture_window_refuses_without_a_pid():
    with pytest.raises(CaptureUnavailable):
        wc.capture_window(0)


def test_linux_capture_needs_a_display(monkeypatch):
    monkeypatch.setattr(wc.sys, "platform", "linux")
    monkeypatch.delenv("DISPLAY", raising=False)
    with pytest.raises(CaptureUnavailable, match="DISPLAY"):
        wc.capture_window(1)


def test_missing_tool_is_reported_as_unavailable(monkeypatch):
    def missing(*_args, **_kwargs):
        raise FileNotFoundError("xdotool")

    monkeypatch.setattr(wc.subprocess, "run", missing)
    with pytest.raises(CaptureUnavailable, match="not installed"):
        wc._run(["xdotool", "search"])

"""Unit tests for the WSL distro parser (#975).

Machinery group (no app, no Windows): :func:`parse_wsl_distros` is a pure
function of its input bytes, so both the happy path and the messy real-world
output (UTF-16LE, BOM, trailing nulls, blank lines) are asserted on any host.
This mirrors the Rust ``parse_wsl_output`` tests in
``core/src/session/shell.rs`` so the Python gate and the backend agree on what
counts as an installed distribution.
"""

from __future__ import annotations

from termihub_harness.wsl import detect_wsl_distros, parse_wsl_distros


def _utf16le(text: str) -> bytes:
    return text.encode("utf-16-le")


def test_parses_plain_distro_list():
    raw = _utf16le("Ubuntu\nDebian\n")
    assert parse_wsl_distros(raw) == ["Ubuntu", "Debian"]


def test_strips_bom_and_blank_lines():
    # wsl.exe prefixes a UTF-16 BOM and pads output with blank lines.
    raw = _utf16le("﻿Ubuntu\n\nfedoraremix\n")
    assert parse_wsl_distros(raw) == ["Ubuntu", "fedoraremix"]


def test_strips_embedded_nulls_and_carriage_returns():
    # Some builds emit each character null-padded and use CRLF line endings.
    raw = _utf16le("Ubuntu-22.04\r\nkali-linux\r\n")
    assert parse_wsl_distros(raw) == ["Ubuntu-22.04", "kali-linux"]


def test_drops_trailing_odd_byte():
    # A truncated final code unit must not raise — the odd byte is dropped.
    raw = _utf16le("Ubuntu\n") + b"\x00"
    assert parse_wsl_distros(raw) == ["Ubuntu"]


def test_empty_output_yields_no_distros():
    assert parse_wsl_distros(b"") == []
    assert parse_wsl_distros(_utf16le("\n\n")) == []


def test_detect_returns_empty_off_windows(monkeypatch):
    # The subprocess gate short-circuits on non-Windows hosts.
    monkeypatch.setattr("termihub_harness.wsl.sys.platform", "linux")
    assert detect_wsl_distros() == []

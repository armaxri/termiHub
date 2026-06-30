"""WSL distribution detection for the Windows-only system suites (#975).

The Windows-shells port (``tests/system/tests/test_windows_shells.py``) drives a
real ``wsl`` connection, which needs an installed distribution. There is no
bridge call that enumerates ``<option>`` text, so the suite gates its WSL cases
on the host directly — exactly as the backend does — by running
``wsl.exe --list --quiet`` and parsing its output.

:func:`parse_wsl_distros` mirrors the Rust ``parse_wsl_output``
(``core/src/session/shell.rs``): ``wsl.exe`` emits **UTF-16LE** (often with a
BOM), so the bytes are decoded, BOM/null characters stripped, and blank lines
dropped. It is a pure function of its input, so it is unit-tested on any host
(no Windows, no WSL needed); :func:`detect_wsl_distros` is the thin subprocess
wrapper that feeds it and returns ``[]`` when WSL is absent.
"""

from __future__ import annotations

import subprocess
import sys

_BOM = "﻿"


def parse_wsl_distros(raw: bytes) -> list[str]:
    """Parse the UTF-16LE stdout of ``wsl.exe --list --quiet`` into distro names.

    Decodes the bytes as UTF-16LE (dropping a trailing odd byte, as the Rust
    ``chunks_exact(2)`` does), strips the BOM and embedded null characters, and
    returns the non-empty trimmed lines.
    """
    even = raw[: len(raw) - (len(raw) % 2)]
    text = even.decode("utf-16-le", errors="replace")
    distros: list[str] = []
    for line in text.splitlines():
        cleaned = line.replace("\0", "").strip().lstrip(_BOM).strip()
        if cleaned:
            distros.append(cleaned)
    return distros


def detect_wsl_distros() -> list[str]:
    """Return installed WSL distributions, or ``[]`` if WSL is unavailable.

    Runs ``wsl.exe --list --quiet`` and parses its output with
    :func:`parse_wsl_distros`. Any failure (not Windows, ``wsl.exe`` missing, a
    non-zero exit, or a timeout) yields an empty list so callers can skip
    cleanly when no WSL2 distribution is installed.
    """
    if not sys.platform.startswith("win"):
        return []
    try:
        result = subprocess.run(
            ["wsl.exe", "--list", "--quiet"],
            capture_output=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if result.returncode != 0:
        return []
    return parse_wsl_distros(result.stdout)

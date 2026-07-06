"""Read the OS clipboard from the harness (issue #957).

The guided-manual clipboard test drives the app's "Copy to Clipboard", then had
the operator paste into an external editor to judge the result — but whether the
copy actually reached the OS clipboard is machine-checkable. :func:`read_os_clipboard`
reads it per-OS so the test can auto-assert the copy landed and reserve the
operator only for the genuinely-external paste round-trip.
"""

from __future__ import annotations

import platform
import subprocess
from typing import Optional


def _run_capture(cmd: list[str]) -> Optional[str]:
    """Stdout of ``cmd``, or ``None`` if it cannot run or returns non-zero."""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout if result.returncode == 0 else None


def read_os_clipboard(*, system: Optional[str] = None) -> Optional[str]:
    """The current OS clipboard text, or ``None`` if it cannot be read.

    - **macOS**: ``pbpaste``.
    - **Linux**: ``xclip`` then ``xsel`` (whichever is installed).
    - **Windows**: PowerShell ``Get-Clipboard``.

    ``system`` is injectable for tests; it defaults to :func:`platform.system`.
    """
    system = system or platform.system()
    if system == "Darwin":
        return _run_capture(["pbpaste"])
    if system == "Linux":
        for cmd in (["xclip", "-selection", "clipboard", "-o"], ["xsel", "-b"]):
            out = _run_capture(cmd)
            if out is not None:
                return out
        return None
    if system == "Windows":
        return _run_capture(["powershell", "-NoProfile", "-Command", "Get-Clipboard"])
    return None

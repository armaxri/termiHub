"""Resolve a usable local X11 display for the app process (issue #957).

The guided-manual X11-forwarding test needs the app to negotiate SSH X11
forwarding, which only works when the app can reach a local X server through
``$DISPLAY``. Resolving that display is OS-specific and — on macOS — the value
lives in launchd rather than the shell environment, so exporting it from a
launcher script is both entrypoint-specific and easy to forget.

:func:`ensure_local_display` centralises it. Called before the app launches (so
the child process inherits the value), it resolves and exports ``DISPLAY`` for
the current OS, optionally starting XQuartz on macOS. Because it lives in the
harness rather than one wrapper script, every entrypoint — ``pytest.sh``,
``test-system-py.sh`` or ``run-guided-manual.sh`` — gets identical behaviour.
"""

from __future__ import annotations

import os
import platform
import subprocess
import time
from typing import Optional

#: How long to wait for XQuartz to publish a display after starting it.
_XQUARTZ_WAIT_SECONDS = 15


def _macos_launchd_display() -> Optional[str]:
    """The ``DISPLAY`` XQuartz publishes via launchd, or ``None`` if unset.

    On macOS the X server socket path is exported into the launchd session
    (``launchctl getenv DISPLAY``), not the shell, so a subprocess must ask
    launchd for it. Any failure (no launchctl, timeout) resolves to ``None``.
    """
    try:
        result = subprocess.run(
            ["launchctl", "getenv", "DISPLAY"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() or None


def _start_xquartz() -> None:
    """Best-effort launch of XQuartz (idempotent — a no-op if already running)."""
    try:
        subprocess.run(["open", "-a", "XQuartz"], capture_output=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        pass


def _resolve_macos(*, start_if_missing: bool) -> Optional[str]:
    """Read the launchd display; when absent and allowed, start XQuartz + wait."""
    display = _macos_launchd_display()
    if display or not start_if_missing:
        return display
    _start_xquartz()
    for _ in range(_XQUARTZ_WAIT_SECONDS):
        time.sleep(1.0)
        display = _macos_launchd_display()
        if display:
            return display
    return None


def ensure_local_display(
    *, start_if_missing: bool, system: Optional[str] = None
) -> Optional[str]:
    """Resolve and export ``DISPLAY`` for the current OS; return it or ``None``.

    - **macOS**: read the launchd value; when ``start_if_missing`` and it is
      absent, start XQuartz and wait for it to publish one.
    - **Linux**: use the existing ``$DISPLAY`` (a desktop session already sets
      it; there is no X server to fabricate one for on a headless host).
    - **Windows / other**: ``None`` — the X11 test is a macOS/Linux feature.

    Exports the resolved value into ``os.environ`` so an app launched afterwards
    inherits it. Idempotent; safe to call once per app launch. ``system`` is
    injectable for tests; it defaults to :func:`platform.system`.
    """
    system = system or platform.system()
    if system == "Darwin":
        display = _resolve_macos(start_if_missing=start_if_missing)
    elif system == "Linux":
        display = os.environ.get("DISPLAY") or None
    else:
        display = None
    if display:
        os.environ["DISPLAY"] = display
    return display

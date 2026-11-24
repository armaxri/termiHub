"""Settings dependencies and per-platform pages (#5844): measure live, grade without an app.

Three findings of the second product run's review:

- **X server (R-054)** — "Provide X server automatically" shows only the current
  platform's line, and "Stop X server when idle" sits nested under it. While the
  parent is off the child is disabled and shows its effective state (off),
  never "on while the parent is off".
- **Serial (R-055)** — the "n / m enabled" prefix count only shows on Linux,
  where the ``/dev`` scan runs; elsewhere a note says where the serial line
  settings live (each serial connection).
- **Close confirmations (R-056)** — one "Ask before closing a live session"
  choice replaces the two overlapping close toggles.

:func:`measure_x_server`, :func:`measure_serial` and :func:`measure_safety_prompts`
read the open settings page; :func:`settings_dependency_problems` grades the
merged measurements and runs in the normal lane.
"""

from __future__ import annotations

import re
from typing import Any, Optional

#: The platform names the X server hint must not mix (R-054's "platform dump").
PLATFORM_WORDS: dict[str, tuple[str, ...]] = {
    "windows": ("Windows", "VcXsrv"),
    "macos": ("macOS", "XQuartz"),
    "linux": ("Linux",),
}

#: The close-confirm choices, in the order the select lists them.
CLOSE_CHOICES = (
    "Always",
    "Only for keyboard shortcuts",
    "Only for mouse closes",
    "Never",
)

#: The two toggles the single close choice replaced.
OLD_CLOSE_TOGGLES = (
    "settings-confirm-close-tab-on-shortcut",
    "settings-confirm-close-live-session",
)

PROVIDE = "settings-provide-x-server"
PROVIDE_HINT = "settings-provide-x-server-hint"
STOP = "settings-stop-x-server-idle"
STOP_ROW = "settings-stop-x-server-idle-row"
STOP_HINT = "settings-stop-x-server-idle-hint"
SERIAL_COUNT = "settings-serial-prefixes-count"
SERIAL_CONNECTION_NOTE = "settings-serial-connection-settings-note"
CLOSE_CHOICE = "settings-close-live-session-confirm"

_COUNT_RE = re.compile(r"\d+\s*/\s*\d+\s+enabled")


def _text(driver: Any, test_id: str) -> Optional[str]:
    return driver.get_text(test_id).strip() if driver.exists(test_id) else None


def measure_x_server(driver: Any, platform: str) -> dict:
    """One state of the open Settings ▸ X server page."""
    classes = (driver.get_attribute(STOP_ROW, "class") or "") if driver.exists(STOP_ROW) else ""
    return {
        "platform": platform,
        "provide_hint": _text(driver, PROVIDE_HINT) or "",
        "provide_on": driver.get_attribute(PROVIDE, "aria-checked") == "true",
        "stop_on": driver.get_attribute(STOP, "aria-checked") == "true",
        "stop_disabled": driver.get_attribute(STOP, "disabled") is not None,
        "stop_nested": "settings-panel__nested" in classes.split(),
        "stop_hint": _text(driver, STOP_HINT) or "",
    }


def measure_serial(driver: Any, platform: str) -> dict:
    """The open Settings ▸ Serial page."""
    return {
        "platform": platform,
        "count": _text(driver, SERIAL_COUNT),
        "connection_note": _text(driver, SERIAL_CONNECTION_NOTE),
    }


def measure_safety_prompts(driver: Any, options: Optional[list] = None) -> dict:
    """The open Settings ▸ Safety prompts page; ``options`` from an opened select."""
    return {
        "choice": _text(driver, CLOSE_CHOICE),
        "old_toggles": [t for t in OLD_CLOSE_TOGGLES if driver.exists(t)],
        "options": options,
    }


def _x_server_problems(state: dict) -> list[str]:
    problems: list[str] = []
    platform = state["platform"]
    hint = state["provide_hint"]
    if not hint:
        problems.append("X server: no hint under 'Provide X server automatically'")
    for other, words in PLATFORM_WORDS.items():
        if other == platform:
            continue
        mixed = [w for w in words if w in hint]
        if mixed:
            problems.append(f"X server: the {platform} hint also describes {other} ({mixed})")
    if not state["stop_nested"]:
        problems.append("X server: 'Stop X server when idle' is not nested under its parent")
    if state["provide_on"]:
        if state["stop_disabled"]:
            problems.append("X server: idle stop is disabled although the parent is on")
    else:
        if state["stop_on"]:
            problems.append("X server: idle stop reads on while the parent is off")
        if not state["stop_disabled"]:
            problems.append("X server: idle stop is editable while the parent is off")
        if not state["stop_hint"]:
            problems.append("X server: no hint says why idle stop is off")
    return problems


def _serial_problems(serial: dict) -> list[str]:
    problems: list[str] = []
    count = serial.get("count")
    if serial["platform"] == "linux":
        if not count or not _COUNT_RE.search(count):
            problems.append(f"Serial: no 'n / m enabled' prefix count on Linux ({count!r})")
        return problems
    if count:
        problems.append(f"Serial: prefix count {count!r} shows where the scan does not run")
    note = serial.get("connection_note") or ""
    if "connection" not in note:
        problems.append("Serial: no note says where the serial line settings live")
    return problems


def _safety_problems(safety: dict) -> list[str]:
    problems: list[str] = []
    for toggle in safety.get("old_toggles") or []:
        problems.append(f"Close confirmations: the old overlapping toggle {toggle} still shows")
    choice = safety.get("choice")
    if not choice:
        problems.append("Close confirmations: no 'Ask before closing a live session' choice")
    elif not any(choice.startswith(c) for c in CLOSE_CHOICES):
        problems.append(f"Close confirmations: the choice reads {choice!r}")
    options = safety.get("options")
    if options is not None and list(options) != list(CLOSE_CHOICES):
        problems.append(f"Close confirmations: options {options}, want {list(CLOSE_CHOICES)}")
    return problems


def settings_dependency_problems(m: dict) -> list[str]:
    """Every finding over ``{"x_server": [states], "serial": {...}, "safety": {...}}``."""
    problems: list[str] = []
    for state in m.get("x_server") or []:
        problems.extend(_x_server_problems(state))
    if m.get("serial"):
        problems.extend(_serial_problems(m["serial"]))
    if m.get("safety"):
        problems.extend(_safety_problems(m["safety"]))
    return problems

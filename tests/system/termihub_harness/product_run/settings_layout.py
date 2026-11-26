"""The shared settings layout (#5843): measure it live, grade it without an app.

Numeric settings are compact inputs sized to their value range with a unit; the
"Default" marker is plain muted text (a labelled "Reset to default" button only
once the value is overridden); hints are one line, with details behind a "?";
"Clear all history" is a normal secondary button; and the search bar, nav and
content share one centred max width. :func:`measure_settings_page` reads one
open settings category, :func:`settings_layout_problems` grades the merged
measurements and runs in the normal lane.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from ..colors import parse_color

#: ``--settings-page-max-width`` = nav (180px) + content (640px) in variables.css.
PAGE_MAX_WIDTH = 820.0
#: A compact number input stays at or below this width (the issue asks ~120 px).
MAX_NUMBER_INPUT_WIDTH = 140.0
#: A hint taller than this many lines is a paragraph, not a one-line hint.
MAX_HINT_LINES = 1.5
#: Sub-pixel rounding / centring allowance for measured boxes.
_SLACK = 2.0

#: Numeric settings: (category, input testid, marker testid prefix or None, label, unit).
NUMERIC_FIELDS: tuple[tuple[str, str, Optional[str], str, Optional[str]], ...] = (
    ("appearance", "settings-font-size-input", "settings-font-size", "Font size", "px"),
    ("appearance", "settings-line-height-input", "settings-line-height", "Line height", None),
    (
        "terminal",
        "settings-scrollback-buffer-input",
        "settings-scrollback-buffer",
        "Scrollback buffer",
        "lines",
    ),
    ("sessions", "settings-session-history-limit", None, "Session history limit", "sessions"),
)

#: One-line hints the grade measures, by category.
HINTS: dict[str, tuple[str, ...]] = {
    "appearance": (
        "settings-font-family-hint",
        "settings-font-size-hint",
        "settings-line-height-hint",
    ),
    # General and Terminal hints moved behind the "?" by #5846 / #5900.
    "general": (
        "settings-file-log-level-hint",
        "settings-copy-debug-info-hint",
        "settings-show-crash-report-notice-hint",
        "settings-export-diagnostics-hint",
    ),
    # Under General until #5860.
    "connection-defaults": (
        "settings-default-x11-forwarding-hint",
        "settings-file-browser-hint",
    ),
    "terminal": (
        "settings-scrollback-buffer-hint",
        "settings-line-ending-hint",
        "settings-right-click-behavior-hint",
        "settings-terminal-inline-images-hint",
        "settings-terminal-combine-emoji-hint",
        "settings-ask-open-saved-file-in-tab-hint",
        "settings-terminal-command-decorations-hint",
        "settings-default-shell-integration-hint",
        "settings-syntax-highlighting-enabled-hint",
    ),
    # The remaining pages of #5900.
    "accessibility": ("settings-screen-reader-mode-hint",),
    "safety-prompts": (
        "settings-close-live-session-confirm-hint",
        "settings-confirm-close-attached-tab-hint",
        "settings-confirm-undoable-delete-hint",
        "settings-warn-large-port-scan-hint",
        "settings-warn-large-ping-sweep-hint",
    ),
    "monitoring": (
        "settings-monitor-local-shells-hint",
        "settings-status-bar-metrics-hint",
    ),
    "plugins": (
        "settings-frontend-plugins-enabled-hint",
        "settings-native-plugins-enabled-hint",
    ),
    "updates": ("update-auto-check-hint",),
    "sessions": (
        "settings-restore-last-session-mode-hint",
        "settings-session-history-enabled-hint",
        "settings-session-history-limit-hint",
        "settings-network-tool-history-hint",
    ),
}

#: Clear-history buttons that must not use the danger skin.
CLEAR_BUTTONS = ("settings-clear-session-history", "settings-clear-network-tool-history")

#: The page frame: the panel, and the two boxes that share its centred width.
PANEL = "settings-panel"
SEARCH = "settings-search-bar"
BODY = "settings-panel-body"

_PX_RE = re.compile(r"(-?[\d.]+)px")


def _px(value: Optional[str]) -> float:
    match = _PX_RE.search(value or "")
    return float(match.group(1)) if match else 0.0


def _unit_text(driver: Any, input_id: str) -> Optional[str]:
    """The unit beside ``input_id``: ``<prefix>-unit`` of the input's test id."""
    prefix = input_id[: -len("-input")] if input_id.endswith("-input") else input_id
    unit_id = f"{prefix}-unit"
    return driver.get_text(unit_id).strip() if driver.exists(unit_id) else None


def _measure_marker(driver: Any, prefix: str, label: str) -> Optional[dict]:
    tag, reset = f"{prefix}-default", f"{prefix}-reset"
    if driver.exists(tag):
        return {
            "label": label,
            "kind": "default",
            "border": driver.get_computed_style("border-top-width", tag),
            "background": driver.get_computed_style("background-color", tag),
            "text": driver.get_text(tag).strip(),
        }
    if driver.exists(reset):
        return {
            "label": label,
            "kind": "reset",
            "type": driver.get_attribute(reset, "type"),
            "text": driver.get_text(reset).strip(),
        }
    return None


def _measure_hint(driver: Any, hint: str) -> dict:
    rect = driver.measure_element(hint)["rect"]
    line = _px(driver.get_computed_style("line-height", hint))
    if line <= 0:
        line = _px(driver.get_computed_style("font-size", hint)) * 1.4
    return {"testId": hint, "height": float(rect["height"]), "line_height": line}


def measure_settings_page(driver: Any, category: str) -> dict:
    """What the grade reads on the open settings ``category``; absent fields are skipped."""
    m: dict = {
        "panel": driver.measure_element(PANEL)["rect"],
        "search": driver.measure_element(SEARCH)["rect"],
        "body": driver.measure_element(BODY)["rect"],
        "numbers": [],
        "markers": [],
        "hints": [],
        "clear_buttons": [],
    }
    for cat, input_id, marker, label, _unit in NUMERIC_FIELDS:
        if cat != category or not driver.exists(input_id):
            continue
        width = float(driver.measure_element(input_id)["rect"]["width"])
        m["numbers"].append({"label": label, "width": width, "unit": _unit_text(driver, input_id)})
        measured = _measure_marker(driver, marker, label) if marker else None
        if measured:
            m["markers"].append(measured)
    m["hints"] = [_measure_hint(driver, h) for h in HINTS.get(category, ()) if driver.exists(h)]
    for button in CLEAR_BUTTONS:
        if driver.exists(button):
            classes = (driver.get_attribute(button, "class") or "").split()
            m["clear_buttons"].append({"testId": button, "classes": classes})
    return m


def merge_measurements(pages: "list[dict]") -> dict:
    """Merge per-category measurements: lists concatenate, the last page's frame wins."""
    merged: dict = {"numbers": [], "markers": [], "hints": [], "clear_buttons": [], "pages": []}
    for page in pages:
        for key in ("numbers", "markers", "hints", "clear_buttons"):
            merged[key].extend(page.get(key, []))
        if "panel" in page:
            merged["pages"].append({k: page[k] for k in ("panel", "search", "body")})
    return merged


def _number_problems(numbers: "list[dict]") -> list[str]:
    expected = {label: unit for _c, _i, _m, label, unit in NUMERIC_FIELDS}
    problems = []
    for n in numbers:
        label = n["label"]
        if n["width"] > MAX_NUMBER_INPUT_WIDTH + _SLACK:
            problems.append(
                f"{label}: the number input is {n['width']:.0f}px wide "
                f"(> {MAX_NUMBER_INPUT_WIDTH:.0f}px)"
            )
        want = expected.get(label)
        if want is not None and n.get("unit") != want:
            problems.append(f"{label}: unit {n.get('unit')!r}, want {want!r}")
    return problems


def _marker_problems(markers: "list[dict]") -> list[str]:
    problems = []
    for mk in markers:
        label = mk["label"]
        if mk["kind"] == "default":
            if _px(mk.get("border")) > 0:
                problems.append(f"{label}: the Default marker has a border (looks like a button)")
            if parse_color(mk.get("background") or "transparent").a > 0:
                problems.append(f"{label}: the Default marker has a fill (looks like a button)")
            if mk.get("text") != "Default":
                problems.append(f"{label}: the Default marker reads {mk.get('text')!r}")
        else:
            if mk.get("type") != "button":
                problems.append(f"{label}: the reset is not a button (type {mk.get('type')!r})")
            if "Reset" not in (mk.get("text") or ""):
                problems.append(f"{label}: the reset button reads {mk.get('text')!r}")
    return problems


def _hint_problems(hints: "list[dict]") -> list[str]:
    problems = []
    for h in hints:
        line = h.get("line_height") or 0.0
        if line <= 0:
            continue
        lines = h["height"] / line
        if lines > MAX_HINT_LINES:
            problems.append(f"{h['testId']}: the hint wraps to {lines:.1f} lines")
    return problems


def _page_problems(page: dict) -> list[str]:
    panel, search, body = page["panel"], page["search"], page["body"]
    problems = []
    for name, box in (("search bar", search), ("settings body", body)):
        width = float(box["width"])
        if width > PAGE_MAX_WIDTH + _SLACK:
            problems.append(f"the {name} is {width:.0f}px wide (> {PAGE_MAX_WIDTH:.0f}px)")
        left = float(box["x"]) - float(panel["x"])
        right = float(panel["x"]) + float(panel["width"]) - (float(box["x"]) + width)
        if abs(left - right) > _SLACK:
            problems.append(f"the {name} is not centred ({left:.0f}px left, {right:.0f}px right)")
    if abs(float(search["x"]) - float(body["x"])) > _SLACK:
        problems.append("the search bar and the settings body do not share one left edge")
    return problems


def settings_layout_problems(m: dict) -> list[str]:
    """What is wrong with the settings layout; empty when it is right (#5843)."""
    problems = _number_problems(m.get("numbers", []))
    problems += _marker_problems(m.get("markers", []))
    problems += _hint_problems(m.get("hints", []))
    for button in m.get("clear_buttons", []):
        if "ui-btn--danger" in button["classes"]:
            problems.append(f"{button['testId']}: a clear-history button uses the danger skin")
    for page in m.get("pages", []):
        problems += _page_problems(page)
    return problems

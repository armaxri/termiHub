"""Measure and grade the empty Connections sidebar's experimental signpost (#5873).

The product-run UI review (R-098, from #5858) saw the signpost "Workflows are
behind Settings ▸ General ▸ Allow experimental features" render the whole
settings path as one inline link that wrapped into several underlined
fragments in a narrow sidebar. It is now one short sentence ("Workflows are
still experimental.") and one small button ("Turn on in Settings") that opens
Settings ▸ General. :func:`measure_empty_hint` reads the boxes over the bridge;
:func:`empty_hint_layout_problems` grades them without an app.
"""

from __future__ import annotations

import re
from typing import Any, Optional

#: The signpost's container, sentence and button testIds.
HINT = "connections-empty-experimental-hint"
TEXT = "connections-empty-experimental-text"
ACTION = "connections-empty-experimental-action"

#: The sentence (``EXPERIMENTAL_HINT_TEXT`` in ``ConnectionsEmptyState.tsx``).
HINT_TEXT = "Workflows are still experimental."
#: The button's label (``EXPERIMENTAL_HINT_ACTION``).
ACTION_LABEL = "Turn on in Settings"
#: The sentence may wrap onto at most this many lines at the minimum width.
MAX_TEXT_LINES = 2
#: The whole signpost (sentence + button) spans at most this many lines.
MAX_TOTAL_LINES = 3
#: Rounding slack for box comparisons, in CSS pixels.
EPS = 1.0


def _px(value: Optional[str], fallback: float) -> float:
    """A computed ``"16px"`` as a float, ``fallback`` for ``normal`` / unknown."""
    match = re.match(r"^\s*([\d.]+)px\s*$", value or "")
    return float(match.group(1)) if match else fallback


def _right(rect: dict[str, Any]) -> float:
    return float(rect["x"]) + float(rect["width"])


def _lines(height: float, line_height: float) -> int:
    return max(1, round(height / line_height))


def measure_empty_hint(driver: Any) -> dict[str, Any]:
    """The boxes the grade reads: sidebar, signpost, its sentence and its buttons."""
    if not driver.exists(HINT):
        return {"sidebar": driver.measure_element("sidebar")["rect"], "hint": None}
    text = driver.measure_element(TEXT) if driver.exists(TEXT) else None
    if text is not None:
        font = _px(driver.get_computed_style("font-size", TEXT), 11.0)
        text["lineHeight"] = _px(driver.get_computed_style("line-height", TEXT), font * 1.25)
    return {
        "sidebar": driver.measure_element("sidebar")["rect"],
        "hint": driver.measure_element(HINT, "buttons"),
        "text": text,
    }


def empty_hint_layout_problems(m: dict[str, Any]) -> list[str]:
    """What is wrong with the signpost's layout; empty when it is right (#5873).

    ``m`` is :func:`measure_empty_hint`'s result. The signpost holds one short
    sentence that wraps onto at most two lines and exactly one button reading
    "Turn on in Settings", whose label is not clipped and stays inside the
    sidebar. The settings path ("▸") is not in the visible text any more.
    """
    hint = m.get("hint")
    if hint is None:
        return ["no experimental signpost on the empty Connections sidebar"]
    problems: list[str] = []
    if "▸" in (hint.get("text") or ""):
        problems.append(f"the signpost still spells out the settings path: {hint['text']!r}")
    text = m.get("text")
    text_lines = 0
    if text is None:
        problems.append("the signpost has no sentence")
    else:
        sentence = " ".join((text.get("text") or "").split())
        if sentence != HINT_TEXT:
            problems.append(f"the signpost reads {sentence!r}, not {HINT_TEXT!r}")
        text_lines = _lines(float(text["rect"]["height"]), float(text["lineHeight"]))
        if text_lines > MAX_TEXT_LINES:
            problems.append(f"the sentence wraps onto {text_lines} lines")
    buttons = [b for b in hint.get("items") or [] if b.get("visible", True)]
    if len(buttons) != 1:
        problems.append(f"the signpost has {len(buttons)} buttons, not one")
        return problems
    button = buttons[0]
    label = " ".join((button.get("text") or "").split())
    if label != ACTION_LABEL:
        problems.append(f"the button reads {label!r}, not {ACTION_LABEL!r}")
    if button.get("overflows"):
        problems.append("the button's label is clipped")
    if _right(button["rect"]) > _right(m["sidebar"]) + EPS:
        problems.append("the button runs outside the sidebar")
    if text_lines + 1 > MAX_TOTAL_LINES:
        problems.append(f"the signpost spans {text_lines + 1} lines")
    return problems

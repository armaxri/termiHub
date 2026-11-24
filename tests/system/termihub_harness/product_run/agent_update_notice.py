"""Measure and grade the agent update notice in a narrow sidebar (#5821).

The product-run UI review saw the agent's "update available" notice rendered
as three columns inside the 260 px sidebar row: the text wrapped one word per
line and ran off the bottom (R-001), and "Apply now" did not say what it does
(R-012). The row now carries only a compact marker; the notice is a full-width
strip under the row ("Update to v<x> available", a short note, Close and
"Restart agent and update"). :func:`measure_agent_update_notice` reads the
boxes over the bridge; :func:`agent_update_notice_problems` grades them
without an app.
"""

from __future__ import annotations

import re
from typing import Any, Optional

#: The apply button's label (#5821).
APPLY_LABEL = "Restart agent and update"
#: The strip spans at least this share of the sidebar's width.
MIN_WIDTH_SHARE = 0.9
#: The title may wrap onto at most this many lines.
MAX_TITLE_LINES = 2
#: Rounding slack for box comparisons, in CSS pixels.
EPS = 1.0


def _px(value: Optional[str], fallback: float) -> float:
    """A computed ``"18px"`` as a float, ``fallback`` for ``normal`` / unknown."""
    match = re.match(r"^\s*([\d.]+)px\s*$", value or "")
    return float(match.group(1)) if match else fallback


def _bottom(rect: dict[str, Any]) -> float:
    return float(rect["y"]) + float(rect["height"])


def _right(rect: dict[str, Any]) -> float:
    return float(rect["x"]) + float(rect["width"])


def _inside(inner: dict[str, Any], outer: dict[str, Any]) -> bool:
    return (
        float(inner["x"]) >= float(outer["x"]) - EPS
        and float(inner["y"]) >= float(outer["y"]) - EPS
        and _right(inner) <= _right(outer) + EPS
        and _bottom(inner) <= _bottom(outer) + EPS
    )


def measure_agent_update_notice(driver: Any, agent_id: str) -> dict[str, Any]:
    """The boxes the grade reads: sidebar, agent row, marker, strip, title, note, button."""

    def measured(test_id: str) -> Optional[dict[str, Any]]:
        return driver.measure_element(test_id) if driver.exists(test_id) else None

    title_id = f"agent-update-banner-title-{agent_id}"
    title = measured(title_id)
    if title is not None:
        font = _px(driver.get_computed_style("font-size", title_id), 13.0)
        title["lineHeight"] = _px(driver.get_computed_style("line-height", title_id), font * 1.25)
    return {
        "sidebar": driver.measure_element("sidebar")["rect"],
        "row": driver.measure_element(f"agent-header-{agent_id}"),
        "marker": measured(f"agent-update-marker-{agent_id}"),
        "strip": measured(f"agent-update-banner-{agent_id}"),
        "title": title,
        "note": measured(f"agent-update-banner-note-{agent_id}"),
        "apply": measured(f"agent-update-banner-apply-{agent_id}"),
    }


def _row_problems(m: dict[str, Any], agent_name: str, version: str) -> list[str]:
    row, marker = m["row"], m.get("marker")
    problems: list[str] = []
    if marker is None:
        problems.append("no update marker on the agent row")
    elif not _inside(marker["rect"], row["rect"]):
        problems.append(f"the update marker {marker['rect']} is outside the agent row")
    rest = " ".join((row.get("text") or "").replace(agent_name, " ", 1).split()).lower()
    if "available" in rest or version in rest:
        problems.append(f"the agent row carries update prose: {rest!r}")
    return problems


def _text_problems(m: dict[str, Any], strip: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    title = m.get("title")
    if title is None:
        return ["the strip has no title"]
    words = len((title.get("text") or "").split())
    lines = round(float(title["rect"]["height"]) / float(title["lineHeight"]))
    if lines > MAX_TITLE_LINES or (words > 1 and lines >= words):
        problems.append(
            f"the title wraps onto {lines} lines ({words} words): {title.get('text')!r}"
        )
    for role in ("title", "note"):
        box = m.get(role)
        if box is None:
            continue
        if box["scrollWidth"] > box["clientWidth"] + EPS:
            problems.append(f"the strip's {role} is clipped: {box.get('text')!r}")
        if not _inside(box["rect"], strip):
            problems.append(f"the strip's {role} runs outside the strip")
    return problems


def _apply_problems(m: dict[str, Any], strip: dict[str, Any]) -> list[str]:
    apply = m.get("apply")
    if apply is None:
        return ["the strip has no apply button"]
    problems: list[str] = []
    label = " ".join((apply.get("text") or "").split())
    if label != APPLY_LABEL:
        problems.append(f"the apply button reads {label!r}, not {APPLY_LABEL!r}")
    if not _inside(apply["rect"], strip):
        problems.append("the apply button runs outside the strip")
    if apply["scrollWidth"] > apply["clientWidth"] + EPS:
        problems.append("the apply button's label is clipped")
    return problems


def agent_update_notice_problems(
    m: dict[str, Any], *, agent_name: str, version: str
) -> list[str]:
    """What is wrong with the agent update notice; empty when it is right (#5821).

    ``m`` is :func:`measure_agent_update_notice`'s result. The row shows the
    agent's name and a marker inside it, no update prose; the strip sits under
    the row at (nearly) the sidebar's full width; its title wraps onto at most
    two lines and never one word per line; nothing is clipped or runs outside
    the strip; the apply button reads "Restart agent and update".
    """
    problems = _row_problems(m, agent_name, version)
    strip_box = m.get("strip")
    if strip_box is None:
        return problems + ["no update strip under the agent row"]
    strip, row, sidebar = strip_box["rect"], m["row"]["rect"], m["sidebar"]
    if float(strip["y"]) + EPS < _bottom(row):
        problems.append("the update strip overlaps the agent row instead of sitting under it")
    if float(strip["width"]) < MIN_WIDTH_SHARE * float(sidebar["width"]):
        problems.append(
            f"the strip is {strip['width']:.0f}px wide in a {sidebar['width']:.0f}px sidebar"
        )
    if strip_box["scrollHeight"] > strip_box["clientHeight"] + EPS:
        problems.append("the strip cuts off its content at the bottom")
    return problems + _text_problems(m, strip) + _apply_problems(m, strip)

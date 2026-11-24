"""Measure and grade the sidebar's folder rows (#5855).

The UI review of run ``20261123T215628Z`` found two problems on the
Connections sidebar. A collapsed folder holding the active connection showed
only a 6 px accent dot that read as an unread badge (R-058). Folder rows also
put their chevron on the right while the section headers put it on the left
(R-142). Folder rows now lead with the chevron. A marked folder tints and bolds
its name, the dot follows the name, and the row's tooltip says what it means.

:func:`measure_disclosure` and :func:`measure_folder_marker` read the boxes and
styles over the bridge. :func:`chevron_side_problems` and
:func:`folder_marker_problems` grade them without an app.
"""

from __future__ import annotations

from typing import Any, Optional

#: The marker's accessible name and the row's tooltip (``ConnectionList.tsx``).
CONTAINS_ACTIVE = "Contains the active connection"
#: The lowest font weight that reads as bold next to a normal-weight name.
BOLD_WEIGHT = 600
#: Largest gap (CSS px) between the end of the name and the dot.
MAX_MARKER_GAP = 12.0
#: Rounding slack for box comparisons, in CSS pixels.
EPS = 1.0


def measure_disclosure(driver: Any, test_id: str, label_test_id: str) -> dict[str, Any]:
    """The chevron and label boxes of one disclosure row (header or folder)."""
    return {
        "id": test_id,
        "chevron": driver.measure_element(f"{test_id}-chevron")["rect"],
        "label": driver.measure_element(label_test_id)["rect"],
    }


def measure_folder_marker(
    driver: Any, row_test_id: str, plain_row_test_id: str
) -> dict[str, Any]:
    """What the grade reads for a marked folder and an unmarked one beside it."""
    marker_id = f"{row_test_id}-active-marker"
    marker = driver.measure_element(marker_id) if driver.exists(marker_id) else None
    label = driver.measure_element(f"{row_test_id}-label")
    return {
        "row_title": driver.get_attribute(row_test_id, "title") or "",
        "marker": marker,
        "marker_label": driver.get_attribute(marker_id, "aria-label") if marker else None,
        "label_rect": label["rect"],
        "label_weight": driver.get_computed_style("font-weight", f"{row_test_id}-label"),
        "label_color": driver.get_computed_style("color", f"{row_test_id}-label"),
        "plain_color": driver.get_computed_style("color", f"{plain_row_test_id}-label"),
    }


def chevron_side_problems(rows: list[dict[str, Any]]) -> list[str]:
    """Why these disclosure rows disagree on the chevron side; empty when they pass.

    Every row, whether a section header or a folder, draws its chevron to the
    left of its label.
    """
    problems = []
    for row in rows:
        chevron, label = row["chevron"], row["label"]
        if chevron["width"] <= 0:
            problems.append(f"{row['id']}: no visible chevron")
            continue
        if chevron["x"] + chevron["width"] > label["x"] + EPS:
            problems.append(
                f"{row['id']}: chevron at x={chevron['x']:.0f} is not left of its label "
                f"at x={label['x']:.0f}"
            )
    return problems


def _weight(value: Optional[str]) -> int:
    text = (value or "").strip()
    if text == "bold":
        return 700
    try:
        return int(float(text))
    except ValueError:
        return 400


def folder_marker_problems(measured: dict[str, Any]) -> list[str]:
    """Why a marked collapsed folder fails to explain itself; empty when it passes.

    The dot carries the accessible name and sits right after the name. The row's
    tooltip says what it means. The name is bold and tinted, unlike an unmarked
    folder's.
    """
    problems = []
    marker = measured.get("marker")
    if not marker:
        return ["the collapsed folder shows no contains-active marker"]
    if measured.get("marker_label") != CONTAINS_ACTIVE:
        problems.append(f"the marker is named {measured.get('marker_label')!r}")
    if measured.get("row_title") != CONTAINS_ACTIVE:
        problems.append(f"the row tooltip reads {measured.get('row_title')!r}")
    label, dot = measured["label_rect"], marker["rect"]
    gap = dot["x"] - (label["x"] + label["width"])
    if gap < -EPS or gap > MAX_MARKER_GAP:
        problems.append(f"the dot is {gap:.0f}px from the end of the name")
    if _weight(measured.get("label_weight")) < BOLD_WEIGHT:
        problems.append(f"the name is not bold (font-weight {measured.get('label_weight')})")
    if measured.get("label_color") == measured.get("plain_color"):
        problems.append(f"the name is not tinted (color {measured.get('label_color')})")
    return problems

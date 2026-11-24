"""Measure and grade the file browser's breadcrumb (#5833).

The second product run's UI review saw the current folder itself truncated in
a deep path ("… > 5-a-rather-long-folder-name-for-the-…", R-034 / R-036), no
affordance on the "…" fold, and "Copy path" buried in a menu (R-118). The path
bar now keeps the leaf (current folder) whole: earlier segments fold into the
"…" menu first, and a leaf wider than the bar wraps onto more lines; a "Copy
path" button sits at the bar's end.

:func:`measure_breadcrumb` reads the bar over the bridge;
:func:`breadcrumb_problems` and :func:`fold_menu_problems` grade the
measurements without an app.
"""

from __future__ import annotations

from typing import Any, Optional

PATH_BAR = "file-browser-current-path"
CRUMB_OVERFLOW = "file-browser-crumb-overflow"
CRUMB_MENU = "file-browser-crumb-menu"
PATH_COPY = "file-browser-path-copy"
SIDEBAR = "sidebar"
#: Rounding slack for box comparisons, in CSS pixels.
EPS = 1.0


def crumb_testid(label: str) -> str:
    """The test id of the breadcrumb segment labelled ``label``."""
    return f"file-browser-crumb-{label}"


def menu_item_testid(label: str) -> str:
    """The test id of the "…" menu entry for the folded folder ``label``."""
    return f"file-browser-crumb-menu-{label}"


def _shown(item: dict[str, Any]) -> bool:
    """Rendered and bigger than a screen-reader-only 1 px box."""
    return bool(item.get("visible", True)) and item["rect"]["width"] > 2 and item["rect"]["height"] > 2


def _inside_x(inner: dict[str, float], outer: dict[str, float]) -> bool:
    return (
        inner["x"] >= outer["x"] - EPS
        and inner["x"] + inner["width"] <= outer["x"] + outer["width"] + EPS
    )


def measure_breadcrumb(driver: Any, leaf: str) -> dict[str, Any]:
    """The boxes the grade reads: the bar, its leaf segment, the fold and the copy button."""

    def measured(test_id: str, kind: Optional[str] = None) -> Optional[dict[str, Any]]:
        if not driver.exists(test_id):
            return None
        return driver.measure_element(test_id, kind) if kind else driver.measure_element(test_id)

    return {
        "nav": driver.measure_element(PATH_BAR, "text"),
        "leaf": measured(crumb_testid(leaf)),
        "overflow": measured(CRUMB_OVERFLOW),
        "copy": measured(PATH_COPY),
        "sidebar": driver.measure_element(SIDEBAR)["rect"],
    }


def breadcrumb_problems(
    m: dict[str, Any], *, full: str, leaf: str, expect_fold: bool = True
) -> list[str]:
    """Why this breadcrumb fails the #5833 grade; empty when it passes.

    The leaf segment exists, reads its whole name, is neither ellipsized nor
    clamped (no horizontal or vertical overflow) and lies inside the bar; no
    visible segment spills past the bar; a path that does not fit
    (``expect_fold``) folds into a "…" button; the bar's tooltip is the full path; and a "Copy path"
    button is rendered inside the sidebar.
    """
    problems: list[str] = []
    nav = m["nav"]
    box = nav["rect"]
    spill = [i["text"] for i in nav.get("items", []) if _shown(i) and not _inside_x(i["rect"], box)]
    if spill:
        problems.append(f"segments spill past the bar: {spill[:4]}")
    crumb = m.get("leaf")
    if not crumb:
        problems.append(f"no segment for the current folder {leaf!r}")
    else:
        if crumb.get("text", leaf) != leaf:
            problems.append(f"the current folder reads {crumb.get('text')!r}, not {leaf!r}")
        if crumb["scrollWidth"] > crumb["clientWidth"] + EPS:
            problems.append("the current folder name is cut off sideways (ellipsized)")
        if crumb.get("scrollHeight", 0) > crumb.get("clientHeight", 0) + EPS:
            problems.append("the current folder name is clamped (lines hidden)")
        if crumb["rect"]["width"] <= 2 or not _inside_x(crumb["rect"], box):
            problems.append("the current folder lies outside the bar")
    overflow = m.get("overflow")
    if expect_fold and not (overflow and overflow["rect"]["width"] > 2):
        problems.append("a long path does not fold its middle into a '…' button")
    if (nav.get("title") or "").rstrip("/") != full.rstrip("/"):
        problems.append(f"the bar's tooltip is {nav.get('title')!r}, not the full path")
    copy = m.get("copy")
    if not copy:
        problems.append("no 'Copy path' button in the bar")
    elif copy["rect"]["width"] <= 2 or not _inside_x(copy["rect"], m["sidebar"]):
        problems.append("the 'Copy path' button lies outside the sidebar")
    return problems


def fold_menu_problems(entries: list[str], hidden: list[str]) -> list[str]:
    """Why the opened "…" menu fails to list the folded folders; empty when it passes.

    ``entries`` are the menu's ``file-browser-crumb-menu-*`` test ids in screen
    order (top to bottom), ``hidden`` the folder labels the bar does not show.
    Every hidden folder has an entry, nearest the root first.
    """
    want = [menu_item_testid(h) for h in hidden]
    listed = [e for e in entries if e in want]
    problems = []
    missing = [w for w in want if w not in entries]
    if missing:
        problems.append(f"folded folders missing from the '…' menu: {missing[:4]}")
    elif listed != want:
        problems.append(f"the '…' menu is out of order: {listed}")
    return problems

"""Measure and grade the file browser's header menu (#5832).

The second product run's UI review saw the "…" menu mix a toggle ("Show
hidden files") and a toggle-sounding command ("Follow terminal folder") with
no checked state (R-011), "Sort by" duplicate the column headers and hide the
current direction (R-079, R-122), near-identical New file / New folder icons
next to Up / Upload (R-011), and no hint which folder the menu acts on (R-123).

Now the menu opens with a muted line naming its folder; "Show hidden files" is
a checkbox entry ticked while on; the cwd command reads "Go to terminal
folder"; "Sort by" shows only while a column header is hidden and names the
current column; New file / New folder are one "New ▾" menu button, set apart
from Up and Refresh.

:func:`read_menu` and :func:`read_header` read the app over the bridge; the
``*_problems`` functions grade those readings without an app.
"""

from __future__ import annotations

from typing import Any, Optional

MORE_ACTIONS = "file-browser-more-actions"
MORE_MENU = "file-browser-more-menu"
MENU_FOLDER = "file-browser-more-menu-folder"
TOGGLE_HIDDEN = "file-browser-toggle-hidden"
GO_TO_CWD = "file-browser-go-to-cwd"
SORT_MENU = "file-browser-sort-menu"
SORT_CURRENT = "file-browser-sort-current"
NEW_MENU = "file-browser-new"
NEW_FILE = "file-browser-new-file"
NEW_FOLDER = "file-browser-new-folder"
UP = "file-browser-up"
REFRESH = "file-browser-refresh"
#: Column headers that can sort, by sort key.
SORT_HEADERS = {
    "name": "file-browser-sort-name",
    "modified": "file-browser-sort-modified",
    "size": "file-browser-sort-size",
}
SORT_LABELS = {"name": "Name", "modified": "Modified", "size": "Size"}
#: Rounding slack for box comparisons, in CSS pixels.
EPS = 0.5


def _shown(m: Optional[dict[str, Any]]) -> bool:
    """Rendered and bigger than a 1-2 px box."""
    return bool(m) and m["rect"]["width"] > 2 and m["rect"]["height"] > 2


def read_menu(driver: Any) -> dict[str, Any]:
    """Read the open "…" menu: its folder line, toggles, cwd command and sort entry."""

    def attr(test_id: str, name: str) -> Optional[str]:
        return driver.get_attribute(test_id, name) if driver.exists(test_id) else None

    def text(test_id: str) -> Optional[str]:
        return driver.get_text(test_id).strip() if driver.exists(test_id) else None

    return {
        "folder_text": text(MENU_FOLDER),
        "folder_title": attr(MENU_FOLDER, "title"),
        "hidden_role": attr(TOGGLE_HIDDEN, "role"),
        "hidden_checked": attr(TOGGLE_HIDDEN, "aria-checked"),
        "cwd_role": attr(GO_TO_CWD, "role"),
        "cwd_text": text(GO_TO_CWD),
        "sort_present": driver.exists(SORT_MENU),
        "sort_label": attr(SORT_MENU, "aria-label"),
        "sort_current": text(SORT_CURRENT),
    }


def read_header(driver: Any) -> dict[str, Any]:
    """Read the header row: the New button and the boxes of Up / Refresh / New, the headers."""

    def measured(test_id: str) -> Optional[dict[str, Any]]:
        return driver.measure_element(test_id) if driver.exists(test_id) else None

    return {
        "new_haspopup": driver.get_attribute(NEW_MENU, "aria-haspopup")
        if driver.exists(NEW_MENU)
        else None,
        "new_file_inline": driver.exists(NEW_FILE),
        "new_folder_inline": driver.exists(NEW_FOLDER),
        "up": measured(UP),
        "refresh": measured(REFRESH),
        "new": measured(NEW_MENU),
        "headers": {key: _shown(measured(tid)) for key, tid in SORT_HEADERS.items()},
    }


def menu_state_problems(m: dict[str, Any], *, folder: str, hidden_on: bool) -> list[str]:
    """Why the open "…" menu fails the toggle / folder grade; empty when it passes.

    The first line names the current folder (its last segment, full path as
    the tooltip); "Show hidden files" is a checkbox entry whose
    ``aria-checked`` matches ``hidden_on``; the cwd entry is a plain command
    that does not read like a toggle ("Follow …").
    """
    problems: list[str] = []
    leaf = folder.rstrip("/").rsplit("/", 1)[-1] or "/"
    if m.get("folder_text") is None:
        problems.append("the menu does not say which folder it acts on")
    else:
        if m["folder_text"] != leaf:
            problems.append(f"the menu's folder line reads {m['folder_text']!r}, not {leaf!r}")
        if (m.get("folder_title") or "").rstrip("/") != folder.rstrip("/"):
            problems.append(f"the folder line's tooltip is {m.get('folder_title')!r}, not {folder!r}")
    if m.get("hidden_role") != "menuitemcheckbox":
        problems.append(f"'Show hidden files' is a {m.get('hidden_role')!r}, not a checkbox entry")
    want = "true" if hidden_on else "false"
    if m.get("hidden_checked") != want:
        problems.append(
            f"'Show hidden files' is aria-checked={m.get('hidden_checked')!r} while it is "
            f"{'on' if hidden_on else 'off'}"
        )
    cwd = m.get("cwd_text") or ""
    if m.get("cwd_role") not in (None, "menuitem"):
        problems.append(f"the terminal-folder entry is a {m.get('cwd_role')!r}, not a command")
    if cwd.lower().startswith("follow"):
        problems.append(f"the terminal-folder command reads like a toggle: {cwd!r}")
    return problems


def sort_control_problems(
    m: dict[str, Any], headers: dict[str, bool], *, sort_key: str, sort_dir: str
) -> list[str]:
    """Why the sort controls fail the one-control grade; empty when it passes.

    ``headers`` says which column headers are on screen (every column has data
    in the graded folder). The menu offers "Sort by" exactly when a header is
    hidden; then its trigger names the current column and direction.
    """
    problems: list[str] = []
    hidden = [k for k, shown in headers.items() if not shown]
    if not hidden and m.get("sort_present"):
        problems.append("the menu's 'Sort by' duplicates the column headers, which all show")
    if hidden and not m.get("sort_present"):
        problems.append(f"headers {hidden} are hidden and the menu offers no 'Sort by'")
    if m.get("sort_present"):
        label = SORT_LABELS[sort_key]
        direction = "ascending" if sort_dir == "asc" else "descending"
        if (m.get("sort_current") or "") != label:
            problems.append(f"'Sort by' shows {m.get('sort_current')!r}, not the current {label!r}")
        if direction not in (m.get("sort_label") or ""):
            problems.append(f"'Sort by' does not say the direction ({m.get('sort_label')!r})")
    return problems


def new_menu_problems(h: dict[str, Any], entries: list[str]) -> list[str]:
    """Why the creation controls fail the "New ▾" grade; empty when it passes.

    ``h`` is :func:`read_header` at a width where New is inline; ``entries``
    the test ids the opened New menu lists. New is one menu button (no
    separate New file / New folder icons), it lists File and Folder, and a
    divider sets it apart from Up / Refresh (a wider gap than Up-to-Refresh).
    """
    problems: list[str] = []
    if h.get("new_haspopup") != "menu":
        problems.append("there is no 'New' menu button in the header")
    if h.get("new_file_inline") or h.get("new_folder_inline"):
        problems.append("New file / New folder are still separate header icons")
    missing = [e for e in (NEW_FILE, NEW_FOLDER) if e not in entries]
    if missing:
        problems.append(f"the 'New' menu lacks {missing}")
    up, refresh, new = h.get("up"), h.get("refresh"), h.get("new")
    if up and refresh and new:
        nav_gap = refresh["rect"]["x"] - (up["rect"]["x"] + up["rect"]["width"])
        create_gap = new["rect"]["x"] - (refresh["rect"]["x"] + refresh["rect"]["width"])
        if create_gap <= nav_gap + EPS:
            problems.append(
                f"nothing sets 'New' apart from Up / Refresh (gap {create_gap:.0f}px vs "
                f"{nav_gap:.0f}px)"
            )
    return problems

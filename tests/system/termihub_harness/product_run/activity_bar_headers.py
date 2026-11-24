"""Grade the activity bar's glyphs and the sidebar headers (#5848), without an app.

The UI review of run ``20261123T215628Z`` found three problems in the main
window's chrome:

* R-022: the activity bar's glyphs were hard to place (a clapperboard for
  macros, a scroll for the log viewer), and the Saved header carried three
  unlabelled icons (new folder, "+", import).
* R-096: the compact empty line offered its own "New connection" link right
  under the header's "+", a second entry point in one sidebar.
* R-088: the sidebar headers were uppercase with letter-spacing, unlike the
  sentence case the copy style asks for everywhere else.

The app tags each activity-bar item with a ``data-icon`` naming its glyph.
The functions here grade what the live run reads; each returns a list of
problems, empty when the surface passes.
"""

from __future__ import annotations

from typing import Mapping, Optional, Sequence

#: Glyphs a first-time user could not place (R-022).
UNCLEAR_GLYPHS = {"clapperboard": "macros", "scroll-text": "the log viewer"}
#: The glyphs the fix chose for the two items the review named.
EXPECTED_GLYPHS = {"activity-bar-macros": "zap", "activity-bar-logs": "file-text"}
#: The Saved header's one "New ▾" trigger and its entries, in order.
NEW_MENU = "connection-list-new-menu"
NEW_MENU_ROWS = {
    "connection-list-new-connection": "New connection",
    "connection-list-new-folder": "New folder",
    "connection-list-open-import-settings": "Import connections…",
}
#: The Saved header's collapse toggle, which is not an action.
SAVED_TOGGLE = "connection-list-group-toggle"


def activity_bar_problems(items: Sequence[Mapping[str, Optional[str]]]) -> list[str]:
    """What is wrong with the activity bar's items.

    ``items`` holds one reading per visible activity-bar button: its
    ``testId``, ``label`` (``aria-label``, which is also the tooltip text) and
    ``icon`` (``data-icon``).
    """
    problems: list[str] = []
    if not items:
        return ["the activity bar shows no items"]
    seen: dict[str, str] = {}
    for item in items:
        tid = item.get("testId") or "?"
        label = (item.get("label") or "").strip()
        icon = item.get("icon")
        if not label:
            problems.append(f"{tid} has no accessible name")
        if not icon:
            problems.append(f"{tid} has no glyph tag (data-icon)")
            continue
        if icon in UNCLEAR_GLYPHS:
            problems.append(f"{tid} draws {icon!r}, unclear for {UNCLEAR_GLYPHS[icon]}")
        if icon in seen:
            problems.append(f"{tid} and {seen[icon]} draw the same glyph {icon!r}")
        seen.setdefault(icon, tid)
    by_id = {item.get("testId"): item.get("icon") for item in items}
    for tid, want in EXPECTED_GLYPHS.items():
        if tid in by_id and by_id[tid] != want:
            problems.append(f"{tid} draws {by_id[tid]!r}, want {want!r}")
    if "activity-bar-logs" not in by_id:
        problems.append("the log viewer item is missing")
    return problems


def header_problems(buttons: Sequence[Mapping[str, Optional[str]]]) -> list[str]:
    """What is wrong with the Saved header's controls.

    ``buttons`` holds the header's visible buttons (``testId``, ``label``,
    ``text``). The header must carry one "New" menu trigger beside its
    collapse toggle, and no bare icons.
    """
    actions = [b for b in buttons if b.get("testId") != SAVED_TOGGLE]
    ids = [b.get("testId") for b in actions]
    if ids != [NEW_MENU]:
        return [f"the Saved header has these controls: {ids}, want only {NEW_MENU!r}"]
    text = (actions[0].get("text") or "").strip()
    if not text.startswith("New"):
        return [f"the New menu trigger reads {text!r}, want visible text 'New'"]
    return []


def menu_problems(rows: Mapping[str, Optional[str]]) -> list[str]:
    """What is wrong with the open "New ▾" menu; ``rows`` maps id to text."""
    problems: list[str] = []
    for tid, want in NEW_MENU_ROWS.items():
        got = rows.get(tid)
        if got is None:
            problems.append(f"{tid} is not in the New menu")
        elif got.strip() != want:
            problems.append(f"{tid} reads {got!r}, want {want!r}")
    return problems


def heading_case_problems(headings: Mapping[str, tuple[str, str]]) -> list[str]:
    """What is wrong with the sidebar headings' case.

    ``headings`` maps a heading's name to ``(text, text-transform)``. Each
    must be sentence case in the source and not uppercased by CSS.
    """
    problems: list[str] = []
    for name, (text, transform) in headings.items():
        words = text.strip()
        if transform == "uppercase":
            problems.append(f"{name} is uppercased by CSS ({words!r})")
        if len(words) > 1 and words.isupper():
            problems.append(f"{name} is written in capitals: {words!r}")
        elif words and not words[0].isupper():
            problems.append(f"{name} does not start with a capital: {words!r}")
    return problems


def empty_line_problems(compact: bool, has_link: bool) -> list[str]:
    """The compact empty line must not repeat the header's create action (R-096)."""
    if compact and has_link:
        return ["the compact empty line repeats 'New connection' under the New menu"]
    return []

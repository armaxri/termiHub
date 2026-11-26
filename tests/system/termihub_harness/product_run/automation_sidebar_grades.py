"""Grade the Automations sidebar (#5818, slice 6), without an app.

One list replaced the Macros and Workflows sidebars. The functions here grade
what a live run reads over the bridge; each returns a list of problems, empty
when the surface passes.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Optional, Sequence

from .grades import row_leftover_text

#: Words of the two views the sidebar replaced; nothing in it may say them.
OLD_WORDS = re.compile(r"\b(macro|workflow)s?\b", re.IGNORECASE)
#: Every entry of a row's "…" menu, in order.
MENU = (
    "run",
    "run-on",
    "schedule",
    "history",
    "edit",
    "duplicate",
    "use-in-new",
    "export",
    "delete",
)
#: Entries only an automation that just types keystrokes offers.
KEYSTROKES_ONLY = frozenset({"use-in-new"})
#: The least a name keeps at the narrowest sidebar, in CSS pixels.
MIN_NAME_PX = 40.0
#: Rounding slack for box comparisons, in CSS pixels.
EPS = 1.0

Rect = Mapping[str, float]


def copy_problems(where: str, *texts: Optional[str]) -> list[str]:
    """Copy that still names a macro or a workflow."""
    return [
        f"{where} says {match.group(0)!r}: {text!r}"
        for text in texts
        if text and (match := OLD_WORDS.search(text))
    ]


def list_problems(listed: Sequence[str], expected: Sequence[str]) -> list[str]:
    """Every expected automation is in the one list, once."""
    problems = [f"{i} is not in the list" for i in expected if i not in listed]
    problems += [f"{i} is listed {listed.count(i)} times" for i in set(listed) if listed.count(i) > 1]
    return problems


def row_text_problems(text: str, name: str, description: str = "", marker: str = "") -> list[str]:
    """A row shows its name first, its description and its markers, nothing else (#5757)."""
    shown = " ".join(text.split())
    problems = []
    if not shown.startswith(name):
        problems.append(f"the row starts with {shown[:40]!r}, not its name {name!r}")
    left = row_leftover_text(shown, [name, description, marker])
    if left:
        problems.append(f"settings text on the row: {left!r}")
    return problems


def _right(rect: Rect) -> float:
    return float(rect["x"]) + float(rect["width"])


def _middle(rect: Rect) -> float:
    return float(rect["y"]) + float(rect["height"]) / 2


def row_layout_problems(m: Mapping[str, Any]) -> list[str]:
    """Run sits on the name's line, the trigger sentence and its switch share the line under it.

    The sentence needs the row's width (#6026); R-077's point, that one sees which
    switch belongs to which row and it stays reachable, holds on its own line too.

    ``m`` holds rects: ``sidebar``, ``name``, ``run`` and, for a triggered
    automation, ``marker`` and ``switch``; ``moreOpacity`` is the hover group's
    opacity at rest.
    """
    problems = []
    name = m["name"]
    if float(name["width"]) < MIN_NAME_PX:
        problems.append(f"the name keeps only {float(name['width']):.0f}px")
    for part in ("marker", "switch", "run"):
        rect = m.get(part)
        if rect is None:
            if part == "run":
                problems.append("the row has no run control")
            continue
        if float(rect["width"]) <= 0 or float(rect["height"]) <= 0:
            problems.append(f"the {part} is not laid out")
            continue
        if part == "run":
            if abs(_middle(rect) - _middle(name)) > float(name["height"]):
                problems.append("the run is not on the name's line")
            if float(rect["x"]) < _right(name) - EPS:
                problems.append("the run covers the name")
        elif float(rect["y"]) < float(name["y"]) + float(name["height"]) - EPS:
            problems.append(f"the {part} covers the name")
        if _right(rect) > _right(m["sidebar"]) + EPS:
            problems.append(f"the {part} runs outside the sidebar")
    marker, switch = m.get("marker"), m.get("switch")
    if marker and switch:
        if not float(marker["y"]) <= _middle(switch) <= float(marker["y"]) + float(marker["height"]):
            problems.append("the switch is not beside its sentence")
        if float(switch["x"]) < _right(marker) - EPS:
            problems.append("the switch covers its sentence")
    if str(m.get("moreOpacity")) != "0":
        problems.append("the other actions show at rest and crowd the name")
    return problems


def menu_problems(entries: Sequence[str], *, keystrokes: bool) -> list[str]:
    """The row's menu offers every action the two old sidebars had, as text."""
    want = [e for e in MENU if keystrokes or e not in KEYSTROKES_ONLY]
    return [f"the menu lacks {e!r}" for e in want if e not in entries] + [
        f"the menu offers {e!r} to an automation it does not fit"
        for e in entries
        if e in KEYSTROKES_ONLY and not keystrokes
    ]


#: The sidebar views that became one, per settings step: v4 (#5818), v5 (#6028).
_MERGED_VIEWS = (
    (("macros", "workflows"), "automations"),
    (("tunnels", "services"), "services"),
)


def migrated_layout_problems(before: Sequence[str], after: Sequence[str]) -> list[str]:
    """The hidden activity-bar views after the settings migration.

    Both views of a pair hidden: the one that replaced them is hidden, where the
    first one was. One hidden: it shows. The other hidden views keep their order.
    """
    want = list(before)
    for pair, merged in _MERGED_VIEWS:
        both = set(pair) <= set(want)
        kept: list[str] = []
        placed = False
        for view in want:
            if view not in pair:
                kept.append(view)
            elif both and not placed:
                placed = True
                kept.append(merged)
        want = kept
    return [] if list(after) == want else [f"hidden views {list(after)}, want {want}"]


def side_by_side_problems(
    *,
    running: Sequence[str],
    asked: bool,
    stopped: Optional[Mapping[str, Any]],
    stopped_by: str,
) -> list[str]:
    """Step-by-step runs in two terminals, then a third in one of them (#6042).

    ``running`` names the automations that ran at once in the two terminals,
    ``asked`` whether starting the second was put to the user, ``stopped`` the
    History record of the run the third one replaced, ``stopped_by`` its name.
    """
    problems: list[str] = []
    if len(running) != 2:
        problems.append(f"{len(running)} run(s) at once in two terminals, not 2: {list(running)}")
    if asked:
        problems.append("starting a run in another terminal asked to stop the first")
    if stopped is None:
        problems.append("no History record of the replaced run")
        return problems
    if stopped.get("status") != "cancelled":
        problems.append(f"the replaced run ended {stopped.get('status')!r}")
    want = f"“{stopped_by}” was started in this terminal"
    if stopped.get("error") != want:
        problems.append(f"its History says {stopped.get('error')!r}, not {want!r}")
    return problems

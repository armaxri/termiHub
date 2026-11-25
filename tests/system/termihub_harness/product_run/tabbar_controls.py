"""Grade the terminal toolbar's controls (#5849), without an app.

The UI review of run ``20261123T215628Z`` found three problems on the toolbar
above the tab bar:

* R-023: two "+" side by side, the tab-group strip's (next to a lone "Main"
  pill that read as a tab) and the toolbar's new-terminal "+".
* R-067: new terminal, split right, split down and the sidebar toggle were four
  look-alike outline glyphs; the sidebar toggle read as a third split icon.
* R-066: "Log session output" and "Record automation" are on/off states, but the
  "…" menu showed no state.

The app now tags each toolbar control with a ``data-icon`` naming its glyph.
The functions here grade what the live run reads off those controls; each
returns a list of problems, empty when the surface passes.
"""

from __future__ import annotations

from typing import Mapping, Optional, Sequence

#: The ``data-icon`` of the toolbar's new-terminal "+".
PLUS = "plus"
#: Layout controls whose glyphs must differ from each other.
LAYOUT_CONTROLS = (
    "terminal-view-new-terminal",
    "terminal-view-split-horizontal",
    "terminal-view-split-vertical",
    "terminal-view-toggle-sidebar",
)
#: The "…" menu rows that are on/off states.
TOGGLE_ROWS = ("terminal-view-toggle-logging", "terminal-view-record")
#: Their labels, which stay the same whether on or off.
TOGGLE_LABELS = {
    "terminal-view-toggle-logging": "Log session output",
    "terminal-view-record": "Record automation",
}
#: The words the tab-group add control shows when no chip is on screen.
NEW_TAB_GROUP = "New tab group"


def plus_problems(
    icons: Mapping[str, Optional[str]],
    group_chips: Sequence[str],
    group_count: int,
    add_text: str,
) -> list[str]:
    """What is wrong with the "+" controls of the toolbar.

    ``icons`` maps every toolbar control's test id (tab-group strip included)
    to its ``data-icon``; ``group_chips`` are the test ids of the visible
    tab-group chips; ``add_text`` is the visible text of the tab-group add
    control.
    """
    problems: list[str] = []
    pluses = sorted(tid for tid, icon in icons.items() if icon == PLUS)
    if pluses != ["terminal-view-new-terminal"]:
        problems.append(f"the toolbar has these '+' controls: {pluses}, want only new terminal")
    if group_count <= 1 and group_chips:
        problems.append(f"one tab group, yet its chip shows: {list(group_chips)}")
    if group_count > 1 and len(group_chips) != group_count:
        problems.append(f"{group_count} tab groups but {len(group_chips)} chips")
    if not group_chips and add_text.strip() != NEW_TAB_GROUP:
        problems.append(
            f"with no chip the tab-group control reads {add_text.strip()!r}, "
            f"want {NEW_TAB_GROUP!r}"
        )
    return problems


def layout_icon_problems(icons: Mapping[str, Optional[str]], sidebar_separated: bool) -> list[str]:
    """What is wrong with the layout icons' glyphs and grouping."""
    problems: list[str] = []
    missing = [c for c in LAYOUT_CONTROLS if not icons.get(c)]
    if missing:
        problems.append(f"layout controls without a glyph tag: {missing}")
    seen: dict[str, str] = {}
    for control in LAYOUT_CONTROLS:
        icon = icons.get(control)
        if not icon:
            continue
        if icon in seen:
            problems.append(f"{control} draws the same glyph as {seen[icon]}: {icon!r}")
        seen.setdefault(icon, control)
    if not sidebar_separated:
        problems.append("the sidebar toggle sits among the split icons with no divider")
    return problems


def sidebar_toggle_problems(pressed: Optional[str], sidebar_shown: bool) -> list[str]:
    """What is wrong with the sidebar toggle's reported state."""
    want = "true" if sidebar_shown else "false"
    if pressed != want:
        shown = "shown" if sidebar_shown else "hidden"
        return [f"sidebar {shown} but the toggle reports aria-pressed={pressed!r}, want {want!r}"]
    return []


def menu_toggle_problems(
    rows: Mapping[str, Mapping[str, Optional[str]]], on: Mapping[str, bool]
) -> list[str]:
    """What is wrong with the "…" menu's on/off rows.

    ``rows`` maps a row's test id to ``{"role", "checked", "text"}`` (its
    ``role``, ``aria-checked`` and visible text); ``on`` says which of them is
    currently running.
    """
    problems: list[str] = []
    for row in TOGGLE_ROWS:
        found = rows.get(row)
        if found is None:
            problems.append(f"{row} is not in the menu")
            continue
        if found.get("role") != "menuitemcheckbox":
            problems.append(f"{row} is a {found.get('role')!r}, not a checkbox row")
        want = "true" if on.get(row, False) else "false"
        if found.get("checked") != want:
            problems.append(f"{row} reports aria-checked={found.get('checked')!r}, want {want!r}")
        label = TOGGLE_LABELS[row]
        if label not in (found.get("text") or ""):
            problems.append(f"{row} reads {found.get('text')!r}, want {label!r}")
    return problems

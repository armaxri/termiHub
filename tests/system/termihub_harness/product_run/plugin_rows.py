"""Grade the plugin row's labels and the status bar's plugin item (#5931), without an app.

The UI review of run ``20261123T215628Z`` (R-133) found a plugin row with an
unlabelled sliders icon and a green dot that did not say what it meant, and a
status bar plugin item reading a cryptic ``1 · 1``. Now the dot names its state
("Enabled", "Disabled", "Error") and the type icon names the plugin's type
("Protocol parser", …), each in a tooltip and as its accessible name, and the
status bar item reads "1 plugin" / "3 plugins" with the enabled count and what
a click does in its tooltip.

:func:`plugin_row_label_problems` grades one row from the dot's and the icon's
``aria-label`` and ``title``; :func:`plugins_indicator_problems` grades the
status bar item from its text and ``aria-label``.
"""

from __future__ import annotations

import re
from typing import Optional

#: The words a plugin row's dot may read (its three colours).
DOT_LABELS = ("Enabled", "Disabled", "Error")

#: The names a plugin row's type icon may carry.
TYPE_NAMES = ("Terminal backend", "Theme", "Protocol parser", "Status bar widget", "Plugin")

#: The status bar item's visible text: "1 plugin", "3 plugins".
_INDICATOR_TEXT = re.compile(r"^(\d+) plugins?$")


def plugin_row_label_problems(
    item: str,
    *,
    dot_label: Optional[str],
    dot_title: Optional[str],
    icon_label: Optional[str],
    icon_title: Optional[str],
) -> list[str]:
    """Problems with one plugin row's dot and type icon labels (empty = pass)."""
    problems: list[str] = []
    if not dot_label:
        problems.append(f"{item}: the status dot has no accessible name")
    elif dot_label not in DOT_LABELS:
        problems.append(f"{item}: the status dot reads {dot_label!r}, not a known state")
    if dot_title != dot_label:
        problems.append(f"{item}: the dot's tooltip {dot_title!r} differs from {dot_label!r}")
    if not icon_label:
        problems.append(f"{item}: the type icon has no accessible name")
    elif icon_label not in TYPE_NAMES:
        problems.append(f"{item}: the type icon reads {icon_label!r}, not a plugin type")
    if icon_title != icon_label:
        problems.append(f"{item}: the icon's tooltip {icon_title!r} differs from {icon_label!r}")
    return problems


def plugins_indicator_problems(
    *, text: Optional[str], label: Optional[str], installed: int
) -> list[str]:
    """Problems with the status bar's plugin item (empty = pass).

    ``installed`` is how many plugins the store lists; the item must count them
    in words and its accessible name must start with that text (label in name),
    give the enabled count and say what a click does.
    """
    problems: list[str] = []
    shown = (text or "").strip()
    match = _INDICATOR_TEXT.match(shown)
    if not match:
        problems.append(f"the plugin item reads {shown!r}, not 'N plugin(s)'")
    else:
        count = int(match.group(1))
        if count != installed:
            problems.append(f"the plugin item counts {count}, but {installed} are installed")
        if (count == 1) != shown.endswith("plugin"):
            problems.append(f"the plugin item reads {shown!r}: wrong plural")
    name = label or ""
    if shown and not name.startswith(shown):
        problems.append(f"the plugin item's name {name!r} does not start with {shown!r}")
    if not re.search(r"\b\d+ enabled\b", name):
        problems.append(f"the plugin item's name {name!r} does not give the enabled count")
    if "click to open" not in name:
        problems.append(f"the plugin item's name {name!r} does not say what a click does")
    return problems

"""Grade the graduated SSH tunnels, Services and Network tools views (#5858), without an app.

The UI review of run ``20261123T215628Z`` (R-007) found these advertised core
features hidden behind Settings ▸ General ▸ Allow experimental features, a
switch with an amber "may break" warning. The maintainer graduated them
(option A): they show with experimental features off. Workflows stay behind the
switch until the Automations merge (#5818); remote agents and RDP/VNC stay too.
A view the user hid from the activity bar stays hidden.

:func:`activity_bar_problems` grades which activity-bar items are present;
:func:`experimental_hint_problems` the switch's hint text. The Connections
empty state no longer carries an experimental signpost (#5954); the workflows
note is graded in ``test_product_run_workflows_experimental_note.py``.
"""

from __future__ import annotations

from typing import Collection

#: The graduated views: sidebar view id → activity-bar item testId.
GRADUATED_VIEWS: dict[str, str] = {
    "tunnels": "activity-bar-ssh-tunnels",
    "services": "activity-bar-services",
    "network-tools": "activity-bar-network-tools",
}

#: Each graduated view's sidebar root testId (what opening it must show).
GRADUATED_SIDEBARS: dict[str, str] = {
    "tunnels": "tunnel-sidebar",
    "services": "server-sidebar",
    "network-tools": "network-tools-sidebar",
}

#: Views still behind the experimental switch, with their activity-bar testIds.
STILL_EXPERIMENTAL_VIEWS: dict[str, str] = {"workflows": "activity-bar-workflows"}

#: What the switch's hint must still name (twin of ``EXPERIMENTAL_FEATURE_NAMES``).
STILL_EXPERIMENTAL_NAMES: tuple[str, ...] = (
    "workflows",
    "remote agents",
    "RDP and VNC remote desktop",
)

#: Words that name a graduated feature in copy.
GRADUATED_WORDS: tuple[str, ...] = ("tunnel", "services", "network tools")


def activity_bar_problems(
    present: Collection[str],
    *,
    experimental: bool,
    hidden_views: Collection[str] = (),
) -> list[str]:
    """What is wrong with the activity bar's items.

    ``present`` is the set of activity-bar item testIds that exist;
    ``hidden_views`` the view ids the user hid. Every graduated view shows
    unless hidden; still-experimental views show only with ``experimental``.
    """
    problems: list[str] = []
    for view, test_id in GRADUATED_VIEWS.items():
        shown = test_id in present
        if view in hidden_views and shown:
            problems.append(f"{view}: the user hid it, but the activity bar shows it")
        elif view not in hidden_views and not shown:
            state = "on" if experimental else "off"
            problems.append(f"{view}: missing from the activity bar with experimental {state}")
    if not experimental:
        for view, test_id in STILL_EXPERIMENTAL_VIEWS.items():
            if test_id in present:
                problems.append(f"{view}: shows with experimental off, but is still experimental")
    return problems


def _names_graduated(text: str) -> list[str]:
    lower = text.lower()
    return [w for w in GRADUATED_WORDS if w in lower]


def experimental_hint_problems(hint: str) -> list[str]:
    """What is wrong with the experimental switch's hint text."""
    problems = [f"the hint still names '{w}'" for w in _names_graduated(hint)]
    for name in STILL_EXPERIMENTAL_NAMES:
        if name not in hint:
            problems.append(f"the hint does not name {name!r}")
    return problems

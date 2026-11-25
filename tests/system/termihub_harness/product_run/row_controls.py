"""Grade the run control and status dot of tunnel and service rows (#5852), without an app.

The UI review of run ``20261123T215628Z`` (R-046) found tunnel and service
rows with no visible Start / Stop: the controls were revealed on hover only,
so starting a tunnel had no affordance on the row, and the grey dot did not say
what it meant. Now each row keeps its run control visible at rest on the
trailing edge (like a macro's Play) and its dot names its state in a tooltip
and as its accessible name.

:func:`row_control_problems` grades one row from what the app reports: the
dot's ``aria-label`` and ``title``, the labels of the buttons in the row's
run-control wrapper (``<kind>-primary-<id>``) and the row's class list.
"""

from __future__ import annotations

from typing import Optional, Sequence

#: The class that keeps the run control in the row's flow, visible at rest.
PRIMARY_ACTION_CLASS = "sidebar-list-item--primary-action"

#: Dot label → the run control the row must offer, per row kind.
EXPECTED_CONTROL: dict[str, dict[str, Optional[str]]] = {
    "tunnel": {
        "Stopped": "Start",
        "Starting": "Cancel start",
        "Running": "Stop",
        "Reconnecting": "Stop",
        "Waiting": "Stop waiting",
        "Stopping": None,
        "Stop pending": None,
        "Not reachable": "Stop",
        "Error": "Retry",
    },
    "server": {
        "Stopped": "Start",
        "Starting": "Cancel start",
        "Running": "Stop",
        "Stopping": None,
        "Stop pending": None,
        "Waiting": "Stop waiting",
        "Not reachable": "Stop",
        "Error": "Retry",
    },
}


def row_control_problems(
    kind: str,
    item: str,
    *,
    dot_label: Optional[str],
    dot_title: Optional[str],
    primary_labels: Sequence[Optional[str]],
    row_class: Optional[str],
) -> list[str]:
    """Problems with one row's run control and status dot (empty = pass).

    ``kind`` is ``"tunnel"`` or ``"server"``; ``item`` names the row in the
    messages.
    """
    states = EXPECTED_CONTROL[kind]
    problems: list[str] = []
    if not dot_label:
        problems.append(f"{item}: the status dot has no accessible name")
    elif dot_label not in states:
        problems.append(f"{item}: the status dot reads {dot_label!r}, not a known state")
    if dot_title != dot_label:
        problems.append(f"{item}: the dot's tooltip {dot_title!r} differs from {dot_label!r}")
    labels = [label for label in primary_labels if label]
    if states.get(dot_label or "", "") is None:
        # Stop was pressed already: nothing to run.
        if labels:
            problems.append(f"{item}: a {dot_label!r} row offers {labels!r}, not nothing")
        return problems
    if PRIMARY_ACTION_CLASS not in (row_class or "").split():
        problems.append(f"{item}: the run control is hover-only, not visible at rest")
    if len(labels) != 1:
        problems.append(f"{item}: expected one run control on the row, found {labels!r}")
    elif dot_label in states and labels[0] != states[dot_label]:
        problems.append(
            f"{item}: a {dot_label!r} row offers {labels[0]!r}, not {states[dot_label]!r}"
        )
    return problems

"""Measure and grade the Remote agents rows (#5851).

The second product run's UI review saw agent names cut short by a text
"Connect" button (R-015, R-047), a description indented unlike connection
descriptions (R-047), a connected agent's four bare icons over "No sessions.
Right-click to create one." (R-013), and a red error triangle with focus on
Close for the routine "agent not installed yet" first run (R-094, R-095).

Now every agent action is an icon button (Connect, Reconnect, Set up agent,
Cancel; "+" and one "…" menu once connected), the description shares the
name's text column, the empty states end in a link naming their action, and
"not installed" is a neutral row state with Set up agent; its dialog names
the host, shows an info icon and starts on Set up agent.

:func:`read_agent_row` reads the app over the bridge; the ``*_problems``
functions grade those readings without an app.
"""

from __future__ import annotations

from typing import Any, Optional

#: The most action buttons that may sit beside an agent's name.
MAX_ROW_ACTIONS = 2
#: Rounding slack for box comparisons, in CSS pixels.
EPS = 1.0


def _ids(agent_id: str) -> dict[str, str]:
    return {
        "header": f"agent-header-{agent_id}",
        "name": f"agent-name-{agent_id}",
        "description": f"agent-description-{agent_id}",
        "dot": f"agent-state-{agent_id}",
        "empty": f"agent-empty-{agent_id}",
        "reconnect": f"agent-reconnect-{agent_id}",
        "setup": f"agent-setup-{agent_id}",
        "more": f"agent-more-{agent_id}",
    }


def read_agent_row(driver: Any, agent_id: str) -> dict[str, Any]:
    """Read agent ``agent_id``'s row: name and description boxes, buttons, state, empty line."""
    ids = _ids(agent_id)

    def measured(test_id: str, descendants: Optional[str] = None) -> Optional[dict[str, Any]]:
        return driver.measure_element(test_id, descendants) if driver.exists(test_id) else None

    header = measured(ids["header"], "buttons") or {}
    return {
        "name": measured(ids["name"]),
        "description": measured(ids["description"]),
        # The toggle is a button too; only the actions beside it count.
        "buttons": [
            b for b in header.get("items") or []
            if b.get("visible", True) and b.get("label")
        ],
        "dot_class": driver.get_attribute(ids["dot"], "class") or "",
        "dot_label": driver.get_attribute(ids["dot"], "aria-label"),
        "empty_text": driver.get_text(ids["empty"]).strip() if driver.exists(ids["empty"]) else None,
        "has_reconnect": driver.exists(ids["reconnect"]),
        "has_setup": driver.exists(ids["setup"]),
        "has_more": driver.exists(ids["more"]),
    }


def row_width_problems(row: dict[str, Any], name: str) -> list[str]:
    """What keeps the agent's name from having the row (R-015, R-047); empty when it has.

    The name shows in full (no ellipsis), every action beside it is an icon
    without visible text, at most :data:`MAX_ROW_ACTIONS` of them, and a
    description starts exactly under the name.
    """
    problems: list[str] = []
    box = row.get("name")
    if not box:
        return ["the agent row shows no name"]
    shown = (box.get("text") or "").strip()
    if shown != name:
        problems.append(f"the row shows {shown!r}, not the name {name!r}")
    if (box.get("scrollWidth") or 0) > (box.get("clientWidth") or 0) + EPS:
        problems.append(
            f"the name is cut short ({box.get('clientWidth')}px of {box.get('scrollWidth')}px)"
        )
    actions = [b for b in row.get("buttons") or [] if b.get("label") != name]
    worded = [b.get("text", "").strip() for b in actions if (b.get("text") or "").strip()]
    if worded:
        problems.append(f"text buttons take the name's width: {worded}")
    if len(actions) > MAX_ROW_ACTIONS:
        labels = [b.get("label") for b in actions]
        problems.append(f"{len(actions)} buttons beside the name ({labels}), at most "
                        f"{MAX_ROW_ACTIONS}")
    desc = row.get("description")
    if desc:
        dx = desc["rect"]["x"] - box["rect"]["x"]
        if abs(dx) > EPS:
            problems.append(f"the description starts {dx:+.0f}px from the name")
    return problems


def empty_state_problems(text: Optional[str], *, state: str, host: str = "") -> list[str]:
    """What is wrong with an expanded agent's empty line (R-013); empty when fine.

    ``state`` is ``"connected"`` (nothing saved yet: a New connection link),
    ``"not-installed"`` (names ``host`` and Set up agent) or ``"disconnected"``
    (a Connect link). Never a right-click hint.
    """
    if text is None:
        return ["the expanded agent shows no empty-state line"]
    problems: list[str] = []
    if "right-click" in text.lower():
        problems.append(f"the empty state hides its action behind right-click: {text!r}")
    action = {"connected": "New connection", "not-installed": "Set up agent",
              "disconnected": "Connect"}[state]
    if not text.endswith(action):
        problems.append(f"the empty state does not end in the {action!r} link: {text!r}")
    if state == "not-installed" and host and host not in text:
        problems.append(f"the empty state does not name the host {host!r}: {text!r}")
    return problems


def not_installed_row_problems(row: dict[str, Any]) -> list[str]:
    """What makes "agent not installed" look like an error (R-095); empty when neutral."""
    problems: list[str] = []
    if "status-dot--disconnected" in row.get("dot_class", ""):
        problems.append("the row's dot is red for an agent that is just not installed yet")
    if row.get("dot_label") != "Agent not installed":
        problems.append(f"the dot reads {row.get('dot_label')!r}, not 'Agent not installed'")
    if row.get("has_reconnect"):
        problems.append("the row offers Reconnect instead of the next step")
    if not row.get("has_setup"):
        problems.append("the row offers no 'Set up agent'")
    return problems


def not_installed_dialog_problems(
    dialog: dict[str, Any], *, host: str, enter_opens_setup: bool
) -> list[str]:
    """What is wrong with the "agent not installed" dialog (R-094, R-095); empty when fine.

    ``dialog`` holds ``title``, ``icon`` (the icon's ``data-icon``) and
    ``primary`` (the primary button's text). ``enter_opens_setup`` is whether
    pressing Enter right after the dialog opened ran Set up agent, i.e. the
    initial focus is on it.
    """
    problems: list[str] = []
    title = dialog.get("title") or ""
    if host not in title:
        problems.append(f"the title {title!r} does not name the host {host!r}")
    if dialog.get("icon") != "info":
        problems.append(f"the dialog shows a {dialog.get('icon')!r} icon, not a neutral info one")
    if dialog.get("primary") != "Set up agent":
        problems.append(f"the primary action reads {dialog.get('primary')!r}")
    if not enter_opens_setup:
        problems.append("the dialog does not start on 'Set up agent' (Enter did not run it)")
    return problems


def connected_actions_problems(row: dict[str, Any], menu_entries: list[str]) -> list[str]:
    """A connected agent shows "+" and "…" only, the rest in the menu (R-013)."""
    problems: list[str] = []
    labels = [b.get("label") or "" for b in row.get("buttons") or []]
    actions = [lbl for lbl in labels if lbl == "New connection" or lbl.startswith("More actions")]
    stray = [lbl for lbl in labels if lbl not in actions]
    if "New connection" not in actions:
        problems.append("the connected agent shows no '+' (New connection)")
    if not any(lbl.startswith("More actions") for lbl in actions):
        problems.append("the connected agent shows no '…' menu")
    if stray:
        problems.append(f"bare icons beside the name besides '+' and '…': {stray}")
    for entry in ("New folder", "Disconnect (detach)", "Shutdown (stop remote)"):
        if entry not in menu_entries:
            problems.append(f"the '…' menu lacks {entry!r}")
    return problems

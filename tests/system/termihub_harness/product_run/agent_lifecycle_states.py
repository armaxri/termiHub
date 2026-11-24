"""Measure and grade an agent row around a setup and a live shell (#5906, #5907).

The first UI review loop round (run ``20261124T080801Z``) saw the agent row
show the red dot and "Reconnect" while the setup terminal was installing the
agent and right after "Agent installed" (R-002, R-006), and the row of a
connected agent say "No sessions. Right-click to create one." while a shell
on that agent was open in a tab (R-007).

Now a running setup reads "Installing…" (a busy dot and the word beside the
name, no action), a finished one the neutral "Not connected" with Connect,
and a session on an agent is listed under it as soon as it starts.

:func:`read_lifecycle_row` reads the app over the bridge; the ``*_problems``
functions grade those readings without an app.
"""

from __future__ import annotations

from typing import Any, Optional

#: The words a running setup shows on the agent row.
INSTALLING = "Installing…"
#: The empty line the review saw beside a live agent shell.
NO_SESSIONS = "No sessions"


def read_lifecycle_row(driver: Any, agent_id: str) -> dict[str, Any]:
    """Read agent ``agent_id``'s row: dot, inline marker and actions, body text."""

    def text(test_id: str) -> Optional[str]:
        return driver.get_text(test_id).strip() if driver.exists(test_id) else None

    dot = f"agent-state-{agent_id}"
    return {
        "dot_class": driver.get_attribute(dot, "class") or "",
        "dot_label": driver.get_attribute(dot, "aria-label"),
        "installing": text(f"agent-installing-{agent_id}"),
        "has_connect": driver.exists(f"agent-connect-{agent_id}"),
        "has_reconnect": driver.exists(f"agent-reconnect-{agent_id}"),
        "has_setup": driver.exists(f"agent-setup-{agent_id}"),
        "empty_text": text(f"agent-empty-{agent_id}"),
        "node_text": text(f"agent-node-{agent_id}") or "",
    }


def _red(row: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    if "status-dot--disconnected" in row.get("dot_class", ""):
        problems.append("the row's dot is red (the failure state)")
    if row.get("has_reconnect"):
        problems.append("the row offers Reconnect (the failure action)")
    return problems


def installing_row_problems(row: dict[str, Any]) -> list[str]:
    """What keeps the row from saying a setup is installing (R-002); empty when it does."""
    problems = _red(row)
    if row.get("dot_label") != INSTALLING:
        problems.append(f"the dot reads {row.get('dot_label')!r}, not {INSTALLING!r}")
    if row.get("installing") != INSTALLING:
        problems.append(f"the row shows no {INSTALLING!r} beside the name")
    if row.get("has_connect") or row.get("has_setup"):
        problems.append("the row offers Connect / Set up agent while the setup runs")
    return problems


def installed_row_problems(row: dict[str, Any]) -> list[str]:
    """What keeps the row neutral after a successful setup (R-006); empty when it is."""
    problems = _red(row)
    if row.get("dot_label") != "Not connected":
        problems.append(f"the dot reads {row.get('dot_label')!r}, not 'Not connected'")
    if not row.get("has_connect"):
        problems.append("the row offers no Connect after the setup succeeded")
    if row.get("installing"):
        problems.append(f"the row still shows {row.get('installing')!r}")
    if row.get("has_setup"):
        problems.append("the row still offers 'Set up agent' after the setup succeeded")
    return problems


def session_list_problems(
    row: dict[str, Any], *, session_titles: list[str], tab_title: str
) -> list[str]:
    """What hides a live agent shell from its agent's row (R-007); empty when listed.

    ``session_titles`` are the sessions the app's agents region lists for the
    agent, ``tab_title`` the open shell tab's title.
    """
    problems: list[str] = []
    empty = row.get("empty_text") or ""
    if NO_SESSIONS.lower() in empty.lower():
        problems.append(f"the row says {empty!r} while a shell on the agent is open")
    if tab_title not in session_titles:
        problems.append(f"the agent lists {session_titles}, not the open shell {tab_title!r}")
    elif tab_title not in row.get("node_text", ""):
        problems.append(f"the open shell {tab_title!r} is not shown under the agent's row")
    return problems

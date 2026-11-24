"""Grade that every session end reads the same way (#5955), without an app.

The UI review of run ``20261124T122947Z`` (surfaces terminal, reconnect-model,
drop) saw a local exit named two ways ("Session ended" for code 0, "Process
exited (code 3)" for code 3), "— reconnected —" after a local Restart, the red
network-drop plug on an exited local tab, the "[Process exited with code 3]"
line above the shell's last output, SSH and agent notices that differed (hint,
dismiss), a "View scrollback" button beside a visible scrollback, and a green
SSH status-bar chip while the session was down.

Each function grades one measured part and returns its problems (empty when
right):

* :func:`local_exit_problems` — the strip's heading, icon and the tab's marker
  for a local process exit;
* :func:`exit_line_order_problems` — the exit line is written after the
  session's last output;
* :func:`restart_marker_problems` — a local Restart marks the scrollback
  "— restarted hh:mm:ss —", never "— reconnected";
* :func:`end_notice_problems` — every session-end strip has the "Press Enter
  to …" hint, one dismiss control and no "View scrollback";
* :func:`ssh_chip_problems` — the status-bar SSH chip greys while the session
  is down and is normal while it is live.
"""

from __future__ import annotations

import re
from typing import Optional, Sequence

#: The strip's hint per action (twin of ``drop.end.enter*`` in the catalog).
ENTER_HINTS = {
    "restart": "Press Enter to restart.",
    "reconnect": "Press Enter to reconnect.",
}
VIEW_SCROLLBACK = "View scrollback"
#: The scrollback line a process exit writes.
EXIT_LINE = re.compile(r"\[Process exited(?: with code (-?\d+))?\]")
RESTARTED = re.compile(r"— restarted \d{2}:\d{2}:\d{2} —")
RECONNECTED = "— reconnected"
#: The chip's accessible name while the session is down.
CHIP_DOWN_PREFIX = "Not connected."


def local_exit_problems(
    *,
    heading: str,
    code: Optional[int],
    icon_kind: Optional[str],
    tab_status: Optional[str],
) -> list[str]:
    """What is wrong with how a local process exit is named and marked.

    ``heading`` is the strip heading, ``code`` the exit code, ``icon_kind``
    the strip icon's kind (``terminal-disconnect-icon-<kind>``) and
    ``tab_status`` the tab's state-dot status (``tab__state-dot--<status>``).
    Wants "Process exited (code N)" for every code (0 included), the process
    icon and the neutral "exited" tab marker, never the network-drop plug.
    """
    problems: list[str] = []
    want = "Process exited" if code is None else f"Process exited (code {code})"
    if heading.strip().rstrip(".") != want:
        problems.append(f"the local exit is titled {heading!r}, not {want!r}")
    if icon_kind != "exited":
        problems.append(f"the strip icon is {icon_kind!r}, not the process icon 'exited'")
    if tab_status != "exited":
        problems.append(
            f"the tab marker is {tab_status!r}, not the neutral 'exited' stop marker"
            + (" (the network-drop plug)" if tab_status == "disconnected" else "")
        )
    return problems


def exit_line_order_problems(*, scrollback: str, last_output: str) -> list[str]:
    """What is wrong with where the exit line sits in the scrollback.

    ``scrollback`` is the terminal's text and ``last_output`` a line the
    process printed right before it exited. Wants the exit line once, after
    that output, with no process output below it.
    """
    lines = [line.rstrip() for line in scrollback.splitlines()]
    exits = [i for i, line in enumerate(lines) if EXIT_LINE.search(line)]
    if not exits:
        return ["no '[Process exited…]' line in the scrollback"]
    problems: list[str] = []
    if len(exits) > 1:
        problems.append(f"{len(exits)} exit lines in the scrollback")
    exit_at = exits[-1]
    outputs = [i for i, line in enumerate(lines) if line.strip() == last_output]
    if not outputs:
        problems.append(f"the process's last line {last_output!r} is missing")
    elif outputs[-1] > exit_at:
        problems.append(
            f"{last_output!r} is written below the exit line: output arrived after the exit"
        )
    after = [line for line in lines[exit_at + 1 :] if line.strip()]
    stray = [line for line in after if not line.lstrip().startswith("—")]
    if stray:
        problems.append(f"process output below the exit line: {stray[:3]!r}")
    return problems


def restart_marker_problems(*, scrollback: str) -> list[str]:
    """What is wrong with the marker a local Restart writes."""
    problems: list[str] = []
    if not RESTARTED.search(scrollback):
        problems.append("no '— restarted hh:mm:ss —' marker after the Restart")
    if RECONNECTED in scrollback:
        problems.append("a local Restart is marked '— reconnected', as if a link came back")
    return problems


def end_notice_problems(
    *,
    text: str,
    action: Optional[str],
    buttons: Sequence[str],
    dismiss_controls: int,
) -> list[str]:
    """What is wrong with a session-end strip's shared layout and wording.

    ``text`` is the strip's visible text, ``action`` its primary button's
    ``data-action`` (``restart`` / ``reconnect``), ``buttons`` its button
    labels and ``dismiss_controls`` how many dismiss controls it has. Wants
    the same "Press Enter to …" hint as the view-mode banner, exactly one
    dismiss control, and no "View scrollback" (the scrollback is visible).
    """
    problems: list[str] = []
    flat = " ".join(text.split())
    hint = ENTER_HINTS.get(action or "")
    if hint is None:
        problems.append(f"the strip's primary action is {action!r}, not restart / reconnect")
    elif hint not in flat:
        problems.append(f"the strip does not say {hint!r}: {flat!r}")
    if dismiss_controls != 1:
        problems.append(f"{dismiss_controls} dismiss controls; the strip has exactly one (its x)")
    if VIEW_SCROLLBACK in buttons or VIEW_SCROLLBACK in flat:
        problems.append(f"the strip still offers {VIEW_SCROLLBACK!r} beside a visible scrollback")
    return problems


def ssh_chip_problems(
    *,
    session_down: bool,
    data_down: Optional[str],
    classes: Sequence[str],
    aria_label: str,
) -> list[str]:
    """What is wrong with the status-bar SSH chip for the session's state.

    ``data_down`` is the chip's ``data-down``, ``classes`` its class list and
    ``aria_label`` its accessible name. While the session is down the chip
    greys (``status-bar__item--down``) and its name starts with "Not
    connected."; while it is live it does neither.
    """
    problems: list[str] = []
    greyed = data_down == "true" and "status-bar__item--down" in classes
    named = aria_label.startswith(CHIP_DOWN_PREFIX)
    if session_down:
        if not greyed:
            problems.append("the SSH chip stays as a live secure session while the session is down")
        if not named:
            problems.append(f"the SSH chip's name does not start with {CHIP_DOWN_PREFIX!r}")
    else:
        if greyed or named:
            problems.append("the SSH chip reads as down while the session is live")
    return problems

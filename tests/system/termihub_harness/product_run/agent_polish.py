"""Grade the round-3 agent polish (#5980), without an app.

The UI review of run ``20261124T155441Z`` (surface agent, grade 4) left five
P3s:

- R-003, update strip: the secondary "Close" sat beside "Waits for 1 session
  (…) to close." and read as "close the session"; nothing said what "Restart
  agent and update" does to that session; the session name broke at
  " · bash)". The button is now "Later", a line under the apply button says
  the sessions keep running (agent updates wait, they never cut a session
  off), and each session name stays on one line.
- R-004, disconnected banner: the screen-reader text promised "a new session"
  while Reconnect resumes it (#5953). The live region now announces the
  banner's own visible text ("Agent disconnected. Press Enter to resume.").
- R-001, tab titles: tabs stopped growing at 240px, so "sys-pr-agent-24ef8d… ·
  bash" was cut with the strip half empty. Tabs grow to 360px first; the
  tooltip always carries the full title.
- R-002, setup tab: a setup that exited 0 kept the red disconnected plug and
  the SSH chip stayed in the status bar. The tab now shows a "Finished" check
  and the chip hides.
- R-005, agent row: a disconnected agent offered the row's Connect icon and a
  "Not connected. Connect" link. The empty line now reads "Not connected."
  (graded by :func:`.agent_rows.empty_state_problems`).

Each ``*_problems`` function returns what is wrong; empty when it passes.
"""

from __future__ import annotations

from typing import Any, Optional, Sequence

#: The strip's secondary button (#5980).
LATER_LABEL = "Later"
#: Twin of ``--tab-max-width`` in ``src/styles/variables.css``.
TAB_MAX_WIDTH = 360.0
#: The finished setup tab's status dot.
FINISHED_DOT_CLASS = "tab__state-dot--finished"
FINISHED_DOT_LABEL = "Finished"
#: Twin of ``VIEW_MODE_RESUME_HINT`` in ``TerminalViewModeBanner.tsx``.
RESUME_HINT = "Press Enter to resume."
#: Rounding slack for box comparisons, in CSS pixels.
EPS = 1.0


def kept_sessions_line(open_sessions: int) -> str:
    """The line under the apply button (twin of ``keptSessionsLine``)."""
    if open_sessions == 1:
        return "Your session keeps running."
    return f"Your {open_sessions} sessions keep running."


def _flat(text: Optional[str]) -> str:
    return " ".join((text or "").split())


# ── update strip (R-003) ──────────────────────────────────────────────────
def update_strip_problems(
    *,
    dismiss: Optional[str],
    consequence: Optional[str],
    open_sessions: int,
    name_boxes: Sequence[dict[str, Any]] = (),
    line_height: float = 18.0,
) -> list[str]:
    """The strip offers "Later", says the sessions keep running, keeps names whole.

    ``dismiss`` is the secondary button's text, ``consequence`` the line under
    the apply button (``None`` when absent), ``name_boxes`` the measured
    session-name spans of the note (``rect``, ``text``) and ``line_height`` the
    note's line height in CSS pixels.
    """
    problems: list[str] = []
    if _flat(dismiss) != LATER_LABEL:
        problems.append(f"the strip's secondary button reads {dismiss!r}, want {LATER_LABEL!r}")
    if open_sessions > 0:
        want = kept_sessions_line(open_sessions)
        if consequence is None:
            problems.append("nothing under 'Restart agent and update' says what happens to "
                            "the open sessions")
        elif _flat(consequence) != want:
            problems.append(f"the line under the apply button reads {consequence!r}, want {want!r}")
    elif consequence is not None:
        problems.append(f"a session line {consequence!r} shows with no session open")
    for box in name_boxes:
        if float(box["rect"]["height"]) > 1.5 * line_height:
            problems.append(f"the session name {box.get('text')!r} breaks across lines")
    return problems


# ── disconnected banner (R-004) ───────────────────────────────────────────
def banner_announcement_problems(
    *, visible: str, announcement: str, agent_disconnected: bool
) -> list[str]:
    """The live region says exactly what the banner shows; after an agent
    disconnect that is the resume hint, never "a new session"."""
    problems: list[str] = []
    shown, spoken = _flat(visible), _flat(announcement)
    if shown != spoken:
        problems.append(f"the banner shows {shown!r} but announces {spoken!r}")
    if "new session" in spoken.lower():
        problems.append(f"the announcement promises a new session: {spoken!r}")
    if agent_disconnected and RESUME_HINT not in shown:
        problems.append(f"the agent banner does not say {RESUME_HINT!r}: {shown!r}")
    return problems


# ── tab titles (R-001) ────────────────────────────────────────────────────
def tab_growth_problems(tab: dict[str, Any], *, strip_free: float) -> list[str]:
    """A tab's title is truncated only when the tab is at its max width or the
    strip is full; its tooltip is the full title.

    ``tab`` is :func:`.tab_labels.measure_tab_label` output plus ``tooltip``
    (the tab's ``title`` attribute); ``strip_free`` the empty width right of
    the last tab in CSS pixels.
    """
    title = tab["title"]
    problems: list[str] = []
    head = tab.get("head")
    clipped = bool(head) and head["scrollWidth"] > head["clientWidth"] + EPS
    width = float(tab["tab"]["width"])
    if clipped and width < TAB_MAX_WIDTH - EPS and strip_free > EPS:
        problems.append(
            f"{title!r} is truncated at {width:.0f}px with {strip_free:.0f}px of the strip free"
        )
    tooltip = tab.get("tooltip")
    if tooltip is not None and not str(tooltip).startswith(title):
        problems.append(f"{title!r}: the tooltip reads {tooltip!r}, not the full title")
    return problems


# ── finished setup tab (R-002) ────────────────────────────────────────────
def setup_tab_icon_problems(
    *, exit_code: Optional[int], dot_class: str, dot_label: Optional[str], ssh_chip: bool
) -> list[str]:
    """A setup that exited 0 shows the "Finished" check, not the red plug, and
    no SSH chip; a failed setup keeps the red plug."""
    problems: list[str] = []
    if exit_code == 0:
        if FINISHED_DOT_CLASS not in dot_class:
            problems.append(f"the finished setup tab's icon is {dot_class!r}, want the check")
        if dot_label != FINISHED_DOT_LABEL:
            problems.append(f"the finished setup tab's icon reads {dot_label!r}, "
                            f"want {FINISHED_DOT_LABEL!r}")
        if ssh_chip:
            problems.append("the status bar still shows the SSH chip after the setup ended")
    elif exit_code is not None and FINISHED_DOT_CLASS in dot_class:
        problems.append(f"a setup that exited {exit_code} shows the finished check")
    return problems

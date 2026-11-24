"""Pure grades of the run picker and the running-automation badge (#5818, slice 5).

The product run's ``automation_run_picker`` phase runs one automation on two
terminals from the one run picker and reads the result back; these functions
turn what it read into problem lists, so the grade rules are tested without an
app (``tests/system/tests/test_product_run_automation_run_picker.py``).
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping

#: A line a typed ``echo <marker> $HOME`` prints: the marker, then an
#: absolute path (POSIX ``/…`` or a Windows drive), never the literal ``$HOME``.
_HOME_LINE = r"^{marker} (/\S*|[A-Za-z]:\\\S*)$"


def home_line(text: str, marker: str) -> str:
    """The last line of ``text`` that shows ``marker`` followed by an expanded
    ``$HOME``, or ``""`` when there is none."""
    pattern = re.compile(_HOME_LINE.format(marker=re.escape(marker)))
    lines = [ln.strip() for ln in text.splitlines() if pattern.match(ln.strip())]
    return lines[-1] if lines else ""


def typed_on_problems(texts: Mapping[str, str], marker: str) -> list[str]:
    """Every terminal in ``texts`` (tab id → its terminal text) must show the
    marker with an expanded ``$HOME``: proof the automation typed there and
    the shell ran it."""
    problems: list[str] = []
    for tab_id, text in texts.items():
        if not home_line(text, marker):
            problems.append(f"tab {tab_id} shows no '{marker} $HOME' line")
    return problems


def badge_problems(badged: Iterable[str], running: Iterable[str]) -> list[str]:
    """Exactly the terminals an automation is typing into carry the
    running-automation badge: none missing, none extra."""
    have, want = set(badged), set(running)
    problems = [f"tab {t} has no running-automation badge" for t in sorted(want - have)]
    problems += [f"tab {t} has a badge but runs nothing" for t in sorted(have - want)]
    return problems


def stopped_one_problems(
    runs: Iterable[Mapping[str, Any]], stopped_tab: str, other_tab: str
) -> list[str]:
    """Stopping the run from one tab's badge cancels that tab's run only: the
    newest run on ``stopped_tab`` is canceled, the one on ``other_tab`` completed."""
    newest: dict[str, Mapping[str, Any]] = {}
    for run in sorted(runs, key=lambda r: str(r.get("startedAt", ""))):
        tab = run.get("tabId")
        if isinstance(tab, str):
            newest[tab] = run
    problems: list[str] = []
    for tab, want in ((stopped_tab, "cancelled"), (other_tab, "completed")):
        run = newest.get(tab)
        if run is None:
            problems.append(f"no run recorded on tab {tab}")
        elif run.get("status") != want:
            problems.append(f"the run on tab {tab} ended {run.get('status')!r}, not {want!r}")
    return problems

"""Product run: what an automation types is marked in the terminal (#6021, R-068).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run ``20261123T215628Z``
found that a line a trigger or a schedule typed reads like the user's own. Since
#6021 the line an automation starts typing at is tinted and carries a badge at
its end; the badge's title names the automation, what started it and when, and
a click opens its runs in History. Nothing is written into the terminal's output.

Steps: a local-shell terminal; a one-step automation that echoes a marker, run
from its row; the badge read from the terminal; the user's own echo after it adds
no mark.

The ``test_grade_*`` functions grade fixed texts without an app and run in the
normal lane.
"""

from __future__ import annotations

from typing import Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.automation_steps import AutomationPhaseUi
from termihub_harness.product_run.ssh_steps import SshPhaseUi

#: The badge of a marked line (``automationMarkDecorations.ts``).
BADGE = "automation-mark-badge"


def mark_problems(title: Optional[str], name: str, how: str) -> list[str]:
    """What is wrong with the badge of a marked line, or ``[]``."""
    if not title:
        return ["the line the automation typed has no mark"]
    problems = []
    if f"“{name}”" not in title:
        problems.append(f"the mark does not name the automation: {title!r}")
    if how not in title:
        problems.append(f"the mark does not say what started it ({how!r}): {title!r}")
    if "History" not in title:
        problems.append(f"the mark does not lead to the History: {title!r}")
    return problems


# ── app-free grade tests ──────────────────────────────────────────────────
TITLE = (
    "Typed by the automation “Deploy”, when you ran it, at 14:32:08. "
    "Click to see its runs in History."
)


def test_grade_a_full_mark_passes():
    assert mark_problems(TITLE, "Deploy", "when you ran it") == []


def test_grade_no_mark_is_named():
    assert mark_problems(None, "Deploy", "when you ran it") == [
        "the line the automation typed has no mark"
    ]


def test_grade_a_mark_without_who_or_how_is_named():
    problems = mark_problems("Typed by an automation.", "Deploy", "on its schedule")
    assert problems[0].startswith("the mark does not name the automation")
    assert problems[1].startswith("the mark does not say what started it")
    assert problems[2].startswith("the mark does not lead to the History")


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunAutomationMark(
    ProductRunUi,
    SshPhaseUi,
    AutomationPhaseUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    SystemTest,
):
    phase = "Automation mark"
    request_timeout = 60.0

    tag = unique_name("pr").split("-")[-1]
    ids: dict[str, str] = {}

    def test_00_terminal(self):
        with self.step(
            "automation-mark.terminal",
            "A local-shell terminal to run on",
            expect="one local-shell terminal tab at a prompt",
        ):
            name = f"pr-mark-local-{self.tag}"
            self.switch_to_connections_sidebar()
            self.create_local_connection(name, connect=True)
            self.ids["tab"] = self.tab_id_of(name)
            self.wait_connected(self.ids["tab"])

    def test_10_marked(self):
        t = self.tag
        marker = f"PR_MARK_{t}"
        name = f"Mark me {t}"
        with self.step(
            "automation-mark.line",
            "The line an automation typed is marked with who typed it (#6021)",
            expect="the echo line the automation typed is tinted with a lightning badge at its "
            "end, whose title names the automation, 'when you ran it' and History",
            expect_testid=BADGE,
        ):
            self.require("automation-mark.terminal")
            macro = self.create_macro(name, [f"echo {marker}\\r"])
            self.play_macro(macro)
            tab = self.ids["tab"]
            self.wait(
                lambda: self.driver.read_terminal(tab).count(marker) >= 2,
                what="the automation's echo in the terminal",
            )
            self.wait(lambda: self.driver.exists(BADGE), what="the mark of the typed line")
            title = self.driver.get_attribute(BADGE, "title")
            self.evidence(f"badge title {title!r}")
            self.shot(label="marked")
            problems = mark_problems(title, name, "when you ran it")
            assert not problems, "; ".join(problems)

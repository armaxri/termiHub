"""Product run: no success toast for a result already visible in place (#5859).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` saw success toasts stack over the terminal for results
the screen already showed: "Saved …" after a connection editor closed and its
row appeared (R-132, R-159), "Connected …" beside a green tab dot (R-143,
R-147, R-160), and "Played macro …" / "Ran workflow …" while the output was
typing into the visible terminal (R-016).

The maintainer's rule (decision A): feedback is visible in place; a toast only
when it isn't — failures, background events (transfers, scheduled or automatic
runs, things finishing off-screen) and undo offers. The app enforces it with a
tagged-call guard (``src/components/ui/Toast/toastPolicy.test.ts``); this grade
checks a real flow: it saves a connection, connects one, plays a macro and
runs a workflow in the visible terminal, samples the toast stack after each
action and counts the success toasts that repeat what the screen shows. It
must be zero. Closing the tab must still offer its "Closed … / Reopen" undo,
which also proves the sampling sees toasts at all. No servers needed.

The ``test_grade_*`` functions grade fixed captures without an app and run in
the normal lane.
"""

from __future__ import annotations

import time
from typing import Any, Iterable

import pytest

from termihub_harness import (
    ConnectionsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    WorkflowUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.automation_steps import AutomationPhaseUi
from termihub_harness.product_run.ssh_steps import SshPhaseUi

TOAST_REGION = "toast-region"

#: Titles of success toasts whose result the screen already shows in place.
#: Each was raised before #5859 by one of the flow's actions (or a sibling).
IN_PLACE_PREFIXES = (
    "Saved",
    "Created",
    "Connected",
    "Played macro",
    "Ran workflow",
    "Duplicated",
    "Deleted",
    "Enabled",
    "Disabled",
    "Paused",
    "Resumed",
    "Credential store unlocked",
)
#: The undo offer that must still toast when a tab closes.
UNDO_PREFIX = "Closed"
#: How long to sample the stack after an action: longer than a store toast
#: takes to land after its persist resolves, shorter than a toast's lifetime.
SAMPLE_SECONDS = 1.5
SAMPLE_EVERY = 0.25

#: One captured action: what the flow did, and the toast titles seen after it.
Capture = tuple[str, list[str]]


# ── grading ───────────────────────────────────────────────────────────────
def in_place_toasts(titles: Iterable[str]) -> list[str]:
    """The titles that repeat a result already on screen, first sighting only."""
    seen: list[str] = []
    for title in titles:
        if title.startswith(IN_PLACE_PREFIXES) and title not in seen:
            seen.append(title)
    return seen


def count_success_toasts(flow: list[Capture]) -> int:
    """How many distinct in-place success toasts the whole flow raised."""
    return len(in_place_toasts(t for _, titles in flow for t in titles))


def policy_problems(flow: list[Capture]) -> list[str]:
    """Each action that raised a success toast for a result visible in place."""
    problems = []
    for action, titles in flow:
        for title in in_place_toasts(titles):
            problems.append(f"{action}: the {title!r} toast repeats what the screen shows")
    return problems


def saw_undo(flow: list[Capture]) -> bool:
    """Whether the flow saw the tab-close undo toast."""
    return any(t.startswith(UNDO_PREFIX) for _, titles in flow for t in titles)


# ── app-free grade tests ──────────────────────────────────────────────────
def test_grade_clean_flow_counts_zero():
    flow = [("save", []), ("connect", []), ("macro", []), ("close", ["Closed “Terminal”"])]
    assert count_success_toasts(flow) == 0
    assert policy_problems(flow) == []
    assert saw_undo(flow)


def test_grade_counts_each_in_place_toast_once():
    flow = [
        ("save", ["Saved “web”"]),
        ("connect", ["Connected", "pr-web", "Saved “web”"]),
        ("macro", ["Played macro “deploy”"]),
        ("workflow", ["Ran workflow “check”"]),
    ]
    assert count_success_toasts(flow) == 4
    assert policy_problems(flow) == [
        "save: the 'Saved “web”' toast repeats what the screen shows",
        "connect: the 'Connected' toast repeats what the screen shows",
        "connect: the 'Saved “web”' toast repeats what the screen shows",
        "macro: the 'Played macro “deploy”' toast repeats what the screen shows",
        "workflow: the 'Ran workflow “check”' toast repeats what the screen shows",
    ]


def test_grade_ignores_kept_toasts():
    # Failures, background events, clipboard copies and undo offers stay.
    flow = [
        ("copy", ["Copied path"]),
        ("download", ["Downloaded notes.txt"]),
        ("fail", ["Failed to save connection"]),
        ("close", ["Closed 2 tabs", "web, db"]),
    ]
    assert count_success_toasts(flow) == 0
    assert saw_undo(flow)


def test_grade_without_the_undo_toast_is_flagged():
    assert not saw_undo([("close", [])])


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunToastPolicy(
    ProductRunUi,
    SshPhaseUi,
    AutomationPhaseUi,
    WorkflowUi,
    SettingsUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    SystemTest,
):
    phase = "Toast policy"
    request_timeout = 90.0

    def _toast_titles(self) -> list[str]:
        """The visible texts in the toast stack right now."""
        if not self.driver.exists(TOAST_REGION):
            return []
        items: list[dict[str, Any]] = self.driver.measure_element(TOAST_REGION, "text")["items"]
        return [i["text"] for i in items if i.get("visible", True) and i.get("text")]

    def _sample(self, action: str, flow: list[Capture]) -> None:
        """Record every toast text shown during the next moment, for ``action``."""
        titles: list[str] = []
        end = time.monotonic() + SAMPLE_SECONDS
        while time.monotonic() < end:
            for title in self._toast_titles():
                if title not in titles:
                    titles.append(title)
            time.sleep(SAMPLE_EVERY)
        self.evidence(f"{action}: toasts {titles}")
        flow.append((action, titles))

    def test_10_in_place_results_raise_no_toast(self):
        tag = unique_name("pr").split("-")[-1]
        flow: list[Capture] = []
        with self.step(
            "toasts.policy.in-place",
            "Saving, connecting, playing a macro and running a workflow raise no success "
            "toast; closing the tab still offers Reopen (#5859)",
            expect="#5859 complaint: the connection rows, the connected tab and the terminal "
            "output are the only feedback; the toast stack shows only the 'Closed … / Reopen' "
            "undo after the tab closes",
        ):
            self.enable_experimental_features()
            self.switch_to_connections_sidebar()
            self.create_local_connection(f"pr-policy-saved-{tag}")
            self._sample("save a connection", flow)

            connected = f"pr-policy-live-{tag}"
            self.switch_to_connections_sidebar()
            self.create_local_connection(connected, connect=True)
            tab = self.tab_id_of(connected)
            self.wait_connected(tab)
            self._sample("save and connect", flow)

            macro = self.create_macro(f"Policy macro {tag}", [f"echo PR_POLICY_MACRO_{tag}\\r"])
            self.switch_to_tab(tab)
            self.play_macro(macro)
            self.wait_for_output(f"PR_POLICY_MACRO_{tag}")
            self._sample("play a macro", flow)

            self.open_workflows_sidebar()
            self.open_new_workflow()
            self.add_step("send-command")
            self.set_command(0, f"echo PR_POLICY_FLOW_{tag}")
            self.set_name(f"Policy flow {tag}")
            self.save_workflow()
            workflow = self.workflow_id(f"Policy flow {tag}")
            self.switch_to_tab(tab)
            self.run_workflow(workflow)
            self.wait_for_output(f"PR_POLICY_FLOW_{tag}")
            self._sample("run a workflow", flow)

            self.close_tab(tab)
            self._sample("close the tab", flow)
            self.shot(label="after-flow")

            count = count_success_toasts(flow)
            self.evidence(f"in-place success toasts: {count}")
            assert not policy_problems(flow), policy_problems(flow)
            assert saw_undo(flow), "closing the tab showed no 'Closed … / Reopen' toast"
        self.close_all_tabs()

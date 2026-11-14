"""Product run: disarm a trigger-armed workflow from its row (#5674).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). An on-output-match workflow bound to a saved local-shell
connection is disarmed with the switch on its Workflows-sidebar row: the row's
marker reads "Off", the trigger bindings are kept, and printing the pattern
does not run it. Switched back on, the same output fires it again.

The class runs in its own fresh profile and needs no sshd: the only target is
a local shell.
"""

from __future__ import annotations

import sys
import time

import pytest

from termihub_harness import (
    ConnectionsUi,
    PasswordPromptUi,
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

pytestmark = [
    pytest.mark.product_run,
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform.startswith("win"), reason="uses POSIX shell quoting"),
]

#: How long a disarmed trigger is given to (wrongly) fire. The output-match
#: batch window is ~100 ms; this leaves ample room under load.
QUIET_S = 4.0


class TestProductRunWorkflowDisarm(
    ProductRunUi,
    SshPhaseUi,
    AutomationPhaseUi,
    WorkflowUi,
    SettingsUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
):
    phase = "Workflow disarm"
    request_timeout = 90.0

    tag = unique_name("pr").split("-")[-1]
    ids: dict[str, str] = {}

    def _fire(self, tab: str, label: str) -> None:
        """Print the trigger pattern as command output (split, so the echo does not match)."""
        self.switch_to_tab(tab)
        self.driver.terminal_input(f"echo PR_DISARM_FI''RE_{label}_{self.tag}", tab_id=tab)
        self.wait_for_output(f"PR_DISARM_FIRE_{label}_{self.tag}", tab_id=tab, timeout=30.0)

    def test_10_armed_workflow(self):
        t = self.tag
        with self.step(
            "workflow-disarm.armed",
            "An on-output-match workflow on a local shell shows Armed and an on switch",
            expect="#5674: the Workflows sidebar; the 'Disarm check' row reads 'Armed' with a "
            "lightning icon next to an on (accent) switch; the trigger text ('On output match · "
            "<connection>') is in the row tooltip, not on the row (#5757)",
        ):
            self.enable_experimental_features()
            local = f"pr-disarm-local-{t}"
            self.switch_to_connections_sidebar()
            self.create_local_connection(local, connect=True)
            self.ids["conn"] = self.require_connection(local)["id"]
            self.ids["tab"] = self.tab_id_of(local)
            self.wait_connected(self.ids["tab"])
            self.evidence(self.echo_round_trip(self.ids["tab"], f"PR_DISARM_READY_{t}"))
            self.author_workflow(f"Disarm check {t}", [
                ("send-command", {"step-command": f"echo PR_DISARM_ANSWER_$((6*7))_{t}"}),
            ])
            self.set_output_match_trigger(self.ids["conn"], "PR_DISARM_FIRE_")
            self.save_workflow()
            wid = self.ids["workflow"] = self.workflow_id(f"Disarm check {t}")
            self.open_workflows_sidebar()
            toggle = f"workflow-arm-toggle-{wid}"
            self.wait(lambda: self.driver.exists(toggle), what="the row's arm switch")
            marker = self.driver.get_text(f"workflow-armed-{wid}").strip()
            checked = self.driver.get_attribute(toggle, "aria-checked")
            self.evidence(f"marker {marker!r}, switch aria-checked={checked!r}")
            assert marker == "Armed", f"the marker reads {marker!r}"
            assert checked == "true", f"a fresh armed workflow's switch is {checked!r}"

    def test_20_disarm_from_row(self):
        t = self.tag
        with self.step(
            "workflow-disarm.off",
            "One click on the row switch disarms the workflow; its trigger stays bound and "
            "matching output no longer runs it",
            expect="#5674: the 'Disarm check' row now reads 'Off' in muted text next to an off "
            "(grey) switch, its trigger (in the tooltip) unchanged; the local "
            "terminal shows PR_DISARM_FIRE_OFF but no PR_DISARM_ANSWER_42 line",
        ):
            self.require("workflow-disarm.armed")
            wid, tab = self.ids["workflow"], self.ids["tab"]
            self.open_workflows_sidebar()
            self.driver.click(f"workflow-arm-toggle-{wid}")
            saved = self.wait(
                lambda: (lambda w: w if w and w.get("triggersEnabled") is False else None)(
                    self.workflow(wid)
                ),
                what="the workflow to be saved disarmed",
            )
            trigger = next(
                (x for x in saved.get("triggers", []) if x.get("kind") == "on-output-match"), None
            )
            self.evidence(f"saved triggersEnabled=False, trigger {trigger}")
            assert trigger and trigger["connectionIds"] == [self.ids["conn"]], (
                f"disarming changed the trigger bindings: {trigger}"
            )
            marker = self.driver.get_text(f"workflow-armed-{wid}").strip()
            assert marker == "Off", f"the disarmed marker reads {marker!r}"
            assert self.driver.get_attribute(f"workflow-arm-toggle-{wid}", "aria-checked") == (
                "false"
            )
            self.assert_no_editor_open()
            before = len(self.workflow_runs(wid))
            self._fire(tab, "OFF")
            time.sleep(QUIET_S)
            text = self.driver.read_terminal(tab)
            runs = self.workflow_runs(wid)
            self.evidence(f"runs {before} -> {len(runs)}; tail {self.terminal_tail(tab)!r}")
            assert f"PR_DISARM_ANSWER_42_{t}" not in text, "a disarmed workflow typed its answer"
            assert len(runs) == before, f"a disarmed workflow recorded a run: {runs[:1]}"

    def test_30_rearm_from_row(self):
        t = self.tag
        with self.step(
            "workflow-disarm.on",
            "Switched back on, the same workflow fires on matching output again",
            expect="#5674: the 'Disarm check' row reads 'Armed' again next to an on switch; the "
            "local terminal shows PR_DISARM_FIRE_ON followed by PR_DISARM_ANSWER_42",
        ):
            self.require("workflow-disarm.off")
            wid, tab = self.ids["workflow"], self.ids["tab"]
            self.open_workflows_sidebar()
            self.driver.click(f"workflow-arm-toggle-{wid}")
            self.wait(
                lambda: (lambda w: w is not None and w.get("triggersEnabled", True) is True)(
                    self.workflow(wid)
                ),
                what="the workflow to be saved armed",
            )
            marker = self.driver.get_text(f"workflow-armed-{wid}").strip()
            assert marker == "Armed", f"the re-armed marker reads {marker!r}"
            self._fire(tab, "ON")
            self.wait_for_output(f"PR_DISARM_ANSWER_42_{t}", tab_id=tab, timeout=30.0)
            run = self.wait(
                lambda: next(iter(self.workflow_runs(wid)), None), what="the triggered run"
            )
            self.evidence(f"run: {run.get('status')} triggeredBy={run.get('triggeredBy')}")
            assert run.get("triggeredBy") == "on-output-match", run

    def assert_no_editor_open(self) -> None:
        """The switch must not open the workflow editor."""
        assert not self.driver.exists("workflow-editor-dialog"), "the switch opened the editor"

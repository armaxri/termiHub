"""Product run, phase: automations — macros, workflows, triggers, schedules (#5536).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Every check is a recorded step with a window capture and an
``expect`` line for the UI review.

Two run targets: a saved local-shell connection (the run's scratch profile
``HOME``) and an SSH session on the run's own native sshd (key auth; its
sessions get the fixture's scratch ``HOME``). The macro echoes ``$HOME``, so the
grade proves on which host each run played, not only that text appeared.

Steps (in order): macro create, edit, play on the local shell, play on SSH;
workflow create (send-command, wait, a delayed output, wait-for-output,
send-command), edit, run on both terminals at once ("Run on…"); an
on-output-match trigger fired by real terminal output; macro and workflow run
history; the command palette; a 1-minute schedule that fires on the local
connection (Settings -> Schedules), then is switched off.
"""

from __future__ import annotations

import re
import sys
import time
from datetime import datetime

import pytest

from termihub_harness import (
    SSH_HOST,
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
    pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only"),
]

#: The wait step's delay after the edit, and the shell's own delay before the
#: line the wait-for-output step waits on.
WAIT_MS = 1200
SHELL_SLEEP_S = 1
#: A 1-minute schedule fires within a minute plus a 15 s tick; allow load.
SCHEDULE_BUDGET = 150.0


def _ts(value: str) -> float:
    text = re.sub(r"\.(\d{6})\d+", r".\1", value.strip().replace("Z", "+00:00"))
    return datetime.fromisoformat(text).timestamp()


def _count(text: str, needle: str) -> int:
    return sum(1 for line in text.splitlines() if line.strip() == needle)


class TestProductRunAutomations(
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
    phase = "Automations"
    request_timeout = 90.0

    tag = unique_name("pr").split("-")[-1]
    ids: dict[str, str] = {}
    tabs: dict[str, str] = {}

    # ── targets ──────────────────────────────────────────────────────────────
    def test_00_targets(self):
        with self.step(
            "automations.targets",
            "Run targets: a saved local-shell connection and an SSH session on the run's sshd",
            expect="two terminal tabs: a local shell and an SSH session, both at a prompt",
        ):
            self.enable_experimental_features()
            local = f"pr-auto-local-{self.tag}"
            self.switch_to_connections_sidebar()
            self.create_local_connection(local, connect=True)
            self.ids["local_conn"] = self.require_connection(local)["id"]
            self.tabs["local"] = self.tab_id_of(local)
            self.wait_connected(self.tabs["local"])
            self.evidence(self.echo_round_trip(self.tabs["local"], f"PR_AUTO_LOCAL_{self.tag}"))
            native = self.need_native()
            ssh = f"pr-auto-ssh-{self.tag}"
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                ssh, host=SSH_HOST, port=native.target.port, username=native.target.username,
                auth_method="key", key_path=str(native.client_key), connect=True,
            )
            self.accept_all_hostkeys(timeout=15.0)
            self.tabs["ssh"] = self.tab_id_of(ssh)
            self.wait_connected(self.tabs["ssh"])
            self.evidence(self.echo_round_trip(self.tabs["ssh"], f"PR_AUTO_SSH_{self.tag}"))
            self.evidence(f"local tab {self.tabs['local']}, ssh tab {self.tabs['ssh']}")

    # ── macros ───────────────────────────────────────────────────────────────
    def _macro_steps(self) -> list[str]:
        t = self.tag
        return [f"echo PR_MACRO_1_{t}\\r", "echo PR_MACRO_HOME=$HOME\\r", f"echo PR_MACRO_3_{t}\\r"]

    def _played(self, tab_id: str, marker: str, before: int) -> str:
        self.wait(
            lambda: _count(self.driver.read_terminal(tab_id), marker) > before,
            timeout=30.0, what=f"{marker} in tab {tab_id}",
        )
        text = self.driver.read_terminal(tab_id)
        homes = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("PR_MACRO_HOME=/")]
        return homes[-1] if homes else ""

    def test_10_macro(self):
        t = self.tag
        name = f"Release check {t}"
        with self.step(
            "automations.macro.create",
            "A three-step macro is saved from the Macros sidebar",
            expect="the Macros sidebar with the new macro row, its name first",
        ):
            self.ids["macro"] = self.create_macro(name, self._macro_steps())
            steps = [s.get("data") for s in (self.macro(self.ids["macro"]) or {}).get("steps", [])]
            self.evidence(f"saved steps: {steps}")
            assert len(steps) == 3, f"saved {len(steps)} steps, not 3"
        with self.step(
            "automations.macro.edit",
            "Editing the macro's first step saves the new text",
            expect="the Macros sidebar after the edit, the macro row unchanged in place",
        ):
            self.require("automations.macro.create")
            self.edit_macro_step(self.ids["macro"], 0, f"echo PR_MACRO_EDITED_{t}\\r")
            first = self.wait(
                lambda: (lambda m: m and m["steps"][0]["data"])(self.macro(self.ids["macro"])),
                what="the edited macro",
            )
            self.evidence(f"step 1 is now {first!r}")
            assert f"PR_MACRO_EDITED_{t}" in first, f"the edit did not save: {first!r}"
        for target in ("local", "ssh"):
            with self.step(
                f"automations.macro.play.{target}",
                f"Play runs every macro step in the {target} terminal, in order",
                expect=f"the {target} terminal showing PR_MACRO_EDITED, PR_MACRO_HOME and "
                "PR_MACRO_3 lines",
            ):
                self.require("automations.macro.edit", "automations.targets")
                tab = self.tabs[target]
                self.switch_to_tab(tab)
                before = _count(self.driver.read_terminal(tab), f"PR_MACRO_3_{t}")
                self.play_macro(self.ids["macro"])
                home = self._played(tab, f"PR_MACRO_3_{t}", before)
                text = self.driver.read_terminal(tab)
                order = [text.rfind(f"PR_MACRO_EDITED_{t}\n"), text.rfind("PR_MACRO_HOME="),
                         text.rfind(f"PR_MACRO_3_{t}\n")]
                self.evidence(f"{home}; positions {order}")
                assert -1 not in order and order == sorted(order), "steps ran out of order"
                want = str(self.hosts.native.session_home if target == "ssh" else self.profile_home)
                assert home == f"PR_MACRO_HOME={want}", f"played on the wrong host: {home!r}"

    # ── workflows ────────────────────────────────────────────────────────────
    def test_20_workflow(self):
        t = self.tag
        name = f"Deploy smoke {t}"
        with self.step(
            "automations.workflow.create",
            "A workflow with a wait and a wait-for-output step is saved",
            expect="the Workflows sidebar listing the new workflow by name",
        ):
            self.author_workflow(name, [
                ("send-command", {"step-command": f"echo PR_WF_START_{t}"}),
                ("wait", {"step-delay": 500}),
                ("send-command", {"step-command": f"sleep {SHELL_SLEEP_S}; echo PR_WF_READY_$((40+2))_{t}"}),
                ("wait-for-output", {"wfo-pattern": f"PR_WF_READY_42_{t}", "wfo-timeout": 20000}),
                ("send-command", {"step-command": f"echo PR_WF_DONE_{t}"}),
            ])
            self.shot(label="editor")
            self.save_workflow()
            self.ids["workflow"] = self.workflow_id(name)
            kinds = [s.get("kind") for s in self.workflow(self.ids["workflow"])["steps"]]
            self.evidence(f"saved step kinds: {kinds}")
            assert kinds == ["send-command", "wait", "send-command", "wait-for-output",
                             "send-command"], kinds
        with self.step(
            "automations.workflow.edit",
            "Editing the wait step's delay saves the new value",
            expect="the Workflows sidebar after the edit",
        ):
            self.require("automations.workflow.create")
            self.edit_workflow(self.ids["workflow"], {"workflow-editor-step-delay-1": WAIT_MS})
            delay = self.wait(
                lambda: (lambda w: w and w["steps"][1].get("delayMs"))(self.workflow(self.ids["workflow"])),
                what="the edited workflow",
            )
            self.evidence(f"wait step delayMs = {delay}")
            assert delay == WAIT_MS, f"the delay is {delay}, not {WAIT_MS}"
        with self.step(
            "automations.workflow.run-on",
            "Run on… both terminals: each runs every step, waits, and records a completed run",
            expect="the Workflows sidebar with two completed runs in History; both terminals "
            "show START, READY_42 and DONE",
        ):
            self.require("automations.workflow.edit", "automations.targets")
            wid = self.ids["workflow"]
            before = len(self.workflow_runs(wid))
            self.run_workflow_on(wid, [self.tabs["local"], self.tabs["ssh"]])
            runs = self.wait(
                lambda: (lambda r: r if len(r) >= before + 2 else None)(self.workflow_runs(wid)),
                timeout=60.0, what="two finished workflow runs",
            )
            for run in runs[-2:] if len(runs) >= 2 else runs:
                took = _ts(run["endedAt"]) - _ts(run["startedAt"])
                self.evidence(f"run on {run.get('tabId')}: {run['status']} "
                              f"{run['stepsCompleted']}/{run['total']} in {took:.1f}s")
            fresh = sorted(runs, key=lambda r: r["startedAt"])[-2:]
            assert {r.get("tabId") for r in fresh} == {self.tabs["local"], self.tabs["ssh"]}, fresh
            for run in fresh:
                assert run["status"] == "completed", run
                took = _ts(run["endedAt"]) - _ts(run["startedAt"])
                assert took >= (WAIT_MS / 1000 + SHELL_SLEEP_S) * 0.9, (
                    f"the run took {took:.1f}s; the wait and wait-for-output did not wait"
                )
            for target, tab in self.tabs.items():
                text = self.driver.read_terminal(tab)
                spots = [text.rfind(f"PR_WF_START_{t}\n"), text.rfind(f"PR_WF_READY_42_{t}"),
                         text.rfind(f"PR_WF_DONE_{t}\n")]
                self.evidence(f"{target}: positions {spots}")
                assert -1 not in spots and spots == sorted(spots), f"{target}: steps out of order"
            self.open_workflows_sidebar()

    def test_30_output_match_trigger(self):
        t = self.tag
        name = f"Answer on match {t}"
        with self.step(
            "automations.trigger.output-match",
            "An on-output-match workflow fires when the local terminal prints its pattern",
            expect="the local terminal with PR_TRIGGER_FIRE followed by the workflow's "
            "PR_TRIGGER_ANSWER_42 line",
        ):
            self.require("automations.targets")
            self.author_workflow(name, [
                ("send-command", {"step-command": f"echo PR_TRIGGER_ANSWER_$((6*7))_{t}"}),
            ])
            self.set_output_match_trigger(self.ids["local_conn"], f"PR_TRIGGER_FIRE_{t}")
            self.shot(label="trigger-editor")
            self.save_workflow()
            wid = self.workflow_id(name)
            trigger = next((x for x in self.workflow(wid).get("triggers", [])
                            if x.get("kind") == "on-output-match"), None)
            self.evidence(f"saved trigger: {trigger}")
            assert trigger and trigger["connectionIds"] == [self.ids["local_conn"]], trigger
            tab = self.tabs["local"]
            self.switch_to_tab(tab)
            # Split so only the command's output (not its echo) matches.
            self.driver.terminal_input(f"echo PR_TRIGGER_FI''RE_{t}", tab_id=tab)
            self.wait_for_output(f"PR_TRIGGER_ANSWER_42_{t}", tab_id=tab, timeout=30.0)
            run = self.wait(lambda: next(iter(self.workflow_runs(wid)), None), what="the triggered run")
            self.evidence(f"run: {run['status']} triggeredBy={run.get('triggeredBy')} tab={run.get('tabId')}")
            assert run.get("triggeredBy") == "on-output-match", run
            assert run.get("tabId") == tab, run

    # ── history + palette ────────────────────────────────────────────────────
    def test_40_history(self):
        with self.step(
            "automations.history",
            "Run history lists the macro's and the workflows' runs with their outcome",
            expect="the Macros sidebar with its run history open: completed runs of the macro, "
            "named, with their target terminals",
            screenshot=False,
        ):
            self.require("automations.macro.play.local")
            runs = self.macro_runs(self.ids["macro"])
            self.evidence("macro runs: " + "; ".join(
                f"{r['status']} {r.get('origin')} {r.get('targetLabels')}" for r in runs))
            assert len(runs) >= 2 and all(r["status"] == "completed" for r in runs), runs
            self.show_macros()
            self.driver.click(f"macro-history-{self.ids['macro']}")
            self.wait(lambda: self.driver.exists("macro-history-list"), what="the macro history")
            shown = self.driver.get_text("macro-history-list")
            self.evidence(f"macro history text: {shown[:200]!r}")
            assert "Release check" in shown, "the history does not name the macro"
            self.shot(label="macros")
            self.open_workflows_sidebar()
            self.wait(lambda: self.driver.exists("workflow-history-list"), what="the workflow history")
            shown = self.driver.get_text("workflow-history-list")
            self.evidence(f"workflow history text: {shown[:200]!r}")
            assert "Deploy smoke" in shown and "Answer on match" in shown, shown
            self.shot(label="workflows")

    def test_50_palette(self):
        t = self.tag
        with self.step(
            "automations.palette",
            "The command palette finds the macro by name and plays it",
            expect="the local terminal after the palette closed, with one more PR_MACRO_3 line",
        ):
            self.require("automations.macro.edit", "automations.targets")
            tab = self.tabs["local"]
            self.switch_to_tab(tab)
            before = _count(self.driver.read_terminal(tab), f"PR_MACRO_3_{t}")
            mac = sys.platform == "darwin"
            self.driver.press_key("p", meta=mac, ctrl=not mac, shift=not mac)
            self.wait(lambda: self.driver.exists("command-palette-input"), what="the palette")
            self.driver.type("command-palette-input", "Release check")
            item = f"command-palette-item-macro:{self.ids['macro']}"
            self.wait(lambda: self.driver.exists(item), what="the macro in the palette")
            self.shot(label="palette")
            self.driver.click(item)
            self._played(tab, f"PR_MACRO_3_{t}", before)
            origins = [r.get("origin") for r in self.macro_runs(self.ids["macro"])]
            self.evidence(f"run origins: {origins}")
            assert "palette" in origins, "the palette run was not recorded as a palette run"
        if self.driver.exists("command-palette-input"):
            self.driver.press_key("Escape", "command-palette-input")

    # ── schedule ─────────────────────────────────────────────────────────────
    def test_60_schedule(self):
        t = self.tag
        with self.step(
            "automations.schedule",
            "A 1-minute schedule plays the macro on the local connection by itself",
            expect="Settings -> Schedules with the schedule switched off after its run, its "
            "history showing one completed attempt; the row leads with its name, its dot is grey "
            "(not green) once switched off, 'Disabled' sits on the line under the name in "
            "sentence case, and the switch and delete are visible without a hover (#5612)",
            screenshot=False,
        ):
            self.require("automations.macro.edit", "automations.targets")
            sid = self.schedule_macro(self.ids["macro"], f"Every minute {t}", self.ids["local_conn"])
            self.ids["schedule"] = sid
            tab = self.tabs["local"]
            before = _count(self.driver.read_terminal(tab), f"PR_MACRO_3_{t}")
            started = time.monotonic()
            self.set_schedule_enabled(sid, True)
            self.shot(label="enabled")
            self._grade_schedule_row(sid, enabled=True)
            try:
                attempt = self.wait(
                    lambda: next(iter((self.schedule(sid) or {}).get("history") or []), None),
                    timeout=SCHEDULE_BUDGET, interval=2.0, what="the schedule's first run",
                )
                self.evidence(f"fired after {time.monotonic() - started:.0f}s: {attempt}")
                self._played(tab, f"PR_MACRO_3_{t}", before)
                assert attempt.get("outcome") == "completed", attempt
                origins = [r.get("origin") for r in self.macro_runs(self.ids["macro"])]
                assert "scheduled" in origins, f"no scheduled macro run recorded: {origins}"
            finally:
                self.set_schedule_enabled(sid, False)
            self.shot(label="disabled")
            self._grade_schedule_row(sid, enabled=False)

    def _grade_schedule_row(self, sid: str, *, enabled: bool) -> None:
        """Grade a Settings -> Schedules row (#5612).

        The leading dot shows whether the schedule is on (the disabled tone
        when off, never the last run's green); the state line ("Disabled",
        "Next: …") is sentence case and follows the name; the enable switch
        and delete are visible without a hover.
        """
        dot = self.driver.get_attribute(f"schedule-dot-{sid}", "class") or ""
        self.evidence(f"row dot (enabled={enabled}): {dot}")
        if enabled:
            assert "status-dot--disabled" not in dot, f"an enabled schedule's dot is grey: {dot}"
        else:
            assert "status-dot--disabled" in dot, f"a disabled schedule's dot is not grey: {dot}"
            assert "status-dot--success" not in dot, f"a disabled schedule's dot is green: {dot}"
        status_id = f"schedule-status-{sid}"
        text = self.driver.get_text(status_id).strip()
        transform = self.driver.get_computed_style("text-transform", status_id)
        self.evidence(f"state line: {text!r} (text-transform {transform})")
        if not enabled:
            assert text == "Disabled", f"state line of a disabled schedule: {text!r}"
        assert transform != "uppercase", f"the state line is rendered uppercase: {text!r}"
        assert text[:1].isupper() and not text.isupper(), f"not sentence case: {text!r}"
        name = self.driver.measure_element(f"schedule-name-{sid}")["rect"]
        state = self.driver.measure_element(status_id)["rect"]
        below = state["y"] >= name["y"] + name["height"] - 1
        after = state["x"] >= name["x"] + name["width"] - 1
        assert below or after, f"the state {state} leads the name {name}"
        row = self.driver.get_attribute(f"schedule-item-{sid}", "class") or ""
        assert "sidebar-list-item--actions-visible" in row, f"row actions hidden behind hover: {row}"
        for control in (f"schedule-enable-{sid}", f"schedule-delete-{sid}"):
            assert self.driver.measure_element(control)["rect"]["width"] > 0, f"{control} not shown"

    # ── macro row + history header grade (#5636) ─────────────────────────────
    def test_70_macro_row_actions(self):
        with self.step(
            "automations.macro.row-actions",
            "A macro row offers Play without a hover, and the history header labels and "
            "separates its actions",
            expect="the Macros sidebar at rest: the macro row's Play button visible after its "
            "name; the history filtered to the macro, the filter a removable chip on its own row "
            "below the header, and a labelled 'Clear…' action in the header (#5636)",
            screenshot=False,
        ):
            self.require("automations.macro.create")
            mid = self.ids["macro"]
            self.show_macros()
            self.driver.force_hover(None)
            row = self.driver.get_attribute(f"macro-item-{mid}", "class") or ""
            self.evidence(f"row classes: {row}")
            assert "sidebar-list-item--actions-visible" in row, f"Play hides behind hover: {row}"
            name = self.driver.measure_element(f"macro-name-{mid}")["rect"]
            play = self.driver.measure_element(f"macro-play-{mid}")["rect"]
            more = self.driver.measure_element(f"macro-more-{mid}")["rect"]
            self.evidence(f"name {name}, play {play}, more {more}")
            assert play["width"] > 0 and play["height"] > 0, "the Play button is not laid out"
            assert play["x"] >= name["x"] + name["width"] - 1, f"Play {play} leads the name {name}"
            inside_more = more["x"] <= play["x"] and play["x"] + play["width"] <= more["x"] + more[
                "width"
            ]
            assert not inside_more, "Play sits in the hover-revealed group"
            assert self.driver.get_computed_style("opacity", f"macro-more-{mid}") == "0", (
                "the secondary actions show at rest and crowd the name"
            )
            self.shot(label="row")

            self.driver.click(f"macro-history-{mid}")
            self.wait(lambda: self.driver.exists("macro-history-filter"), what="the macro filter")
            header = self.driver.measure_element("macro-history-header")["rect"]
            chip = self.driver.measure_element("macro-history-show-all")["rect"]
            self.evidence(f"history header {header}, filter clear {chip}")
            assert chip["y"] >= header["y"] + header["height"] - 1, (
                "the filter's clear button sits in the header beside Clear history"
            )
            label = self.driver.get_text("macro-history-clear").strip()
            self.evidence(f"clear action text: {label!r}")
            assert label.startswith("Clear"), f"the clear-history action has no label: {label!r}"
            before = len(self.macro_runs(mid))
            self.driver.click("macro-history-clear")
            self.wait(
                lambda: self.driver.exists("macro-history-clear-confirm-cancel"),
                what="the clear-history confirmation",
            )
            self.shot(label="confirm")
            self.driver.click("macro-history-clear-confirm-cancel")
            self.wait(
                lambda: not self.driver.exists("macro-history-clear-confirm-cancel"),
                what="the confirmation to close",
            )
            after = len(self.macro_runs(mid))
            assert after == before, f"cancelling the confirmation cleared runs: {before} -> {after}"
            self.driver.click("macro-history-show-all")

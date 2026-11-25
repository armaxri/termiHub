"""Product run: the single automation store behind the old views (#5818, slice 4).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). Since slice 4 the Macros and Workflows
sidebars are thin adapters over one automation store: they look and work as
before, but they read and write ``automations.json`` and
``automation-runs.json`` only, and the legacy ``macros.json``,
``workflows.json``, ``macro-runs.json`` and ``runs.json`` stay frozen for older
builds.

Steps: a local-shell terminal; a macro saved from the Automations sidebar and a
workflow from the Automations sidebar, both stored as automations (the macro as
one recorded type-keys step, the workflow without legacy-only kinds); the macro
played and the workflow run on the terminal, each landing in its own history
panel and in ``automation-runs.json``; the legacy files untouched throughout.

The ``test_grade_*`` functions grade fixed records without an app and run in
the normal lane.
"""

from __future__ import annotations

import json
from typing import Any, Optional

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
from termihub_harness.product_run.automation_store import (
    AUTOMATION_RUNS_FILE,
    AUTOMATIONS_FILE,
    fingerprint,
    frozen_problems,
    history_problems,
    library_problems,
)
from termihub_harness.product_run.ssh_steps import SshPhaseUi


# ── app-free grade tests ──────────────────────────────────────────────────
def _macro(**over: Any) -> dict[str, Any]:
    return {
        "id": "m1",
        "steps": [{"kind": "type-keys", "chunks": [{"data": "ls\r", "delayMs": 0}]}],
        "triggers": [],
        **over,
    }


def _workflow(**over: Any) -> dict[str, Any]:
    return {
        "id": "w1",
        "steps": [{"kind": "send-command", "command": "make"}],
        "triggers": [],
        **over,
    }


def test_grade_macro_and_workflow_stored_as_automations_pass():
    both = [_macro(), _workflow()]
    assert library_problems(both, both, "m1", "w1") == []


def test_grade_missing_from_the_file_fails():
    """Saved in the store but not persisted: the UI wrote somewhere else."""
    problems = library_problems([_macro(), _workflow()], [], "m1", "w1")
    assert problems == [
        f"the macro is not in {AUTOMATIONS_FILE}",
        f"the workflow is not in {AUTOMATIONS_FILE}",
    ]


def test_grade_legacy_shapes_fail():
    macro = _macro(steps=[{"kind": "send-command", "command": "ls"}])
    workflow = _workflow(
        triggers=[{"kind": "manual"}],
        steps=[{"kind": "loop", "body": [{"kind": "run-macro", "macroId": "m1"}]}],
    )
    problems = library_problems([macro, workflow], [macro, workflow], "m1", "w1")
    assert "the macro in the store is not one type-keys step" in problems
    assert "the workflow in the store stores a manual trigger" in problems
    assert f"the workflow in {AUTOMATIONS_FILE} stores a run-macro step" in problems


def test_grade_frozen_legacy_files():
    before = {"macros.json": "a", "workflows.json": None}
    assert frozen_problems(before, dict(before)) == []
    assert frozen_problems(before, {"macros.json": "b", "workflows.json": "c"}) == [
        "macros.json was written",
        "workflows.json was written",
    ]


def test_grade_runs_in_their_own_history():
    runs = [
        {"id": "r1", "automationId": "m1", "status": "completed", "targetCount": 1},
        {"id": "r2", "automationId": "w1", "status": "completed"},
    ]
    assert history_problems(runs, "m1", "w1") == []
    swapped = [
        {"id": "r1", "automationId": "m1", "status": "failed"},
        {"id": "r2", "automationId": "w1", "status": "completed", "targetCount": 1},
    ]
    assert history_problems(swapped, "m1", "w1") == [
        "a macro run has no targetCount",
        "a workflow run carries a targetCount",
        "run r1 ended 'failed'",
    ]
    assert history_problems([], "m1", "w1") == [
        f"no macro run in {AUTOMATION_RUNS_FILE}",
        f"no workflow run in {AUTOMATION_RUNS_FILE}",
    ]


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunAutomationStore(
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
    phase = "Automation store"
    request_timeout = 60.0

    tag = unique_name("pr").split("-")[-1]
    ids: dict[str, str] = {}
    legacy: dict[str, Optional[str]] = {}

    def _stored(self, file_name: str, key: str) -> list[dict[str, Any]]:
        try:
            data = json.loads((self.config_dir / file_name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        items = data.get(key) if isinstance(data, dict) else None
        return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []

    def test_00_terminal(self):
        with self.step(
            "automation-store.terminal",
            "A local-shell terminal to run on",
            expect="one local-shell terminal tab at a prompt",
        ):
            self.legacy.update(fingerprint(self.config_dir))
            name = f"pr-store-local-{self.tag}"
            self.switch_to_connections_sidebar()
            self.create_local_connection(name, connect=True)
            self.ids["tab"] = self.tab_id_of(name)
            self.wait_connected(self.ids["tab"])
            self.evidence(self.echo_round_trip(self.ids["tab"], f"PR_STORE_{self.tag}"))

    def test_10_saved_as_automations(self):
        with self.step(
            "automation-store.saved",
            "A typed and a step-by-step automation are stored in automations.json",
            expect="the Automations sidebar with the new workflow row; the Automations sidebar "
            "unchanged in look, with its new macro row",
        ):
            t = self.tag
            self.ids["macro"] = self.create_macro(f"Store macro {t}", [f"echo PR_STORE_M_{t}\\r"])
            self.author_workflow(
                f"Store workflow {t}", [("send-command", {"step-command": f"echo PR_STORE_W_{t}"})]
            )
            self.save_workflow()
            self.ids["workflow"] = self.workflow_id(f"Store workflow {t}")
            self.wait(
                lambda: not library_problems(
                    self.driver.get_state("automations"),
                    self._stored(AUTOMATIONS_FILE, "automations"),
                    self.ids["macro"],
                    self.ids["workflow"],
                ),
                what="both in automations.json",
            )
            self.shot(label="workflows-sidebar")
            problems = frozen_problems(self.legacy, fingerprint(self.config_dir))
            self.evidence(f"legacy files {self.legacy}; problems {problems}")
            assert not problems, problems

    def test_20_runs_in_their_histories(self):
        with self.step(
            "automation-store.history",
            "The macro played and the workflow run each land in their own history",
            expect="the terminal shows both echo lines; the Workflows history lists the run",
        ):
            t, tab = self.tag, self.ids["tab"]
            self.play_macro(self.ids["macro"])
            self.wait(
                lambda: f"PR_STORE_M_{t}" in self.driver.read_terminal(tab), what="the macro output"
            )
            self.show_automations()
            self.run_workflow(self.ids["workflow"])
            self.wait(
                lambda: f"PR_STORE_W_{t}" in self.driver.read_terminal(tab),
                what="the workflow output",
            )
            runs = self.wait(
                lambda: (
                    lambda r: r
                    if not history_problems(r, self.ids["macro"], self.ids["workflow"])
                    else None
                )(self._stored(AUTOMATION_RUNS_FILE, "runs")),
                what="both runs in automation-runs.json",
            )
            assert self.automation_runs(self.ids["macro"]), "the macro history lists no run"
            assert self.automation_runs(self.ids["workflow"]), "the workflow history lists no run"
            self.shot(label="workflow-history")
            problems = frozen_problems(self.legacy, fingerprint(self.config_dir))
            self.evidence(f"{len(runs)} stored runs; legacy problems {problems}")
            assert not problems, problems
            self.close_all_tabs()
            self.switch_to_connections_sidebar()

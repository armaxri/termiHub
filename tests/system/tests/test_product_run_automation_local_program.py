"""Product run: an imported automation asks before it runs a local program (#6019).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``).

Steps: with experimental features and local programs on, an automation is imported
from a file whose forged marks are ignored; run, it asks with the exact command and
starts nothing until it is answered; confirmed, it runs at once the next time; a
changed argument asks again. Its program writes only into the run's own directory.

The ``test_grade_*`` functions grade fixed readings without an app and run in the
normal lane.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
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
from termihub_harness.product_run.automation_files_grades import IMPORT_BUTTON, IMPORT_DIALOG
from termihub_harness.product_run.automation_local_program import (
    TRUST_FILE,
    mark_problems,
    question_problems,
    trust_problems,
)
from termihub_harness.product_run.automation_steps import AutomationPhaseUi
from termihub_harness.product_run.ssh_steps import SshPhaseUi

DIALOG = "local-process-auth-dialog"
PROGRAM = "/usr/bin/touch"


# ── app-free grade tests ──────────────────────────────────────────────────
def _question(**over: Any) -> list[str]:
    shown: dict[str, Any] = {
        "lead": "“Helper” came from a file or a backup, or was changed outside termiHub.",
        "program": PROGRAM,
        "args": ["/tmp/a b"],
        "note": "“Allow this command” remembers exactly this command for this automation.",
        "buttons": ["Don't allow", "Allow once", "Allow this command"],
        **over,
    }
    return question_problems(
        **shown, name="Helper", want_program=PROGRAM, want_args=["/tmp/a b"]
    )


def test_grade_question():
    assert _question() == []
    assert len(_question(lead="The automation Helper wants to run a program")) == 1
    assert len(_question(program="touch")) == 1
    assert len(_question(args=["/tmp/a", "b"])) == 1
    assert len(_question(note="remembers this file, with any arguments")) == 1
    assert len(_question(buttons=["Don't allow", "Allow once", "Always allow"])) == 1


def test_grade_trust():
    trust = {"own": {"mine": "x"}, "imported": ["theirs"], "confirmed": {"theirs": ["h"]}}
    assert trust_problems(trust, "theirs", confirmed=1) == []
    assert trust_problems(trust, "theirs", confirmed=2) == ["1 commands are confirmed, not 2"]
    assert trust_problems(trust, "mine", confirmed=0) == [
        "the imported automation is listed as the user's own",
        "the imported automation is not listed as imported",
    ]
    assert trust_problems(None, "theirs", confirmed=0) == [f"{TRUST_FILE} is not a JSON object"]


def test_grade_mark():
    assert mark_problems({"id": "a", "steps": []}) == []
    assert mark_problems({"own": True, "imported": False}) != []


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="runs a POSIX program")
class TestProductRunAutomationLocalProgram(
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
    phase = "Imported local programs"
    request_timeout = 60.0

    tag = unique_name("pr").split("-")[-1]
    ids: dict[str, str] = {}

    def reset_before_rerun(self) -> None:
        self.dismiss_modals(DIALOG, IMPORT_DIALOG)

    def _stored(self, name: str) -> Any:
        try:
            return json.loads((Path(self.config_dir) / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _automation(self) -> Optional[dict[str, Any]]:
        name = f"Imported helper {self.tag}"
        stored = (self._stored("automations.json") or {}).get("automations") or []
        return next((a for a in stored if a.get("name") == name), None)

    def _marker(self, name: str) -> Path:
        return Path(self.config_dir) / f"pr-local {self.tag} {name}"

    def _run(self) -> None:
        self.show_automations()
        self.driver.click(f"automation-start-{self.ids['automation']}")

    def _grade_question(self, marker: Path, label: str) -> list[str]:
        self.wait(lambda: self.driver.exists(DIALOG), what="the question")
        problems = question_problems(
            self.driver.get_text("local-process-auth-lead"),
            self.driver.get_text("local-process-auth-program"),
            [self.driver.get_text("local-process-auth-args").strip()],
            self.driver.get_text("local-process-auth-note"),
            [
                self.driver.get_text(f"local-process-auth-{b}").replace("’", "'")
                for b in ("cancel", "once", "always")
            ],
            name=f"Imported helper {self.tag}",
            want_program=PROGRAM,
            want_args=[str(marker)],
        )
        self.shot(label=label)
        if marker.exists():
            problems.append("the program ran before the question was answered")
        return problems

    def test_00_import(self):
        t = self.tag
        with self.step(
            "imported-program.import",
            "An automation with a local program is imported; its forged marks are ignored",
            expect="the import dialog, which says that it runs a program on this computer",
        ):
            self.enable_experimental_features()
            self.open_settings_category("security")
            self.wait(
                lambda: self.driver.exists("workflow-local-process-toggle"),
                what="the local-programs switch",
            )
            self.driver.click("workflow-local-process-toggle")
            name = f"pr-program-{t}"
            self.switch_to_connections_sidebar()
            self.create_local_connection(name, connect=True)
            self.wait_connected(self.tab_id_of(name))
            path = Path(self.config_dir) / f"pr-program-{t}.json"
            entry = {
                "id": "x",
                "name": f"Imported helper {t}",
                "own": True,
                "imported": False,
                "steps": [
                    {
                        "kind": "run-local-process",
                        "program": PROGRAM,
                        "args": [str(self._marker("one"))],
                    }
                ],
            }
            path.write_text(json.dumps({"version": 1, "automations": [entry]}), encoding="utf-8")
            self.show_automations()
            self.driver.click("automation-new-btn")
            self.wait(lambda: self.driver.exists("automation-files-btn"), what="the New menu")
            self.driver.click("automation-files-btn")
            self.wait(lambda: self.driver.exists(IMPORT_BUTTON), what="the import settings")
            self.driver.stub_native_dialog("open", path)
            self.driver.click(IMPORT_BUTTON)
            self.wait(lambda: self.driver.exists(IMPORT_DIALOG), what="the import dialog")
            self.shot(label="imported")
            self.driver.click("automation-import-close")
            stored = self.wait(self._automation, what="the imported automation")
            self.ids["automation"] = stored["id"]
            problems = mark_problems(stored)
            problems += trust_problems(self._stored(TRUST_FILE), stored["id"], confirmed=0)
            assert not problems, problems

    def test_10_asks(self):
        with self.step(
            "imported-program.asks",
            "It asks with the exact command, starts nothing, and is not asked about twice",
            expect="'Run a local program of an imported automation?' with /usr/bin/touch, its one "
            "argument with spaces, and Don't allow / Allow once / Allow this command",
            screenshot=False,
        ):
            self.require("imported-program.import")
            marker = self._marker("one")
            self._run()
            problems = self._grade_question(marker, "question")
            self.driver.click("local-process-auth-cancel")
            self.wait(lambda: not self.driver.exists(DIALOG), what="it to close")
            if marker.exists():
                problems.append("a refused program ran")
            self._run()
            self.wait(lambda: self.driver.exists(DIALOG), what="the question again")
            self.driver.click("local-process-auth-always")
            self.wait(marker.exists, what="the program to run")
            problems += trust_problems(
                self._stored(TRUST_FILE), self.ids["automation"], confirmed=1
            )
            marker.unlink()
            self._run()
            self.wait(marker.exists, what="it to run without a question")
            if self.driver.exists(DIALOG):
                problems.append("it asked about a confirmed command")
            assert not problems, problems

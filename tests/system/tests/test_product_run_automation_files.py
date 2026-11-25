"""Product run: automations as files, and in the command palette (#5818, slice 11).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``).

Steps: the sidebar's "Import or export…" leads to Settings; Export all writes one
list; importing it again loses nothing, runs the imported copies and arrives
switched off, which the dialog and the row say; a hotkey that came from a file
does nothing until its automation is turned on; macro and workflow files of older
versions import; a file of a newer version imports nothing; the command palette
lists each automation once, finds it by its old names and runs it.

The native file dialogs are answered by the bridge.

The ``test_grade_*`` functions grade fixed readings without an app and run in
the normal lane.
"""

from __future__ import annotations

import json
import sys
import time
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
from termihub_harness.product_run.automation_files_grades import (
    EXPORT_BUTTON,
    IMPORT_BUTTON,
    IMPORT_DIALOG,
    called_problems,
    disarmed_problems,
    export_problems,
    palette_problems,
    round_trip_problems,
)
from termihub_harness.product_run.automation_steps import AutomationPhaseUi
from termihub_harness.product_run.automation_store import AUTOMATIONS_FILE, fingerprint
from termihub_harness.product_run.ssh_steps import SshPhaseUi

NEW_BUTTON = "automation-new-btn"
FILES_ENTRY = "automation-files-btn"
PALETTE_INPUT = "command-palette-input"
#: The hotkey of the imported automation; bound by nothing else.
HOTKEY = "Ctrl+Alt+Shift+F9"


# ── app-free grade tests ──────────────────────────────────────────────────
def _automation(**over: Any) -> dict[str, Any]:
    return {
        "id": "a",
        "name": "Deploy",
        "steps": [{"kind": "run-automation", "automationId": "b"}],
        "triggers": [],
        "updatedAt": "x",
        **over,
    }


def test_grade_export():
    text = json.dumps({"version": 1, "automations": [_automation()]})
    assert export_problems(text, ["Deploy"]) == []
    assert export_problems(text, ["Deploy", "B"]) == ["'B' is not in the export"]
    both = json.dumps({"version": 2, "macros": [], "automations": []})
    assert len(export_problems(both, [])) == 2
    assert export_problems("{", []) != []


def test_grade_round_trip():
    copy = _automation(id="n", name="Deploy (imported)", updatedAt="y")
    assert round_trip_problems(_automation(), copy) == []
    script = [{"kind": "run-script", "script": "x", "sourcePath": "/a"}]
    stripped = [{"kind": "run-script", "script": "x"}]
    assert round_trip_problems(_automation(steps=script), _automation(steps=stripped)) == []
    lost = _automation(steps=[])
    assert any(p.startswith("steps is") for p in round_trip_problems(_automation(), lost))
    assert round_trip_problems(_automation(tags=["a"]), _automation()) != []
    assert round_trip_problems(_automation(), None) == ["the automation was not imported"]


def test_grade_disarmed():
    assert disarmed_problems(_automation(triggersEnabled=False), "Triggers off: not on …") == []
    assert disarmed_problems(_automation(), None) == [
        "it is stored armed",
        "its row shows no marker",
    ]
    assert disarmed_problems(_automation(triggersEnabled=False), "Triggers on: …") != []


def test_grade_called():
    assert called_problems(_automation(), _automation(id="b")) == []
    assert called_problems(_automation(), _automation(id="old")) != []
    assert called_problems(_automation(), None) != []
    assert called_problems(_automation(steps=[]), _automation(id="b")) != []


def test_grade_palette():
    assert palette_problems("Run Deploytypes 1 step in prod-web", "Deploy", "prod-web") == []
    assert palette_problems(None, "Deploy", "t") == ["'Deploy' is not found"]
    assert len(palette_problems("Play macro: Deploymacro", "Deploy", "t")) == 3
    # The user's own name may hold the word.
    assert palette_problems("Run My macrotypes 1 step in t", "My macro", "t") == []


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="uses POSIX shell quoting")
class TestProductRunAutomationFiles(
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
    phase = "Automation files and palette"
    request_timeout = 60.0

    tag = unique_name("pr").split("-")[-1]
    ids: dict[str, str] = {}

    def reset_before_rerun(self) -> None:
        self.dismiss_modals(IMPORT_DIALOG)
        if self.driver.exists(PALETTE_INPUT):
            self.driver.press_key("Escape", PALETTE_INPUT)

    # ── actions and reads ────────────────────────────────────────────────────
    def _named(self, name: str) -> Optional[dict[str, Any]]:
        return next(
            (a for a in self.driver.get_state("automations") or [] if a["name"] == name), None
        )

    def _file(self, name: str) -> Path:
        return Path(self.config_dir) / f"pr-files-{self.tag}-{name}.json"

    def _open_import_settings(self) -> None:
        self.show_automations()
        self.driver.click(NEW_BUTTON)
        self.wait(lambda: self.driver.exists(FILES_ENTRY), what="the New menu")
        self.driver.click(FILES_ENTRY)
        self.wait(lambda: self.driver.exists(IMPORT_BUTTON), what="the import settings")

    def _import(self, path: Path) -> None:
        self._open_import_settings()
        self.driver.stub_native_dialog("open", path)
        self.driver.click(IMPORT_BUTTON)

    def _close_import(self) -> None:
        self.driver.click("automation-import-close")
        self.wait(lambda: not self.driver.exists(IMPORT_DIALOG), what="the dialog to close")

    def _entry(self, name: str) -> Optional[str]:
        """What the import's result says about the automation called ``name``."""
        testid = f"automation-import-entry-{name}"
        return self.driver.get_text(testid) if self.driver.exists(testid) else None

    def _palette(self, query: str) -> None:
        if not self.driver.exists(PALETTE_INPUT):
            mac = sys.platform == "darwin"
            self.driver.press_key("p", meta=mac, ctrl=not mac, shift=not mac)
            self.wait(lambda: self.driver.exists(PALETTE_INPUT), what="the palette")
        self.driver.type(PALETTE_INPUT, query)

    def _press_hotkey(self) -> None:
        self.driver.press_key("F9", ctrl=True, alt=True, shift=True)

    # ── steps ────────────────────────────────────────────────────────────────
    def test_00_export_import(self):
        t = self.tag
        with self.step(
            "automation-files.round-trip",
            "Export all and import again: nothing is lost, references follow, triggers are off",
            expect="Settings ▸ Import & migration with Import / export automations; then the "
            "dialog 'Imported 2 automations' with what is switched off",
            screenshot=False,
        ):
            name = f"pr-files-{t}"
            self.switch_to_connections_sidebar()
            self.create_local_connection(name)
            self.ids["conn"] = self.require_stable_connection(name)["id"]
            self.connect_connection(name)
            self.ids["tab"] = self.tab_id_of(name)
            self.wait_connected(self.ids["tab"])
            callee = {
                "version": 1,
                "automations": [
                    {
                        "id": f"callee-{t}",
                        "name": f"Callee {t}",
                        "tags": ["pr"],
                        "steps": [
                            {
                                "kind": "type-keys",
                                "chunks": [{"data": f"echo PR_FILE_{t}", "delayMs": 0},
                                           {"data": "\r", "delayMs": 40}],
                                "timing": "fixed",
                                "fixedDelayMs": 20,
                                "recorded": True,
                            }
                        ],
                    },
                    {
                        "id": f"caller-{t}",
                        "name": f"Caller {t}",
                        "steps": [
                            {"kind": "wait", "delayMs": 10},
                            {"kind": "run-automation", "automationId": f"callee-{t}"},
                        ],
                        "triggers": [{"kind": "hotkey", "binding": HOTKEY}],
                    },
                ],
            }
            first = self._file("first")
            first.write_text(json.dumps(callee), encoding="utf-8")
            self._import(first)
            self.wait(lambda: self.driver.exists(IMPORT_DIALOG), what="the import dialog")
            note = self._entry(f"Caller {t}")
            self.evidence(f"caller {note!r}")
            self.shot(label="imported")
            problems = [] if "Triggers off" in (note or "") else ["it does not say what is off"]
            self._close_import()
            originals = {n: self._named(f"{n} {t}") for n in ("Callee", "Caller")}
            problems += called_problems(originals["Caller"], originals["Callee"])

            exported = self._file("exported")
            self.driver.stub_native_dialog("save", exported)
            self.driver.click(EXPORT_BUTTON)
            self.wait(exported.exists, what="the exported file")
            problems += export_problems(
                exported.read_text(encoding="utf-8"), [f"Callee {t}", f"Caller {t}"]
            )
            self.shot(label="settings")
            self._import(exported)
            self.wait(lambda: self.driver.exists(IMPORT_DIALOG), what="the import dialog")
            self._close_import()
            copies = {n: self._named(f"{n} {t} (imported)") for n in ("Callee", "Caller")}
            assert originals["Callee"] and originals["Caller"], originals
            problems += round_trip_problems(originals["Callee"], copies["Callee"])
            problems += called_problems(copies["Caller"], copies["Callee"])
            assert copies["Caller"], copies
            self.ids["caller"] = copies["Caller"]["id"]
            assert not problems, problems

    def test_10_switched_off(self):
        t = self.tag
        with self.step(
            "automation-files.switched-off",
            "The hotkey of an imported automation does nothing until it is turned on",
            expect="the Automations sidebar: the imported 'Caller' row reads 'Triggers off …' with its "
            "switch off",
            screenshot=False,
        ):
            self.require("automation-files.round-trip")
            tab, caller = self.ids["tab"], self.ids["caller"]
            # Only the copy under test may answer the hotkey.
            original = self._named(f"Caller {t}")
            assert original is not None
            self.show_automations()
            marker = f"automation-armed-{caller}"
            text = self.driver.get_text(marker) if self.driver.exists(marker) else None
            problems = disarmed_problems(self._named(f"Caller {t} (imported)"), text)
            self.shot(label="off")
            self.switch_to_tab(tab)
            self._press_hotkey()
            time.sleep(2.0)  # a run would have typed by now
            if f"PR_FILE_{t}" in self.driver.read_terminal(tab):
                problems.append("the hotkey of a switched off automation ran it")
            self.show_automations()
            self.driver.click(f"automation-arm-toggle-{caller}")
            self.wait(
                lambda: (self._named(f"Caller {t} (imported)") or {}).get("triggersEnabled")
                is not False,
                what="it to be turned on",
            )
            self.switch_to_tab(tab)
            self._press_hotkey()
            self.wait_for_output(f"PR_FILE_{t}", tab_id=tab)
            assert not problems, problems

    def test_20_old_files(self):
        t = self.tag
        with self.step(
            "automation-files.old-files",
            "Macro and workflow files of older versions import; a newer file imports nothing",
            expect="'Imported 2 automations', naming the one that runs an automation that is "
            "missing",
            screenshot=False,
        ):
            self.require("automation-files.round-trip")
            old = self._file("old")
            old.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "macros": [{"name": f"Old macro {t}", "tags": [],
                                    "steps": [{"data": "ls\r", "delayMs": 5}]}],
                        "workflows": [{"name": f"Old workflow {t}",
                                       "steps": [{"kind": "run-macro", "macroId": "gone"}],
                                       "triggers": [{"kind": "manual"}]}],
                    }
                ),
                encoding="utf-8",
            )
            self._import(old)
            self.wait(lambda: self.driver.exists(IMPORT_DIALOG), what="the import dialog")
            outside = self._entry(f"Old workflow {t}")
            self.evidence(f"outside {outside!r}")
            self.shot(label="old")
            self._close_import()
            problems = []
            if "an automation that" not in (outside or ""):
                problems.append("the missing automation is not mentioned")
            macro = self._named(f"Old macro {t}") or {}
            kinds = [s.get("kind") for s in macro.get("steps") or []]
            if kinds != ["type-keys"]:
                problems.append(f"the macro became {kinds}")

            newer = self._file("newer")
            newer.write_text(json.dumps({"version": 2, "automations": []}), encoding="utf-8")
            before = fingerprint(self.config_dir, (AUTOMATIONS_FILE,))
            self._import(newer)
            time.sleep(1.5)  # an import would have been stored by now
            if self.driver.exists(IMPORT_DIALOG):
                problems.append("a newer file opened the import dialog")
            if fingerprint(self.config_dir, (AUTOMATIONS_FILE,)) != before:
                problems.append("a newer file changed the library")
            self.shot(label="newer")
            assert not problems, problems

    def test_30_palette(self):
        t = self.tag
        with self.step(
            "automation-files.palette",
            "The palette lists an automation once, finds it by its old names and runs it",
            expect="the command palette with 'Run' and the automation, and what it types in which terminal",
            screenshot=False,
        ):
            self.require("automation-files.round-trip")
            tab, name = self.ids["tab"], f"Callee {t} (imported)"
            automation = self._named(name)
            assert automation is not None
            item = f"command-palette-item-automation:{automation['id']}"
            self.switch_to_tab(tab)
            problems = []
            for query in (name, f"run macro: {name}", f"run workflow: {name}"):
                self._palette(query)
                self.wait(lambda: self.driver.exists(item), what=f"{query!r} to find it")
            self.shot(label="palette")
            row = self.driver.get_text(item)
            self.evidence(f"row {row!r}")
            problems += palette_problems(row, name, f"pr-files-{t}")
            before = self.driver.read_terminal(tab).count(f"PR_FILE_{t}")
            self.driver.click(item)
            self.wait(
                lambda: self.driver.read_terminal(tab).count(f"PR_FILE_{t}") > before,
                what="the palette run to type",
            )
            assert not problems, problems

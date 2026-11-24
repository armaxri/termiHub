"""Product run: recording what you type into an automation (#5818, slice 8).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``).

Steps: the toolbar's Record automation shows a chip, stops there and stores
exactly what was typed, under the typed line as its name, and the stored
automation types it again; a save dialog closed with Escape keeps the recording
in a bar, starting another one asks about it first, and Discard recording can be
undone; a recording is added to an existing automation; what is typed at a
password prompt is announced while recording and is not stored; the editor's
Record steps comes back with its draft and the recording; closing the recorded
terminal keeps what was typed; the save dialog fits 800x600.

Keys are pressed in the terminal (``terminal_key``): text the bridge injects is
not typed by the user and is not recorded.

The ``test_grade_*`` functions grade fixed readings without an app and run in
the normal lane.
"""

from __future__ import annotations

import sys
from typing import Any, Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    LayoutUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    WorkflowUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.automation_recording_grades import (
    CHIP,
    CHIP_AT_PROMPT,
    CHIP_HERE,
    EDITOR_BAR,
    KEPT_BAR,
    RECORD,
    SAVE_BUTTONS,
    SAVE_DIALOG,
    chip_problems,
    recorded_problems,
    save_dialog_problems,
    save_layout_problems,
    secret_problems,
)
from termihub_harness.product_run.automation_steps import AutomationPhaseUi
from termihub_harness.product_run.automation_store import AUTOMATIONS_FILE
from termihub_harness.product_run.ssh_steps import SshPhaseUi
from termihub_harness.ui.automation_sidebar import EDITOR

#: The minimum supported window, and the product run's normal one.
NARROW_WINDOW = (800, 600)
NORMAL_WINDOW = (1280, 800)
DISCARDED_TOAST = "recording-discarded"


# ── app-free grade tests ──────────────────────────────────────────────────
def _box(x: float, y: float, width: float, height: float) -> dict[str, float]:
    return {"x": x, "y": y, "width": width, "height": height}


def _automation(*data: str, **over: Any) -> dict[str, Any]:
    step = {
        "kind": "type-keys",
        "chunks": [{"data": d, "delayMs": 0} for d in data],
        "timing": "recorded",
        "recorded": True,
        **over,
    }
    return {"id": "a1", "steps": [{"kind": "send-command", "command": "ls"}, step]}


def test_grade_recorded_step_passes():
    assert recorded_problems(_automation("l", "s", "\r"), "ls\r", 1) == []
    assert recorded_problems(_automation("l", "s", "\r"), "ls\r", -1) == []


def test_grade_recorded_step_fails():
    assert recorded_problems(_automation("l", timing="instant", recorded=False), "ls", 1) == [
        "it types 'l', not 'ls'",
        "its speed is 'instant', not 'recorded'",
        "it is not marked as recorded",
    ]
    assert recorded_problems(_automation("l"), "l", 0) == ["step 0 does not type keys"]
    assert recorded_problems(_automation("l"), "l", 2) == ["step 2 does not type keys"]
    assert recorded_problems(None, "l") == ["step 0 does not type keys"]


def test_grade_secret():
    assert secret_problems('{"data":"sudo -v"}', "hunter2") == []
    assert secret_problems('{"data":"hunter2"}', "hunter2") != []


def test_grade_chip():
    assert chip_problems("Recording", CHIP_HERE) == []
    assert chip_problems(None, None) == []
    assert chip_problems(None, CHIP_HERE) == ["no recording chip"]
    assert chip_problems("Recording", CHIP_AT_PROMPT) != []
    assert chip_problems("Recording", None) == ["the chip still reads 'Recording'"]


def test_grade_save_dialog():
    summary = "Recorded 3 keys in pr-rec (1.2 s)"
    assert save_dialog_problems(summary, "ls", 3, "ls") == []
    assert save_dialog_problems("Recorded 1 key in t (0.0 s)", "l", 1, "l") == []
    assert len(save_dialog_problems(summary, "⎋[A", 4, "ls")) == 2


def test_grade_save_layout():
    dialog, save = _box(150, 40, 500, 500), _box(560, 500, 80, 28)
    assert save_layout_problems((800, 600), dialog, [save]) == []
    assert save_layout_problems((800, 600), _box(150, -10, 500, 700), [save]) != []
    assert save_layout_problems((800, 600), dialog, [_box(560, 590, 80, 28)]) != []


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="uses POSIX shell quoting")
class TestProductRunAutomationRecording(
    ProductRunUi,
    SshPhaseUi,
    AutomationPhaseUi,
    WorkflowUi,
    LayoutUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    SystemTest,
):
    phase = "Recording an automation"
    request_timeout = 60.0

    tag = unique_name("pr").split("-")[-1]
    ids: dict[str, str] = {}

    def reset_before_rerun(self) -> None:
        if self.driver.exists(CHIP):
            self.driver.click(CHIP)
        self._discard()
        self.dismiss_modals(EDITOR)
        self.driver.resize_window(*NORMAL_WINDOW)

    # ── actions and reads ────────────────────────────────────────────────────
    def _press(self, text: str, tab: Optional[str] = None) -> None:
        """Press the keys of ``text`` in the terminal, one by one."""
        for char in text:
            self.driver.terminal_key("Enter" if char == "\r" else char, tab or self.ids["tab"])

    def _start(self) -> None:
        self.switch_to_tab(self.ids["tab"])
        self.invoke_terminal_toolbar_action(RECORD)
        self.wait(lambda: self.driver.exists(CHIP), what="the Recording chip")

    def _stop(self) -> None:
        self.driver.click(CHIP)
        self.wait(lambda: self.driver.exists(SAVE_DIALOG), what="the save dialog")

    def _record(self, text: str) -> None:
        self._start()
        self._press(text)
        self._stop()

    def _discard(self) -> None:
        """Discard what is recorded, wherever it waits."""
        for button in ("recording-save-discard", "recording-bar-discard"):
            if self.driver.exists(button):
                self.driver.click(button)

    def _save(self) -> None:
        self.driver.click("recording-save-confirm")
        self.wait(lambda: not self.driver.exists(SAVE_DIALOG), what="the save dialog to close")

    def _chip(self) -> Optional[str]:
        return self.driver.get_text(CHIP) if self.driver.exists(CHIP) else None

    def _automation(self, automation_id: str) -> dict[str, Any]:
        found = [a for a in self.driver.get_state("automations") or [] if a["id"] == automation_id]
        return found[0] if found else {}

    def _stored_text(self) -> str:
        return (self.config_dir / AUTOMATIONS_FILE).read_text(encoding="utf-8")

    # ── steps ────────────────────────────────────────────────────────────────
    def test_00_record_and_run(self):
        t = self.tag
        with self.step(
            "automation-recording.toolbar",
            "Record automation from the toolbar, stop on its chip, and run what was stored",
            expect="the toolbar with the Recording chip and a dot on the tab; then Save the "
            "recording: what was recorded, New automation or Add to an automation, a name; "
            "Discard recording and Save",
            screenshot=False,
        ):
            name = f"pr-rec-{t}"
            self.switch_to_connections_sidebar()
            self.create_local_connection(name)
            self.connect_connection(name)
            self.ids["tab"] = self.tab_id_of(name)
            self.wait_connected(self.ids["tab"])
            line = f"echo PR_REC_$((40+2))_{t}"
            self._start()
            self._press(f"{line}\r")
            problems = chip_problems(self._chip(), CHIP_HERE)
            badge = f"tab-recording-badge-{self.ids['tab']}"
            if not self.driver.exists(badge):
                problems.append("the recorded tab has no badge")
            self.shot(label="recording")
            self._stop()
            problems += chip_problems(self._chip(), None)
            summary = self.driver.get_text("recording-save-summary")
            offered = self.driver.get_value("recording-save-name")
            self.evidence(f"{summary!r}, name {offered!r}")
            problems += save_dialog_problems(summary, offered, len(line) + 1, line)
            self.shot(label="save")
            self.driver.type("recording-save-name", f"Recorded {t}")
            self._save()
            stored = self.wait(
                lambda: self.stored_automation(f"Recorded {t}"), what="the stored automation"
            )
            self.ids["recorded"] = stored["id"]
            problems += recorded_problems(stored, f"{line}\r")
            self.run_automation(stored["id"])
            self.wait(
                lambda: self.driver.read_terminal(self.ids["tab"]).count(f"PR_REC_42_{t}") >= 2,
                what="the recording to type the same again",
                timeout=60.0,
            )
            assert not problems, problems

    def test_10_kept_and_undone(self):
        with self.step(
            "automation-recording.kept",
            "A recording is kept when its dialog is closed, and a discarded one can be undone",
            expect="the bar above the terminal: the recording is not saved, with Discard "
            "recording and Save…; then the dialog again with the same keys",
            screenshot=False,
        ):
            self.require("automation-recording.toolbar")
            self._record("pwd\r")
            summary = self.driver.get_text("recording-save-summary")
            self.driver.press_key("Escape", "recording-save-name")
            self.wait(lambda: self.driver.exists(KEPT_BAR), what="the bar of the kept recording")
            self.shot(label="kept")
            problems = []
            # A second recording must not replace it.
            self.invoke_terminal_toolbar_action(RECORD)
            self.wait(lambda: self.driver.exists(SAVE_DIALOG), what="the dialog of the first one")
            if not self.driver.exists("recording-save-note"):
                problems.append("the dialog does not say why it came back")
            self.driver.click("recording-save-discard")
            self.wait(lambda: not self.driver.exists(SAVE_DIALOG), what="the dialog to close")
            self.wait(lambda: self.driver.exists(DISCARDED_TOAST), what="the Undo toast")
            self.shot(label="undo")
            self.driver.click(f"{DISCARDED_TOAST}-undo")
            self.wait(lambda: self.driver.exists(SAVE_DIALOG), what="the recording to come back")
            again = self.driver.get_text("recording-save-summary")
            if again != summary:
                problems.append(f"it came back as {again!r}, not {summary!r}")
            self._discard()
            assert not problems, problems

    def test_20_add_to_existing(self):
        t = self.tag
        with self.step(
            "automation-recording.append",
            "A recording is added to an existing automation as its last step",
            expect="Save recording with Add to an automation chosen and the automation picked",
            screenshot=False,
        ):
            self.require("automation-recording.kept")
            before = self._automation(self.ids["recorded"])
            self._record("true\r")
            self.driver.click("recording-save-to-existing")
            self.driver.select("recording-save-automation", self.ids["recorded"])
            self.shot(label="append")
            self._save()
            count = len(before["steps"]) + 1
            self.wait(
                lambda: len(self._automation(self.ids["recorded"])["steps"]) == count,
                what="the added step",
            )
            stored = self._automation(self.ids["recorded"])
            problems = recorded_problems(stored, "true\r", -1)
            if stored["steps"][:-1] != before["steps"]:
                problems.append("the steps it had changed")
            self.evidence(f"{len(stored['steps'])} steps, name {stored['name']!r} ({t})")
            assert not problems, problems

    def test_30_password_prompt(self):
        t = self.tag
        with self.step(
            "automation-recording.password",
            "What is typed at a password prompt is announced while recording and not stored",
            expect="the chip 'Recording: password prompt'; then Save recording naming the "
            "prompt, with 'Leave it out' chosen",
            screenshot=False,
        ):
            self.require("automation-recording.toolbar")
            tab, secret = self.ids["tab"], f"secret{t}"
            self.switch_to_tab(tab)
            self.run_command(
                "stty -echo; printf 'Password: '; IFS= read -r PW; stty echo; "
                'printf "\\nPR_LEN_%s\\n" "${#PW}"'
            )
            self.wait(
                lambda: self.driver.read_terminal(tab).rstrip().endswith("Password:"),
                what="the password prompt",
            )
            self._start()
            self._press(secret)
            problems = chip_problems(self._chip(), CHIP_AT_PROMPT)
            self.shot(label="prompt")
            self._press("\r")
            self.wait_for_output(f"PR_LEN_{len(secret)}", tab_id=tab)
            self._press("id\r")
            self._stop()
            note = self.driver.get_text("recording-save-secrets")
            self.evidence(f"note {note!r}")
            self.shot(label="save")
            if "Password:" not in note or secret in note:
                problems.append(f"the dialog says {note!r}")
            self.driver.type("recording-save-name", f"Prompt {t}")
            self._save()
            stored = self.wait(
                lambda: self.stored_automation(f"Prompt {t}"), what="the stored automation"
            )
            problems += recorded_problems(stored, "id\r")
            problems += secret_problems(self._stored_text(), secret)
            assert not problems, problems

    def test_40_editor(self):
        t = self.tag
        with self.step(
            "automation-recording.editor",
            "Record steps in the editor records in a terminal and comes back with the draft",
            expect="the terminal with a bar 'Recording into …' and Stop and return; then the "
            "Edit automation dialog with the recording as its last step",
            screenshot=False,
        ):
            self.require("automation-recording.toolbar")
            tab = self.ids["tab"]
            self.edit_automation(self.ids["recorded"])
            count = self.step_count()
            self.driver.type("automation-editor-name", f"Draft {t}")
            self.driver.click("automation-editor-record")
            item = f"automation-editor-record-in-{tab}"
            if self.driver.get_state("recording") is None:
                self.wait(lambda: self.driver.exists(item), what="the terminals to record in")
                self.driver.click(item)
            self.wait(lambda: self.driver.exists(EDITOR_BAR), what="the way back to the editor")
            problems = [] if not self.editor_open() else ["the editor covers the terminal"]
            self._press("date\r")
            self.evidence(f"bar {self.driver.get_text(EDITOR_BAR)!r}")
            self.shot(label="bar")
            self.driver.click("recording-bar-return")
            self.wait(self.editor_open, what="the editor to come back")
            self.driver.scroll_into_view(f"automation-editor-step-{count}")
            self.shot(label="returned")
            if self.driver.get_value("automation-editor-name") != f"Draft {t}":
                problems.append("the draft's name was lost")
            if self.step_count() != count + 1 or self.step_kind(count) != "type-keys":
                problems.append("the recording is not the last step")
            self.save_editor()
            stored = self.wait(
                lambda: self.stored_automation(f"Draft {t}"), what="the saved draft"
            )
            problems += recorded_problems(stored, "date\r", -1)
            assert not problems, problems

    def test_50_closed_terminal(self):
        with self.step(
            "automation-recording.closed-terminal",
            "Closing the recorded terminal stops the recording and keeps what was typed",
            expect="Save recording with a note that the terminal was closed",
            screenshot=False,
        ):
            self.require("automation-recording.toolbar")
            self.switch_to_tab(self.ids["tab"])
            self.ensure_terminal_in_active_panel()
            before = set(self.tab_ids())
            self.open_new_terminal()
            tab = self.wait(
                lambda: next(iter(set(self.tab_ids()) - before), None), what="a second terminal"
            )
            self.wait_connected(tab)
            self.switch_to_tab(tab)
            self.invoke_terminal_toolbar_action(RECORD)
            self.wait(lambda: self.driver.exists(CHIP), what="the Recording chip")
            self._press("ls", tab)
            self.close_tab(tab)
            self.wait(lambda: self.driver.exists(SAVE_DIALOG), what="the save dialog")
            note = self.driver.get_text("recording-save-note")
            summary = self.driver.get_text("recording-save-summary")
            self.evidence(f"{note!r} {summary!r}")
            self.shot(label="closed")
            self._discard()
            assert "closed" in note, note
            assert "Recorded 2 keys" in summary, summary

    def test_60_narrow(self):
        with self.step(
            "automation-recording.narrow",
            "At 800x600 the save dialog fits, with its description and tags open",
            expect="the 800x600 Save recording dialog with Description and Tags; nothing "
            "cut off, Discard recording and Save in view",
            screenshot=False,
        ):
            self.require("automation-recording.toolbar")
            self.driver.resize_window(*NARROW_WINDOW)
            try:
                self._record("ls\r")
                self.driver.click("recording-save-details")
                self.wait(lambda: self.driver.exists("recording-save-tags"), what="the tags field")
                dialog = self.driver.measure_element(SAVE_DIALOG)["rect"]
                buttons = [self.driver.measure_element(b)["rect"] for b in SAVE_BUTTONS]
                self.evidence(f"dialog {dialog}; buttons {buttons}")
                self.shot(label="save")
                problems = save_layout_problems(NARROW_WINDOW, dialog, buttons)
                assert not problems, problems
            finally:
                self._discard()
                self.driver.resize_window(*NORMAL_WINDOW)

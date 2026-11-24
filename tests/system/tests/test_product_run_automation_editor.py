"""Product run: one editor for every automation (#5818, slice 7).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``).

Steps: a typed automation opens on a name and its keys, shows no trigger, value
or failure option unasked, and Enter in the keys adds an Enter key instead of
saving; Save and run types into the active terminal; a Type keys step's speed is
saved and used by the row and by a run from another automation (#5820); opening
and saving an unchanged automation leaves ``automations.json`` byte for byte;
steps are moved with the arrow keys, deleted and brought back; a Type keys step
with Ctrl+C plus a trigger is saved; "On a schedule…" opens the schedule editor
over this one and the saved schedule is linked; a dirty editor asks before it
closes; everything fits 800x600.

The ``test_grade_*`` functions grade fixed readings without an app and run in
the normal lane.
"""

from __future__ import annotations

import sys
import time
from typing import Any

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
from termihub_harness.product_run.automation_editor_grades import (
    ON_REQUEST,
    disclosure_problems,
    footer_problems,
    layout_problems,
    speed_problems,
    stored_keys_problems,
    trigger_problems,
    untouched_problems,
)
from termihub_harness.product_run.automation_steps import SCHEDULE_EDITOR, AutomationPhaseUi
from termihub_harness.product_run.automation_store import AUTOMATIONS_FILE, fingerprint
from termihub_harness.product_run.ssh_steps import SshPhaseUi
from termihub_harness.ui.automation_sidebar import EDITOR

#: The minimum supported window, and the product run's normal one.
NARROW_WINDOW = (800, 600)
NORMAL_WINDOW = (1280, 800)
#: The delay before the second key row of the speed check, in milliseconds.
SLOW_MS = 4000


# ── app-free grade tests ──────────────────────────────────────────────────
def _box(x: float, y: float, width: float, height: float) -> dict[str, float]:
    return {"x": x, "y": y, "width": width, "height": height}


DIALOG = _box(80, 30, 640, 540)
SAVE = _box(620, 530, 70, 28)


def _automation(**over: Any) -> dict[str, Any]:
    return {
        "id": "a1",
        "steps": [
            {"kind": "type-keys", "chunks": [{"data": "ls\r", "delayMs": 0}], "timing": "instant"}
        ],
        "triggers": [],
        **over,
    }


def test_grade_plain_keys_pass():
    assert disclosure_problems([], "Type keys ls⏎ 2 keys, recorded", recorded=True) == []
    assert disclosure_problems([], "Type keys ls⏎", recorded=False) == []


def test_grade_unasked_options_fail():
    problems = disclosure_problems(["automation-editor-when"], "Type keys ls", recorded=True)
    assert problems == [
        "automation-editor-when shows unasked",
        "the keys row does not say 'recorded': 'Type keys ls'",
    ]


def test_grade_footer():
    assert footer_problems(["Cancel", "Save", "Save and run"], is_new=True) == []
    assert footer_problems(["Cancel", "Save and run", "Save"], is_new=False) == []
    assert footer_problems(["Cancel", "Save and run", "Save"], is_new=True) != []
    assert footer_problems(["Cancel", "Save"], is_new=False) != []


def test_grade_layout_passes():
    rows = [_box(100, 180 + 40 * i, 600, 36) for i in range(5)]
    assert layout_problems((800, 600), DIALOG, rows, SAVE) == []


def test_grade_layout_fails():
    tall = _box(80, -20, 640, 700)
    rows = [_box(100, 180, 600, 310), _box(100, 500, 600, 60)]
    problems = layout_problems((800, 600), tall, rows, SAVE)
    assert any("does not fit" in p for p in problems)
    assert "step 0 is 310px tall" in problems
    assert "step 1 is below the fold" in problems
    assert layout_problems((800, 600), DIALOG, [], SAVE) == ["no step rows"]
    wide = _box(-10, 30, 820, 500)
    assert any("wider" in p for p in layout_problems((800, 600), wide, rows[:1], SAVE))


def test_grade_stored_keys():
    assert stored_keys_problems(_automation(), ["ls\r"], "instant") == []
    assert stored_keys_problems(_automation(), ["ls"], "recorded") == [
        "it types ['ls\\r'], not ['ls']",
        "its speed is 'instant', not 'recorded'",
    ]
    assert stored_keys_problems(None, ["ls"], "recorded") != []
    assert stored_keys_problems(_automation(), ["ls"], "recorded", step=1) != []


def test_grade_triggers():
    hotkey = {"kind": "hotkey", "binding": "F8"}
    assert trigger_problems(_automation(triggers=[hotkey]), ["hotkey"]) == []
    assert trigger_problems(_automation(triggers=[{"kind": "manual"}]), []) != []


def test_grade_untouched_file():
    assert untouched_problems("a", "a") == []
    assert untouched_problems("a", "b") == [
        "saving an unchanged automation rewrote automations.json"
    ]
    assert untouched_problems(None, None) != []


def test_grade_speed():
    assert speed_problems(1.0, 4000) == []
    assert speed_problems(4.2, 4000) != []


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="uses POSIX shell quoting")
class TestProductRunAutomationEditor(
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
    phase = "Automation editor"
    request_timeout = 60.0

    tag = unique_name("pr").split("-")[-1]
    ids: dict[str, str] = {}

    def reset_before_rerun(self) -> None:
        self.dismiss_modals(EDITOR, SCHEDULE_EDITOR)
        self.driver.resize_window(*NORMAL_WINDOW)

    # ── reads ────────────────────────────────────────────────────────────────
    def _automation(self, automation_id: str) -> dict[str, Any]:
        found = [a for a in self.driver.get_state("automations") or [] if a["id"] == automation_id]
        return found[0] if found else {}

    def _footer(self) -> list[str]:
        items = self.driver.measure_element(EDITOR, "buttons").get("items", [])
        return [i["text"].strip() for i in items if i.get("visible")]

    def _store_bytes(self) -> Any:
        return fingerprint(self.config_dir, (AUTOMATIONS_FILE,))[AUTOMATIONS_FILE]

    def _rows(self) -> list[dict[str, float]]:
        return [
            self.driver.measure_element(f"automation-editor-step-{i}")["rect"]
            for i in range(self.step_count())
        ]

    def _close_editor(self) -> None:
        self.dismiss_modals(EDITOR)

    # ── steps ────────────────────────────────────────────────────────────────
    def test_00_typed_keys(self):
        t = self.tag
        with self.step(
            "automation-editor.keys",
            "A new typed automation asks for a name and keys only; Enter adds an Enter key, and "
            "Save and run types into the terminal",
            expect="the New automation dialog: Name, Description, one Type keys step with its "
            "row of keys and a Typing speed; closed 'When it runs' and 'Tags'; footer Cancel, "
            "Save, Save and run",
            screenshot=False,
        ):
            name = f"pr-editor-{t}"
            self.switch_to_connections_sidebar()
            self.create_local_connection(name)
            self.ids["conn"] = self.require_stable_connection(name)["id"]
            self.connect_connection(name)
            self.ids["tab"] = self.tab_id_of(name)
            self.wait_connected(self.ids["tab"])

            self.open_new_keystrokes()
            shown = [i for i in ON_REQUEST if self.driver.exists(i)]
            row = self.driver.get_text("automation-editor-step-0")
            footer = self._footer()
            self.evidence(f"shown {shown}; row {row!r}; footer {footer}")
            problems = disclosure_problems(shown, row, recorded=False)
            problems += footer_problems(footer, is_new=True)
            self.driver.type("automation-editor-name", f"Typed {t}")
            self.driver.type("automation-editor-keys-text-0-0", f"echo PR_EDIT_$((40+2))_{t}")
            self.driver.press_key("Enter", "automation-editor-keys-text-0-0")
            typed = self.driver.get_value("automation-editor-keys-text-0-0")
            self.evidence(f"keys after Enter: {typed!r}")
            self.shot(label="keys")
            if not typed.endswith("\\r"):
                problems.append(f"Enter in the keys gave {typed!r}")
            if not self.editor_open():
                problems.append("Enter in the keys closed the editor")
            self.driver.click("automation-editor-save-run")
            self.wait(lambda: not self.editor_open(), what="the editor to close")
            self.wait_for_output(f"PR_EDIT_42_{t}", tab_id=self.ids["tab"], timeout=30.0)
            stored = self.wait(
                lambda: self.stored_automation(f"Typed {t}"), what="the saved automation"
            )
            self.ids["typed"] = stored["id"]
            problems += stored_keys_problems(stored, [f"echo PR_EDIT_$((40+2))_{t}\r"], "recorded")
            assert not problems, problems

    def test_10_unchanged_save(self):
        with self.step(
            "automation-editor.untouched",
            "Opening and saving an unchanged automation does not rewrite its file",
            expect="the Edit automation dialog: the keys as one line; footer Cancel, Save and "
            "run, Save",
            screenshot=False,
        ):
            self.require("automation-editor.keys")
            before = self._store_bytes()
            self.edit_automation(self.ids["typed"])
            shown = [i for i in ON_REQUEST if self.driver.exists(i)]
            row = self.driver.get_text("automation-editor-step-0")
            problems = disclosure_problems(shown, row, recorded=False)
            problems += footer_problems(self._footer(), is_new=False)
            self.shot(label="stored")
            self.save_editor()
            time.sleep(1.0)  # a rewrite would land within this
            problems += untouched_problems(before, self._store_bytes())
            assert not problems, problems

    def test_20_typing_speed(self):
        t = self.tag
        with self.step(
            "automation-editor.speed",
            "A Type keys step's speed is saved and used by every start (#5820)",
            expect="the Type keys step with Typing speed 'Instant' and no delay fields",
            screenshot=False,
        ):
            self.require("automation-editor.keys")
            tab = self.ids["tab"]
            self.edit_automation(self.ids["typed"])
            self.fill_keystrokes([f"echo PR_FAST_{t}", "\\r"])
            self.driver.type("automation-editor-keys-delay-0-1", str(SLOW_MS))
            self.set_typing_speed("instant")
            self.wait(
                lambda: not self.driver.exists("automation-editor-keys-delay-0-1"),
                what="the delays that no longer count to go",
            )
            self.shot(label="speed")
            self.save_editor()
            problems = stored_keys_problems(
                self._automation(self.ids["typed"]), [f"echo PR_FAST_{t}", "\r"], "instant"
            )
            self.switch_to_tab(tab)
            started = time.monotonic()
            self.run_automation(self.ids["typed"])
            self.wait(
                lambda: self.driver.read_terminal(tab).count(f"PR_FAST_{t}") >= 2,
                what="the typed echo and its output",
                timeout=30.0,
            )
            took = time.monotonic() - started
            self.evidence(f"row run took {took:.1f}s for delays of {SLOW_MS} ms")
            problems += speed_problems(took, SLOW_MS)
            assert not problems, problems

    def test_30_steps(self):
        t = self.tag
        with self.step(
            "automation-editor.steps",
            "Steps are added from the grouped menu, moved with the arrow keys, deleted and "
            "brought back",
            expect="the New automation dialog with the Add step menu open: Type keys, Run "
            "command, Wait, Wait for output, then More: Condition, Loop, Run script, Run "
            "automation",
            screenshot=False,
        ):
            self.require("automation-editor.keys")
            self.open_new_workflow()
            self.driver.click("automation-editor-add-step")
            self.wait(
                lambda: self.driver.exists("automation-editor-add-step-wait"),
                what="the Add step menu",
            )
            self.shot(label="add-step")
            self.driver.press_key("Escape", "automation-editor-add-step-wait")
            for kind in ("send-command", "wait", "type-keys"):
                self.add_step(kind)
            self.set_command(0, f"echo PR_STEP_{t}")
            self.fill_keystrokes(["\\x03"], step=2)
            self.move_step_with_key(2, "ArrowUp")
            self.wait(lambda: self.step_kind(1) == "type-keys", what="the step to move up")
            self.delete_step(2)
            self.shot(label="deleted")
            self.driver.click("automation-editor-step-undo")
            self.wait(lambda: self.step_count() == 3, what="the deleted step to come back")
            order = [self.step_kind(i) for i in range(3)]
            self.evidence(f"steps {order}")
            assert order == ["send-command", "type-keys", "wait"], order

    def test_40_trigger(self):
        t = self.tag
        with self.step(
            "automation-editor.trigger",
            "A trigger shows its settings under itself; Ctrl+C and the trigger are stored",
            expect="the open 'When it runs' section: 'When you run it …', the Armed switch and "
            "an On output match card with its connections and pattern",
            screenshot=False,
        ):
            self.require("automation-editor.steps")
            self.set_output_match_trigger(self.ids["conn"], f"PR_EDIT_NEVER_{t}")
            self.driver.scroll_into_view("automation-editor-trigger-0")
            self.shot(label="trigger")
            armed = self.driver.get_attribute("automation-editor-armed", "aria-checked")
            self.set_name(f"Steps {t}")
            self.save_editor()
            stored = self.wait(
                lambda: self.stored_automation(f"Steps {t}"), what="the saved automation"
            )
            self.ids["steps"] = stored["id"]
            self.evidence(f"stored {stored}")
            problems = stored_keys_problems(stored, ["\x03"], "recorded", step=1)
            problems += trigger_problems(stored, ["on-output-match"])
            if armed != "true":
                problems.append(f"the Armed switch reads {armed!r}")
            assert not problems, problems

    def test_50_schedule_link(self):
        t = self.tag
        with self.step(
            "automation-editor.schedule",
            "On a schedule… opens the schedule editor over this one, and the schedule is linked",
            expect="the Edit automation dialog behind it, then its 'When it runs' section with "
            "the schedule, its rule and its target, and Edit…",
            screenshot=False,
        ):
            self.require("automation-editor.trigger")
            self.edit_automation(self.ids["steps"])
            self.open_editor_section("when")
            self.driver.click("automation-editor-add-trigger")
            self.wait(
                lambda: self.driver.exists("automation-editor-add-schedule"),
                what="On a schedule…",
            )
            self.driver.click("automation-editor-add-schedule")
            self.wait(lambda: self.driver.exists(SCHEDULE_EDITOR), what="the schedule editor")
            self.shot(label="schedule-editor")
            self.driver.type("schedule-editor-name", f"Editor schedule {t}")
            box = f"schedule-editor-connection-{self.ids['conn']}"
            self.wait(lambda: self.driver.exists(box), what="the target connection checkbox")
            self.driver.click(box)
            self.wait(lambda: not self.is_blocked("schedule-editor-save"), what="Save to enable")
            self.driver.click("schedule-editor-save")
            self.wait(lambda: not self.driver.exists(SCHEDULE_EDITOR), what="it to close")
            schedule = self.wait(
                lambda: next(
                    (
                        s
                        for s in self.driver.get_state("schedules") or []
                        if s.get("name") == f"Editor schedule {t}"
                    ),
                    None,
                ),
                what="the saved schedule",
            )
            link = f"automation-editor-schedule-{schedule['id']}"
            self.wait(lambda: self.driver.exists(link), what="the linked schedule")
            self.driver.scroll_into_view(link)
            text = self.driver.get_text(link)
            self.evidence(f"linked {text!r}")
            self.shot(label="linked")
            assert self.editor_open(), "saving the schedule closed the automation editor"
            assert f"Editor schedule {t}" in text, text
            self.cancel_clean_editor()

    def test_60_unsaved_guard(self):
        with self.step(
            "automation-editor.unsaved",
            "An edited automation asks before it is closed; Discard keeps the stored one",
            expect="the unsaved-changes prompt over the Edit automation dialog",
            screenshot=False,
        ):
            self.require("automation-editor.keys")
            before = self._store_bytes()
            self.edit_automation(self.ids["typed"])
            self.expand_step(0)
            self.driver.type("automation-editor-keys-text-0-0", "\\q")
            self.driver.click("automation-editor-cancel")
            self.wait(self.unsaved_prompt_open, what="the unsaved-changes prompt")
            self.shot(label="prompt")
            self.driver.click("unsaved-changes-cancel")
            self.wait(lambda: not self.unsaved_prompt_open(), what="the prompt to close")
            self.driver.click("automation-editor-save")
            self.wait(
                lambda: self.driver.exists("automation-editor-keys-error-0-0"),
                what="why the keys cannot be saved",
            )
            self.evidence(self.driver.get_text("automation-editor-keys-error-0-0"))
            self.cancel_dirty_editor()
            assert not untouched_problems(before, self._store_bytes())

    def test_70_narrow(self):
        with self.step(
            "automation-editor.narrow",
            "At 800x600 the editor fits, with every step in view",
            expect="the 800x600 Edit automation dialog: Name beside Description, three one-line "
            "steps, the three closed sections under them and the footer; nothing cut off",
            screenshot=False,
        ):
            self.require("automation-editor.trigger")
            self.driver.resize_window(*NARROW_WINDOW)
            try:
                self.edit_automation(self.ids["steps"])
                rows = self._rows()
                dialog = self.driver.measure_element(EDITOR)["rect"]
                save = self.driver.measure_element("automation-editor-save")["rect"]
                self.evidence(f"dialog {dialog}; rows {rows}; Save {save}")
                self.shot(label="steps")
                problems = layout_problems(NARROW_WINDOW, dialog, rows, save)
                self.expand_step(1)
                self.driver.scroll_into_view("automation-editor-step-speed-1")
                self.shot(label="keys")
                box = self.driver.measure_element("automation-editor-form")
                if box["scrollWidth"] > box["clientWidth"] + 1:
                    problems.append("the opened Type keys step is wider than the dialog")
                self.cancel_clean_editor()
                assert not problems, problems
            finally:
                self._close_editor()
                self.driver.resize_window(*NORMAL_WINDOW)

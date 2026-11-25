"""End-to-end coverage for step-by-step automations (#1851, #5818).

Drives the real app over the bridge through the whole authoring + run journey:
show the Automations sidebar, author a workflow in the editor (add every
step kind through the "Add step" menu, edit a field, reorder, remove), confirm
that a new one only runs by hand, save it, then run a `send-command` workflow against a live
local-shell session and assert the command actually reaches the terminal.

The "Add step" menu is the #1868 regression surface — a Radix menu that
rendered in the DOM but was dead in the real app while jsdom unit tests passed.
:meth:`WorkflowUi.add_step` asserts the step count actually changes, so a menu
item that renders-but-does-nothing fails here. The run-automation step's
picker is the same kind of portalled listbox inside the modal;
:meth:`WorkflowUi.pick_automation` clicks an option in the real webview (#4012).

Automations need no experimental switch (#5818); only the "Run local process"
step does.
"""

import pytest

from termihub_harness import (
    SettingsUi,
    SidebarUi,
    SystemTest,
    TerminalUi,
    WorkflowUi,
    unique_name,
)

pytestmark = pytest.mark.integration

STEP_KINDS = [
    "type-keys",
    "send-command",
    "wait",
    "wait-for-output",
    "wait-for-user",
    "conditional",
    "loop",
    "run-script",
    "run-automation",
    "run-local-process",
]

#: The editor dialog a failed attempt can leave open (#4834).
WORKFLOW_MODALS = ("automation-editor-dialog",)


class TestWorkflowEditor(WorkflowUi, SettingsUi, SidebarUi, SystemTest):
    """Author a workflow through the sidebar + editor dialog."""

    def reset_before_rerun(self) -> None:
        # A failed attempt can leave the editor dialog open (or its Add-step menu,
        # or the unsaved prompt over it); the rerun's open_new_workflow would then
        # click New behind it (#4834).
        self.dismiss_modals(*WORKFLOW_MODALS)

    def test_panel_opens(self):
        # Graduated with the Automations merge (#5818): no experimental switch.
        self.show_automations()
        assert self.driver.exists("automation-sidebar")
        assert self.driver.get_state("sidebarView") == "automations"

    def test_new_workflow_opens_empty_editor(self):
        self.open_new_workflow()
        assert self.editor_open()
        assert self.step_count() == 0
        # A workflow with no steps cannot be saved.
        assert self.driver.exists("automation-editor-no-steps")
        assert self.save_disabled()
        # Nothing was edited, so Cancel closes without the unsaved prompt.
        self.cancel_clean_editor()

    def test_add_step_menu_adds_every_kind(self):
        # The #1868 surface: each kind must be genuinely clickable in the real
        # app, not merely present. add_step asserts the count actually grows.
        # "Run local process" is the one kind still behind the switch (#5818).
        self.enable_experimental_features()
        self.open_new_workflow()
        for index, kind in enumerate(STEP_KINDS):
            self.add_step(kind)
            assert self.step_kind(index) == kind
            # The row shows a readable sentence-case label, not the raw id (#5529).
            label = self.step_label(index)
            assert label[:1].isupper() and "-" not in label, label
        assert self.step_count() == len(STEP_KINDS)

        # The added steps make the editor dirty, so Cancel raises the shared
        # unsaved-changes prompt instead of closing (#4314). "Keep editing"
        # returns to the editor with every step intact...
        self.driver.click("automation-editor-cancel")
        self.wait(self.unsaved_prompt_open, what="the unsaved-changes prompt")
        assert self.editor_open()
        self.driver.click("unsaved-changes-cancel")
        self.wait(lambda: not self.unsaved_prompt_open(), what="the prompt to close")
        assert self.editor_open()
        assert self.step_count() == len(STEP_KINDS)

        # ...and Discard closes it without saving.
        self.cancel_dirty_editor()

    def test_edit_reorder_remove_and_save(self):
        name = unique_name("wf-edit")
        self.open_new_workflow()

        # Two steps: a send-command then a wait.
        self.add_step("send-command")
        self.add_step("wait")
        self.set_command(0, "echo authored")
        assert self.driver.get_value("automation-editor-step-command-0") == "echo authored"

        # Reorder: move the send-command down so the wait leads.
        self.move_step_down(0)
        self.wait(
            lambda: self.step_kind(0) == "wait" and self.step_kind(1) == "send-command",
            what="the steps to swap order",
        )

        # Remove the (now second) send-command step.
        self.delete_step(1)
        assert self.step_count() == 1
        assert self.step_kind(0) == "wait"

        # Nothing but the user starts it until a trigger is added.
        assert self.trigger_kinds() == []

        self.set_name(name)
        assert not self.save_disabled()
        self.save_workflow()

        saved = self.find_workflow(name)
        assert saved is not None
        assert len(saved["steps"]) == 1
        assert self.driver.exists(f"automation-item-{saved['id']}")


class TestWorkflowRun(WorkflowUi, TerminalUi, SettingsUi, SidebarUi, SystemTest):
    """Run a stored send-command workflow against a live local shell."""

    def reset_before_rerun(self) -> None:
        # Same leftover as TestWorkflowEditor: an editor dialog a failed authoring
        # step left open would sit over the rerun's New click (#4834).
        self.dismiss_modals(*WORKFLOW_MODALS)

    def test_send_command_reaches_terminal(self):
        name = unique_name("wf-run")
        marker = unique_name("WF_MARK").replace("-", "_")

        self.open_new_workflow()
        self.add_step("send-command")
        self.set_command(0, f"echo {marker}")
        self.set_name(name)
        self.save_workflow()
        workflow_id = self.workflow_id(name)

        # Stand up a local-shell terminal; it becomes the active run target.
        self.ensure_terminal()
        self.run_workflow(workflow_id)

        assert marker in self.wait_for_output(marker)

    def test_run_script_sends_each_line(self):
        # A run-script step streams each non-empty line as its own command
        # through the same terminal choke point — assert both lines land.
        name = unique_name("wf-script")
        first = unique_name("WF_A").replace("-", "_")
        second = unique_name("WF_B").replace("-", "_")

        self.open_new_workflow()
        self.add_step("run-script")
        self.set_script(0, f"echo {first}\necho {second}")
        self.set_name(name)
        self.save_workflow()
        workflow_id = self.workflow_id(name)

        self.ensure_terminal()
        self.run_workflow(workflow_id)

        assert first in self.wait_for_output(first)
        assert second in self.wait_for_output(second)

    def test_run_macro_step_picks_a_macro_and_plays_it(self):
        # #1868 / #4012: the automation picker inside the editor modal must be
        # clickable in the real webview — pick an automation, save, and run it.
        macro_name = unique_name("wf-macro")
        marker = unique_name("WF_MACRO").replace("-", "_")
        self.ensure_terminal()
        macro_id = self._create_macro(macro_name, f"echo {marker}\\r")

        name = unique_name("wf-pick")
        self.open_new_workflow()
        self.add_step("run-automation")
        self.pick_automation(0, macro_id, macro_name)
        # Picking from the listbox must not dismiss the editor modal.
        assert self.editor_open()
        self.set_name(name)
        self.wait(lambda: not self.save_disabled(), what="Save to enable")
        self.save_workflow()

        saved = self.wait(lambda: self.find_workflow(name), what=f"the saved workflow {name!r}")
        assert len(saved["steps"]) == 1
        assert saved["steps"][0]["kind"] == "run-macro"
        assert saved["steps"][0]["macroId"] == macro_id

        self.run_workflow(saved["id"])
        assert marker in self.wait_for_output(marker)

    def _create_macro(self, name: str, step_text: str) -> str:
        """Write a one-step automation in the Automations sidebar; return its id."""
        return self.create_typed_automation(name, [step_text])

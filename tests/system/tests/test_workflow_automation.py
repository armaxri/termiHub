"""End-to-end coverage for the Workflow Automation feature (#1851).

Drives the real app over the bridge through the whole authoring + run journey:
reveal the Workflows panel, author a workflow in the editor dialog (add every
step kind through the "Add step…" menu, edit a field, reorder, remove), confirm
the manual trigger, save it, then run a `send-command` workflow against a live
local-shell session and assert the command actually reaches the terminal.

The "Add step…" menu is the #1868 regression surface — a Radix menu that
rendered in the DOM but was dead in the real app while jsdom unit tests passed.
:meth:`WorkflowUi.add_step` asserts the step count actually changes, so a menu
item that renders-but-does-nothing fails here. The run-macro step's Macro
select is the same kind of portalled listbox inside the modal;
:meth:`WorkflowUi.pick_macro` clicks an option in the real webview (#4012).

The Workflows activity-bar item is experimental-gated (re-gated as experimental
on develop), so every suite enables experimental features before opening it.
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

STEP_KINDS = ["send-command", "run-script", "run-macro", "wait", "run-local-process"]


class TestWorkflowEditor(WorkflowUi, SettingsUi, SidebarUi, SystemTest):
    """Author a workflow through the sidebar + editor dialog."""

    def test_panel_opens(self):
        # The Workflows panel is experimental-gated, so reveal it first, then
        # open it from the activity bar.
        self.enable_experimental_features()
        self.open_workflows_sidebar()
        assert self.driver.exists("workflow-sidebar")
        assert self.driver.get_state("sidebarView") == "workflows"

    def test_new_workflow_opens_empty_editor(self):
        self.open_workflows_sidebar()
        self.open_new_workflow()
        assert self.editor_open()
        assert self.step_count() == 0
        # A workflow with no steps cannot be saved.
        assert self.driver.exists("workflow-editor-no-steps")
        assert self.save_disabled()
        # Nothing was edited, so Cancel closes without the unsaved prompt.
        self.cancel_clean_editor()

    def test_add_step_menu_adds_every_kind(self):
        # The #1868 surface: each kind must be genuinely clickable in the real
        # app, not merely present. add_step asserts the count actually grows.
        self.open_new_workflow()
        for index, kind in enumerate(STEP_KINDS):
            self.add_step(kind)
            assert self.step_kind(index) == kind
        assert self.step_count() == len(STEP_KINDS)

        # The added steps make the editor dirty, so Cancel raises the shared
        # unsaved-changes prompt instead of closing (#4314). "Keep editing"
        # returns to the editor with every step intact...
        self.driver.click("workflow-editor-cancel")
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
        assert self.driver.get_value("workflow-editor-step-command-0") == "echo authored"

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

        # Manual trigger is on by default.
        assert self.trigger_active("manual")

        self.set_name(name)
        assert not self.save_disabled()
        self.save_workflow()

        saved = self.find_workflow(name)
        assert saved is not None
        assert len(saved["steps"]) == 1
        assert self.driver.exists(f"workflow-item-{saved['id']}")


class TestWorkflowRun(WorkflowUi, TerminalUi, SettingsUi, SidebarUi, SystemTest):
    """Run a stored send-command workflow against a live local shell."""

    def test_send_command_reaches_terminal(self):
        name = unique_name("wf-run")
        marker = unique_name("WF_MARK").replace("-", "_")

        # The Workflows panel is experimental-gated — reveal it first.
        self.enable_experimental_features()
        self.open_workflows_sidebar()
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

        self.open_workflows_sidebar()
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
        # #1868 / #4012: the Macro select inside the editor modal must be
        # clickable in the real webview — pick a macro, save, and run it.
        macro_name = unique_name("wf-macro")
        marker = unique_name("WF_MACRO").replace("-", "_")
        self.ensure_terminal()
        macro_id = self._create_macro(macro_name, f"echo {marker}\\r")

        name = unique_name("wf-pick")
        self.enable_experimental_features()
        self.open_workflows_sidebar()
        self.open_new_workflow()
        self.add_step("run-macro")
        self.pick_macro(0, macro_id, macro_name)
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
        """Author a one-step macro in the Macros sidebar; return its id."""
        self._ensure_sidebar("macros", "activity-bar-macros")
        self.wait(lambda: self.driver.exists("macro-sidebar"), what="the Macros sidebar")
        self.driver.click("macro-new-btn")
        self.wait(lambda: self.driver.exists("macro-editor-dialog"), what="the macro editor")
        self.driver.type("macro-editor-name", name)
        # A new macro opens pre-seeded with one empty step; only add one if the
        # form ever starts empty, or a blank second step keeps Save disabled
        # (the same harness bug test_history_restart hit, #4017).
        self.wait(
            lambda: self.driver.exists("macro-editor-step-data-0")
            or self.driver.exists("macro-editor-no-steps"),
            what="the macro editor's steps",
        )
        if not self.driver.exists("macro-editor-step-data-0"):
            self.driver.click("macro-editor-add-step")
        self.wait(
            lambda: self.driver.exists("macro-editor-step-data-0"), what="the first macro step"
        )
        assert not self.driver.exists("macro-editor-step-data-1"), "expected a single step"
        self.driver.type("macro-editor-step-data-0", step_text)
        self.wait(lambda: not self.is_disabled("macro-editor-save"), what="Save to enable")
        self.driver.click("macro-editor-save")
        self.wait(
            lambda: not self.driver.exists("macro-editor-dialog"), what="the macro editor to close"
        )
        macro = self.wait(
            lambda: next(
                (m for m in self.driver.get_state("macros") or [] if m.get("name") == name),
                None,
            ),
            what=f"the saved macro {name!r}",
        )
        return macro["id"]

"""End-to-end coverage for the Workflow Automation feature (#1851).

Drives the real app over the bridge through the whole authoring + run journey:
reveal the Workflows panel, author a workflow in the editor dialog (add every
step kind through the "Add step…" menu, edit a field, reorder, remove), confirm
the manual trigger, save it, then run a `send-command` workflow against a live
local-shell session and assert the command actually reaches the terminal.

The "Add step…" menu is the #1868 regression surface — a Radix menu that
rendered in the DOM but was dead in the real app while jsdom unit tests passed.
:meth:`WorkflowUi.add_step` asserts the step count actually changes, so a menu
item that renders-but-does-nothing fails here.

Note: the Workflows activity-bar item is *not* experimental-gated in the current
code (unlike Tunnels/Services). The panel-opens test still enables experimental
features first, both to exercise the journey the concept describes and so the
suite keeps passing if gating is later added.
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
        # Enable experimental features first (the journey the concept describes),
        # then open the Workflows panel from the activity bar.
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
        self.driver.click("workflow-editor-cancel")
        self.wait(lambda: not self.editor_open(), what="the editor to close")

    def test_add_step_menu_adds_every_kind(self):
        # The #1868 surface: each kind must be genuinely clickable in the real
        # app, not merely present. add_step asserts the count actually grows.
        self.open_new_workflow()
        for index, kind in enumerate(STEP_KINDS):
            self.add_step(kind)
            assert self.step_kind(index) == kind
        assert self.step_count() == len(STEP_KINDS)
        self.driver.click("workflow-editor-cancel")
        self.wait(lambda: not self.editor_open(), what="the editor to close")

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


class TestWorkflowRun(WorkflowUi, TerminalUi, SystemTest):
    """Run a stored send-command workflow against a live local shell."""

    def test_send_command_reaches_terminal(self):
        name = unique_name("wf-run")
        marker = unique_name("WF_MARK").replace("-", "_")

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

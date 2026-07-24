"""Workflow-automation editor + sidebar helpers (#1851 E2E coverage).

``WorkflowUi`` drives the experimental Workflow Automation feature over the
bridge: open the Workflows sidebar, author a workflow in the editor dialog (add
typed steps through the "Add step…" menu, edit fields, reorder, remove), bind a
trigger, save it, and run a stored workflow against the active terminal.

The "Add step…" menu is the regression surface from #1868 (a Radix menu that
looked present in the DOM but was dead in the real app). Every add here asserts
the **step count actually changed**, so a menu item that renders but is not
wired fails the test — which a jsdom unit test would miss.

Suites mix this in alongside :class:`~termihub_harness.TerminalUi` (to stand up
a run target) and :class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

from typing import Any, Optional

from ..bridge import BridgeError
from .base import HarnessMixin

WORKFLOW_SIDEBAR = "workflow-sidebar"
WORKFLOW_EDITOR_DIALOG = "workflow-editor-dialog"


class WorkflowUi(HarnessMixin):
    """Author, save and run workflows through the sidebar + editor dialog."""

    # ── Sidebar ─────────────────────────────────────────────────────────────
    def open_workflows_sidebar(self) -> None:
        """Show the Workflows sidebar from the activity bar (idempotent).

        Clicking an already-active activity-bar icon toggles the sidebar closed,
        so only click when Workflows isn't already the visible view.
        """
        try:
            showing = self.driver.get_state("sidebarView") == "workflows" and not (
                self.driver.get_state("sidebarCollapsed")
            )
        except BridgeError:
            showing = False
        if not showing:
            self.driver.click("activity-bar-workflows")
        self.wait(
            lambda: self.driver.exists(WORKFLOW_SIDEBAR), what="the workflows sidebar"
        )

    def find_workflow(self, name: str) -> Optional[dict[str, Any]]:
        """Return the stored workflow with the given ``name`` (or ``None``)."""
        workflows = self.driver.get_state("workflows") or []
        return next((w for w in workflows if w.get("name") == name), None)

    def workflow_id(self, name: str) -> str:
        """Wait for a saved workflow named ``name`` and return its id."""
        found = self.wait(
            lambda: self.find_workflow(name), what=f"the saved workflow {name!r}"
        )
        return found["id"]

    def run_workflow(self, workflow_id: str) -> None:
        """Click the Run action on a workflow row (runs against the active tab)."""
        self.driver.click(f"workflow-run-{workflow_id}")

    # ── Editor dialog ───────────────────────────────────────────────────────
    def open_new_workflow(self) -> None:
        """Open the editor on a fresh blank workflow via the New menu."""
        self.driver.click("workflow-new-btn")
        self.wait(
            lambda: self.driver.exists("workflow-new-blank"),
            what="the New-workflow menu",
        )
        self.driver.click("workflow-new-blank")
        self.wait(
            lambda: self.driver.exists(WORKFLOW_EDITOR_DIALOG),
            what="the workflow editor dialog",
        )

    def editor_open(self) -> bool:
        """Whether the workflow editor dialog is currently mounted."""
        return self.driver.exists(WORKFLOW_EDITOR_DIALOG)

    def step_count(self) -> int:
        """Number of step rows currently rendered in the editor."""
        index = 0
        while self.driver.exists(f"workflow-editor-step-{index}"):
            index += 1
        return index

    def step_kind(self, index: int) -> str:
        """The kind label shown on the step row at ``index``."""
        return self.driver.get_text(f"workflow-editor-step-kind-{index}")

    def add_step(self, kind: str) -> None:
        """Add a step of ``kind`` through the "Add step…" menu.

        Asserts the step count increases by one, so a menu item that renders but
        is not wired (the #1868 failure mode) fails here rather than silently
        adding nothing.
        """
        before = self.step_count()
        self.driver.click("workflow-editor-add-step")
        item = f"workflow-editor-add-step-{kind}"
        self.wait(
            lambda: self.driver.exists(item),
            what=f"the {kind!r} entry in the Add-step menu",
        )
        self.driver.click(item)
        self.wait(
            lambda: self.step_count() == before + 1,
            what=f"a {kind!r} step to be added",
        )

    def set_name(self, name: str) -> None:
        """Set the workflow name field."""
        self.driver.type("workflow-editor-name", name)

    def set_command(self, index: int, command: str) -> None:
        """Set the command field of a send-command step at ``index``."""
        self.driver.type(f"workflow-editor-step-command-{index}", command)

    def move_step_down(self, index: int) -> None:
        """Reorder the step at ``index`` one slot down via the arrow button."""
        self.driver.click(f"workflow-editor-step-down-{index}")

    def delete_step(self, index: int) -> None:
        """Remove the step at ``index``; asserts the count drops by one."""
        before = self.step_count()
        self.driver.click(f"workflow-editor-step-delete-{index}")
        self.wait(
            lambda: self.step_count() == before - 1,
            what="the step to be removed",
        )

    def trigger_active(self, kind: str) -> bool:
        """Whether the trigger chip of ``kind`` is toggled on (aria-pressed)."""
        return self.driver.get_attribute(f"workflow-trigger-{kind}", "aria-pressed") == "true"

    def save_workflow(self) -> None:
        """Save the workflow and wait for the editor dialog to close."""
        self.driver.click("workflow-editor-save")
        self.wait(lambda: not self.editor_open(), what="the workflow editor to close")

    def save_disabled(self) -> bool:
        """Whether the Save button is disabled (no name / no steps)."""
        return self.is_disabled("workflow-editor-save")

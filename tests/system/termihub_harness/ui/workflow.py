"""Automation editor helpers (#1851 E2E coverage, #5818).

``WorkflowUi`` drives the one automation editor over the bridge: author an
automation step by step (add steps through the "Add step" menu, edit fields,
reorder, remove), add a trigger, save it, and run it against the active terminal.
The list itself is :class:`AutomationSidebarUi`.

The "Add step" menu is the regression surface from #1868 (a Radix menu that
looked present in the DOM but was dead in the real app). Every add here asserts
the **step count actually changed**, so a menu item that renders but is not
wired fails the test — which a jsdom unit test would miss.

Suites mix this in alongside :class:`~termihub_harness.TerminalUi` (to stand up
a run target) and :class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

from typing import Any, Optional

from .automation_sidebar import EDITOR, EDITOR_SAVE, NEW_STEPS, AutomationSidebarUi

EDITOR_CANCEL = "automation-editor-cancel"
# The shared unsaved-changes prompt the Modal raises when a dirty editor is
# dismissed (#4314). "Just close" renders as "Discard changes" in this variant.
UNSAVED_DIALOG = "unsaved-changes-dialog"
UNSAVED_KEEP_EDITING = "unsaved-changes-cancel"
UNSAVED_DISCARD = "unsaved-changes-just-close"


class WorkflowUi(AutomationSidebarUi):
    """Author, save and run step-by-step automations (the store's workflow view)."""

    # ── Sidebar ─────────────────────────────────────────────────────────────
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
        """Click the Run action on its row (runs against the active tab)."""
        self.run_automation(workflow_id)

    # ── Editor dialog ───────────────────────────────────────────────────────
    def open_new_workflow(self) -> None:
        """Open the editor on a fresh draft via New ▾ → Step by step…"""
        self.open_new_automation(NEW_STEPS)

    def editor_open(self) -> bool:
        """Whether the workflow editor dialog is currently mounted."""
        return self.driver.exists(EDITOR)

    def step_count(self) -> int:
        """Number of step rows currently rendered in the editor."""
        index = 0
        while self.driver.exists(f"automation-editor-step-{index}"):
            index += 1
        return index

    def step_kind(self, index: int) -> str:
        """The kind id (``send-command``) of the step row at ``index``.

        Read from the row's ``data-kind`` attribute: the visible text is the
        readable label ("Run command", #5529), see :meth:`step_label`.
        """
        return self.driver.get_attribute(f"automation-editor-step-kind-{index}", "data-kind") or ""

    def step_label(self, index: int) -> str:
        """The readable kind label shown on the step row at ``index``."""
        return self.driver.get_text(f"automation-editor-step-kind-{index}")

    def add_step(self, kind: str) -> None:
        """Add a step of ``kind`` through the "Add step" menu.

        Asserts the step count increases by one, so a menu item that renders but
        is not wired (the #1868 failure mode) fails here rather than silently
        adding nothing.
        """
        before = self.step_count()
        self.driver.click("automation-editor-add-step")
        item = f"automation-editor-add-step-{kind}"
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
        self.driver.type("automation-editor-name", name)

    def set_command(self, index: int, command: str) -> None:
        """Set the command field of a send-command step at ``index``."""
        self.driver.type(f"automation-editor-step-command-{index}", command)

    def set_script(self, index: int, script: str) -> None:
        """Set the script textarea of a run-script step at ``index``."""
        self.driver.type(f"automation-editor-step-script-{index}", script)

    def pick_automation(self, index: int, automation_id: str, name: str) -> None:
        """Choose an automation in the picker of the run-automation step at ``index``.

        The select's listbox portals into the editor dialog (#1868); this opens it
        and clicks the option like a user, then waits for the trigger to show
        ``name`` — a listbox that renders but swallows the click fails here.
        """
        test_id = f"automation-editor-step-automation-{index}"
        self.driver.select(test_id, automation_id)
        self.wait(
            lambda: name in self.driver.get_text(test_id),
            what=f"the run-automation step {index} to show {name!r}",
        )

    def choose_step_option(self, path: int | str, entry: str) -> None:
        """Choose an entry (``delete``, ``down``, ``duplicate``, ``failure-menu``,
        ``speed-menu``) of a step's "…" menu."""
        item = f"automation-editor-step-{entry}-{path}"
        self.driver.click(f"automation-editor-step-more-{path}")
        self.wait(lambda: self.driver.exists(item), what=f"{entry!r} in the step's menu")
        self.driver.click(item)
        self.wait(lambda: not self.driver.exists(item), what="the step's menu to close")

    def move_step_down(self, index: int) -> None:
        """Move the step at ``index`` one slot down from its menu."""
        self.choose_step_option(index, "down")

    def move_step_with_key(self, index: int, key: str) -> None:
        """Move the step at ``index`` with ``ArrowUp`` / ``ArrowDown`` on its handle."""
        self.driver.press_key(key, f"automation-editor-step-grip-{index}")

    def delete_step(self, index: int) -> None:
        """Remove the step at ``index``; asserts the count drops by one."""
        before = self.step_count()
        self.choose_step_option(index, "delete")
        self.wait(
            lambda: self.step_count() == before - 1,
            what="the step to be removed",
        )

    def trigger_kinds(self) -> list[str]:
        """The kinds of the open editor's triggers (opens "When it runs")."""
        self.open_editor_section("when")
        kinds: list[str] = []
        while self.driver.exists(f"automation-editor-trigger-{len(kinds)}"):
            kind = self.driver.get_attribute(
                f"automation-editor-trigger-kind-{len(kinds)}", "data-kind"
            )
            kinds.append(kind or "")
        return kinds

    def add_trigger(self, kind: str) -> int:
        """Add a trigger of ``kind`` under "When it runs"; return its position."""
        before = len(self.trigger_kinds())
        self.driver.click("automation-editor-add-trigger")
        item = f"automation-editor-add-trigger-{kind}"
        self.wait(lambda: self.driver.exists(item), what=f"the {kind!r} entry in Add trigger")
        self.driver.click(item)
        self.wait(
            lambda: self.driver.exists(f"automation-editor-trigger-{before}"),
            what=f"the {kind!r} trigger's settings",
        )
        return before

    def save_workflow(self) -> None:
        """Save the workflow and wait for the editor dialog to close."""
        self.driver.click(EDITOR_SAVE)
        self.wait(lambda: not self.editor_open(), what="the workflow editor to close")

    def unsaved_prompt_open(self) -> bool:
        """Whether the shared unsaved-changes prompt is currently raised."""
        return self.driver.exists(UNSAVED_DIALOG)

    def cancel_clean_editor(self) -> None:
        """Cancel an editor with no edits; it must close without a prompt."""
        self.driver.click(EDITOR_CANCEL)
        self.wait(lambda: not self.editor_open(), what="the workflow editor to close")
        assert not self.unsaved_prompt_open(), "a clean editor raised the unsaved prompt"

    def cancel_dirty_editor(self) -> None:
        """Cancel an edited editor, assert the unsaved prompt, then Discard.

        Since #4314 a dismiss on a dirty editor dialog raises the shared
        unsaved-changes prompt instead of closing. This asserts the prompt
        appears while the editor stays mounted behind it, then answers it with
        Discard and waits for the editor to close.
        """
        self.driver.click(EDITOR_CANCEL)
        self.wait(self.unsaved_prompt_open, what="the unsaved-changes prompt")
        assert self.editor_open(), "the dirty editor closed instead of prompting"
        self.driver.click(UNSAVED_DISCARD)
        self.wait(lambda: not self.editor_open(), what="the workflow editor to close")
        assert not self.unsaved_prompt_open(), "the unsaved prompt outlived the editor"

    def save_disabled(self) -> bool:
        """Whether Save refuses to save (no name / no steps).

        Save stays clickable while blocked (``aria-disabled``, #5917).
        """
        return self.is_blocked(EDITOR_SAVE)

"""The Automations sidebar (#5818): one list, and one editor, for every automation.

It replaced the Macros and Workflows sidebars. :class:`AutomationSidebarUi`
shows it, creates automations that type keys, runs them, reaches a row's "…"
menu and opens the Schedules and History sections, which start closed. The rest
of the editor is :class:`~.workflow.WorkflowUi`.
"""

from __future__ import annotations

from typing import Any, Optional

from ..bridge import BridgeError
from .base import HarnessMixin

AUTOMATIONS_VIEW = "automations"
AUTOMATIONS_ITEM = "activity-bar-automations"
AUTOMATION_SIDEBAR = "automation-sidebar"
TOOLBAR_OVERFLOW = "automation-toolbar-overflow"
NEW_BUTTON = "automation-new-btn"
NEW_STEPS = "automation-new-steps"
NEW_KEYS = "automation-new-keys"
#: The one automation editor (slice 7), and its Save.
EDITOR = "automation-editor-dialog"
EDITOR_SAVE = "automation-editor-save"
SCHEDULES_TOGGLE = "schedules-section-toggle"
HISTORY_TOGGLE = "automation-history-toggle"


class AutomationSidebarUi(HarnessMixin):
    """Find, create, run and manage automations in their sidebar."""

    # ── view and sections ────────────────────────────────────────────────────
    def show_automations(self) -> None:
        """Show the Automations sidebar (idempotent).

        Clicking an already-active activity-bar icon closes the sidebar, so only
        click when Automations is not the visible view. The activity bar mounts a
        beat after the bridge connects, so wait for the item first.
        """
        self.wait(
            lambda: self.driver.exists(AUTOMATIONS_ITEM), what="the Automations activity-bar item"
        )
        try:
            showing = self.driver.get_state(
                "sidebarView"
            ) == AUTOMATIONS_VIEW and not self.driver.get_state("sidebarCollapsed")
        except BridgeError:
            showing = False
        if not showing:
            self.driver.click(AUTOMATIONS_ITEM)
        self.wait(lambda: self.driver.exists(AUTOMATION_SIDEBAR), what="the Automations sidebar")

    def _open_section(self, toggle: str, what: str) -> None:
        self.show_automations()
        self.wait(lambda: self.driver.exists(toggle), what=f"the {what} section header")
        if self.driver.get_attribute(toggle, "aria-expanded") != "true":
            self.driver.click(toggle)
        self.wait(
            lambda: self.driver.get_attribute(toggle, "aria-expanded") == "true",
            what=f"the {what} section to open",
        )

    def open_automation_history(self) -> None:
        """Show the sidebar with its History section open (idempotent)."""
        self._open_section(HISTORY_TOGGLE, "History")

    def open_automation_schedules(self) -> None:
        """Show the sidebar with its Schedules section open (idempotent)."""
        self._open_section(SCHEDULES_TOGGLE, "Schedules")

    def close_automation_schedules(self) -> None:
        """Close the sidebar's Schedules section when it is open.

        Saving a schedule opens it, and its rows carry the same testIds as
        Settings ▸ Schedules; a test that reads Settings closes it first.
        """
        if not self.driver.exists(SCHEDULES_TOGGLE):
            return
        if self.driver.get_attribute(SCHEDULES_TOGGLE, "aria-expanded") == "true":
            self.driver.click(SCHEDULES_TOGGLE)
            self.wait(
                lambda: self.driver.get_attribute(SCHEDULES_TOGGLE, "aria-expanded") == "false",
                what="the Schedules section to close",
            )

    # ── rows ─────────────────────────────────────────────────────────────────
    def run_automation(self, automation_id: str) -> None:
        """The row's Run: run on the active terminal."""
        self.show_automations()
        start = f"automation-start-{automation_id}"
        self.wait(lambda: self.driver.exists(start), what="the automation's Run button")
        self.driver.click(start)

    def edit_automation(self, automation_id: str) -> None:
        """Open an automation's editor from its row."""
        self.show_automations()
        button = f"automation-edit-{automation_id}"
        self.wait(lambda: self.driver.exists(button), what="the automation's Edit button")
        self.driver.click(button)
        self.wait(lambda: self.driver.exists(EDITOR), what="the automation editor")

    def automation_menu(self, automation_id: str, entry: str) -> None:
        """Choose ``entry`` (``run-on``, ``schedule``, ``history``, …) of a row's "…" menu."""
        self.show_automations()
        row = f"automation-item-{automation_id}"
        more = f"automation-more-{automation_id}"
        item = f"automation-menu-{entry}-{automation_id}"
        self.wait(lambda: self.driver.exists(row), what=f"the row {row}")
        self.driver.force_hover(row)
        try:
            self.wait(lambda: self.driver.exists(more), what='the row\'s "…" button')
            # A re-render can close the menu between its mount and the click;
            # open it once more then.
            for attempt in range(3):
                if not self.driver.exists(item):
                    self.driver.click(more)
                self.wait(lambda: self.driver.exists(item), what=f"the menu entry {item}")
                try:
                    self.driver.click(item)
                    break
                except BridgeError as exc:
                    if "no element" not in str(exc) or attempt == 2:
                        raise
        finally:
            self.driver.force_hover(None)

    # ── creating ─────────────────────────────────────────────────────────────
    def open_new_automation(self, entry: str) -> None:
        """New ▾: choose ``entry`` and wait for the editor."""
        self.show_automations()
        # "New" is the toolbar's primary action (inline beside the "…" menu); at a
        # width too narrow even for that it becomes a sub-menu of "…" (#4824).
        self.invoke_toolbar_action(NEW_BUTTON, overflow=TOOLBAR_OVERFLOW)
        self.wait(lambda: self.driver.exists(entry), what="the New-automation menu")
        self.driver.click(entry)
        self.wait(lambda: self.driver.exists(EDITOR), what="the automation editor")

    def open_new_keystrokes(self) -> None:
        """New ▾ → Typed keystrokes…"""
        self.open_new_automation(NEW_KEYS)

    def expand_step(self, path: int | str) -> None:
        """Open the step row at ``path`` (``1``, ``"0-then-1"``) to its fields (idempotent).

        A stored automation's steps start as one summary line each (#5637); a
        step's fields only exist once its row is open.
        """
        toggle = f"automation-editor-step-toggle-{path}"
        self.wait(lambda: self.driver.exists(toggle), what=f"step {path} in the editor")
        if self.driver.get_attribute(toggle, "aria-expanded") != "true":
            self.driver.click(toggle)
        self.wait(
            lambda: self.driver.exists(f"automation-editor-step-body-{path}"),
            what=f"step {path} to open",
        )

    def open_editor_section(self, section: str) -> None:
        """Open the editor's ``when``, ``values`` or ``tags`` section (idempotent)."""
        toggle = f"automation-editor-{section}-toggle"
        self.wait(lambda: self.driver.exists(toggle), what=f"the editor's {section} section")
        if self.driver.get_attribute(toggle, "aria-expanded") != "true":
            self.driver.click(toggle)
        self.wait(
            lambda: self.driver.get_attribute(toggle, "aria-expanded") == "true",
            what=f"the editor's {section} section to open",
        )

    def set_tags(self, tags: str) -> None:
        """Set the open editor's tags (a section that starts closed)."""
        self.open_editor_section("tags")
        self.driver.type("automation-editor-tags", tags)

    def fill_keystrokes(self, keys: list[str], step: int = 0) -> None:
        """Type ``keys`` (escape notation) into a Type keys step, one row each.

        A new one opens with one empty row; a row is only added when the step
        lacks it, or a blank extra row keeps Save disabled (#4017).
        """
        self.expand_step(step)
        for index, data in enumerate(keys):
            field = f"automation-editor-keys-text-{step}-{index}"
            if not self.driver.exists(field):
                self.driver.click(f"automation-editor-keys-add-{step}")
                self.wait(lambda f=field: self.driver.exists(f), what=f"key row {index}")
            self.driver.type(field, data)

    def set_typing_speed(self, speed: str, step: int = 0) -> None:
        """Choose ``recorded``, ``fixed`` or ``instant`` for a Type keys step (#5820)."""
        self.expand_step(step)
        self.driver.select(f"automation-editor-step-speed-{step}", speed)

    def save_editor(self) -> None:
        """Save the open editor and wait for it to close."""
        self.wait(lambda: not self.is_blocked(EDITOR_SAVE), what="Save to enable")
        self.driver.click(EDITOR_SAVE)
        self.wait(lambda: not self.driver.exists(EDITOR), what="the automation editor to close")

    def stored_automation(self, name: str) -> Optional[dict[str, Any]]:
        """The stored automation called ``name``, or ``None``."""
        stored = self.driver.get_state("automations") or []
        return next((a for a in stored if a.get("name") == name), None)

    def create_typed_automation(self, name: str, steps: list[str]) -> str:
        """Write an automation that types ``steps`` by hand; return its id."""
        self.open_new_keystrokes()
        self.driver.type("automation-editor-name", name)
        self.fill_keystrokes(steps)
        self.save_editor()
        found = self.wait(
            lambda: self.stored_automation(name), what=f"the saved automation {name!r}"
        )
        return found["id"]

"""Authoring and run reads of the product run's automations phase (#5536).

:class:`AutomationPhaseUi` drives macros, workflows and schedules the way a
user does (sidebar toolbar, editor dialogs, row actions, Settings ->
Schedules) and reads the stores the steps grade on (``macros``,
``macroRuns``, ``workflows``, ``workflowRuns``, ``schedules``). Mix it in after
:class:`~.ui.ProductRunUi` with ``WorkflowUi``, ``SettingsUi``, ``SidebarUi``
and ``TerminalUi``.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any, Optional

from ..ui.base import HarnessMixin

MACRO_EDITOR = "macro-editor-dialog"
WORKFLOW_EDITOR = "workflow-editor-dialog"
SCHEDULE_EDITOR = "schedule-editor-dialog"
SCHEDULE_CONFIRM = "schedule-enable-confirm"
#: The one run picker (#5818, slice 5) behind every "Run on…" and Play macro….
RUN_TARGETS = "run-targets-dialog"
#: A field inside a workflow step row (``workflow-editor-step-delay-1``): the
#: row starts collapsed when an existing workflow is opened (#5637).
_STEP_FIELD = re.compile(r"^workflow-editor-step-[a-z-]+-(\d+)$")


class AutomationPhaseUi(HarnessMixin):
    """Macros, workflows and schedules through the real UI."""

    if TYPE_CHECKING:  # supplied by SettingsUi / SidebarUi / WorkflowUi / TabsUi
        def tab_ids(self) -> list[str]: ...
        def enable_experimental_features(self) -> None: ...
        def open_settings_category(self, category: str) -> None: ...
        def open_workflows_sidebar(self) -> None: ...
        def open_new_workflow(self) -> None: ...
        def add_step(self, kind: str) -> None: ...
        def set_name(self, name: str) -> None: ...
        def set_command(self, index: int, command: str) -> None: ...
        def save_workflow(self) -> None: ...
        def workflow_id(self, name: str) -> str: ...
        def expand_step(self, index: int) -> None: ...

    # ── stores ───────────────────────────────────────────────────────────────
    def _state_list(self, key: str) -> list[dict[str, Any]]:
        value = self.driver.get_state(key)
        return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []

    def macro(self, macro_id: str) -> Optional[dict[str, Any]]:
        return next((m for m in self._state_list("macros") if m.get("id") == macro_id), None)

    def macro_runs(self, macro_id: str) -> list[dict[str, Any]]:
        return [r for r in self._state_list("macroRuns") if r.get("macroId") == macro_id]

    def workflow(self, workflow_id: str) -> Optional[dict[str, Any]]:
        return next((w for w in self._state_list("workflows") if w.get("id") == workflow_id), None)

    def workflow_runs(self, workflow_id: str) -> list[dict[str, Any]]:
        return [r for r in self._state_list("workflowRuns") if r.get("workflowId") == workflow_id]

    def schedule(self, schedule_id: str) -> Optional[dict[str, Any]]:
        return next((s for s in self._state_list("schedules") if s.get("id") == schedule_id), None)

    # ── list rows (#5757) ────────────────────────────────────────────────────
    def row_tooltip(self, row_testid: str) -> str:
        """A list row's tooltip text: its accessible description (SidebarListItem)."""
        return self.driver.get_attribute(row_testid, "aria-description") or ""

    def row_text(self, row_testid: str) -> str:
        """The text a list row shows at rest (its tooltip is not in the DOM)."""
        self.driver.force_hover(None)
        return self.driver.get_text(row_testid)

    # ── macros ───────────────────────────────────────────────────────────────
    def show_macros(self) -> None:
        """Show the Macros sidebar (clicking its active icon would close it)."""
        showing = self.driver.get_state("sidebarView") == "macros" and not self.driver.get_state(
            "sidebarCollapsed"
        )
        if not showing:
            self.driver.click("activity-bar-macros")
        self.wait(lambda: self.driver.exists("macro-sidebar"), what="the Macros sidebar")

    def _fill_macro_steps(self, steps: list[str]) -> None:
        for index, data in enumerate(steps):
            field = f"macro-editor-step-data-{index}"
            if not self.driver.exists(field):
                self.driver.click("macro-editor-add-step")
                self.wait(lambda f=field: self.driver.exists(f), what=f"macro step {index}")
            self.driver.type(field, data)

    def _save_macro(self) -> None:
        self.wait(lambda: not self.is_blocked("macro-editor-save"), what="Save to enable")
        self.driver.click("macro-editor-save")
        self.wait(lambda: not self.driver.exists(MACRO_EDITOR), what="the macro editor to close")

    def create_macro(self, name: str, steps: list[str]) -> str:
        """Author a macro in the Macros sidebar; return its id."""
        self.show_macros()
        self.invoke_toolbar_action("macro-new-btn", overflow="macro-toolbar-overflow")
        self.wait(lambda: self.driver.exists(MACRO_EDITOR), what="the macro editor")
        self.driver.type("macro-editor-name", name)
        self.wait(
            lambda: self.driver.exists("macro-editor-step-data-0")
            or self.driver.exists("macro-editor-no-steps"),
            what="the macro editor's steps",
        )
        self._fill_macro_steps(steps)
        self._save_macro()
        found = self.wait(
            lambda: next((m for m in self._state_list("macros") if m.get("name") == name), None),
            what=f"the saved macro {name!r}",
        )
        return found["id"]

    def edit_macro_step(self, macro_id: str, index: int, data: str) -> None:
        """Open the macro's editor from its row, change one step, save."""
        self.show_macros()
        self.driver.click(f"macro-edit-{macro_id}")
        self.wait(lambda: self.driver.exists(MACRO_EDITOR), what="the macro editor")
        self.wait(
            lambda: self.driver.exists(f"macro-editor-step-data-{index}"),
            what=f"macro step {index} in the editor",
        )
        self.driver.type(f"macro-editor-step-data-{index}", data)
        self._save_macro()

    def play_macro(self, macro_id: str) -> None:
        self.show_macros()
        self.wait(lambda: self.driver.exists(f"macro-play-{macro_id}"), what="the macro's Play")
        self.driver.click(f"macro-play-{macro_id}")

    # ── workflows ────────────────────────────────────────────────────────────
    def author_workflow(self, name: str, steps: list[tuple[str, dict[str, Any]]]) -> None:
        """Fill a new workflow's steps (kind, fields) and its name; leaves it open."""
        self.enable_experimental_features()
        self.open_workflows_sidebar()
        self.open_new_workflow()
        for index, (kind, fields) in enumerate(steps):
            self.add_step(kind)
            for key, value in fields.items():
                self.driver.type(f"workflow-editor-{key}-{index}", str(value))
        self.set_name(name)

    def set_output_match_trigger(self, connection_id: str, pattern: str) -> None:
        """Turn on the on-output-match trigger for one connection and a literal pattern."""
        chip = "workflow-trigger-on-output-match"
        if self.driver.get_attribute(chip, "aria-pressed") != "true":
            self.driver.click(chip)
        self.wait(
            lambda: self.driver.exists("workflow-trigger-on-output-match-detail"),
            what="the output-match trigger detail",
        )
        box = f"workflow-trigger-on-output-match-connection-{connection_id}"
        self.wait(lambda: self.driver.exists(box), what="the trigger's connection checkbox")
        if self.driver.get_attribute(box, "data-state") != "checked":
            self.driver.click(box)
        self.driver.type("workflow-trigger-on-output-match-pattern", pattern)

    def edit_workflow(self, workflow_id: str, fields: dict[str, Any]) -> None:
        """Open the workflow's editor from its row, set fields by testid, save."""
        self.open_workflows_sidebar()
        self.driver.click(f"workflow-edit-{workflow_id}")
        self.wait(lambda: self.driver.exists(WORKFLOW_EDITOR), what="the workflow editor")
        for testid, value in fields.items():
            step = _STEP_FIELD.match(testid)
            if step:
                self.expand_step(int(step.group(1)))
            self.wait(lambda t=testid: self.driver.exists(t), what=f"{testid} in the editor")
            self.driver.type(testid, str(value))
        self.save_workflow()

    def run_workflow_on(self, workflow_id: str, tab_ids: list[str]) -> None:
        """Row "Run on…": pick exactly ``tab_ids`` in the run picker and run."""
        self.open_workflows_sidebar()
        self.driver.click(f"workflow-run-on-{workflow_id}")
        self.run_picker_on(tab_ids)

    def play_macro_on(self, macro_id: str, tab_ids: list[str]) -> None:
        """Macro row "Run on…": pick exactly ``tab_ids`` in the run picker and run."""
        self.show_macros()
        self.invoke_row_action(f"macro-item-{macro_id}", f"macro-run-on-{macro_id}")
        self.run_picker_on(tab_ids)

    def invoke_row_action(self, row_testid: str, action_testid: str) -> None:
        """Click a hover-revealed row action (hovering the row first)."""
        self.wait(lambda: self.driver.exists(row_testid), what=f"the row {row_testid}")
        self.driver.force_hover(row_testid)
        self.wait(lambda: self.driver.exists(action_testid), what=f"the action {action_testid}")
        self.driver.click(action_testid)

    def run_picker_on(self, tab_ids: list[str]) -> None:
        """In the open run picker: "Pick terminals…", tick exactly ``tab_ids``,
        run, and confirm the terminal list a multi-terminal run asks for."""
        self.wait(lambda: self.driver.exists(RUN_TARGETS), what="the run picker")
        self.driver.click("run-targets-target-pick")
        self.wait(
            lambda: self.driver.exists("run-targets-terminal-list"), what="the terminal list"
        )
        # The list opens on the last pick (or the active terminal): set every row.
        for tab_id in self.tab_ids():
            box = f"run-targets-terminal-{tab_id}"
            if not self.driver.exists(box):
                continue
            ticked = self.driver.get_attribute(box, "data-state") == "checked"
            if ticked != (tab_id in tab_ids):
                self.driver.click(box)
        for tab_id in tab_ids:
            box = f"run-targets-terminal-{tab_id}"
            self.wait(
                lambda b=box: self.driver.get_attribute(b, "data-state") == "checked",
                what=f"the target {tab_id} ticked",
            )
        self.wait(lambda: not self.is_blocked("run-targets-run"), what="Run to enable")
        self.driver.click("run-targets-run")
        if len(tab_ids) > 1:
            self.wait(
                lambda: self.driver.exists("run-targets-confirm-step"),
                what="the multi-terminal confirmation",
            )
            self.driver.click("run-targets-run")
        self.wait(lambda: not self.driver.exists(RUN_TARGETS), what="the run picker to close")

    # ── schedules ────────────────────────────────────────────────────────────
    def schedule_macro(
        self, macro_id: str, name: str, connection_id: str, description: Optional[str] = None
    ) -> str:
        """Macro row "Schedule": every minute on one connection; return the id."""
        self.show_macros()
        self.driver.click(f"macro-schedule-{macro_id}")
        self.wait(lambda: self.driver.exists(SCHEDULE_EDITOR), what="the schedule editor")
        self.driver.type("schedule-editor-name", name)
        if description is not None:
            self.driver.type("schedule-editor-description", description)
        box = f"schedule-editor-connection-{connection_id}"
        self.wait(lambda: self.driver.exists(box), what="the target connection checkbox")
        self.driver.click(box)
        self.driver.type("schedule-editor-every", "1")
        self.wait(lambda: not self.is_blocked("schedule-editor-save"), what="Save to enable")
        self.driver.click("schedule-editor-save")
        self.wait(lambda: not self.driver.exists(SCHEDULE_EDITOR), what="the editor to close")
        found = self.wait(
            lambda: next((s for s in self._state_list("schedules") if s.get("name") == name), None),
            what=f"the saved schedule {name!r}",
        )
        return found["id"]

    def set_schedule_enabled(self, schedule_id: str, enabled: bool) -> None:
        """Settings -> Schedules: flip the switch (accepting the first-enable confirmation)."""
        self.open_settings_category("schedules")
        toggle = f"schedule-enable-{schedule_id}"
        self.wait(lambda: self.driver.exists(toggle), what="the schedule's enable switch")
        if bool((self.schedule(schedule_id) or {}).get("enabled")) == enabled:
            return
        self.driver.click(toggle)
        if enabled:
            self.wait(lambda: self.driver.exists(SCHEDULE_CONFIRM), what="the enable confirmation")
            self.driver.click(f"{SCHEDULE_CONFIRM}-confirm")
        self.wait(
            lambda: bool((self.schedule(schedule_id) or {}).get("enabled")) == enabled,
            what=f"the schedule enabled={enabled}",
        )

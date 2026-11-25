"""Authoring and run reads of the product run's automations phase (#5536).

:class:`AutomationPhaseUi` drives automations and schedules the way a
user does (sidebar toolbar, editor dialogs, row menus, Settings ->
Schedules) and reads the stores the steps grade on (``macros``,
``workflows``, ``automationRuns``, ``schedules``). Mix it in after
:class:`~.ui.ProductRunUi` with ``WorkflowUi``, ``SettingsUi``, ``SidebarUi``
and ``TerminalUi``.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any, Optional

from ..ui.automation_sidebar import AutomationSidebarUi

SCHEDULE_EDITOR = "schedule-editor-dialog"
SCHEDULE_CONFIRM = "schedule-enable-confirm"
#: The one run picker (#5818, slice 5) behind every "Run on…" and Run automation….
RUN_TARGETS = "run-targets-dialog"
#: A field inside a step row (``automation-editor-step-delay-1``): the row starts
#: collapsed when a stored automation is opened (#5637).
_STEP_FIELD = re.compile(r"^automation-editor-step-[a-z-]+-(\d+)$")


class AutomationPhaseUi(AutomationSidebarUi):
    """Automations and their schedules through the real UI.

    "Macro" and "workflow" here name the store's two views of an automation
    (one that only types keystrokes, and every other one); both are rows of the
    one Automations sidebar (#5818).
    """

    if TYPE_CHECKING:  # supplied by SettingsUi / SidebarUi / WorkflowUi / TabsUi
        def tab_ids(self) -> list[str]: ...
        def open_settings_category(self, category: str) -> None: ...
        def open_new_workflow(self) -> None: ...
        def add_step(self, kind: str) -> None: ...
        def set_name(self, name: str) -> None: ...
        def set_command(self, index: int, command: str) -> None: ...
        def save_workflow(self) -> None: ...
        def workflow_id(self, name: str) -> str: ...
        def add_trigger(self, kind: str) -> int: ...

    # ── stores ───────────────────────────────────────────────────────────────
    def _state_list(self, key: str) -> list[dict[str, Any]]:
        value = self.driver.get_state(key)
        return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []

    def macro(self, macro_id: str) -> Optional[dict[str, Any]]:
        return next((m for m in self._state_list("macros") if m.get("id") == macro_id), None)

    def automation_runs(self, automation_id: str) -> list[dict[str, Any]]:
        """The recorded runs of one automation, newest first."""
        return [
            r for r in self._state_list("automationRuns") if r.get("automationId") == automation_id
        ]

    def workflow(self, workflow_id: str) -> Optional[dict[str, Any]]:
        return next((w for w in self._state_list("workflows") if w.get("id") == workflow_id), None)

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

    # ── typed keystrokes (the macro view) ────────────────────────────────────
    def create_macro(self, name: str, steps: list[str]) -> str:
        """Write an automation's keystrokes by hand; return its id."""
        return self.create_typed_automation(name, steps)

    def edit_macro_step(self, macro_id: str, index: int, data: str) -> None:
        """Open the editor from the row, change one row of its keys, save."""
        self.edit_automation(macro_id)
        self.expand_step(0)
        self.driver.type(f"automation-editor-keys-text-0-{index}", data)
        self.save_editor()

    def play_macro(self, macro_id: str) -> None:
        self.run_automation(macro_id)

    # ── workflows ────────────────────────────────────────────────────────────
    def author_workflow(self, name: str, steps: list[tuple[str, dict[str, Any]]]) -> None:
        """Fill a new workflow's steps (kind, fields) and its name; leaves it open."""
        self.open_new_workflow()
        for index, (kind, fields) in enumerate(steps):
            self.add_step(kind)
            for key, value in fields.items():
                self.driver.type(f"automation-editor-{key}-{index}", str(value))
        self.set_name(name)

    def set_output_match_trigger(self, connection_id: str, pattern: str) -> None:
        """Add an on-output-match trigger for one connection and a literal pattern."""
        index = self.add_trigger("on-output-match")
        box = f"automation-trigger-connection-{index}-{connection_id}"
        self.wait(lambda: self.driver.exists(box), what="the trigger's connection checkbox")
        if self.driver.get_attribute(box, "data-state") != "checked":
            self.driver.click(box)
        self.driver.type(f"automation-trigger-pattern-{index}", pattern)

    def edit_workflow(self, workflow_id: str, fields: dict[str, Any]) -> None:
        """Open the automation's editor from its row, set fields by testid, save."""
        self.edit_automation(workflow_id)
        for testid, value in fields.items():
            step = _STEP_FIELD.match(testid)
            if step:
                self.expand_step(int(step.group(1)))
            self.wait(lambda t=testid: self.driver.exists(t), what=f"{testid} in the editor")
            self.driver.type(testid, str(value))
        self.save_workflow()

    def run_automation_on(self, automation_id: str, tab_ids: list[str]) -> None:
        """Row menu "Run on…": pick exactly ``tab_ids`` in the run picker and run."""
        self.automation_menu(automation_id, "run-on")
        self.run_picker_on(tab_ids)

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
    def schedule_automation(
        self,
        automation_id: str,
        name: str,
        connection_id: str,
        description: Optional[str] = None,
        if_closed: str = "skip",
    ) -> str:
        """Row menu "Schedule…": the editor opens with that automation picked (#5818);
        choose what to do with a closed connection (``skip`` or ``connect``, #6024),
        save it every minute on one connection and return the schedule id."""
        self.automation_menu(automation_id, "schedule")
        self.wait(lambda: self.driver.exists(SCHEDULE_EDITOR), what="the schedule editor")
        self.driver.type("schedule-editor-name", name)
        if description is not None:
            self.driver.type("schedule-editor-description", description)
        box = f"schedule-editor-connection-{connection_id}"
        self.wait(lambda: self.driver.exists(box), what="the target connection checkbox")
        self.driver.click(box)
        self.driver.click(f"schedule-editor-closed-{if_closed}")
        self.driver.type("schedule-editor-every", "1")
        self.wait(lambda: not self.is_blocked("schedule-editor-save"), what="Save to enable")
        self.driver.click("schedule-editor-save")
        self.wait(lambda: not self.driver.exists(SCHEDULE_EDITOR), what="the editor to close")
        found = self.wait(
            lambda: next((s for s in self._state_list("schedules") if s.get("name") == name), None),
            what=f"the saved schedule {name!r}",
        )
        return found["id"]

    def schedule_row_texts(self, schedule_id: str) -> dict[str, str]:
        """What the schedule's row says, by line (#6024); a line it lacks is empty."""
        texts = {}
        for line in ("status", "rule", "what", "last"):
            test_id = f"schedule-{line}-{schedule_id}"
            shown = self.driver.exists(test_id)
            texts[line] = self.driver.get_text(test_id).strip() if shown else ""
        return texts

    def set_schedule_enabled(self, schedule_id: str, enabled: bool) -> None:
        """Settings -> Schedules: flip the switch (accepting the first-enable confirmation)."""
        self.close_automation_schedules()  # its rows share Settings' testIds
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

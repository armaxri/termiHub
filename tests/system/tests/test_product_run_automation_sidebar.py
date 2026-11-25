"""Product run: one Automations sidebar for macros and workflows (#5818, slice 6).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). It runs with experimental features off:
Automations graduated, except the "Run local process" step.

Steps: the empty view offers Record and New; a typed, a triggered and a
scheduled automation share one list whose rows show names and state, and nothing
says "macro" or "workflow"; every row action of the two old sidebars is in the
row's menu; Run types into the active terminal and Stop ends a run; the list is
searched by name; at the narrowest sidebar the run control and the trigger
switch stay on the name's line; "Run local process" is not offered; Schedules
and History open from their headers; hiding both old views in an older settings
file leaves Automations hidden, hiding one leaves it shown.

The ``test_grade_*`` functions grade fixed readings without an app and run in
the normal lane.
"""

from __future__ import annotations

import sys
from typing import Any, Optional

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
from termihub_harness.product_run.automation_sidebar_grades import (
    KEYSTROKES_ONLY,
    MENU,
    copy_problems,
    list_problems,
    menu_problems,
    migrated_layout_problems,
    row_layout_problems,
    row_text_problems,
)
from termihub_harness.product_run.automation_steps import AutomationPhaseUi
from termihub_harness.product_run.ssh_steps import SshPhaseUi

#: The minimum supported window, and the product run's normal one.
NARROW_WINDOW = (800, 600)
NORMAL_WINDOW = (1280, 800)
#: ``SIDEBAR_MIN_WIDTH`` in ``src/hooks/useSidebarResize.ts``.
SIDEBAR_MIN_WIDTH = 200
SIDEBAR_HANDLE = "sidebar-resize-handle"
#: How long the run that is stopped would otherwise wait.
WAIT_MS = 60_000


# ── app-free grade tests ──────────────────────────────────────────────────
def _box(x: float, y: float, width: float, height: float) -> dict[str, float]:
    return {"x": x, "y": y, "width": width, "height": height}


def _layout(**over: Any) -> dict[str, Any]:
    good: dict[str, Any] = {
        "sidebar": _box(48, 0, 200, 560),
        "name": _box(60, 100, 70, 16),
        "marker": _box(72, 124, 110, 30),
        "switch": _box(190, 130, 28, 16),
        "run": _box(190, 95, 26, 26),
        "moreOpacity": "0",
    }
    good.update(over)
    return good


def test_grade_one_list_passes():
    assert list_problems(["a", "b", "c"], ["a", "c"]) == []


def test_grade_missing_or_doubled_automation_fails():
    assert list_problems(["a", "a"], ["a", "b"]) == ["b is not in the list", "a is listed 2 times"]


@pytest.mark.parametrize("text", ["Search macros", "No workflows yet", "Export all Macros"])
def test_grade_old_copy_fails(text):
    assert copy_problems("the sidebar", text) != []


def test_grade_new_copy_passes():
    assert copy_problems("the sidebar", "Search automations", "New", None) == []


def test_grade_row_text():
    row = "Deploy prep Pull and build Triggers on: hotkey F8"
    marker = "Triggers on: hotkey F8"
    assert row_text_problems(row, "Deploy prep", "Pull and build", marker) == []
    assert row_text_problems("Deploy prep\nOn connect · prod", "Deploy prep") == [
        "settings text on the row: 'On connect · prod'"
    ]
    assert any("starts with" in p for p in row_text_problems("3 steps Deploy", "Deploy"))


def test_grade_row_layout_passes():
    assert row_layout_problems(_layout()) == []
    assert row_layout_problems(_layout(marker=None, switch=None)) == []


def test_grade_switch_away_from_its_sentence_fails():
    # The R-077 shape: one could not tell which row the switch belongs to.
    problems = row_layout_problems(_layout(switch=_box(190, 170, 28, 16)))
    assert problems == ["the switch is not beside its sentence"]
    assert row_layout_problems(_layout(switch=_box(160, 130, 28, 16))) == [
        "the switch covers its sentence"
    ]
    assert row_layout_problems(_layout(marker=_box(72, 98, 110, 50))) == [
        "the marker covers the name"
    ]


def test_grade_hidden_run_control_fails():
    # The R-075 shape: workflow rows had no visible run control.
    assert row_layout_problems(_layout(run=None)) == ["the row has no run control"]
    assert row_layout_problems(_layout(run=_box(190, 95, 0, 26))) == ["the run is not laid out"]


def test_grade_crowded_narrow_row_fails():
    problems = row_layout_problems(
        _layout(name=_box(60, 100, 10, 16), run=_box(240, 95, 26, 26), moreOpacity="1")
    )
    assert problems == [
        "the name keeps only 10px",
        "the run runs outside the sidebar",
        "the other actions show at rest and crowd the name",
    ]


def test_grade_menu():
    assert menu_problems(MENU, keystrokes=True) == []
    steps = [e for e in MENU if e not in KEYSTROKES_ONLY]
    assert menu_problems(steps, keystrokes=False) == []
    assert menu_problems([e for e in MENU if e != "schedule"], keystrokes=True) == [
        "the menu lacks 'schedule'"
    ]
    assert menu_problems(MENU, keystrokes=False) == [
        "the menu offers 'use-in-new' to an automation it does not fit"
    ]


@pytest.mark.parametrize(
    "before, after",
    [
        (["macros", "workflows"], ["automations"]),
        (["tunnels", "workflows", "files", "macros"], ["automations", "files"]),
        (["tunnels", "macros", "services", "workflows"], ["services", "automations"]),
        (["macros"], []),
        (["workflows", "services"], []),
        ([], []),
    ],
)
def test_grade_migrated_layout_passes(before, after):
    assert migrated_layout_problems(before, after) == []


def test_grade_migrated_layout_fails():
    assert migrated_layout_problems(["macros", "workflows"], []) != []
    assert migrated_layout_problems(["macros"], ["automations"]) != []
    assert migrated_layout_problems(["macros"], ["macros"]) != []


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="uses POSIX shell quoting")
class TestProductRunAutomationSidebar(
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
    phase = "Automations sidebar"
    request_timeout = 60.0

    tag = unique_name("pr").split("-")[-1]
    ids: dict[str, str] = {}
    state: dict[str, Any] = {}

    def reset_before_rerun(self) -> None:
        self._restore_layout()

    # ── reads ────────────────────────────────────────────────────────────────
    def _rect(self, testid: str) -> Optional[dict[str, float]]:
        if not self.driver.exists(testid):
            return None
        return self.driver.measure_element(testid)["rect"]

    def _measure_row(self, aid: str) -> dict[str, Any]:
        self.driver.force_hover(None)
        return {
            "sidebar": self.driver.measure_element("sidebar")["rect"],
            "name": self._rect(f"automation-name-{aid}"),
            "marker": self._rect(f"automation-armed-{aid}"),
            "switch": self._rect(f"automation-arm-toggle-{aid}"),
            "run": self._rect(f"automation-start-{aid}"),
            "moreOpacity": self.driver.get_computed_style(
                "opacity", f"automation-more-group-{aid}"
            ),
        }

    def _menu_entries(self, aid: str) -> list[str]:
        """The entries of a row's open "…" menu, then close it."""
        self.driver.force_hover(f"automation-item-{aid}")
        self.driver.click(f"automation-more-{aid}")
        self.wait(
            lambda: self.driver.exists(f"automation-menu-edit-{aid}"), what="the row's menu"
        )
        entries = [e for e in MENU if self.driver.exists(f"automation-menu-{e}-{aid}")]
        self.shot(label=f"menu-{aid[:8]}")
        self.driver.press_key("Escape", f"automation-menu-edit-{aid}")
        self.wait(
            lambda: not self.driver.exists(f"automation-menu-edit-{aid}"), what="the menu to close"
        )
        self.driver.force_hover(None)
        return entries

    def _restore_layout(self) -> None:
        self.driver.resize_window(*NORMAL_WINDOW)
        width = self.state.pop("sidebar_width", None)
        current = self.driver.get_state("sidebarWidth")
        if isinstance(width, (int, float)) and isinstance(current, (int, float)):
            self.driver.drag(SIDEBAR_HANDLE, float(width) - float(current))

    # ── steps ────────────────────────────────────────────────────────────────
    def test_00_empty(self):
        with self.step(
            "automation-sidebar.empty",
            "One Automations item opens a view that says what automations are and how to start",
            expect="the Automations sidebar: 'No automations yet.' with a Record and a 'New step "
            "by step' button; toolbar New ▾ and Record; closed Schedules and History",
        ):
            self.show_automations()
            present = [t for t in ("activity-bar-macros", "activity-bar-workflows")
                       if self.driver.exists(t)]
            assert not present, f"the old views still show: {present}"
            if self.driver.get_state("automations"):
                pytest.skip("the run already has automations; no empty state")
            text = self.driver.get_text("automation-empty")
            self.evidence(f"empty state {text!r}")
            problems = copy_problems("the empty state", text)
            for button in ("automation-empty-record-btn", "automation-empty-new-btn"):
                if not self.driver.exists(button):
                    problems.append(f"the empty state lacks {button}")
            assert not problems, problems

    def test_10_one_list(self):
        t = self.tag
        with self.step(
            "automation-sidebar.list",
            "A typed, a triggered and a scheduled automation share one list of names and states",
            expect="the Automations sidebar: 'Typed …' and 'Scheduled …' with only their names "
            "and a Run button, 'Answer …' with 'Triggers on: …' and its switch under its name",
        ):
            name = f"pr-sidebar-{t}"
            self.switch_to_connections_sidebar()
            self.create_local_connection(name)
            self.ids["conn"] = self.require_stable_connection(name)["id"]
            self.connect_connection(name)
            self.ids["tab"] = self.tab_id_of(name)
            self.wait_connected(self.ids["tab"])
            self.ids["typed"] = self.create_macro(f"Typed {t}", [f"echo PR_SIDE_$((40+2))_{t}\\r"])
            self.ids["scheduled"] = self.create_macro(f"Scheduled {t}", ["echo later\\r"])
            self.author_workflow(
                f"Answer {t}",
                [
                    ("send-command", {"step-command": f"echo PR_SIDE_ANSWER_{t}"}),
                    ("wait", {"step-delay": WAIT_MS / 1000}),
                ],
            )
            self.set_output_match_trigger(self.ids["conn"], f"PR_SIDE_NEVER_{t}")
            self.save_workflow()
            self.ids["triggered"] = self.workflow_id(f"Answer {t}")
            self.ids["schedule"] = self.schedule_automation(
                self.ids["scheduled"], f"Side schedule {t}", self.ids["conn"]
            )
            # Saving a schedule opens the section, so its row is in view.
            self.wait(
                lambda: self.driver.exists(f"schedule-item-{self.ids['schedule']}"),
                what="the saved schedule's row",
            )
            self.close_automation_schedules()
            rows = {k: self.ids[k] for k in ("typed", "scheduled", "triggered")}
            stored = {a["id"]: a for a in self.driver.get_state("automations") or []}
            listed = [i for i in stored if self.driver.exists(f"automation-item-{i}")]
            problems = list_problems(listed, list(rows.values()))
            for kind, aid in rows.items():
                marker = ""
                if kind == "triggered":
                    marker = self.driver.get_text(f"automation-armed-{aid}").strip()
                    if not marker.startswith("Triggers on: matching output in "):
                        problems.append(f"the trigger sentence reads {marker!r}")
                text = self.row_text(f"automation-item-{aid}")
                self.evidence(f"{kind}: {text!r}; tooltip {self.row_tooltip(f'automation-item-{aid}')!r}")
                problems += row_text_problems(text, stored[aid]["name"], "", marker)
                problems += copy_problems(kind, self.row_tooltip(f"automation-item-{aid}"))
                problems += row_layout_problems(self._measure_row(aid))
            problems += copy_problems("the sidebar", self.driver.get_text("automation-sidebar"))
            self.shot(label="list")
            assert not problems, problems

    def test_20_every_action(self):
        with self.step(
            "automation-sidebar.actions",
            "A row's menu offers every action the two old sidebars had, as text",
            expect="an automation row with its '…' menu open: Run, Run on…, Schedule…, Recent "
            "runs, Edit…, Duplicate, New automation from this…, Export… and Delete…",
        ):
            self.require("automation-sidebar.list")
            self.show_automations()
            problems = []
            for kind in ("typed", "triggered"):
                entries = self._menu_entries(self.ids[kind])
                self.evidence(f"{kind}: {entries}")
                problems += menu_problems(entries, keystrokes=kind == "typed")
            assert not problems, problems

    def test_30_run_and_stop(self):
        t = self.tag
        with self.step(
            "automation-sidebar.run",
            "Run types into the active terminal; a running row shows Running and stops",
            expect="the terminal with PR_SIDE_42; the 'Answer …' row reads 'Running' with a stop "
            "square, then shows Run again",
        ):
            self.require("automation-sidebar.list")
            tab, aid = self.ids["tab"], self.ids["triggered"]
            self.switch_to_tab(tab)
            self.run_automation(self.ids["typed"])
            self.wait_for_output(f"PR_SIDE_42_{t}", tab_id=tab, timeout=30.0)
            self.run_automation(aid)
            self.wait(
                lambda: self.driver.exists(f"automation-running-{aid}"), what="the Running marker"
            )
            marker = self.driver.get_text(f"automation-running-{aid}").strip()
            self.shot(label="running")
            self.evidence(f"running marker {marker!r}")
            assert marker.startswith("Running"), marker
            assert not self.driver.exists(f"automation-start-{aid}"), "Run shows while running"
            self.driver.click(f"automation-stop-{aid}")
            self.wait(
                lambda: self.driver.exists(f"automation-start-{aid}"), what="Run after the stop"
            )
            run = self.wait(
                lambda: next(iter(self.automation_runs(aid)), None), what="the stopped run's record"
            )
            assert run.get("status") == "cancelled", run

    def test_40_search(self):
        with self.step(
            "automation-sidebar.search",
            "The list is searched by name, and an empty result offers to clear the search",
            expect="the Automations sidebar with 'No automations match …' and Clear search",
        ):
            self.require("automation-sidebar.list")
            self.show_automations()
            self.driver.type("automation-search", f"typed {self.tag}")
            self.wait(
                lambda: not self.driver.exists(f"automation-item-{self.ids['triggered']}"),
                what="the other rows to go",
            )
            assert self.driver.exists(f"automation-item-{self.ids['typed']}")
            self.driver.type("automation-search", "no such automation")
            self.wait(
                lambda: self.driver.exists("automation-no-results"), what="the no-results state"
            )
            self.shot(label="no-results")
            self.driver.click("automation-clear-search-btn")
            self.wait(
                lambda: self.driver.exists(f"automation-item-{self.ids['triggered']}"),
                what="every row again",
            )

    def test_50_narrow(self):
        with self.step(
            "automation-sidebar.narrow",
            "At 800x600 and the narrowest sidebar, Run, the marker and the switch stay on the "
            "name's line",
            expect="the 200px Automations sidebar: 'Answer …' with a bolt icon, its switch and "
            "Run beside a readable name; nothing cut off",
            screenshot=False,
        ):
            self.require("automation-sidebar.list")
            self.show_automations()
            self.state["sidebar_width"] = self.driver.get_state("sidebarWidth")
            self.driver.resize_window(*NARROW_WINDOW)
            self.driver.press_key("Home", SIDEBAR_HANDLE)
            try:
                self.wait(
                    lambda: self.driver.get_state("sidebarWidth") == SIDEBAR_MIN_WIDTH,
                    what="the sidebar at its narrowest width",
                )
                problems = []
                for kind in ("typed", "triggered"):
                    measured = self._measure_row(self.ids[kind])
                    self.evidence(f"{kind}: {measured}")
                    problems += row_layout_problems(measured)
                self.shot(label="narrow")
                assert not problems, problems
            finally:
                self._restore_layout()

    def test_60_local_process_not_offered(self):
        with self.step(
            "automation-sidebar.local-process",
            "With experimental features off, the Add step menu leaves out Run local process",
            expect="the editor's Add step menu without 'Run local process'",
            screenshot=False,
        ):
            assert not self._experimental_enabled(), "the run turned experimental features on"
            self.open_new_workflow()
            try:
                self.driver.click("automation-editor-add-step")
                self.wait(
                    lambda: self.driver.exists("automation-editor-add-step-wait"),
                    what="the Add step menu",
                )
                offered = self.driver.exists("automation-editor-add-step-run-local-process")
                self.shot(label="add-step")
                self.driver.press_key("Escape", "automation-editor-add-step-wait")
                self.evidence(f"Run local process offered: {offered}")
                assert not offered, "Run local process is offered with experimental features off"
            finally:
                self.cancel_clean_editor()

    def test_70_sections(self):
        with self.step(
            "automation-sidebar.sections",
            "Schedules and History are sections of the one sidebar, one open at a time",
            expect="the Automations sidebar with History open under the list, which keeps a few "
            "rows in view; Schedules closed again",
        ):
            self.require("automation-sidebar.list", "automation-sidebar.run")
            self.open_automation_schedules()
            row = f"schedule-item-{self.ids['schedule']}"
            self.wait(lambda: self.driver.exists(row), what="the schedule's row")
            self.open_automation_history()
            self.wait(lambda: self.driver.exists("automation-history-list"), what="the history")
            # The open one takes the room (#6045).
            self.wait(lambda: not self.driver.exists(row), what="Schedules to close")
            pane = self.driver.measure_element("automation-list")["rect"]
            self.evidence(f"list {pane} with a section open")
            self.shot(label="sections")
            assert pane["height"] >= 90, f"the sections leave the list {pane['height']:.0f}px"
            self.close_automation_schedules()

    def _restart_with_hidden_views(self, hidden: list[str]) -> list[str]:
        """Restart on an older (v3) settings file that hides ``hidden``; the views hidden now."""
        layout = dict(self.persisted_settings().get("layout") or {})
        layout.setdefault("activityBarPosition", "left")
        layout.setdefault("sidebarPosition", "left")
        layout.setdefault("sidebarVisible", True)
        layout.setdefault("statusBarVisible", True)
        layout["hiddenActivityBarViews"] = hidden
        self.restart_app(
            between=lambda: self.write_settings_file(version="3", layout=layout)
        )
        # The layout loads a beat after the bridge connects.
        self.wait(
            lambda: not migrated_layout_problems(hidden, self._hidden_views()),
            what=f"the migrated hidden views of {hidden}",
        )
        return self._hidden_views()

    def _hidden_views(self) -> list[str]:
        layout = self.driver.get_state("layoutConfig") or {}
        return list(layout.get("hiddenActivityBarViews") or [])

    def test_80_hidden_views_migrate(self):
        with self.step(
            "automation-sidebar.migration",
            "Hiding both old views keeps Automations hidden; hiding one shows it",
            expect="after the restart on the older settings file that hid only Macros: the "
            "activity bar with its Automations icon",
        ):
            self.close_all_tabs()
            problems = []
            for hidden in (["tunnels", "workflows", "macros"], ["macros"]):
                after = self._restart_with_hidden_views(hidden)
                shown = self.driver.exists("activity-bar-automations")
                self.evidence(f"hidden {hidden} -> {after}; Automations shown {shown}")
                problems += migrated_layout_problems(hidden, after)
                if shown == ("automations" in after):
                    problems.append(f"hidden {hidden}: the Automations item shown is {shown}")
            assert not problems, problems
            self.switch_to_connections_sidebar()

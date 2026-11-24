"""Product run: SSH tunnels, Services and Network tools are on by default (#5858).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` found these advertised core features hidden behind
Settings ▸ General ▸ Allow experimental features, a switch with an amber "may
break" warning (R-007), so most users would never find them. They graduated:
with experimental features OFF the activity bar shows SSH tunnels, Services and
Network tools, and each opens its sidebar. Workflows stay behind the switch
until the Automations merge (#5818). A view the user hid stays hidden. The
switch's hint lists what is still behind it.

The ``test_grade_*`` functions grade fixed inputs without an app and run in the
normal lane.
"""

from __future__ import annotations

from typing import Optional

import pytest

from termihub_harness import SettingsUi, SidebarUi, SystemTest, TabsUi
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.graduated_features import (
    GRADUATED_SIDEBARS,
    GRADUATED_VIEWS,
    STILL_EXPERIMENTAL_VIEWS,
    activity_bar_problems,
    experimental_hint_problems,
)

TOGGLE = "settings-experimental-features"
SETTINGS_CONTENT = "settings-panel-content"
#: Text that starts the switch's hint (``EXPERIMENTAL_SETTING_HINT``).
HINT_START = "Turns on features still under active development"
APP_HINT = (
    "Turns on features still under active development: workflows, remote agents and "
    "RDP and VNC remote desktop. They may change, break, or be removed without notice."
)
ALL_GRADUATED = set(GRADUATED_VIEWS.values())
WORKFLOWS = STILL_EXPERIMENTAL_VIEWS["workflows"]


# ── app-free grade tests ──────────────────────────────────────────────────
def test_grade_graduated_views_with_experimental_off_pass():
    assert activity_bar_problems(ALL_GRADUATED, experimental=False) == []


def test_grade_missing_graduated_view_fails():
    present = ALL_GRADUATED - {"activity-bar-services"}
    problems = activity_bar_problems(present, experimental=False)
    assert problems == ["services: missing from the activity bar with experimental off"]


def test_grade_workflows_with_experimental_off_fail():
    problems = activity_bar_problems(ALL_GRADUATED | {WORKFLOWS}, experimental=False)
    assert any("workflows: shows with experimental off" in p for p in problems)
    assert activity_bar_problems(ALL_GRADUATED | {WORKFLOWS}, experimental=True) == []


def test_grade_user_hidden_view_must_stay_hidden():
    present = ALL_GRADUATED - {"activity-bar-ssh-tunnels"}
    assert activity_bar_problems(present, experimental=False, hidden_views={"tunnels"}) == []
    problems = activity_bar_problems(ALL_GRADUATED, experimental=False, hidden_views={"tunnels"})
    assert problems == ["tunnels: the user hid it, but the activity bar shows it"]


def test_grade_switch_hint_matches_the_app():
    assert experimental_hint_problems(APP_HINT) == []
    old = (
        "Enables hidden features under active development. Experimental features may "
        "change, break, or be removed at any time without notice."
    )
    problems = experimental_hint_problems(old)
    assert any("'workflows'" in p for p in problems)
    assert any("'RDP and VNC remote desktop'" in p for p in problems)


def test_grade_switch_hint_naming_a_graduated_feature_fails():
    problems = experimental_hint_problems(APP_HINT + " Also SSH tunnels.")
    assert problems == ["the hint still names 'tunnel'"]


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunGraduatedFeatures(ProductRunUi, SettingsUi, SidebarUi, TabsUi, SystemTest):
    phase = "Graduated features"
    request_timeout = 60.0

    def _set_experimental(self, on: bool) -> None:
        if self._experimental_enabled() == on:
            return
        self.open_settings_category("general")
        self.wait(lambda: self.driver.exists(TOGGLE), what="the experimental-features toggle")
        self.driver.click(TOGGLE)
        self.wait(lambda: self._experimental_enabled() == on, what=f"experimental {on}")
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    def _present(self) -> set[str]:
        ids = set(GRADUATED_VIEWS.values()) | set(STILL_EXPERIMENTAL_VIEWS.values())
        return {t for t in ids if self.driver.exists(t)}

    def _hidden_views(self) -> list[str]:
        layout = self.driver.get_state("layoutConfig") or {}
        return list(layout.get("hiddenActivityBarViews") or [])

    def _toggle_view(self, view: str) -> None:
        before = view in self._hidden_views()
        self.driver.context_menu("activity-bar")
        item = f"activity-bar-context-toggle-{view}"
        self.wait(lambda: self.driver.exists(item), what=f"the {view} layout toggle")
        self.driver.click(item)
        self.wait(lambda: (view in self._hidden_views()) != before, what=f"{view} to toggle")
        if self.driver.exists(item):
            self.driver.press_key("Escape")

    def test_10_views_show_with_experimental_off(self):
        with self.step(
            "graduated.activity-bar",
            "With experimental features off, the activity bar shows SSH tunnels, Services "
            "and Network tools; Workflows stay hidden (#5858)",
            expect="the activity bar with the SSH tunnels, Services and Network tools icons "
            "and no Workflows icon; Settings ▸ General ▸ Allow experimental features is off",
        ):
            self._set_experimental(False)
            hidden = self._hidden_views()
            present = self._present()
            self.evidence(f"activity-bar items {sorted(present)}, user-hidden {hidden}")
            self.shot(label="activity-bar")
            problems = activity_bar_problems(present, experimental=False, hidden_views=hidden)
            assert not problems, problems

    def test_20_each_view_opens(self):
        self._set_experimental(False)
        for view, test_id in GRADUATED_VIEWS.items():
            if view in self._hidden_views():
                continue
            with self.step(
                f"graduated.open.{view}",
                f"The {view} view opens with experimental features off (#5858)",
                expect=f"the {view} sidebar is open, no Settings detour needed",
            ):
                self._ensure_sidebar(view, test_id)
                sidebar = GRADUATED_SIDEBARS[view]
                self.wait(lambda s=sidebar: self.driver.exists(s), what=f"the {view} sidebar")
                self.shot(label=view)
        self.switch_to_connections_sidebar()

    def test_30_hidden_view_stays_hidden(self):
        with self.step(
            "graduated.user-hidden",
            "A graduated view the user hid from the activity bar stays hidden (#5858)",
            expect="the activity bar without the SSH tunnels icon after hiding it via "
            "right-click; Services and Network tools still shown",
        ):
            self._set_experimental(False)
            was_hidden = "tunnels" in self._hidden_views()
            if not was_hidden:
                self._toggle_view("tunnels")
            try:
                hidden = self._hidden_views()
                present = self._present()
                self.evidence(f"activity-bar items {sorted(present)}, user-hidden {hidden}")
                self.shot(label="tunnels-hidden")
                problems = activity_bar_problems(present, experimental=False, hidden_views=hidden)
                assert not problems, problems
                assert "activity-bar-ssh-tunnels" not in present
            finally:
                if not was_hidden:
                    self._toggle_view("tunnels")

    def _switch_hint(self) -> Optional[str]:
        items = self.driver.measure_element(SETTINGS_CONTENT, "text").get("items", [])
        return next(
            (i["text"] for i in items if (i.get("text") or "").startswith(HINT_START)), None
        )

    def test_40_switch_hint_lists_what_remains(self):
        with self.step(
            "graduated.switch-hint",
            "The experimental switch's hint lists what is still behind it (#5858)",
            expect="Settings ▸ General: the 'Allow experimental features' hint names workflows, "
            "remote agents and RDP and VNC remote desktop, and no longer tunnels, services "
            "or network tools",
        ):
            self.open_settings_category("general")
            self.wait(lambda: self.driver.exists(TOGGLE), what="the experimental toggle")
            hint = self.wait(self._switch_hint, what="the experimental switch's hint")
            self.evidence(f"hint {hint!r}")
            self.shot(label="switch-hint")
            problems = experimental_hint_problems(hint)
            assert not problems, problems
            self.close_all_tabs()
            self.switch_to_connections_sidebar()

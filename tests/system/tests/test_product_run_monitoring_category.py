"""Product run: the Monitoring settings category (#5775).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Power monitoring, Monitor local shells and Status bar
metrics used to sit under Settings ▸ External files ▸ Advanced, where nobody
looked for them. Since #5775 they have their own Monitoring category in the
Terminal nav group; the setting keys did not change. (The File browser toggle
moved to General in #5786; ``test_product_run_file_browser_setting.py`` grades
that.)

The placement check is a pure function, graded without an app in the per-PR
lane by the tests at the bottom of this file.
"""

from __future__ import annotations

from collections.abc import Iterable

import pytest

from termihub_harness import SettingsUi, SystemTest
from termihub_harness.product_run import ProductRunUi

#: The fields the Monitoring category must show (testids).
MONITORING_FIELDS = (
    "toggle-power-monitoring",
    "toggle-monitor-local-shells",
    "settings-status-bar-metrics",
)
#: The Settings nav group the Monitoring category sits in (``CATEGORY_GROUPS``).
MONITORING_GROUP = "terminal"


def placement_problems(
    group: str | None,
    on_monitoring: Iterable[str],
    on_external_files: Iterable[str],
) -> list[str]:
    """What is wrong with the Monitoring category's placement, or ``[]``.

    ``group`` is the nav item's ``data-nav-group``; the two iterables are the
    :data:`MONITORING_FIELDS` testids found on each category's page.
    """
    problems = []
    if group != MONITORING_GROUP:
        problems.append(f"Monitoring sits in nav group {group!r}, want {MONITORING_GROUP!r}")
    shown = set(on_monitoring)
    problems += [f"'{f}' missing from Monitoring" for f in MONITORING_FIELDS if f not in shown]
    left = set(on_external_files)
    problems += [f"'{f}' still under External files" for f in MONITORING_FIELDS if f in left]
    return problems


@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunMonitoringCategory(ProductRunUi, SettingsUi, SystemTest):
    phase = "Monitoring category"

    def _fields_on(self, category: str) -> list[str]:
        self.open_settings_category(category)
        self.wait(
            lambda: self.driver.exists(f"settings-nav-{category}"),
            what=f"the {category} settings page",
        )
        return [f for f in MONITORING_FIELDS if self.driver.exists(f)]

    def test_01_monitoring_has_its_own_category(self):
        with self.step(
            "settings.monitoring.category",
            "Host monitoring settings have their own Monitoring category (#5775)",
            expect="Settings ▸ Monitoring with Power monitoring, Monitor local shells and "
            "Status bar metrics",
        ):
            on_external_files = self._fields_on("external-files")
            on_monitoring = self._fields_on("monitoring")
            self.wait(
                lambda: self.driver.exists("settings-monitoring"), what="the Monitoring page"
            )
            group = self.driver.get_attribute("settings-nav-monitoring", "data-nav-group")
            self.evidence(f"nav group {group!r}; fields {on_monitoring}")
            problems = placement_problems(group, on_monitoring, on_external_files)
            assert not problems, problems


# ── Per-PR grade checks (no app) ─────────────────────────────────────────────
def test_the_new_placement_passes():
    assert placement_problems("terminal", MONITORING_FIELDS, ()) == []


def test_the_old_placement_is_named():
    problems = placement_problems("connections", (), MONITORING_FIELDS)
    assert problems[0] == "Monitoring sits in nav group 'connections', want 'terminal'"
    assert "'toggle-power-monitoring' missing from Monitoring" in problems
    assert "'settings-status-bar-metrics' still under External files" in problems


def test_a_missing_field_is_named():
    shown = ("toggle-power-monitoring", "settings-status-bar-metrics")
    assert placement_problems("terminal", shown, ()) == [
        "'toggle-monitor-local-shells' missing from Monitoring"
    ]

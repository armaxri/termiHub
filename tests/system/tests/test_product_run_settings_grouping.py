"""Product run: Settings grouped by object (#5860, decision A of 2026-11-23).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). The usability review of run ``20261123T215628Z`` found:

- **R-041 / R-051**: Schedules, Plugins and Import & migration hid under a folded
  Advanced group; SSH defaults and the File browser default sat under General.
- **R-125**: Monitoring sat under the Terminal group, though it is about hosts.
- **R-052**: two backup places, Security's "Credential vault backup" and Backup
  & restore, with "vault" words also for the OS Keychain.
- **R-018**: schedules listed in Settings and in the Automations sidebar, with
  different controls.

Since #5860 the nav groups settings by what they are about: Connections holds
the connection defaults (SSH user and key, X11, file browser), Serial,
Monitoring and External files; Automation holds Schedules, which opens the one
list in the Automations sidebar; Plugins and Open in termiHub are under General,
Backup & restore and Import & migration under Security and data; Advanced folds
only the X server and Portable mode. Security points to Backup & restore.

The grades are pure functions over what the live run reads, graded without an
app in the per-PR lane by the tests at the bottom of this file.
"""

from __future__ import annotations

from typing import Optional

import pytest

from termihub_harness import AutomationSidebarUi, SettingsUi, SystemTest
from termihub_harness.product_run import ProductRunUi

#: Where each category belongs (``settingsRegistry.ts`` CATEGORY_GROUPS).
GROUP_OF = {
    "connection-defaults": "connections",
    "serial": "connections",
    "monitoring": "connections",
    "external-files": "connections",
    "schedules": "automation",
    "plugins": "general",
    "shell-integration": "general",
    "backup": "security",
    "import": "security",
    "x-server": "advanced",
    "portable": "advanced",
}
#: The only categories a fresh Settings tab folds away.
FOLDED = {"x-server", "portable"}
#: The fields that moved to Connection defaults (testids).
CONNECTION_DEFAULTS = (
    "settings-default-user",
    "settings-default-x11-forwarding",
    "toggle-file-browser",
)
#: The second, passwords-only export that #5860 removed.
OLD_VAULT_ACTIONS = ("credential-vault-export-btn", "credential-vault-import-btn")


def nav_problems(groups: dict[str, Optional[str]], folded: set[str]) -> list[str]:
    """What is wrong with the nav groups, or ``[]``.

    ``groups`` maps a category to its nav item's ``data-nav-group``; ``folded``
    holds the categories whose item starts in a folded group.
    """
    problems = [
        f"{category} sits in group {groups.get(category)!r}, want {group!r}"
        for category, group in GROUP_OF.items()
        if groups.get(category) != group
    ]
    if folded != FOLDED:
        problems.append(f"folded at first: {sorted(folded)}, want {sorted(FOLDED)}")
    return problems


def page_problems(
    *,
    on_general: set[str],
    on_defaults: set[str],
    schedules_open: bool,
    schedules_list_in_settings: bool,
    sidebar_list_after_open: bool,
    security_points_to_backup: bool,
    old_vault_actions: set[str],
    older_export_restore: bool,
) -> list[str]:
    """What is wrong with the moved pages, or ``[]``."""
    problems = []
    if on_general:
        problems.append(f"still under General: {sorted(on_general)}")
    problems += [
        f"'{f}' missing from Connection defaults" for f in CONNECTION_DEFAULTS if f not in on_defaults
    ]
    if not schedules_open:
        problems.append("Settings ▸ Schedules has no Open schedules button")
    if schedules_list_in_settings:
        problems.append("Settings ▸ Schedules still shows a second schedules list (R-018)")
    if not sidebar_list_after_open:
        problems.append("Open schedules does not show the Automations sidebar's list")
    if not security_points_to_backup:
        problems.append("Security does not point to Backup & restore")
    if old_vault_actions:
        problems.append(f"Security still offers its own export: {sorted(old_vault_actions)} (R-052)")
    if not older_export_restore:
        problems.append("Backup & restore cannot restore an older password export")
    return problems


@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunSettingsGrouping(ProductRunUi, AutomationSidebarUi, SettingsUi, SystemTest):
    phase = "Settings grouping"

    def _on(self, category: str, fields: tuple[str, ...]) -> set[str]:
        self.open_settings_category(category)
        self.wait(
            lambda: self.driver.get_attribute(f"settings-nav-{category}", "aria-selected")
            == "true",
            what=f"the {category} settings page",
        )
        return {f for f in fields if self.driver.exists(f)}

    def test_01_nav_groups_by_object(self):
        with self.step(
            "settings.grouping.nav",
            "The Settings nav groups settings by object; Advanced folds only two pages (#5860)",
            expect="Settings: General (… Open in termiHub, Plugins, Updates), Terminal, "
            "Connections (Connection defaults, Serial, Monitoring, External files), Automation "
            "(Schedules), Security and data (… Backup & restore, Import & migration), and a "
            "folded Advanced with X server and Portable mode",
        ):
            self.close_all_tabs()
            self.open_settings_category("general")
            groups = {
                c: self.driver.get_attribute(f"settings-nav-{c}", "data-nav-group")
                for c in GROUP_OF
            }
            folded = {
                c
                for c in GROUP_OF
                if self.driver.get_attribute(f"settings-nav-{c}", "data-group-collapsed")
                == "true"
            }
            self.evidence(f"groups {groups}; folded {sorted(folded)}")
            self.shot(label="nav", expect="settings-category-nav")
            problems = nav_problems(groups, folded)
            assert not problems, "; ".join(problems)

    def test_02_moved_pages(self):
        with self.step(
            "settings.grouping.pages",
            "Connection defaults, the one schedules list and the one backup flow (#5860)",
            expect="Connection defaults holds Default user, X11 forwarding and File browser; "
            "Schedules opens the Automations sidebar's list; Security ▸ Back up saved "
            "passwords points to Backup & restore, which restores an older export too",
        ):
            on_general = self._on("general", CONNECTION_DEFAULTS)
            on_defaults = self._on("connection-defaults", CONNECTION_DEFAULTS)
            self.shot(label="connection-defaults", expect="settings-panel-content")

            self.open_settings_category("schedules")
            self.wait(lambda: self.driver.exists("schedules-settings"), what="Settings ▸ Schedules")
            schedules_open = self.driver.exists("schedules-settings-open")
            in_settings = self.driver.exists("schedules-pause-toggle")
            self.shot(label="schedules", expect="settings-panel-content")
            self.close_automation_schedules()
            if schedules_open:
                self.driver.click("schedules-settings-open")
            sidebar_list = bool(
                self.wait(
                    lambda: self.driver.exists("schedules-section"),
                    what="the Automations sidebar's schedules list",
                )
            )
            self.shot(label="schedules-opened")

            self.open_settings_category("security")
            self.wait(lambda: self.driver.exists("password-backup"), what="Back up saved passwords")
            self.driver.scroll_into_view("password-backup")
            points = self.driver.exists("password-backup-open") or self.driver.exists(
                "password-backup-unavailable"
            )
            old = {t for t in OLD_VAULT_ACTIONS if self.driver.exists(t)}
            self.shot(label="security-backup", expect="settings-panel-content")

            self.open_settings_category("backup")
            self.wait(lambda: self.driver.exists("backup-restore-settings"), what="Backup & restore")
            older = self.driver.exists("older-password-import")
            self.shot(label="backup", expect="settings-panel-content")

            self.evidence(
                f"general {sorted(on_general)}; defaults {sorted(on_defaults)}; "
                f"schedules open {schedules_open}, list in settings {in_settings}, sidebar list "
                f"{sidebar_list}; security points {points}, old {sorted(old)}; older {older}"
            )
            problems = page_problems(
                on_general=on_general,
                on_defaults=on_defaults,
                schedules_open=schedules_open,
                schedules_list_in_settings=in_settings,
                sidebar_list_after_open=sidebar_list,
                security_points_to_backup=points,
                old_vault_actions=old,
                older_export_restore=older,
            )
            assert not problems, "; ".join(problems)


# ── Per-PR grade checks (no app) ─────────────────────────────────────────────
def _good_pages() -> dict:
    return {
        "on_general": set(),
        "on_defaults": set(CONNECTION_DEFAULTS),
        "schedules_open": True,
        "schedules_list_in_settings": False,
        "sidebar_list_after_open": True,
        "security_points_to_backup": True,
        "old_vault_actions": set(),
        "older_export_restore": True,
    }


def test_the_new_nav_passes():
    assert nav_problems(dict(GROUP_OF), set(FOLDED)) == []


def test_the_old_nav_is_named():
    old = dict(GROUP_OF)
    old.update(
        {
            "schedules": "advanced",
            "plugins": "advanced",
            "import": "advanced",
            "monitoring": "terminal",
            "connection-defaults": None,
        }
    )
    problems = nav_problems(old, FOLDED | {"schedules", "plugins", "import"})
    assert "schedules sits in group 'advanced', want 'automation'" in problems
    assert "monitoring sits in group 'terminal', want 'connections'" in problems
    assert "connection-defaults sits in group None, want 'connections'" in problems
    assert problems[-1].startswith("folded at first: ['import', 'plugins', 'portable'")


def test_the_new_pages_pass():
    assert page_problems(**_good_pages()) == []


def test_the_old_pages_are_named():
    old = _good_pages()
    old.update(
        on_general=set(CONNECTION_DEFAULTS),
        on_defaults=set(),
        schedules_open=False,
        schedules_list_in_settings=True,
        old_vault_actions=set(OLD_VAULT_ACTIONS),
        older_export_restore=False,
    )
    problems = page_problems(**old)
    assert problems[0].startswith("still under General: ")
    assert "'toggle-file-browser' missing from Connection defaults" in problems
    assert "Settings ▸ Schedules still shows a second schedules list (R-018)" in problems
    assert any("(R-052)" in p for p in problems)
    assert "Backup & restore cannot restore an older password export" in problems

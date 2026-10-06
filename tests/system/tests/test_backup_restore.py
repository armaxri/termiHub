"""Unified backup and restore through the native file dialogs, with the restart
(PROD-068, #3509; automated in #4127 — was the manual MT-APP-01).

The Rust suites (``src-tauri/src/backup/tests*.rs``) prove the format, the
encryption and the staged restore that the next start swaps in. What they do not
cover is the user's path through the real app: Settings → Backup & Restore →
**Back up everything…** with a passphrase and the native Save dialog, then
**Restore…** with the native Open dialog, the preview, **Restore and restart**,
and the app coming back with the data restored.

Both native dialogs are stubbed with ``driver.stub_native_dialog`` (#4122). The
app restarts *itself* after the restore (``AppHandle::request_restart``), so the
harness follows that relaunch with ``adopt_app_self_restart`` instead of
restarting the app on its own. Marked ``integration`` (needs the built
test-bridge app).
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from termihub_harness import (
    SETTINGS_REGION,
    ConnectionsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    unique_name,
)

pytestmark = [pytest.mark.integration]

#: The passphrase sealing the backup (the dialog's minimum is 12 characters).
_PASSPHRASE = "harness-backup-pw-4127"
#: The Appearance theme select, and the theme kept in the backup vs. the one
#: switched to afterwards.
_THEME_SELECT = "appearance-theme-select"
_BACKED_UP_THEME = "light"
_CHANGED_THEME = "dark"


class TestBackupRestore(ConnectionsUi, SidebarUi, SettingsUi, TabsUi, SystemTest):
    """Back up with a passphrase, change things, restore, and restart."""

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _set_theme(self, theme: str) -> None:
        """Pick ``theme`` in Settings → Appearance and wait until it is saved."""
        self.select_setting(
            "appearance", _THEME_SELECT, theme, key="theme", expected=theme
        )

    def _back_up(self, target: Path) -> None:
        """Back up everything, encrypted with the passphrase, to a stubbed Save path."""
        self.open_settings_category("backup")
        self.wait(lambda: self.driver.exists("backup-export-btn"), what="the Back up button")
        self.driver.click("backup-export-btn")
        self.wait(
            lambda: self.driver.exists("backup-export-section-connections"),
            what="the backup sections to load",
        )
        # The sections that exist here are pre-selected; leave the credentials
        # out (an OS-keychain export would ask for the OS password).
        if self.driver.get_attribute("backup-export-credentials", "aria-checked") == "true":
            self.driver.click("backup-export-credentials")
        for section in ("connections", "settings"):
            checked = self.driver.get_attribute(
                f"backup-export-section-{section}", "aria-checked"
            )
            assert checked == "true", f"the {section} section is not selected: {checked!r}"
        self.driver.type("backup-export-passphrase", _PASSPHRASE)
        self.driver.type("backup-export-confirm", _PASSPHRASE)
        self.driver.stub_native_dialog("save", target)
        self.driver.click("backup-export-submit")
        self.wait(
            lambda: target.exists() and target.stat().st_size > 0,
            what=f"the backup to be written to {target}",
        )
        self.wait(
            lambda: not self.driver.exists("backup-export-title"),
            what="the backup dialog to close after saving",
        )
        assert not self.driver.exists("backup-export-error")

    def _restore(self, target: Path) -> None:
        """Pick the backup (stubbed Open), preview it, and Restore and restart."""
        self.open_settings_category("backup")
        self.wait(lambda: self.driver.exists("backup-restore-btn"), what="the Restore button")
        self.driver.click("backup-restore-btn")
        self.wait(
            lambda: self.driver.exists("backup-restore-choose-file"),
            what="the restore dialog",
        )
        self.driver.stub_native_dialog("open", target)
        self.driver.click("backup-restore-choose-file")
        self.wait(
            lambda: self.driver.get_text("backup-restore-file-name") == target.name,
            what="the picked backup to be read",
        )
        assert "encrypted" in self.driver.get_text("backup-restore-header")
        self.driver.type("backup-restore-passphrase", _PASSPHRASE)
        self.driver.click("backup-restore-preview")
        self.wait(
            lambda: self.driver.exists("backup-restore-preview-panel"),
            what="the restore preview",
        )
        for section in ("connections", "settings"):
            included = self.driver.get_attribute(
                f"backup-restore-include-{section}", "aria-checked"
            )
            assert included == "true", f"the {section} section is not restored: {included!r}"
        self.driver.click("backup-restore-submit")

    # ── MT-APP-01 ────────────────────────────────────────────────────────────
    def test_backup_and_restore_bring_back_a_connection_and_the_theme(self):
        """A sealed backup restores a deleted connection and the theme after a restart.

        The harness creates a connection and picks the light theme, backs up
        everything with a passphrase to a stubbed Save path, and checks the file
        is sealed: an encrypted envelope, with neither the connection name nor
        the passphrase readable in it. It then deletes the connection and
        switches to the dark theme, restores the file through a stubbed Open
        pick with the passphrase, and confirms Restore and restart. The app
        restarts itself; after the restart the connection is listed again and
        the theme is light.
        """
        self.close_all_tabs()
        name = unique_name("backup-conn")
        self.create_local_connection(name)
        self._set_theme(_BACKED_UP_THEME)

        target = Path(tempfile.mkdtemp(prefix="thub-backup-")) / "termihub-backup.json"
        self._back_up(target)

        blob = target.read_text(encoding="utf-8")
        doc = json.loads(blob)
        assert doc.get("format") == "termihub-backup", f"not a backup file: {doc.get('format')!r}"
        assert doc.get("encrypted") is True and "envelope" in doc, "the backup is not sealed"
        assert "contents" not in doc, "an encrypted backup carries plaintext contents"
        assert name not in blob, "the connection name is readable in the sealed backup"
        assert _PASSPHRASE not in blob, "the passphrase reached the backup file"

        # Change what the backup holds: delete the connection, switch the theme.
        self.switch_to_connections_sidebar()
        self.connection_context_action(name, self.CTX_DELETE)
        self.wait(lambda: self.find_connection(name) is None, what="the connection to be deleted")
        self._set_theme(_CHANGED_THEME)

        self._restore(target)
        # "Restore and restart": the app relaunches itself to load the restore.
        self.adopt_app_self_restart()

        self.switch_to_connections_sidebar()
        self.wait(
            lambda: self.find_connection(name),
            what=f"the restored connection {name!r} after the restart",
        )
        self.wait(
            lambda: self.projection_region_cache(SETTINGS_REGION).get("theme")
            == _BACKED_UP_THEME,
            what=f"the restored {_BACKED_UP_THEME!r} theme after the restart",
        )
        assert self.persisted_settings().get("theme") == _BACKED_UP_THEME

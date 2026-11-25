"""Unified backup and restore through the native file dialogs, with the restart
(PROD-068, #3509; automated in #4127 — was the manual MT-APP-01).

The Rust suites (``src-tauri/src/backup/tests*.rs``) prove the format, the
encryption and the staged restore that the next start swaps in. What they do not
cover is the user's path through the real app: Settings → Backup & Restore →
**Back up…** with a passphrase and the native Save dialog, then
**Restore…** with the native Open dialog, the preview, **Restore and restart**,
and the app coming back with the data restored.

Both native dialogs are stubbed with ``driver.stub_native_dialog`` (#4122). The
app restarts *itself* after the restore (``utils::relaunch``, #5647), so the
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

#: Entries of a backup from another machine that would start by themselves (#6056).
_TUNNEL_ID = "restored-tunnel"
_AUTOMATION_ID = "restored-automation"


def _backup_from_elsewhere(path: Path, automation: str, tunnel: str) -> None:
    """A backup without a passphrase holding an armed trigger and a starting tunnel."""
    stamp = "2026-01-01T00:00:00+00:00"
    sections = [
        {
            "id": "automations",
            "schemaVersion": 1,
            "data": {
                "version": "1",
                "automations": [
                    {
                        "id": _AUTOMATION_ID,
                        "name": automation,
                        "steps": [{"kind": "send-command", "command": "echo restored"}],
                        "triggers": [{"kind": "hotkey", "binding": "Ctrl+Alt+Shift+F9"}],
                        "createdAt": stamp,
                        "updatedAt": stamp,
                    }
                ],
            },
        },
        {
            "id": "tunnels",
            "schemaVersion": 1,
            "data": {
                "version": "1",
                "tunnels": [
                    {
                        "id": _TUNNEL_ID,
                        "name": tunnel,
                        "sshConnectionId": "not-here",
                        "tunnelType": {
                            "type": "local",
                            "config": {
                                "localHost": "127.0.0.1",
                                "localPort": 1,
                                "remoteHost": "127.0.0.1",
                                "remotePort": 1,
                            },
                        },
                        "autoStart": True,
                        "startWithConnection": True,
                        "reconnectOnDisconnect": False,
                    }
                ],
            },
        },
    ]
    head = {
        "format": "termihub-backup",
        "formatVersion": 1,
        "createdAt": stamp,
        "appVersion": "0.1.0",
    }
    contents = {
        "format": head["format"],
        "formatVersion": 1,
        "createdAt": stamp,
        "sections": sections,
        "credentials": None,
    }
    path.write_text(
        json.dumps({**head, "encrypted": False, "contents": contents}), encoding="utf-8"
    )

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
        self.driver.click("backup-export-next")  # one secret per step (#5847)
        self.wait(
            lambda: self.driver.exists("backup-export-passphrase"),
            what="the backup passphrase step",
        )
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
        header = self.driver.get_text("backup-restore-header")
        assert "· encrypted" in header, f"the backup is not read as encrypted: {header!r}"
        self.driver.type("backup-restore-passphrase", _PASSPHRASE)
        self.driver.click("backup-restore-preview")
        self.wait(
            lambda: self.driver.exists("backup-restore-preview-panel"),
            what="the restore preview",
        )
        included = self.driver.get_attribute("backup-restore-include-connections", "aria-checked")
        assert included == "true", f"the connections section is not restored: {included!r}"
        # Settings can only be replaced, so it starts unticked (#5824): tick it
        # on purpose to bring the theme back.
        settings = self.driver.get_attribute("backup-restore-include-settings", "aria-checked")
        assert settings == "false", f"settings is restored by default: {settings!r}"
        self.driver.click("backup-restore-include-settings")
        self.wait(
            lambda: self.driver.get_attribute("backup-restore-include-settings", "aria-checked")
            == "true",
            what="settings to be ticked",
        )
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

    # ── #6056 ────────────────────────────────────────────────────────────────
    def _stored(self, file_name: str, field: str, item_id: str) -> dict:
        """An item of a store file, or an empty dict."""
        doc = json.loads((Path(self.config_dir) / file_name).read_text(encoding="utf-8"))
        return next((i for i in doc[field] if i["id"] == item_id), {})

    def test_what_a_restore_brings_starts_only_after_the_user_turned_it_on(self):
        """A restored trigger and tunnel arrive off, are listed, and one is turned on.

        The preview lists both entries; after the restart the question lists them with
        nothing ticked. Only the automation is ticked: its triggers are on then, the
        tunnel stays off, and nothing is offered again.
        """
        self.close_all_tabs()
        automation, tunnel = unique_name("restored-auto"), unique_name("restored-tunnel")
        target = Path(tempfile.mkdtemp(prefix="thub-backup-")) / "elsewhere.json"
        _backup_from_elsewhere(target, automation, tunnel)

        self.open_settings_category("backup")
        self.wait(lambda: self.driver.exists("backup-restore-btn"), what="the Restore button")
        self.driver.click("backup-restore-btn")
        self.wait(
            lambda: self.driver.exists("backup-restore-choose-file"), what="the restore dialog"
        )
        self.driver.stub_native_dialog("open", target)
        self.driver.click("backup-restore-choose-file")
        self.wait(
            lambda: self.driver.get_text("backup-restore-file-name") == target.name,
            what="the picked backup to be read",
        )
        self.driver.click("backup-restore-preview")
        self.wait(
            lambda: self.driver.exists("backup-restore-switched-off"),
            what="the preview to say what arrives switched off",
        )
        said = self.driver.get_text(f"backup-restore-off-automations-{_AUTOMATION_ID}")
        assert automation in said and "Hotkey" in said, f"the preview says {said!r}"
        said = self.driver.get_text(f"backup-restore-off-tunnels-{_TUNNEL_ID}")
        assert tunnel in said and "When termiHub starts" in said, f"the preview says {said!r}"
        self.driver.click("backup-restore-submit")
        self.adopt_app_self_restart()

        tick = f"restored-off-check-automations-{_AUTOMATION_ID}"
        self.wait(lambda: self.driver.exists(tick), what="the question after the restart")
        for check in (tick, f"restored-off-check-tunnels-{_TUNNEL_ID}"):
            checked = self.driver.get_attribute(check, "aria-checked")
            assert checked == "false", f"{check} is ticked from the start: {checked!r}"
        stored = self._stored("automations.json", "automations", _AUTOMATION_ID)
        assert stored.get("triggersEnabled") is False, f"its triggers are armed: {stored!r}"
        self.driver.click(tick)
        self.driver.click("restored-off-turn-on")
        self.wait(lambda: not self.driver.exists(tick), what="the question to close")

        stored = self._stored("automations.json", "automations", _AUTOMATION_ID)
        assert stored.get("triggersEnabled") is not False, f"its triggers are off: {stored!r}"
        stored = self._stored("tunnels.json", "tunnels", _TUNNEL_ID)
        assert stored["autoStart"] is False and stored["startWithConnection"] is False
        assert not (Path(self.config_dir) / "restored-off.json").exists()

"""MobaXterm import graded against a committed fixture (#4960, MT-APP-05).

Replaces the guided check that asked an operator to install MobaXterm, save a
few sessions and eyeball the import. The fixture under
``tests/fixtures/mobaxterm/`` is fully synthetic (example.com / RFC 5737
addresses, invented names, a dummy key path): a ``MobaXterm.ini`` with an SSH
session using a private key, a Telnet session, a Serial session in a nested
sub-folder, a Browser session (no termiHub counterpart) and a ``[Passwords]``
entry that must never be imported; ``example.mxtsessions`` is the matching
export of the same bookmarks.

The app is never pointed at a real MobaXterm profile:

- **Windows**: the suite's app runs with ``APPDATA`` redirected to a scratch
  dir holding ``MobaXterm\\MobaXterm.ini``, so autodiscovery finds the fixture
  as the installed edition's file and the dialog previews it without a pick.
- **macOS / Linux**: MobaXterm is Windows-only, so discovery reports nothing
  and the fixture is picked through the stubbed native open dialog (#4122).

Graded: the Import & Migration page names the detected file (Windows) or says
none was found; the preview lists type / target / folder per session; the
Browser session is under *Not imported*; the imported tree lands under the
chosen target folder with MobaXterm's folders recreated, a real key path (no
``_ProfileDir_``) and no password anywhere in the store or on disk; and the
``.mxtsessions`` export previews the same rows.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
)
from termihub_harness.ui.lookups import folders

pytestmark = pytest.mark.integration

_FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "mobaxterm"
_INI = _FIXTURES / "MobaXterm.ini"
_MXTSESSIONS = _FIXTURES / "example.mxtsessions"

#: The fixture's ``[Passwords]`` value: it must never reach termiHub.
_PASSWORD_TRAP = "SYNTHETIC-NOT-A-PASSWORD-4960"

_TARGET_FOLDER = "MobaXterm Import 4960"

#: Preview rows by session key (file order), as ``(name, type, target, folder)``.
_IMPORTABLE = {
    "moba-0": ("Example Telnet", "Telnet", "192.0.2.10:2323", ""),
    "moba-2": ("Example SSH", "SSH", "demo@ssh.example.com:2222", "Example Lab"),
    "moba-3": ("Example Serial", "Serial", "COM3 @ 115200", "Example Lab / Consoles"),
}
_SKIPPED = {"moba-1": ("Example Docs", "Browser", "termiHub has no Browser connection type.")}

_IS_WINDOWS = sys.platform == "win32"


def _meta(session_type: str, target: str, folder: str) -> str:
    """The row's meta line (``MobaxtermSessionList.metaLine``)."""
    return " · ".join(part for part in (session_type, target, folder) if part)


def _same_path(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


class TestMobaxtermImport(SidebarUi, TabsUi, ConnectionsUi, SettingsUi, SystemTest):
    """Import & Migration → MobaXterm, end to end against the fixture."""

    #: Where the Windows app looks for the installed edition's configuration.
    discovered_ini: Optional[Path] = None

    @classmethod
    def extra_app_env(cls, request: pytest.FixtureRequest) -> dict[str, str]:
        if not _IS_WINDOWS:
            return {}
        app_data = Path(tempfile.mkdtemp(prefix="thub_moba_appdata_"))
        request.addfinalizer(lambda: shutil.rmtree(app_data, ignore_errors=True))
        ini = app_data / "MobaXterm" / "MobaXterm.ini"
        ini.parent.mkdir(parents=True)
        shutil.copyfile(_INI, ini)
        cls.discovered_ini = ini
        return {"APPDATA": str(app_data)}

    # ── helpers ──────────────────────────────────────────────────────────────
    def _open_import_dialog(self) -> None:
        self.open_settings_category("import")
        self.wait(
            lambda: self.driver.exists("import-migration-mobaxterm-btn"),
            what="the Import from MobaXterm button",
        )
        self.driver.click("import-migration-mobaxterm-btn")
        self.wait(
            lambda: self.driver.exists("mobaxterm-import-source"),
            what="the MobaXterm import dialog to finish discovery",
        )

    def _pick(self, path: Path) -> None:
        """Pick ``path`` through the (stubbed) native open dialog."""
        self.driver.stub_native_dialog("open", path)
        self.driver.click("mobaxterm-import-choose-file")
        self._wait_for_preview_of(path)

    def _wait_for_preview_of(self, path: Path) -> None:
        def ready() -> bool:
            source = self.driver.get_text("mobaxterm-import-source")
            return path.name in source and self.driver.exists("mobaxterm-import-list")

        self.wait(ready, what=f"the preview of {path.name}")

    def _preview_rows(self) -> dict[str, str]:
        """Text of every preview row, importable and skipped, by session key."""
        rows = {}
        for key in _IMPORTABLE:
            rows[key] = self.driver.get_text(f"mobaxterm-import-row-{key}")
        for key in _SKIPPED:
            rows[key] = self.driver.get_text(f"mobaxterm-import-skip-{key}")
        return rows

    def _assert_preview(self) -> dict[str, str]:
        """The rows show name, type, target and folder; Browser is not imported."""
        rows = self._preview_rows()
        for key, (name, session_type, target, folder) in _IMPORTABLE.items():
            assert name in rows[key], f"{key}: {rows[key]!r}"
            assert _meta(session_type, target, folder) in rows[key], f"{key}: {rows[key]!r}"
        skipped = self.driver.get_text("mobaxterm-import-skipped")
        assert "Not imported (1)" in skipped, skipped
        for key, (name, session_type, reason) in _SKIPPED.items():
            assert name in rows[key] and session_type in rows[key], f"{key}: {rows[key]!r}"
            assert reason in rows[key], f"{key}: {rows[key]!r}"
            assert not self.driver.exists(f"mobaxterm-import-row-{key}"), (
                f"{name} must not be offered for import"
            )
        assert "3 of 3 selected" in self.driver.get_text("mobaxterm-import-dialog")
        return rows

    def _folder_by_id(self, folder_id: Any) -> Optional[dict[str, Any]]:
        return next((f for f in folders(self.driver) if f.get("id") == folder_id), None)

    def _folder_path(self, folder_id: Any) -> list[str]:
        """Folder names from the root down to ``folder_id``."""
        names: list[str] = []
        while folder_id:
            folder = self._folder_by_id(folder_id)
            if folder is None:
                return []
            names.insert(0, str(folder.get("name")))
            folder_id = folder.get("parentId")
        return names

    def _imported(self, name: str, folder: list[str]) -> Optional[dict[str, Any]]:
        conn = self.find_connection(name)
        if conn is None or self._folder_path(conn.get("folderId")) != folder:
            return None
        return conn

    # ── the grade ────────────────────────────────────────────────────────────
    def test_mobaxterm_import_previews_and_imports_the_fixture(self):
        """MT-APP-05: detect (Windows) or pick the fixture MobaXterm.ini, preview
        type/target/folder per session with the Browser one under Not imported,
        import the tree under a target folder with a resolved key path and no
        password, then preview the matching .mxtsessions export."""
        self.close_all_tabs()
        self.switch_to_connections_sidebar()
        target = self.create_folder(_TARGET_FOLDER)

        # The Import & Migration page names the detected file (Windows) or
        # says there is none (MobaXterm is Windows-only).
        self.open_settings_category("import")
        def discovered() -> Optional[str]:
            text = self.driver.get_text("import-migration-mobaxterm-hint")
            return None if "Looking for" in text else text

        hint = self.wait(discovered, what="MobaXterm discovery on the Import & Migration page")
        if self.discovered_ini is not None:
            assert "Found MobaXterm configuration at" in hint, hint
            assert str(self.discovered_ini) in hint, hint
        else:
            assert "No MobaXterm configuration was found" in hint, hint

        self._open_import_dialog()
        if self.discovered_ini is not None:
            # Previewed straight away, without a pick.
            self._wait_for_preview_of(self.discovered_ini)
            assert str(self.discovered_ini) in self.driver.get_text("mobaxterm-import-source")
        else:
            assert "No MobaXterm configuration was found" in self.driver.get_text(
                "mobaxterm-import-source"
            )
            self._pick(_INI)
        ini_rows = self._assert_preview()

        # Import everything selectable into the target folder.
        self.driver.select("mobaxterm-import-folder", str(target["id"]))
        submit = self.driver.get_text("mobaxterm-import-submit")
        assert submit == "Import 3", submit
        self.driver.click("mobaxterm-import-submit")
        self.wait(
            lambda: not self.driver.exists("mobaxterm-import-dialog"),
            what="the import dialog to close",
        )

        root = [_TARGET_FOLDER]
        telnet = self.wait(
            lambda: self._imported("Example Telnet", root), what="the imported Telnet session"
        )
        ssh = self.wait(
            lambda: self._imported("Example SSH", [*root, "Example Lab"]),
            what="the imported SSH session under Example Lab",
        )
        serial = self.wait(
            lambda: self._imported("Example Serial", [*root, "Example Lab", "Consoles"]),
            what="the imported Serial session under Example Lab / Consoles",
        )
        assert self.find_connection("Example Docs") is None, "the Browser session was imported"

        assert telnet["config"]["type"] == "telnet", telnet["config"]
        assert telnet["config"]["config"]["host"] == "192.0.2.10"
        assert telnet["config"]["config"]["port"] == 2323

        assert serial["config"]["type"] == "serial", serial["config"]
        assert serial["config"]["config"]["port"] == "COM3"
        assert str(serial["config"]["config"]["baudRate"]) == "115200"

        ssh_cfg = ssh["config"]["config"]
        assert ssh["config"]["type"] == "ssh", ssh["config"]
        assert ssh_cfg["host"] == "ssh.example.com" and ssh_cfg["port"] == 2222
        assert ssh_cfg["username"] == "demo"
        assert ssh_cfg["authMethod"] == "key", ssh_cfg
        key_path = str(ssh_cfg["keyPath"])
        assert "_ProfileDir_" not in key_path, key_path
        assert _same_path(key_path, str(Path.home() / "keys" / "demo_ed25519")), key_path

        # No password anywhere: not on the connections, not in the config dir.
        for conn in (telnet, ssh, serial):
            assert not conn["config"]["config"].get("password"), conn
            assert _PASSWORD_TRAP not in json.dumps(conn)
        on_disk = [
            p
            for p in Path(self.config_dir).rglob("*")
            if p.is_file() and _PASSWORD_TRAP.encode() in p.read_bytes()
        ]
        assert not on_disk, f"the MobaXterm password reached {on_disk}"

        # The .mxtsessions export of the same bookmarks previews the same rows.
        self._open_import_dialog()
        if self.discovered_ini is not None:
            self._wait_for_preview_of(self.discovered_ini)
        self._pick(_MXTSESSIONS)
        assert self._assert_preview() == ini_rows
        self.driver.click("mobaxterm-import-cancel")
        self.wait(
            lambda: not self.driver.exists("mobaxterm-import-dialog"),
            what="the import dialog to close",
        )

"""Guided-manual tests for native OS file/save dialogs (issue #916).

These are the flows that open a native OS dialog the in-webview bridge cannot
drive. Each follows the guided-manual contract (#914): the **harness does all
the automatable work** — launch the app, build the state, and open the
dialog-triggering control so the native dialog is already up — then hands the
operator only the un-automatable step (pick / save the path the harness names),
and finally **verifies the outcome automatically** via the store or the file on
disk. That auto-verification is the difference from the old YAML runner, which
left the whole check to the human.

Covered: Export connections (MT-CONN-09), Import connections (MT-CONN-08), the
SSH key **Browse** button (MT-CONN-17), and Save terminal to file (MT-TAB-08).
Encrypted import (MT-CONN-12..16), Open-in-Editor → Save As (MT-TAB-17..19) and
portable export (MT-PORT-04) remain follow-ups.

Marked ``manual`` + ``integration``, so they **skip** on CI / normal runs and
run only under ``./pytest.sh --manual -k native_dialog -s`` with an operator.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from termihub_harness import (
    ConnectionsUi,
    ManualUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = [pytest.mark.integration, pytest.mark.manual]

#: A pre-generated key the operator browses to (exists in the repo).
_SSH_KEY_FIXTURE = (
    Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "ssh-keys" / "ecdsa_256"
)


class TestNativeDialogs(
    TerminalUi, TabsUi, ConnectionsUi, SidebarUi, ManualUi, SystemTest
):
    """Native-dialog flows: harness sets up + opens the dialog, operator picks,
    harness verifies the result."""

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _scratch(self, prefix: str, name: str) -> Path:
        """A fresh temp path the operator will save to / pick in the dialog."""
        return Path(tempfile.mkdtemp(prefix=f"thub-{prefix}-")) / name

    def _open_activity_menu_item(self, item_testid: str) -> None:
        """Open the activity-bar gear menu and select one of its items."""
        self.driver.click("activity-bar-settings")
        self.wait(
            lambda: self.driver.exists(item_testid),
            what=f"the {item_testid!r} menu item",
        )
        self.driver.click(item_testid)

    def _import_connections_doc(self, name: str) -> dict:
        """A minimal valid export-format document with one local connection.

        Mirrors ``ConnectionManager::export_json`` (``version: "2"`` +
        ``children`` tree), so the app's importer accepts it.
        """
        return {
            "version": "2",
            "children": [
                {"type": "connection", "name": name, "config": {"type": "local", "config": {}}}
            ],
            "agents": [],
        }

    # ── Export connections (MT-CONN-09) ──────────────────────────────────────
    def test_export_connections_writes_a_json_file(self):
        """Harness creates a connection and opens the Save dialog; operator saves;
        harness asserts the JSON file holds the connection."""
        self.close_all_tabs()
        name = unique_name("export")
        self.create_local_connection(name)
        self.switch_to_connections_sidebar()

        target = self._scratch("export", "connections-export.json")
        # Drive everything up to the native Save dialog: gear → Export → plain → submit.
        self._open_activity_menu_item("settings-menu-export")
        self.wait(lambda: self.driver.exists("export-submit"), what="the export dialog")
        self.driver.click("export-mode-plain")
        self.driver.click("export-submit")

        self.manual_step(
            f"A native Save dialog is open. Save the file as exactly:\n"
            f"      {target}",
            f"The file {target.name} is written to that location.",
        )

        assert target.exists(), f"no export written at {target}"
        blob = json.dumps(json.loads(target.read_text(encoding="utf-8")))
        assert name in blob, "exported JSON does not contain the connection name"

    # ── Import connections (MT-CONN-08) ──────────────────────────────────────
    def test_import_connections_adds_the_connection(self):
        """Harness writes a fixture export file and opens the Open dialog; operator
        picks it; harness asserts the connection appears in the store."""
        self.close_all_tabs()
        name = unique_name("import")
        fixture = self._scratch("import", "to-import.json")
        fixture.write_text(
            json.dumps(self._import_connections_doc(name)), encoding="utf-8"
        )

        # gear → Import opens the native Open dialog immediately.
        self._open_activity_menu_item("settings-menu-import")
        self.manual_step(
            f"A native Open dialog is open. Select this file:\n      {fixture}",
            "The Import dialog appears for the selected file.",
        )

        # After the operator picks the file, the in-app Import dialog appears —
        # finish a plain (no-credentials) import from there.
        self.wait(
            lambda: self.driver.exists("import-without-credentials")
            or self.driver.exists("import-submit"),
            what="the import dialog",
        )
        if self.driver.exists("import-without-credentials"):
            self.driver.click("import-without-credentials")
        else:
            self.driver.click("import-submit")

        self.switch_to_connections_sidebar()
        self.wait(
            lambda: self.find_connection(name),
            what=f"the imported connection {name!r}",
        )

    # ── SSH key Browse button (MT-CONN-17) ───────────────────────────────────
    def test_ssh_key_browse_populates_the_path(self):
        """Harness opens the SSH editor on key auth and clicks Browse; operator
        picks the fixture key; harness asserts the path field is populated."""
        self.close_all_tabs()
        self.open_new_connection_editor()
        self.driver.type("connection-editor-name-input", unique_name("key-browse"))
        self.select_connection_type("ssh")
        self.wait(lambda: self.driver.exists("field-authMethod"), what="the SSH fields")
        self.driver.select("field-authMethod", "key")
        self.wait(
            lambda: self.driver.exists(self.KEY_PATH_BROWSE),
            what="the key-path Browse button",
        )
        self.driver.click(self.KEY_PATH_BROWSE)

        self.manual_step(
            f"A native Open dialog is open. Select this key file:\n"
            f"      {_SSH_KEY_FIXTURE}",
            "The key-path field fills in with the chosen file.",
        )

        value = self.wait(
            lambda: self.driver.get_value(self.KEY_PATH_INPUT) or None,
            what="the key-path field to populate",
        )
        assert _SSH_KEY_FIXTURE.name in value, f"key path field shows {value!r}"
        self.driver.click(self.EDITOR_CANCEL)

    # ── Save terminal to file (MT-TAB-08) ────────────────────────────────────
    def test_save_terminal_to_file_writes_the_output(self):
        """Harness produces known terminal output and opens the Save dialog;
        operator saves; harness asserts the saved file holds the output."""
        self.close_all_tabs()
        self.ensure_terminal()
        marker = "SAVE_TO_FILE_MARKER_4218"
        self.run_command(f"echo {marker}")
        self.wait_for_output(marker)

        tab = self.active_tab()
        assert tab is not None
        target = self._scratch("termsave", "terminal-output.txt")

        # Right-click the tab and choose Save → opens the native Save dialog.
        self.driver.context_menu(f"tab-{tab['id']}")
        self.wait(
            lambda: self.driver.exists("tab-context-save"), what="the tab context menu"
        )
        self.driver.click("tab-context-save")

        self.manual_step(
            f"A native Save dialog is open. Save the terminal output as exactly:\n"
            f"      {target}",
            f"The file {target.name} is written with the terminal's text.",
        )

        # Saving may raise the "open the saved file?" prompt — dismiss it.
        if self.driver.exists("open-saved-file-cancel"):
            self.driver.click("open-saved-file-cancel")

        assert target.exists(), f"no terminal dump written at {target}"
        assert marker in target.read_text(encoding="utf-8", errors="replace")

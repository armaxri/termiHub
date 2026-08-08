"""Guided-manual tests for native OS file/save dialogs (issues #916, #1004).

These are the flows that open a native OS dialog the in-webview bridge cannot
drive. Each follows the guided-manual contract (#914): the **harness does all
the automatable work** — launch the app, build the state, and open the
dialog-triggering control so the native dialog is already up — then hands the
operator only the un-automatable step (pick / save the path the harness names),
and finally **verifies the outcome automatically** via the store or the file on
disk. That auto-verification is the difference from the old YAML runner, which
left the whole check to the human.

Covered (#916): Export connections (MT-CONN-09), Import connections (MT-CONN-08),
the SSH key **Browse** button (MT-CONN-17), and Save terminal to file
(MT-TAB-08).

Covered (#1004, the deferred follow-ups): Encrypted export+import round-trip
(MT-CONN-12..16), Open-in-Editor → Save As + the unsaved-changes warning
(MT-TAB-17/18/19), portable config export/import (MT-PORT-04), and adding an
external connection file (MT-CONN-23). In each, the harness automates every
bridge-drivable half — building the credential/connection/editor/external-file
state, typing the export/import password, asserting the imported credential, the
saved-file content, the registered external file, the cleared unsaved state —
and the operator performs **only** the native file pick / save.

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
    CredentialStoreUi,
    EditorUi,
    ManualUi,
    PasswordPromptUi,
    SETTINGS_REGION,
    SettingsUi,
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

#: Master password for the credential store in the encrypted round-trip case.
_MASTER_PASSWORD = "harness-master-pw-1004"
#: Password stored for the SSH connection (the credential that gets encrypted).
_STORED_SSH_PASSWORD = "harness-ssh-secret-1004"
#: Password protecting the encrypted export blob (the operator never types this).
_EXPORT_PASSWORD = "harness-export-pw-1004"


class TestNativeDialogs(
    TerminalUi,
    TabsUi,
    ConnectionsUi,
    SidebarUi,
    SettingsUi,
    CredentialStoreUi,
    PasswordPromptUi,
    EditorUi,
    ManualUi,
    SystemTest,
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

    # ── Encrypted export + import round-trip (MT-CONN-12..16) ─────────────────
    def test_encrypted_export_import_round_trip(self):
        """Encrypted credentials survive a native-dialog export+import.

        The harness does the whole bridge-drivable half (#1004): set up a
        master-password store, save an SSH password into it, then export **with
        credentials** (encrypted, a password the harness types) and import the
        same file back **with credentials** (typing the export password). The
        operator performs only the two native dialogs — the Save in export and
        the Open pick in import. The harness asserts the import dialog reports
        the credential was imported, exercising the real Argon2id + AES-256-GCM
        round-trip rather than re-implementing the crypto in a fixture.
        """
        self.close_all_tabs()
        # 1) An unlocked master-password store is what makes credentials savable
        #    (and what makes the export's encrypted section non-empty).
        self.setup_master_password_store(_MASTER_PASSWORD)

        # 2) A password-auth SSH connection whose password we store via the
        #    prompt's "Save password" box — the credential is persisted the
        #    moment the prompt is answered, before the (server-less) connect.
        name = unique_name("enc-import")
        self.create_ssh_connection(
            name,
            host="127.0.0.1",
            port=1,  # unroutable: the connect fails, but the credential is saved first
            username="harness",
            auth_method="password",
        )
        self.switch_to_connections_sidebar()
        self.connect_connection(name)
        # Enter the password, tick "Save password" so storeCredential persists it,
        # then Connect — the credential is saved the moment the prompt is answered,
        # before the (doomed, port-1) connect runs.
        self.wait(
            lambda: self.driver.exists("password-prompt-input"),
            what="the SSH password prompt",
        )
        self.driver.type("password-prompt-input", _STORED_SSH_PASSWORD)
        self.wait(
            lambda: self.driver.exists("password-prompt-save-checkbox"),
            what="the password-prompt Save checkbox",
        )
        self.driver.click("password-prompt-save-checkbox")
        self.driver.click("password-prompt-connect")
        # The connect to port 1 fails; close any error tab it produced.
        self.close_all_tabs()

        # 3) Export WITH credentials (encrypted) → native Save dialog.
        export_target = self._scratch("enc-export", "encrypted-export.json")
        self._open_activity_menu_item("settings-menu-export")
        self.wait(lambda: self.driver.exists("export-submit"), what="the export dialog")
        self.driver.click("export-mode-encrypted")
        self.wait(
            lambda: self.driver.exists("export-password"), what="the export password fields"
        )
        self.driver.type("export-password", _EXPORT_PASSWORD)
        self.driver.type("export-confirm-password", _EXPORT_PASSWORD)
        self.driver.click("export-submit")
        self.manual_step(
            f"A native Save dialog is open. Save the encrypted export as exactly:\n"
            f"      {export_target}",
            f"The file {export_target.name} is written to that location.",
        )
        encrypted_blob = self.wait(
            lambda: export_target.exists() and export_target.read_text(encoding="utf-8"),
            what="the encrypted export file to be written",
        )
        assert "$encrypted" in encrypted_blob, (
            "export did not include an encrypted-credentials section — the stored "
            "credential was not picked up"
        )

        # 4) Import the same file back → native Open dialog, then type the export
        #    password and confirm the credential was imported.
        self._open_activity_menu_item("settings-menu-import")
        self.manual_step(
            f"A native Open dialog is open. Select this file:\n      {export_target}",
            "The Import dialog appears showing an encrypted-credentials password field.",
        )
        self.wait(
            lambda: self.driver.exists("import-password"),
            what="the encrypted-import password field",
        )
        self.driver.type("import-password", _EXPORT_PASSWORD)
        self.driver.click("import-with-credentials")
        success = self.wait(
            lambda: self.driver.exists("import-dialog-success")
            and self.driver.get_text("import-dialog-success"),
            what="the import success message",
        )
        assert "credential" in success.lower(), (
            f"import did not report credentials imported (message: {success!r})"
        )

    # ── Open in Editor → Save As + unsaved warning (MT-TAB-17/18/19) ──────────
    def test_open_in_editor_save_as_and_unsaved_warning(self):
        """Capture terminal output to a scratch editor, Save As, then verify the
        unsaved-changes warning on a fresh unsaved capture.

        Bridge-automatable (#1004): produce known scrollback, open it in the
        editor (MT-TAB-17 — asserts the scratch/Unsaved buffer mounts), click
        **Save As...** and assert the chosen file holds the buffer + the unsaved
        state clears (MT-TAB-18), and that closing a *second* unsaved capture
        raises the unsaved-changes dialog whose **Cancel** keeps the tab and
        **Just Close** discards it (MT-TAB-19). The operator performs only the
        native Save dialog.
        """
        self.close_all_tabs()
        self.ensure_terminal()
        marker = "OPEN_IN_EDITOR_MARKER_7731"
        self.run_command(f"echo {marker}")
        self.wait_for_output(marker)

        tab = self.active_tab()
        assert tab is not None
        # MT-TAB-17: Open in Editor → a scratch "(output)" tab with an Unsaved badge.
        self.driver.context_menu(f"tab-{tab['id']}")
        self.wait(
            lambda: self.driver.exists("tab-context-open-in-editor"),
            what="the tab context menu",
        )
        self.driver.click("tab-context-open-in-editor")
        self.wait(
            lambda: self.driver.exists("file-editor-scratch-badge"),
            what="the captured-output editor with its Unsaved badge",
        )
        editor_tab = self.wait(
            lambda: self.find_tab("(output)"), what="the captured-output editor tab"
        )
        assert self.editor_tab_dirty(editor_tab["id"]), "scratch capture should be dirty"

        # MT-TAB-18: Save As... → native Save dialog → file holds the buffer and
        # the unsaved state clears.
        target = self._scratch("openineditor", "captured-output.txt")
        self.driver.click("file-editor-save")
        self.manual_step(
            f"A native Save dialog is open. Save the captured output as exactly:\n"
            f"      {target}",
            f"The file {target.name} is written with the captured terminal text.",
        )
        body = self.wait(
            lambda: target.exists() and target.read_text(encoding="utf-8"),
            what="the captured output to be saved",
        )
        assert marker in body, "saved file does not contain the captured terminal text"
        # The scratch buffer is now a real file: the Unsaved badge is gone and the
        # tab is no longer dirty.
        self.wait(
            lambda: not self.driver.exists("file-editor-scratch-badge"),
            what="the Unsaved badge to clear after Save As",
        )
        self.wait(
            lambda: not self.editor_tab_dirty(editor_tab["id"]),
            what="the editor tab to lose its dirty flag after Save As",
        )

        # MT-TAB-19: a *fresh* unsaved capture warns before discarding on close.
        self.driver.context_menu(f"tab-{tab['id']}")
        self.wait(
            lambda: self.driver.exists("tab-context-open-in-editor"),
            what="the tab context menu (second capture)",
        )
        self.driver.click("tab-context-open-in-editor")
        self.wait(
            lambda: self.driver.exists("file-editor-scratch-badge"),
            what="the second captured-output editor",
        )
        unsaved_tab = self.wait(
            lambda: next(
                (
                    t
                    for t in self._all_tabs()
                    if "(output)" in (t.get("title") or "") and t["id"] != editor_tab["id"]
                ),
                None,
            ),
            what="the second captured-output editor tab",
        )
        # Closing it raises the unsaved-changes dialog; Cancel keeps the tab.
        self.driver.click(f"tab-close-{unsaved_tab['id']}")
        self.wait(
            lambda: self.driver.exists("unsaved-changes-cancel"),
            what="the unsaved-changes dialog",
        )
        self.driver.click("unsaved-changes-cancel")
        assert self.find_tab("(output)") is not None, "Cancel should keep the unsaved tab"
        # Closing again and choosing Just Close discards it.
        self.driver.click(f"tab-close-{unsaved_tab['id']}")
        self.wait(
            lambda: self.driver.exists("unsaved-changes-just-close"),
            what="the unsaved-changes dialog (second close)",
        )
        self.driver.click("unsaved-changes-just-close")
        self.wait(
            lambda: not any(t["id"] == unsaved_tab["id"] for t in self._all_tabs()),
            what="the unsaved capture tab to close after Just Close",
        )

    # ── Portable config export to a directory (MT-PORT-04) ────────────────────
    def test_portable_export_to_directory(self):
        """Export config to a chosen directory and assert the files land there.

        Bridge-automatable (#1004): create a connection so ``connections.json``
        has content, open Settings → Portable Mode, click **Export to
        Directory**, then — after the operator picks the destination in the
        native directory picker — drive the migration dialog (**Copy**) and
        assert both the in-app success message and the copied files on disk. The
        operator performs only the native directory pick.
        """
        self.close_all_tabs()
        name = unique_name("portable")
        self.create_local_connection(name)

        dest = Path(tempfile.mkdtemp(prefix="thub-portable-"))
        self.open_settings_category("portable")
        self.wait(
            lambda: self.driver.exists("export-config-btn"),
            what="the portable-mode export button",
        )
        self.driver.click("export-config-btn")
        self.manual_step(
            f"A native directory picker is open. Choose this directory:\n      {dest}",
            "The migration dialog appears listing the config files to copy.",
        )
        # After the directory is chosen the migration dialog opens; copy all files.
        self.wait(
            lambda: self.driver.exists("migration-confirm"),
            what="the migration (Copy) dialog",
        )
        self.driver.click("migration-confirm")
        result = self.wait(
            lambda: self.driver.exists("migration-result")
            and self.driver.get_text("migration-result"),
            what="the migration result message",
        )
        assert "Copied" in result, f"unexpected migration result: {result!r}"
        # connections.json is always part of the config set; assert it was written.
        connections_file = dest / "connections.json"
        self.wait(
            lambda: connections_file.exists(),
            what=f"connections.json to be exported to {dest}",
        )
        assert name in connections_file.read_text(encoding="utf-8"), (
            "exported connections.json does not contain the created connection"
        )

    # ── Add external connection file (MT-CONN-23) ─────────────────────────────
    def test_add_external_connection_file(self):
        """Register an external connection file via the native picker.

        Bridge-automatable (#1004): write a valid external-store JSON fixture
        (with one connection), open Settings → External Files, click **Add
        File**, then — after the operator picks the fixture in the native file
        picker — assert the file is registered in settings and its connection
        appears in the unified connection list. The operator performs only the
        native file pick.
        """
        self.close_all_tabs()
        conn_name = unique_name("ext-conn")
        fixture = self._scratch("external", "shared-connections.json")
        fixture.write_text(
            json.dumps(
                {
                    "name": "Shared",
                    "version": "1",
                    "folders": [],
                    "connections": [
                        {"name": conn_name, "config": {"type": "local", "config": {}}}
                    ],
                }
            ),
            encoding="utf-8",
        )

        self.open_settings_category("external-files")
        self.wait(
            lambda: self.driver.exists("external-files-add"),
            what="the External Files 'Add File' button",
        )
        self.driver.click("external-files-add")
        self.manual_step(
            f"A native Open dialog is open. Select this file:\n      {fixture}",
            "The file appears in the External Connection Files list with a toggle.",
        )
        # The picked file is registered in settings…
        self.wait(
            lambda: any(
                f.get("path") == str(fixture)
                for f in (
                    self.projection_region_cache(SETTINGS_REGION).get(
                        "externalConnectionFiles"
                    )
                    or []
                )
            ),
            what="the external file to be registered in settings",
        )
        # …and its connection is loaded into the unified connection list.
        self.switch_to_connections_sidebar()
        self.wait(
            lambda: self.find_connection(conn_name),
            what=f"the external connection {conn_name!r}",
        )

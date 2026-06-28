"""Encrypted connection export dialog — ported from the WebdriverIO
``encrypted-export-import.test.js`` to the Python bridge harness (#838).

Covers the export dialog's mode switch and password validation: the plain
default hides the password fields, encrypted mode reveals them plus the
AES-256-GCM warning, and a too-short or mismatched password surfaces an error
and disables submit (a matching 8+-char password enables it).

Divergences from the original, by design:

* **Addressed by testid, not CSS class.** The old suite reached the mode radios
  and the warning/error via ``.export-dialog__*`` classes; the bridge addresses
  elements by ``data-testid``, so the radios (``export-mode-plain`` /
  ``export-mode-encrypted``), the warning (``export-warning``) and the password
  error (``export-password-error``) gained stable testids.
* **Import dialog not driven.** Import opens through a native OS file picker that
  blocks the harness and only populates the dialog once a file is chosen, so its
  encrypted-password UI stays a manual check. The reachable part — the Import
  menu entry — is covered by ``test_connection_crud.test_import_menu_item_present``.
  The old ``MT-CONN-15/16`` cases were compile-time selector-constant checks with
  no runtime behavior, so they are not ported.
"""

from __future__ import annotations

import pytest

from termihub_harness import SystemTest

pytestmark = pytest.mark.integration


class TestExportImport(SystemTest):
    """One app for the whole suite; methods run in order and share its state."""

    TITLE = "export-dialog-title"
    PLAIN = "export-mode-plain"
    ENCRYPTED = "export-mode-encrypted"
    PASSWORD = "export-password"
    CONFIRM = "export-confirm-password"
    WARNING = "export-warning"
    ERROR = "export-password-error"
    SUBMIT = "export-submit"

    @pytest.fixture(autouse=True)
    def _export_suite(self):
        """Per-test: ensure no dialog/menu is left open from an earlier test."""
        self.driver.press_key("Escape")
        self.wait(
            lambda: not self.driver.exists(self.TITLE),
            what="any open export dialog to close",
        )
        yield
        self.driver.press_key("Escape")

    def _open_export_dialog(self) -> None:
        """Open the Export Connections dialog from the settings gear menu."""
        self.driver.click("activity-bar-settings")
        self.wait(
            lambda: self.driver.exists("settings-menu-export"), what="the settings menu"
        )
        self.driver.click("settings-menu-export")
        self.wait(lambda: self.driver.exists(self.TITLE), what="the export dialog")

    def _select_encrypted(self) -> None:
        """Switch the dialog to encrypted mode and wait for the password field."""
        self.driver.click(self.ENCRYPTED)
        self.wait(lambda: self.driver.exists(self.PASSWORD), what="the password fields")

    def _submit_disabled(self) -> bool:
        # React reflects a truthy `disabled` prop to the attribute (present → "",
        # absent → None), so a non-None value means the button is disabled.
        return self.driver.get_attribute(self.SUBMIT, "disabled") is not None

    # ── EXP-ENC-01 / MT-CONN-11: default plain state ───────────────────────────
    def test_default_plain_mode_hides_password_fields(self):
        self._open_export_dialog()
        assert "Export Connections" in self.driver.get_text(self.TITLE)
        # Plain is the default mode, so the encrypted password section is absent.
        assert not self.driver.exists(self.PASSWORD)
        assert not self.driver.exists(self.CONFIRM)

    # ── EXP-ENC-02 / MT-CONN-10: encrypted mode reveals fields + warning ───────
    def test_encrypted_mode_shows_fields_and_warning(self):
        self._open_export_dialog()
        self._select_encrypted()  # waits for PASSWORD to render
        assert self.driver.exists(self.CONFIRM)
        assert self.driver.exists(self.WARNING)
        assert "encrypted" in self.driver.get_text(self.WARNING).lower()

    # ── EXP-ENC-03: short password is rejected ─────────────────────────────────
    def test_short_password_shows_error_and_disables_submit(self):
        self._open_export_dialog()
        self._select_encrypted()
        self.driver.type(self.PASSWORD, "short")
        self.wait(lambda: self.driver.exists(self.ERROR), what="the short-password error")
        assert "at least 8 characters" in self.driver.get_text(self.ERROR)
        assert self._submit_disabled()

    # ── EXP-ENC-04: mismatched passwords are rejected ──────────────────────────
    def test_mismatched_passwords_show_error_and_disable_submit(self):
        self._open_export_dialog()
        self._select_encrypted()
        self.driver.type(self.PASSWORD, "validpassword123")
        self.driver.type(self.CONFIRM, "differentpassword")
        self.wait(lambda: self.driver.exists(self.ERROR), what="the mismatch error")
        assert "do not match" in self.driver.get_text(self.ERROR)
        assert self._submit_disabled()

    # ── A valid, matching password enables export ──────────────────────────────
    def test_matching_password_enables_submit(self):
        self._open_export_dialog()
        self._select_encrypted()
        self.driver.type(self.PASSWORD, "validpassword123")
        self.driver.type(self.CONFIRM, "validpassword123")
        # No error and submit becomes enabled. (Clicking it would open a native
        # save dialog, so we only assert the button is actionable.)
        self.wait(lambda: not self._submit_disabled(), what="export to become enabled")
        assert not self.driver.exists(self.ERROR)

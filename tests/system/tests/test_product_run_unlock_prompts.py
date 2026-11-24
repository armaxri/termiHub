"""Product run: the unlock and passphrase prompts (#5838, #5867).

The UI review of run ``20261123T215628Z`` found:

1. **R-038**: the unlock dialog a connect raised had no Cancel, a long
   "Connect without saved password" beside Unlock, a "Forgot password? Reset
   credential store…" link and a placeholder repeating the field's label.
2. **R-042**: with storage off, the passphrase prompt showed a disabled box, a
   sentence and a text-styled action: three elements for one message.
3. **R-126 / R-149**: the passphrase prompt printed the full key path over
   three lines above the field.
4. **R-127 / R-162**: a canceled connect toasted a bare "Connect canceled",
   naming no connection and offering no way on. #5881 brought the agent
   VNC/RDP and spawned-shell connects in line, and an agent cancel's success
   toast is graded as the wrong kind.
5. **R-150**: the telnet password prompt did not say termiHub answers the
   server's login prompt.

The grades are pure functions (:mod:`termihub_harness.product_run.unlock_prompts`);
the module-level tests below run them without an app in the per-PR lane. The
:class:`TestProductRunUnlockPrompts` phase is hand-triggered only
(``scripts/internal/product-run.sh``; deselected without ``--product-run``).
Its fresh profile sets up a master-password vault in the suite's own config
dir, so no OS keychain is touched. Nothing connects: every connect targets
port 1 and is canceled at its prompt.
"""

from __future__ import annotations

import time
from typing import Any, Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    CredentialStoreUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    unique_name,
)
from termihub_harness.fixtures import SSH_KEY_PASSPHRASE_PATH
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.unlock_prompts import (
    FORGOT_LABEL,
    RETRY,
    TURN_ON_SAVING,
    TYPE_PASSWORD_INSTEAD,
    canceled_toast_problems,
    key_name_problems,
    storage_off_problems,
    telnet_description_problems,
    unlock_footer_problems,
)

# ── app-free grade tests (per-PR lane) ────────────────────────────────────────


def _btn(text: str, variant: str, x: float) -> dict[str, Any]:
    return {
        "text": text,
        "class": f"ui-btn ui-btn--{variant} ui-btn--md",
        "rect": {"x": x, "y": 500, "width": 90, "height": 28},
    }


def _footer() -> dict[str, Optional[dict[str, Any]]]:
    return {
        "cancel": _btn("Cancel", "secondary", 200),
        "fallback": _btn(TYPE_PASSWORD_INSTEAD, "secondary", 300),
        "unlock": _btn("Unlock", "primary", 420),
    }


def test_the_new_unlock_footer_passes():
    assert (
        unlock_footer_problems(
            _footer(), placeholder=None, field_label="Master password", forgot_text=FORGOT_LABEL
        )
        == []
    )


def test_the_old_unlock_footer_is_named():
    # Before #5838: no Cancel, the long fallback, the placeholder, the reset link.
    old = _footer()
    old["cancel"] = None
    old["fallback"] = _btn("Connect without saved password", "secondary", 200)
    problems = unlock_footer_problems(
        old,
        placeholder="Master password",
        field_label="Master password",
        forgot_text="Forgot password? Reset credential store…",
    )
    assert "no Cancel button" in problems
    assert any("want 'Type password instead'" in p for p in problems), problems
    assert any("placeholder repeats" in p for p in problems), problems
    assert any("its own confirm" in p for p in problems), problems


def test_two_primaries_or_a_wrong_order_are_named():
    footer = _footer()
    footer["fallback"] = _btn(TYPE_PASSWORD_INSTEAD, "primary", 100)
    problems = unlock_footer_problems(
        footer, placeholder="", field_label="Master password", forgot_text=FORGOT_LABEL
    )
    assert "the fallback is primary, want secondary" in problems
    assert "2 primary buttons, want one" in problems
    assert any("left to right" in p for p in problems), problems


def test_a_named_canceled_unlock_toast_passes():
    text = 'Connect to "prod-db" canceled. Its saved password stays locked.'
    assert canceled_toast_problems(text, TYPE_PASSWORD_INSTEAD, name="prod-db", after="unlock") == []


def test_a_named_canceled_prompt_toast_passes():
    text = 'Connect to "prod-db" canceled.'
    assert canceled_toast_problems(text, RETRY, name="prod-db", after="prompt") == []


def test_the_bare_connect_canceled_toast_is_named():
    problems = canceled_toast_problems("Connect canceled", None, name="prod-db", after="unlock")
    assert any("does not name the connection" in p for p in problems), problems
    assert any("no next step" in p for p in problems), problems
    assert any("stays locked" in p for p in problems), problems


def test_a_missing_or_wrong_action_is_named():
    assert canceled_toast_problems("", None, name="x", after="prompt") == ["no 'canceled' toast"]
    problems = canceled_toast_problems('Connect to "x" canceled.', "Undo", name="x", after="prompt")
    assert problems == ["the toast's action reads 'Undo', want 'Retry'"]


def test_a_named_spawned_shell_cancel_passes():
    # #5881: a spawned SSH shell names its saved connection (or the request's
    # --connection) and, after a canceled unlock, offers a typed password.
    text = 'Connect to "App server" canceled. Its saved password stays locked.'
    assert (
        canceled_toast_problems(
            text, TYPE_PASSWORD_INSTEAD, name="App server", after="unlock", kind="info"
        )
        == []
    )
    assert canceled_toast_problems(
        'Connect to "conn-1" canceled.', RETRY, name="conn-1", after="prompt", kind="info"
    ) == []


def test_a_named_agent_desktop_cancel_passes():
    # #5881: a VNC/RDP connection under an agent names the connection and retries.
    text = 'Connect to "Build server" canceled.'
    assert (
        canceled_toast_problems(text, RETRY, name="Build server", after="prompt", kind="info") == []
    )


def test_a_cancel_as_a_success_toast_is_named():
    # Before #5881 the agent connect's cancel was a bare success toast.
    problems = canceled_toast_problems(
        "Connect canceled", None, name="Jump Box", after="prompt", kind="success"
    )
    assert "the cancel is a 'success' toast, want 'info'" in problems
    assert any("does not name the connection" in p for p in problems), problems
    assert any("no next step" in p for p in problems), problems


def test_the_one_storage_off_line_passes():
    assert (
        storage_off_problems(
            f"Passwords aren't saved. {TURN_ON_SAVING}",
            link_text=TURN_ON_SAVING,
            link_tag="BUTTON",
            save_box_present=False,
        )
        == []
    )
    assert (
        storage_off_problems(
            f"Passphrases aren't saved. {TURN_ON_SAVING}",
            link_text=TURN_ON_SAVING,
            link_tag="button",
            save_box_present=False,
            secret_noun="passphrase",
        )
        == []
    )


def test_the_old_three_element_storage_off_row_is_named():
    problems = storage_off_problems(
        "Credential storage is off — enable it under Settings ▸ Security to save this.",
        link_text="Enable credential storage…",
        link_tag="SPAN",
        save_box_present=True,
    )
    assert any("the line reads" in p for p in problems), problems
    assert "the old 'Credential storage is off' sentence is back" in problems
    assert "the link is a 'SPAN', not a link or button" in problems
    assert "a disabled save box is still shown" in problems
    assert storage_off_problems(None, link_text=None, link_tag=None, save_box_present=False) == [
        "no storage-off line"
    ]


def test_a_key_named_by_its_file_passes():
    path = "/Users/someone/work/keys/ed25519_passphrase"
    description = "Enter the passphrase for key ed25519_passphrase, used by ops@db.example"
    assert key_name_problems(description, path, path) == []


def test_a_full_key_path_or_a_missing_tooltip_is_named():
    path = "/Users/someone/work/keys/ed25519_passphrase"
    old = f"Enter the passphrase for key {path}, used by ops@db.example"
    problems = key_name_problems(old, None, path)
    assert any("full key path" in p for p in problems), problems
    assert any("tooltip" in p for p in problems), problems
    assert any("does not name" in p for p in key_name_problems("Enter it", path, path))


def test_the_telnet_description_must_mention_the_login_prompt():
    assert (
        telnet_description_problems(
            "Enter the password for pi@10.0.0.7. termiHub answers the server's login prompt for you."
        )
        == []
    )
    assert telnet_description_problems("Enter password for pi@10.0.0.7")


# ── the live phase (hand-triggered product run) ───────────────────────────────

MASTER_PASSWORD = "product-run-unlock-pw"
TOAST_REGION = "toast-region"
RETRY_ACTION = "connect-canceled-retry"


@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunUnlockPrompts(
    ProductRunUi,
    ConnectionsUi,
    CredentialStoreUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
):
    phase = "Unlock prompts"
    request_timeout = 90.0

    _password_conn: Optional[str] = None
    _key_conn: Optional[str] = None

    def _toasts(self) -> str:
        return self.driver.get_text(TOAST_REGION) if self.driver.exists(TOAST_REGION) else ""

    def _button(self, test_id: str) -> Optional[dict[str, Any]]:
        if not self.driver.exists(test_id):
            return None
        return {
            "text": self.driver.get_text(test_id),
            "class": self.driver.get_attribute(test_id, "class"),
            "rect": self.driver.measure_element(test_id)["rect"],
        }

    def _action(self) -> Optional[str]:
        return self.driver.get_text(RETRY_ACTION).strip() if self.driver.exists(RETRY_ACTION) else None

    def _unlock_open(self) -> bool:
        return self.driver.exists("unlock-dialog-input")

    def test_10_unlock_dialog_footer(self):
        name = unique_name("pr-unlock-prompt")
        with self.step(
            "unlock-prompts.footer",
            "A connect-raised unlock dialog: Cancel, 'Type password instead', Unlock",
            expect="#5838: Cancel · Type password instead · Unlock (the one primary), no "
            "placeholder in the field, 'Forgot master password?' under the actions",
        ):
            self.setup_master_password_store(MASTER_PASSWORD)
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name, host="127.0.0.1", port=1, username="nobody", save_password=True
            )
            self.require_connection(name)
            type(self)._password_conn = name
            self.lock_credential_store()
            self.connect_connection(name)
            self.wait(self._unlock_open, what="the unlock dialog")
            self.shot(label="unlock-dialog")
            buttons = {
                "cancel": self._button("unlock-dialog-cancel"),
                "fallback": self._button("unlock-dialog-connect-without-saved"),
                "unlock": self._button("unlock-dialog-unlock"),
            }
            placeholder = self.driver.get_attribute("unlock-dialog-input", "placeholder")
            forgot = (
                self.driver.get_text("unlock-dialog-forgot").strip()
                if self.driver.exists("unlock-dialog-forgot")
                else None
            )
            self.evidence(f"buttons {buttons}; placeholder {placeholder!r}; forgot {forgot!r}")
            problems = unlock_footer_problems(
                buttons, placeholder=placeholder, field_label="Master password", forgot_text=forgot
            )
            assert not problems, problems

    def test_20_cancel_unlock_names_the_connect(self):
        with self.step(
            "unlock-prompts.cancel-unlock",
            "Cancel on the unlock dialog toasts the connection and offers a typed password",
            expect="#5838: a toast 'Connect to \"<name>\" canceled. Its saved password stays "
            "locked.' with a 'Type password instead' action",
        ):
            self.require("unlock-prompts.footer")
            name = self._password_conn
            assert name
            self.driver.click("unlock-dialog-cancel")
            self.wait(lambda: not self._unlock_open(), what="the dialog to close")
            self.wait(lambda: "canceled" in self._toasts().lower(), what="the canceled toast")
            self.shot(label="canceled-unlock-toast")
            toasts, action = self._toasts(), self._action()
            self.evidence(f"toasts {toasts!r}; action {action!r}")
            problems = canceled_toast_problems(toasts, action, name=name, after="unlock")
            assert not problems, problems

    def test_30_type_password_instead_then_retry(self):
        with self.step(
            "unlock-prompts.retry",
            "The toast's action asks for the password without the vault; canceling offers Retry",
            expect="#5838: the SSH password prompt (no unlock dialog); after Cancel a toast "
            "'Connect to \"<name>\" canceled.' with Retry",
        ):
            self.require("unlock-prompts.cancel-unlock")
            name = self._password_conn
            assert name
            self.driver.click(RETRY_ACTION)
            self.wait(self.password_prompt_open, what="the password prompt")
            unlock_shown = self._unlock_open()
            self.evidence(f"unlock dialog shown again: {unlock_shown}")
            assert not unlock_shown, "the action raised the unlock dialog again"
            self.cancel_password_prompt()
            self.wait(lambda: not self.password_prompt_open(), what="the prompt to close")
            time.sleep(0.3)
            toasts, action = self._toasts(), self._action()
            self.shot(label="canceled-prompt-toast")
            self.evidence(f"toasts {toasts!r}; action {action!r}")
            problems = canceled_toast_problems(toasts, action, name=name, after="prompt")
            assert not problems, problems

    def test_40_passphrase_names_the_key_file(self):
        name = unique_name("pr-unlock-key")
        with self.step(
            "unlock-prompts.key-name",
            "The passphrase prompt names the key by its file name, the path in a tooltip",
            expect=f"#5838: 'Enter the passphrase for key {SSH_KEY_PASSPHRASE_PATH.name}, used "
            "by nobody@127.0.0.1' on one line above the field",
        ):
            self.require("unlock-prompts.footer")
            if self.credential_store_locked():
                self.unlock_credential_store(MASTER_PASSWORD)
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name,
                host="127.0.0.1",
                port=1,
                username="nobody",
                auth_method="key",
                key_path=str(SSH_KEY_PASSPHRASE_PATH),
                save_password=True,
            )
            self.require_connection(name)
            type(self)._key_conn = name
            self.connect_connection(name)
            self.wait(self.password_prompt_open, what="the passphrase prompt")
            try:
                self.shot(label="passphrase-prompt")
                description = self.password_prompt_description()
                tooltip = self.driver.get_attribute("password-prompt-description", "title")
                self.evidence(f"description {description!r}; tooltip {tooltip!r}")
                problems = key_name_problems(description, tooltip, str(SSH_KEY_PASSPHRASE_PATH))
                assert not problems, problems
            finally:
                self.cancel_password_prompt()

    def test_50_storage_off_is_one_line(self):
        with self.step(
            "unlock-prompts.storage-off",
            "With storage off the passphrase prompt shows one line with a real link",
            expect="#5838: 'Passphrases aren't saved. Turn on saving…' under the field, the "
            "action underlined as a link, no disabled save box",
        ):
            self.require("unlock-prompts.key-name")
            name = self._key_conn
            assert name
            if self.credential_store_locked():
                self.unlock_credential_store(MASTER_PASSWORD)
            self.open_settings_category("security")
            self.wait(lambda: self.driver.exists("storage-mode-none"), what="the storage options")
            self.driver.click("storage-mode-none")
            self.confirm_store_switch("none")
            self.wait(
                lambda: (self.credential_store_status() or {}).get("mode") == "none",
                what="storage off",
            )
            self.switch_to_connections_sidebar()
            self.connect_connection(name)
            self.wait(self.password_prompt_open, what="the passphrase prompt")
            try:
                self.shot(label="storage-off-prompt")
                line = (
                    self.driver.get_text("password-prompt-storage-off")
                    if self.driver.exists("password-prompt-storage-off")
                    else None
                )
                link = "password-prompt-enable-storage"
                link_text = self.driver.get_text(link) if self.driver.exists(link) else None
                # The bridge reads attributes, not tag names: the link is a type="button".
                link_tag = (
                    "BUTTON"
                    if link_text and self.driver.get_attribute(link, "type") == "button"
                    else None
                )
                box = self.driver.exists("password-prompt-save-checkbox")
                self.evidence(f"line {line!r}; link {link_text!r} ({link_tag}); save box {box}")
                problems = storage_off_problems(
                    line,
                    link_text=link_text,
                    link_tag=link_tag,
                    save_box_present=box,
                    secret_noun="passphrase",
                )
                assert not problems, problems
            finally:
                self.cancel_password_prompt()
        try:
            self.dismiss_modals()
        except Exception as exc:  # noqa: BLE001 - cleanup must not fail the run
            print(f"[product-run] could not close the prompts cleanly: {exc}")

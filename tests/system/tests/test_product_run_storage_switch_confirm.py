"""Product run: switching credential storage confirms before passwords go (#5837).

The UI review of run ``20261123T215628Z`` found:

1. **R-027 / R-043**: one click on "Don't save passwords" could remove saved
   passwords, and the result read "Switched to None — 1 credential removed.".
2. **R-113**: right after confirming, the screen still showed Master password
   selected with its options.
3. **R-114**: success read "1 credential migrated", and nothing said the vault
   was kept.
4. **R-097 / R-156**: the "Switched to …" banner stayed on the page for good.

The grades are pure functions (:mod:`termihub_harness.product_run.storage_switch`);
the module-level tests below run them without an app in the per-PR lane. The
:class:`TestProductRunStorageSwitchConfirm` phase is hand-triggered only
(``scripts/internal/product-run.sh``; deselected without ``--product-run``).
It runs in its own fresh profile and only ever uses a master-password vault in
that profile's config dir: the OS Keychain is never chosen or touched.
"""

from __future__ import annotations

import time
from typing import Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    CredentialStoreUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.storage_switch import (
    FADE_DEADLINE_S,
    confirm_problems,
    expected_result,
    faded_problems,
    result_problems,
    selection_problems,
)

# ── app-free grade tests (per-PR lane) ────────────────────────────────────────

DELETE_TITLE = "Stop saving passwords?"
DELETE_TEXT = (
    "This permanently deletes the 1 saved password in your master-password vault and cannot "
    "be undone. You'll be asked for passwords each time you connect."
)


def test_a_counted_delete_confirmation_passes():
    assert confirm_problems("none", "master_password", 1, title=DELETE_TITLE, text=DELETE_TEXT) == []


def test_no_confirmation_before_a_delete_is_named():
    # Before #5837 (R-027): nothing asked before passwords were removed.
    assert confirm_problems("none", "master_password", 1, title=None, text=None) == [
        "no confirmation before a switch that touches 1 saved password"
    ]


def test_the_old_uncounted_confirmation_is_named():
    old_title = "Delete saved credentials?"
    old_text = (
        "This permanently deletes every credential saved in your master-password vault and "
        "cannot be undone."
    )
    problems = confirm_problems("none", "master_password", 2, title=old_title, text=old_text)
    assert len(problems) == 1 and "'2 saved passwords'" in problems[0], problems


def test_a_move_confirmation_must_keep_the_vault():
    title = "Move 1 saved password to the OS Keychain?"
    assert confirm_problems(
        "os_keychain", "master_password", 1, title=title, text="Your vault stays on this computer."
    ) == []
    assert confirm_problems("os_keychain", "master_password", 1, title=title, text="Copies them.") == [
        "the confirmation does not say the master-password vault is kept"
    ]


def test_the_plain_results_pass():
    assert result_problems(
        "none", "master_password", 1,
        result="Stopped saving passwords. 1 saved password removed.", toasts="",
    ) == []
    assert result_problems("none", "master_password", 0, result="Stopped saving passwords.", toasts="") == []
    assert expected_result("os_keychain", "master_password", 2) == (
        "Moved 2 saved passwords to the OS Keychain. Your master-password vault is kept."
    )
    assert expected_result("master_password", "none", 0) == (
        "Passwords are now saved in your master-password vault."
    )


def test_the_old_internal_result_is_named():
    # Before #5837 (R-043 / R-114).
    problems = result_problems(
        "none", "master_password", 1, result="Switched to None — 1 credential removed.", toasts=""
    )
    assert problems[0].startswith("the result reads 'Switched to None"), problems
    assert {"the result uses 'Switched to'", "the result uses 'None —'",
            "the result uses 'credential'"} <= set(problems)


def test_a_toast_repeating_the_result_is_named():
    problems = result_problems(
        "none", "master_password", 0,
        result="Stopped saving passwords.", toasts="Stopped saving passwords.",
    )
    assert problems == ["a toast repeats the result shown in place: 'Stopped saving passwords.'"]


def test_a_missing_result_is_named():
    assert result_problems("none", "master_password", 0, result=None, toasts="") == [
        "no result under the option cards"
    ]


def test_selection_follows_the_choice():
    cards = {"storage-mode-master-password": False, "storage-mode-none": True}
    assert selection_problems("storage-mode-none", cards) == []
    # Before #5837 (R-113): the old card stayed selected while the switch ran.
    stale = {"storage-mode-master-password": True, "storage-mode-none": False}
    assert selection_problems("storage-mode-none", stale) == [
        "after confirming, the selected card is ['storage-mode-master-password'], "
        "want 'storage-mode-none'"
    ]


def test_a_result_that_never_fades_is_named():
    assert faded_problems(6.4) == []
    assert faded_problems(None) == [f"the result is still shown after {FADE_DEADLINE_S:.0f}s"]


# ── the live phase (hand-triggered product run) ───────────────────────────────

MASTER_PASSWORD = "product-run-switch-confirm-pw"
SECRET = "product-run-switch-confirm-secret"
NONE_CARD = "storage-mode-none"
VAULT_CARD = "storage-mode-master-password"
CARDS = (VAULT_CARD, NONE_CARD, "storage-mode-os-keychain")
CONFIRM = "confirm-switch-dialog"
RESULT = "migration-result"
TOAST_REGION = "toast-region"


@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunStorageSwitchConfirm(
    ProductRunUi, ConnectionsUi, CredentialStoreUi, SettingsUi, SidebarUi, SystemTest
):
    phase = "Storage switch confirmation"
    request_timeout = 90.0

    def _mode(self) -> str:
        return str((self.credential_store_status() or {}).get("mode") or "")

    def _toasts(self) -> str:
        return self.driver.get_text(TOAST_REGION) if self.driver.exists(TOAST_REGION) else ""

    def _checked(self) -> dict[str, bool]:
        return {
            card: self.driver.get_attribute(card, "aria-checked") == "true"
            for card in CARDS
            if self.driver.exists(card)
        }

    def _confirm_copy(self) -> tuple[Optional[str], Optional[str]]:
        if not self.driver.exists(CONFIRM):
            return None, None
        text = self.driver.get_text(CONFIRM)
        title = text.splitlines()[0] if text else ""
        return title, text

    def _vault_with_one_password(self) -> None:
        if self._mode() != "master_password":
            self.setup_master_password_store(MASTER_PASSWORD)
        if self.credential_store_locked():
            self.unlock_credential_store(MASTER_PASSWORD)
        self.switch_to_connections_sidebar()
        # Never connected: saving the editor writes the password to the vault.
        self.create_ssh_connection(
            unique_name("pr-switch-confirm"),
            host="127.0.0.1",
            port=1,
            username="nobody",
            password=SECRET,
            save_password=True,
        )

    def _click_none(self) -> None:
        self.open_settings_category("security")
        self.wait(lambda: self.driver.exists(NONE_CARD), what="the storage options")
        self.driver.click(NONE_CARD)

    def test_10_confirm_names_count_and_cancel_keeps(self):
        with self.step(
            "storage-switch.confirm",
            "Choosing Don't save passwords with a saved password asks first, naming "
            "how many and where; Cancel keeps the vault (#5837)",
            expect="#5837: 'Stop saving passwords?' saying it deletes the 1 saved password in "
            "your master-password vault and cannot be undone, Cancel and a red 'Delete saved "
            "passwords'",
        ):
            if self._mode() not in ("none", "master_password"):
                pytest.skip(f"the profile uses {self._mode()!r}; this phase only uses a vault")
            self._vault_with_one_password()
            self._click_none()
            self.wait(lambda: self.driver.exists(CONFIRM), what="the confirmation")
            title, text = self._confirm_copy()
            self.evidence(f"confirmation {text!r}")
            self.shot(label="confirm")
            problems = confirm_problems("none", "master_password", 1, title=title, text=text)
            self.driver.click("confirm-switch-cancel-btn")
            self.wait(lambda: not self.driver.exists(CONFIRM), what="the confirmation to close")
            if self._mode() != "master_password":
                problems.append(f"Cancel switched the store to {self._mode()!r}")
            if not self._checked().get(VAULT_CARD):
                problems.append("after Cancel, Master password is not the selected card")
            assert not problems, problems

    def test_20_confirmed_switch_selects_reports_and_fades(self):
        with self.step(
            "storage-switch.result",
            "Confirming selects Don't save passwords at once and says 'Stopped saving "
            "passwords. 1 saved password removed.' in place, then the line fades (#5837)",
            expect="#5837: Settings ▸ Security with Don't save passwords selected, no "
            "master-password options, the one-line result and no toast",
        ):
            self.require("storage-switch.confirm")
            self._click_none()
            self.wait(lambda: self.driver.exists("confirm-switch-confirm-btn"), what="the confirm")
            self.driver.click("confirm-switch-confirm-btn")
            checked = self._checked()
            self.evidence(f"cards right after confirming {checked}")
            problems = selection_problems(NONE_CARD, checked)
            self.wait(lambda: self._mode() == "none", what="the switch to finish")
            self.wait(lambda: self.driver.exists(RESULT), what="the result")
            result = self.driver.get_text(RESULT)
            toasts = self._toasts()
            self.evidence(f"result {result!r}; toasts {toasts!r}")
            self.shot(label="result")
            problems += result_problems("none", "master_password", 1, result=result, toasts=toasts)
            if self.driver.exists("auto-lock-timeout"):
                problems.append("the master-password options still show")
            shown_at = time.monotonic()
            faded = self._wait_gone(RESULT, FADE_DEADLINE_S)
            problems += faded_problems(None if faded is None else faded - shown_at)
            assert not problems, problems

    def test_30_no_confirm_when_nothing_saved(self):
        with self.step(
            "storage-switch.nothing-saved",
            "With an empty vault, Don't save passwords switches at once, without asking (#5837)",
            expect="#5837: Settings ▸ Security with Don't save passwords selected and "
            "'Stopped saving passwords.' under the cards, no confirmation",
        ):
            self.require("storage-switch.result")
            self.setup_master_password_store(MASTER_PASSWORD)
            self._click_none()
            self.wait(
                lambda: self._mode() == "none" or self.driver.exists(CONFIRM),
                what="the switch or a confirmation",
            )
            asked = self.driver.exists(CONFIRM)
            if asked:
                self.driver.click("confirm-switch-cancel-btn")
                pytest.fail("an empty vault still asked before switching")
            self.wait(lambda: self.driver.exists(RESULT), what="the result")
            result = self.driver.get_text(RESULT)
            self.evidence(f"result {result!r}")
            problems = result_problems(
                "none", "master_password", 0, result=result, toasts=self._toasts()
            )
            assert not problems, problems

    def _wait_gone(self, test_id: str, seconds: float) -> Optional[float]:
        """The monotonic time ``test_id`` disappeared, or ``None`` if it stayed."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if not self.driver.exists(test_id):
                return time.monotonic()
            time.sleep(0.25)
        return None

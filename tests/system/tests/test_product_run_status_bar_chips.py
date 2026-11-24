"""Product run: the status bar's lock button and security chips (#5839).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` saw a low-contrast "Locked"/"Unlocked" text as the only
lock indicator (R-071, R-121), host-key trust and the auth method reachable
only by hovering the SSH chip (R-089, R-112), no positive "encrypted" cue
(R-103), and an empty status bar on a local shell (R-172).

Now the lock is an outlined button named with its state and action
("Unlocked, lock the credential store now"); the SSH chip is a button with a
trust shield whose name says "encrypted" and the host key's trust, opening a
popover with the host, encryption, sign-in method, host key and a link to
manage trusted keys; and a local shell shows a chip with the shell's name.

The ``test_grade_*`` functions grade fixed readings without an app and run in
the normal lane.
"""

from __future__ import annotations

import sys
from typing import Any, Optional

import pytest

from termihub_harness import (
    SSH_HOST,
    ConnectionsUi,
    CredentialStoreUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.round2_polish import ssh_popover_problems
from termihub_harness.product_run.ssh_steps import SshPhaseUi

LOCK = "credential-store-indicator"
SSH_CHIP = "status-bar-ssh"
SSH_DETAILS = "status-bar-ssh-details"
SSH_MANAGE = "status-bar-ssh-manage-trust"
SSH_DETAILS_TITLE = "status-bar-ssh-details-title"
LOCAL_CHIP = "status-bar-local-shell"
DETAIL_ROWS = ("endpoint", "encryption", "auth", "hostKey")
TRUST_LEVELS = ("trusted", "once", "pending")
#: A test constant for the run's own store, not a real secret.
MASTER_PASSWORD = "pr-status-bar-master-pw"

Reading = dict[str, Any]


# ── grading ───────────────────────────────────────────────────────────────
def _label_in_name(text: str, name: str) -> bool:
    """WCAG 2.5.3: the visible text is part of the accessible name."""
    return bool(text) and text.strip().lower() in name.lower()


def lock_button_problems(lock: Reading) -> list[str]:
    """Problems with the status-bar lock button reading (#5839, R-071, R-121).

    ``lock`` holds ``type``, ``text``, ``aria_label``, ``state`` and ``class``.
    """
    problems = []
    if lock.get("type") != "button":
        problems.append(f"the lock is not a button (type {lock.get('type')!r})")
    state = lock.get("state")
    want = {"locked": "Locked", "unlocked": "Unlocked"}.get(state or "")
    if want is None:
        problems.append(f"the lock has no locked/unlocked state ({state!r})")
    elif lock.get("text", "").strip() != want:
        problems.append(f"the {state} lock reads {lock.get('text')!r}, not {want!r}")
    name = lock.get("aria_label") or ""
    if not _label_in_name(lock.get("text", ""), name):
        problems.append(f"the lock's name {name!r} does not contain its text")
    action = "unlock" if state == "locked" else "lock"
    if f"{action} the credential store" not in name.lower():
        problems.append(f"the lock's name {name!r} does not say a click will {action} it")
    if "credential-indicator--button" not in (lock.get("class") or ""):
        problems.append("the lock is not the outlined normal-contrast button")
    return problems


def ssh_chip_problems(chip: Reading) -> list[str]:
    """Problems with the SSH chip reading (#5839, R-089, R-103, R-112).

    ``chip`` holds ``type``, ``text``, ``aria_label``, ``haspopup``, ``trust``
    and ``shield`` (whether the trust icon is rendered).
    """
    problems = []
    if chip.get("type") != "button" or not chip.get("haspopup"):
        problems.append("the SSH chip is not a button that opens a popover")
    name = chip.get("aria_label") or ""
    if not _label_in_name(chip.get("text", ""), name):
        problems.append(f"the SSH chip's name {name!r} does not contain its text")
    if "encrypted" not in name.lower():
        problems.append(f"the SSH chip's name {name!r} gives no encrypted cue")
    if "host key" not in name.lower():
        problems.append(f"the SSH chip's name {name!r} does not say the host key's trust")
    if chip.get("trust") not in TRUST_LEVELS:
        problems.append(f"the SSH chip has no trust level ({chip.get('trust')!r})")
    if not chip.get("shield"):
        problems.append("the SSH chip shows no trust shield")
    return problems


def ssh_details_problems(
    rows: dict[str, str], manage: bool, *, fingerprint: Optional[str] = None
) -> list[str]:
    """Problems with the SSH details popover (rows by id, the manage link)."""
    problems = [f"the popover has no {r!r} row" for r in DETAIL_ROWS if not rows.get(r)]
    if rows.get("encryption") and "encrypted" not in rows["encryption"].lower():
        problems.append(f"the encryption row reads {rows['encryption']!r}")
    host_key = rows.get("hostKey", "")
    if fingerprint and fingerprint not in host_key:
        problems.append(f"the host key row {host_key!r} lacks the fingerprint {fingerprint!r}")
    elif host_key and not fingerprint and "SHA256:" not in host_key:
        problems.append(f"the host key row {host_key!r} shows no fingerprint")
    if not manage:
        problems.append("the popover has no link to manage trusted host keys")
    return problems


def local_chip_problems(chip: Reading) -> list[str]:
    """Problems with the local-shell chip (``text``, ``title``) (#5839, R-172)."""
    problems = []
    text = (chip.get("text") or "").strip()
    if not text:
        problems.append("a local shell shows no shell chip in the status bar")
    title = chip.get("title") or ""
    if not title.startswith(f"Local shell: {text}"):
        problems.append(f"the local chip's tooltip reads {title!r}")
    return problems


# ── app-free grade tests ──────────────────────────────────────────────────
GOOD_LOCK = {
    "type": "button",
    "text": "Unlocked",
    "aria_label": "Unlocked, lock the credential store now",
    "state": "unlocked",
    "class": "status-bar__item credential-indicator credential-indicator--button",
}
GOOD_CHIP = {
    "type": "button",
    "text": "SSH: arne@127.0.0.1:22400",
    "aria_label": "SSH: arne@127.0.0.1:22400, encrypted, host key trusted. "
    "Show connection security",
    "haspopup": "menu",
    "trust": "trusted",
    "shield": True,
}
GOOD_ROWS = {
    "endpoint": "arne@127.0.0.1:22400",
    "encryption": "Encrypted (SSH)",
    "auth": "key pr_ed25519",
    "hostKey": "trusted · ssh-ed25519 SHA256:abc",
}


def test_grade_lock_button_passes():
    assert lock_button_problems(GOOD_LOCK) == []
    locked = {**GOOD_LOCK, "text": "Locked", "state": "locked",
              "aria_label": "Locked, unlock the credential store"}
    assert lock_button_problems(locked) == []


def test_grade_old_muted_lock_text_fails():
    old = {"type": "button", "text": "Unlocked", "aria_label": "", "state": None,
           "class": "status-bar__item credential-indicator"}
    problems = lock_button_problems(old)
    assert any("state" in p for p in problems)
    assert any("outlined" in p for p in problems)
    assert any("does not contain its text" in p for p in problems)


def test_grade_lock_name_must_say_the_action():
    wrong = {**GOOD_LOCK, "aria_label": "Unlocked"}
    assert lock_button_problems(wrong) == [
        "the lock's name 'Unlocked' does not say a click will lock it"
    ]


def test_grade_ssh_chip_passes():
    assert ssh_chip_problems(GOOD_CHIP) == []


def test_grade_hover_only_ssh_chip_fails():
    old = {"type": None, "text": "SSH: arne@127.0.0.1:22400", "aria_label": "",
           "haspopup": None, "trust": None, "shield": False}
    problems = ssh_chip_problems(old)
    assert "the SSH chip is not a button that opens a popover" in problems
    assert any("encrypted cue" in p for p in problems)
    assert "the SSH chip shows no trust shield" in problems


def test_grade_ssh_details_pass_and_fail():
    assert ssh_details_problems(GOOD_ROWS, True, fingerprint="SHA256:abc") == []
    assert ssh_details_problems(GOOD_ROWS, True) == []
    problems = ssh_details_problems({**GOOD_ROWS, "hostKey": ""}, False)
    assert "the popover has no 'hostKey' row" in problems
    assert "the popover has no link to manage trusted host keys" in problems
    wrong_fp = ssh_details_problems(GOOD_ROWS, True, fingerprint="SHA256:other")
    assert wrong_fp and "lacks the fingerprint" in wrong_fp[0]


def test_grade_local_chip():
    assert local_chip_problems({"text": "Zsh", "title": "Local shell: Zsh"}) == []
    assert local_chip_problems({"text": "", "title": ""})[0].startswith(
        "a local shell shows no shell chip"
    )


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only")
class TestProductRunStatusBarChips(
    ProductRunUi,
    SshPhaseUi,
    CredentialStoreUi,
    SettingsUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    SystemTest,
):
    phase = "Status bar chips"
    request_timeout = 90.0

    def _attr(self, testid: str, name: str) -> Optional[str]:
        return self.driver.get_attribute(testid, name) if self.driver.exists(testid) else None

    def _text(self, testid: str) -> str:
        return self.driver.get_text(testid).strip() if self.driver.exists(testid) else ""

    def _lock_reading(self) -> Reading:
        return {
            "type": self._attr(LOCK, "type"),
            "text": self._text(LOCK),
            "aria_label": self._attr(LOCK, "aria-label"),
            "state": self._attr(LOCK, "data-state"),
            "class": self._attr(LOCK, "class"),
        }

    def test_10_lock_button(self):
        with self.step(
            "status-bar.lock.button",
            "The credential lock is an outlined button that says its state and locks the "
            "store now (#5839)",
            expect="#5839 complaint: at the right end of the status bar, an outlined "
            "'Unlocked' button with an open lock at normal contrast; after a click it "
            "reads 'Locked' with a closed lock and an accent outline",
        ):
            self.setup_master_password_store(MASTER_PASSWORD)
            self.switch_to_connections_sidebar()
            unlocked = self._lock_reading()
            self.evidence(f"unlocked: {unlocked}")
            problems = lock_button_problems(unlocked)
            self.lock_credential_store()
            self.wait(lambda: self._attr(LOCK, "data-state") == "locked",
                      what="the lock to show locked")
            self.shot(label="locked")
            locked = self._lock_reading()
            self.evidence(f"locked: {locked}")
            problems += lock_button_problems(locked)
            self.unlock_credential_store(MASTER_PASSWORD)
            assert not problems, problems

    def test_20_ssh_chip(self):
        name = unique_name("pr-sb-ssh")
        with self.step(
            "status-bar.ssh.chip",
            "The SSH chip shows a trust shield and opens a popover with encryption, sign-in "
            "and the host key (#5839)",
            expect="#5839 complaint: the 'SSH: user@127.0.0.1:<port>' chip with a green "
            "shield; above it a 'Connection security' popover listing Host, Encryption "
            "'Encrypted (SSH)', Signed in with 'key …', Host key '… SHA256:…' and "
            "'Manage trusted host keys'",
        ):
            native = self.need_native()
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name, host=SSH_HOST, port=native.target.port, username=native.target.username,
                auth_method="key", key_path=str(native.client_key), connect=True,
            )
            self.evidence(f"host-key prompts accepted: {self.accept_all_hostkeys()}")
            tab = self.tab_id_of(name)
            self.wait_connected(tab)
            self.switch_to_tab(tab)
            self.wait(lambda: self._attr(SSH_CHIP, "data-trust") not in (None, "pending"),
                      timeout=15.0, what="the SSH chip's host-key trust")
            chip = {
                "type": self._attr(SSH_CHIP, "type"),
                "text": self._text(SSH_CHIP),
                "aria_label": self._attr(SSH_CHIP, "aria-label"),
                "haspopup": self._attr(SSH_CHIP, "aria-haspopup"),
                "trust": self._attr(SSH_CHIP, "data-trust"),
                "shield": self.driver.exists("status-bar-ssh-trust"),
            }
            self.evidence(f"SSH chip: {chip}")
            problems = ssh_chip_problems(chip)
            self.driver.click(SSH_CHIP)
            self.wait(lambda: self.driver.exists(SSH_DETAILS), timeout=5.0,
                      what="the SSH details popover")
            rows = {r: self._text(f"status-bar-ssh-details-{r}") for r in DETAIL_ROWS}
            self.shot(label="details")
            self.evidence(f"details: {rows}")
            problems += ssh_details_problems(rows, self.driver.exists(SSH_MANAGE))
            # Sentence-case title, key file name with the full path on hover (#5956).
            title_text = self._text(SSH_DETAILS_TITLE)
            transform = self.driver.get_computed_style("text-transform", SSH_DETAILS_TITLE)
            auth_title = self._attr("status-bar-ssh-details-auth", "title") or ""
            self.evidence(f"title {title_text!r} ({transform}); key tooltip {auth_title!r}")
            problems += ssh_popover_problems(
                title_text, transform, rows.get("auth", ""), auth_title, str(native.client_key)
            )
            self.driver.press_key("Escape")
            assert not problems, problems
        self.close_all_tabs()

    def test_30_local_shell_chip(self):
        with self.step(
            "status-bar.local.chip",
            "A local shell shows a chip with the shell's name (#5839)",
            expect="#5839 complaint: on a local terminal the status bar's left side shows "
            "a terminal icon and the shell name (e.g. 'Zsh'), not an empty bar",
        ):
            self.ensure_terminal()
            self.wait(lambda: self.driver.exists(LOCAL_CHIP), timeout=10.0,
                      what="the local-shell chip")
            chip = {"text": self._text(LOCAL_CHIP), "title": self._attr(LOCAL_CHIP, "title")}
            self.shot(label="local")
            self.evidence(f"local chip: {chip}")
            problems = local_chip_problems(chip)
            assert not problems, problems
        self.close_all_tabs()

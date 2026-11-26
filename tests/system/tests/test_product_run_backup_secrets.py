"""Product run: Back up asks for one secret per step and never nests its scrolling (#5847).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). The UI review of run ``20261123T215628Z`` (``backup``)
found the backup dialog hard to follow:

1. **R-019 (P2).** "Back up everything" asked for three secrets in one form
   (current master password, backup passphrase, repeat), next to both
   "Credentials … always encrypted with the passphrase" and a separate
   "Encrypt the whole backup" toggle. Now the dialog walks through steps:
   what to back up, then the backup passphrase under one rule ("Everything in
   this file is locked with the backup passphrase."), then the master
   password on its own last step, only when credentials from the
   master-password vault are included, with one line saying why it is needed.
2. **R-020 (P2).** The section list scrolled inside the dialog and clipped its
   "Nothing saved yet: …" line mid-word. Now the dialog body is the only
   scroll area, and the empty kinds are one short line ("3 other kinds have
   nothing saved yet.").
3. **R-140 (P3).** The settings page said "Back up everything…" and listed 15
   kinds of data in one sentence. Now the button reads "Back up…" and the page
   has a one-line description.

The class runs in its own fresh profile with a master-password store (never
the OS keychain) and one local connection. It never writes a backup: it walks
the steps and closes the dialog. The grades are pure functions, graded without
an app in the per-PR lane by the tests at the bottom of this file.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping

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
from termihub_harness.product_run.creds_steps import CredsPhaseUi

MASTER_PASSWORD = "product-run-backup-secrets-pw"
BACKUP_PASSPHRASE = "product-run-backup-secrets-pass"

#: Every secret field the backup dialog can show, and the step that owns it.
SECRET_FIELDS: Mapping[str, str] = {
    "backup-export-passphrase": "Backup passphrase",
    "backup-export-confirm": "Backup passphrase",
    "backup-export-master-password": "Master password",
}
#: The rule the passphrase step states, word for word.
LOCK_RULE = "Everything in this file is locked with the backup passphrase."
STEP_LABEL = re.compile(r"^Step (\d+) of (\d+) · (.+)$")
EMPTY_LINE = re.compile(r"^\d+ other (kind has|kinds have) nothing saved yet\.$")
#: Scroll extents may differ by sub-pixel rounding, never more.
SCROLL_TOLERANCE_PX = 1.0
#: A description "on one line" in a 640px settings panel.
MAX_DESCRIPTION_CHARS = 120


def step_label_problems(text: str, index: int, total: int, name: str) -> list[str]:
    """Whether the step label reads "Step <index> of <total> · <name>", or ``[]``."""
    match = STEP_LABEL.match(text.strip())
    if not match:
        return [f"no 'Step n of m · …' label: {text!r}"]
    problems = []
    got = (int(match.group(1)), int(match.group(2)), match.group(3))
    if got != (index, total, name):
        problems.append(f"step label {text!r}, expected 'Step {index} of {total} · {name}'")
    return problems


def step_secret_problems(step: str, visible: Iterable[str]) -> list[str]:
    """Whether the step shows only its own secret fields, or ``[]``.

    ``step`` is the step's name ("What to back up", "Backup passphrase",
    "Master password"); ``visible`` the secret testids on screen.
    """
    problems = []
    for field in visible:
        owner = SECRET_FIELDS.get(field)
        if owner != step:
            problems.append(f"'{step}' shows {field} (belongs to {owner!r})")
    kinds = {SECRET_FIELDS[f] for f in visible if f in SECRET_FIELDS}
    if len(kinds) > 1:
        problems.append(f"'{step}' asks for {len(kinds)} different secrets: {sorted(kinds)}")
    return problems


def nested_scroll_problems(overflow_y: str, scroll_height: float, client_height: float) -> list[str]:
    """Whether the section list scrolls (or clips) inside the dialog, or ``[]``."""
    problems = []
    if overflow_y.strip() in ("auto", "scroll"):
        problems.append(f"the section list is its own scroll area (overflow-y: {overflow_y})")
    if scroll_height - client_height > SCROLL_TOLERANCE_PX:
        problems.append(
            f"the section list hides {scroll_height - client_height:.0f}px of its content"
        )
    return problems


def empty_line_problems(text: str, height: float, line_height: float) -> list[str]:
    """Whether the empty-kinds line is one short line, or ``[]``."""
    problems = []
    if not EMPTY_LINE.match(text.strip()):
        problems.append(f"empty kinds are not one short count line: {text!r}")
    if line_height > 0 and height > line_height * 1.5:
        problems.append(f"the empty-kinds line wraps ({height:.0f}px for {line_height:.0f}px)")
    return problems


def settings_page_problems(button: str, description: str) -> list[str]:
    """Whether the settings page says "Back up…" with a one-line description, or ``[]``."""
    problems = []
    if button.strip() != "Back up…":
        problems.append(f"the backup button reads {button!r}, not 'Back up…'")
    text = description.strip()
    if len(text) > MAX_DESCRIPTION_CHARS:
        problems.append(f"the description is {len(text)} characters, not one line")
    if text.count(". ") > 0:
        problems.append("the description is more than one sentence")
    return problems


def _px(value: str) -> float:
    try:
        return float(str(value).strip().removesuffix("px"))
    except ValueError:
        return 0.0


@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunBackupSecrets(
    ProductRunUi,
    CredsPhaseUi,
    CredentialStoreUi,
    SettingsUi,
    ConnectionsUi,
    SidebarUi,
    SystemTest,
):
    phase = "Backup secrets"
    request_timeout = 90.0

    def reset_before_rerun(self) -> None:
        self.dismiss_modals("backup-export-title")

    def _visible_secrets(self) -> list[str]:
        return [f for f in SECRET_FIELDS if self.driver.exists(f)]

    def _step_problems(self, index: int, total: int, name: str) -> list[str]:
        label = self.driver.get_text("backup-export-step").strip()
        secrets = self._visible_secrets()
        self.evidence(f"step {label!r}; secret fields {secrets}")
        return step_label_problems(label, index, total, name) + step_secret_problems(
            name, secrets
        )

    def test_10_backup_asks_one_secret_per_step(self):
        with self.step(
            "backup.secrets.choose",
            "Back up starts with what to back up: no password field, no nested scroll, "
            "empty kinds in one line (#5847)",
            expect="#5847: Settings ▸ Backup & restore with a 'Back up…' button and a one-line "
            "description; the dialog's 'Step 1 of 3 · What to back up' with Connections, "
            "Credentials ('You'll enter your master password in the last step.') and Settings "
            "ticked, the list not scrolling on its own, and one line like '9 other kinds have "
            "nothing saved yet.'",
        ):
            self.setup_master_password_store(MASTER_PASSWORD)
            # A fresh profile has no connections: save one so the list has a
            # Connections row above Credentials, as a real user's would.
            self.switch_to_connections_sidebar()
            self.create_local_connection(unique_name("pr-backup-secrets"))
            self.open_settings_category("backup")
            self.wait(lambda: self.driver.exists("backup-export-btn"), what="the Back up button")
            button = self.driver.get_text("backup-export-btn")
            description = self.driver.get_text("backup-restore-description")
            self.evidence(f"button {button!r}; description {description!r}")
            problems = settings_page_problems(button, description)

            self.driver.click("backup-export-btn")
            self.wait(
                lambda: self.driver.exists("backup-export-credentials"),
                what="the backup sections to load",
            )
            if self.driver.get_attribute("backup-export-credentials", "aria-checked") != "true":
                problems.append("Credentials is not ticked although the vault is set up")
            problems += self._step_problems(1, 3, "What to back up")

            overflow = self.driver.get_computed_style("overflow-y", "backup-export-sections")
            box = self.driver.measure_element("backup-export-sections")
            self.evidence(
                f"list overflow-y {overflow!r}; scrollHeight {box['scrollHeight']}, "
                f"clientHeight {box['clientHeight']}"
            )
            problems += nested_scroll_problems(
                overflow, float(box["scrollHeight"]), float(box["clientHeight"])
            )
            if self.driver.exists("backup-export-empty-sections"):
                line = self.driver.measure_element("backup-export-empty-sections")
                line_height = _px(
                    self.driver.get_computed_style("line-height", "backup-export-empty-sections")
                )
                self.evidence(f"empty line {line['text']!r} {line['rect']}")
                problems += empty_line_problems(
                    str(line["text"]), float(line["rect"]["height"]), line_height
                )
            self.shot(label="choose", expect="backup-export-sections")
            assert not problems, "; ".join(problems)

        with self.step(
            "backup.secrets.passphrase",
            "Step 2 asks only for the backup passphrase, under one rule (#5847)",
            expect="#5847: 'Step 2 of 3 · Backup passphrase' with 'Everything in this file is "
            "locked with the backup passphrase. …', Backup passphrase + Repeat backup "
            "passphrase and no master password field; 'Save without a passphrase' unavailable "
            "while credentials are included",
        ):
            self.require("backup.secrets.choose")
            self.driver.click("backup-export-next")
            self.wait(
                lambda: self.driver.exists("backup-export-passphrase"),
                what="the backup passphrase step",
            )
            problems = self._step_problems(2, 3, "Backup passphrase")
            rule = self.driver.get_text("backup-export-rule").strip()
            self.evidence(f"rule {rule!r}")
            if not rule.startswith(LOCK_RULE):
                problems.append(f"the step does not state the rule: {rule!r}")
            if self.driver.get_attribute("backup-export-plain", "disabled") is None:
                problems.append("a plain backup is offered although credentials are included")
            self.driver.type("backup-export-passphrase", BACKUP_PASSPHRASE)
            self.driver.type("backup-export-confirm", BACKUP_PASSPHRASE)
            self.shot(label="passphrase", expect="backup-export-passphrase")
            assert not problems, "; ".join(problems)

        with self.step(
            "backup.secrets.master",
            "The master password has its own last step and says why it is needed (#5847)",
            expect="#5847: 'Step 3 of 3 · Master password' with 'Your saved credentials are "
            "locked with your master password. …', one Master password field and "
            "'Save backup…'",
        ):
            self.require("backup.secrets.passphrase")
            self.driver.click("backup-export-next")
            self.wait(
                lambda: self.driver.exists("backup-export-master-password"),
                what="the master password step",
            )
            problems = self._step_problems(3, 3, "Master password")
            purpose = self.driver.get_text("backup-export-master-purpose").strip()
            self.evidence(f"purpose {purpose!r}")
            if "master password" not in purpose:
                problems.append(f"the step does not say why it needs the password: {purpose!r}")
            if not self.driver.exists("backup-export-submit"):
                problems.append("the last step has no 'Save backup…'")
            self.shot(label="master-password", expect="backup-export-master-password")
            self.driver.click("modal-close")
            assert not problems, "; ".join(problems)


# ── Per-PR grade checks (no app) ─────────────────────────────────────────────
def test_a_correct_step_label_passes_and_a_wrong_one_is_named():
    assert step_label_problems("Step 2 of 3 · Backup passphrase", 2, 3, "Backup passphrase") == []
    assert step_label_problems("Step 2 of 2 · Backup passphrase", 2, 3, "Backup passphrase") == [
        "step label 'Step 2 of 2 · Backup passphrase', expected 'Step 2 of 3 · Backup passphrase'"
    ]
    assert step_label_problems("Back up everything", 1, 3, "What to back up") == [
        "no 'Step n of m · …' label: 'Back up everything'"
    ]


def test_one_secret_per_step_passes():
    assert step_secret_problems("What to back up", []) == []
    assert (
        step_secret_problems(
            "Backup passphrase", ["backup-export-passphrase", "backup-export-confirm"]
        )
        == []
    )
    assert step_secret_problems("Master password", ["backup-export-master-password"]) == []


def test_three_secrets_in_one_form_are_named():
    problems = step_secret_problems("Backup passphrase", list(SECRET_FIELDS))
    assert problems == [
        "'Backup passphrase' shows backup-export-master-password (belongs to 'Master password')",
        "'Backup passphrase' asks for 2 different secrets: ['Backup passphrase', 'Master password']",
    ]
    assert step_secret_problems("What to back up", ["backup-export-passphrase"]) == [
        "'What to back up' shows backup-export-passphrase (belongs to 'Backup passphrase')"
    ]


def test_a_nested_scroll_area_is_named():
    assert nested_scroll_problems("visible", 400, 400) == []
    assert nested_scroll_problems("visible", 400.5, 400) == []
    assert nested_scroll_problems("auto", 520, 320) == [
        "the section list is its own scroll area (overflow-y: auto)",
        "the section list hides 200px of its content",
    ]


def test_the_empty_kinds_line_must_be_one_short_line():
    assert empty_line_problems("9 other kinds have nothing saved yet.", 18, 18) == []
    assert empty_line_problems("1 other kind has nothing saved yet.", 18, 18) == []
    assert empty_line_problems("Nothing saved yet: shared credentials, workspaces", 18, 18) == [
        "empty kinds are not one short count line: "
        "'Nothing saved yet: shared credentials, workspaces'"
    ]
    assert empty_line_problems("9 other kinds have nothing saved yet.", 36, 18) == [
        "the empty-kinds line wraps (36px for 18px)"
    ]


def test_the_settings_page_must_say_back_up_with_one_line():
    # Since #5860 (G-004) it says the passwords are in it and how they are locked.
    one_line = (
        "Save your connections, settings and saved passwords to one passphrase-locked file, "
        "and restore it on any computer."
    )
    assert settings_page_problems("Back up…", one_line) == []
    old = (
        "Save everything — connections, settings, themes, keyboard shortcuts, workspaces, "
        "macros, workflows, tunnels, trusted host keys, plugins and optionally your saved "
        "credentials — to one passphrase-protected file. Restore lets you pick what to bring back."
    )
    problems = settings_page_problems("Back up everything…", old)
    assert problems[0] == "the backup button reads 'Back up everything…', not 'Back up…'"
    assert problems[1].startswith("the description is ")
    assert problems[2] == "the description is more than one sentence"

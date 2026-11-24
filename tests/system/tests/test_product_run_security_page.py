"""Product run: Settings ▸ Security reads short where nothing can be used (#5875, #5876).

The UI review of run ``20261123T215628Z`` found:

1. **R-050** (``security-none``): with "Don't save passwords", Shared credentials
   and Credential vault backup kept their full description paragraphs next to
   the "Credential storage is off — choose … above" line.
2. **R-157** (``touchid-note``): the "Unlock with Touch ID" hint was two lines of
   conditions shown before the unlock was on.

The grades are pure functions (:mod:`termihub_harness.product_run.security_page`);
the module-level tests below run them without an app in the per-PR lane. The
:class:`TestProductRunSecurityPage` phase is hand-triggered only
(``scripts/internal/product-run.sh``; deselected without ``--product-run``). It
runs in its own fresh profile and only ever sets up a master-password vault in
that profile's config dir: the OS Keychain is never chosen or touched.
"""

from __future__ import annotations

import pytest

from termihub_harness import CredentialStoreUi, SettingsUi, SidebarUi, SystemTest
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.security_page import (
    SECTIONS,
    TOUCHID_CONDITIONS,
    TOUCHID_HINT,
    SectionReading,
    collapsed_section_problems,
    storing_section_problems,
    touchid_hint_problems,
)

# ── app-free grade tests (per-PR lane) ────────────────────────────────────────

OFF_LINE = (
    "Credential storage is off — choose OS Keychain or Master password above to use "
    "shared credentials."
)
DESCRIPTION = (
    "A password or key passphrase that several connections use. Change it here once and "
    "every connection that uses it picks up the new secret."
)
SHORT_HINT = "Use Touch ID instead of typing your master password."
OLD_HINT = (
    "Unlock the credential store with Touch ID instead of typing your master password. Your "
    "master password keeps working, and is needed again after you change it or your Touch ID "
    "enrollment changes."
)
CONDITIONS = (
    "Your master password keeps working. You need it again after you change it or your "
    "Touch ID enrollment changes."
)


def _collapsed(**over) -> SectionReading:
    s: SectionReading = {
        "testId": "shared-credentials",
        "heading": "Shared credentials",
        "text": f"Shared credentials\n{OFF_LINE}",
        "description": False,
        "offLine": OFF_LINE,
        "collapsed": "true",
    }
    s.update(over)  # type: ignore[typeddict-item]
    return s


def test_the_graded_sections_are_the_two_store_dependent_ones():
    assert [s[0] for s in SECTIONS] == ["shared-credentials", "credential-vault-backup"]


def test_a_collapsed_section_passes():
    assert collapsed_section_problems(_collapsed()) == []


def test_the_old_description_with_storage_off_is_named():
    # Before #5875 (R-050): the paragraph stayed above the storage-off line.
    s = _collapsed(description=True, text=f"Shared credentials\n{DESCRIPTION}\n{OFF_LINE}")
    problems = collapsed_section_problems(s)
    assert any("R-050" in p for p in problems)
    assert any("more than its heading and one line" in p for p in problems)


def test_a_missing_storage_off_line_is_named():
    problems = collapsed_section_problems(_collapsed(offLine=None, text="Shared credentials"))
    assert problems == ["shared-credentials: no storage-off line pointing at the storage options"]


def test_a_reworded_storage_off_line_is_named():
    line = "Credential storage is off — enable it under Settings ▸ Security to save this."
    s = _collapsed(offLine=line, text=f"Shared credentials\n{line}")
    problems = collapsed_section_problems(s)
    assert any("the storage-off line reads" in p for p in problems)


def test_an_extra_button_while_collapsed_is_named():
    s = _collapsed(text=f"Shared credentials\n{OFF_LINE}\nNew shared credential…")
    assert any("New shared credential" in p for p in collapsed_section_problems(s))


def test_a_storing_section_keeps_its_description():
    s: SectionReading = {"testId": "shared-credentials", "description": True, "offLine": None}
    assert storing_section_problems(s) == []
    lost = storing_section_problems({"testId": "x", "description": False, "collapsed": "true"})
    assert len(lost) == 2


def test_the_short_hint_passes_before_and_after_enabling():
    assert touchid_hint_problems(SHORT_HINT, unlock_on=False, conditions=None) == []
    assert (
        touchid_hint_problems(
            SHORT_HINT, hint_height=15.0, line_height=15.4, unlock_on=True, conditions=CONDITIONS
        )
        == []
    )


def test_the_old_two_line_hint_is_named():
    # Before #5876 (R-157): the conditions sat in the hint, wrapped to two lines.
    problems = touchid_hint_problems(
        OLD_HINT, hint_height=31.0, line_height=15.4, unlock_on=False, conditions=None
    )
    assert any("carries the conditions" in p for p in problems)
    assert any("wraps to 2.0 lines" in p for p in problems)


def test_conditions_belong_to_the_note_only_while_on():
    assert touchid_hint_problems(SHORT_HINT, unlock_on=True, conditions=None) == [
        "with the unlock on, the note does not say when the password is needed"
    ]
    assert any(
        "before the unlock is on" in p
        for p in touchid_hint_problems(SHORT_HINT, unlock_on=False, conditions=CONDITIONS)
    )


# ── live phase (product run only) ─────────────────────────────────────────────

MASTER_PASSWORD = "product-run-security-page-pw"


@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunSecurityPage(
    ProductRunUi,
    CredentialStoreUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
):
    phase = "Security page"
    request_timeout = 90.0

    def _read_section(
        self, section: str, description: str, off: str, heading: str
    ) -> SectionReading:
        self.wait(lambda: self.driver.exists(section), what=section)
        return {
            "testId": section,
            "heading": heading,
            "text": self.driver.get_text(section),
            "description": self.driver.exists(description),
            "offLine": self.driver.get_text(off) if self.driver.exists(off) else None,
            "collapsed": self.driver.get_attribute(section, "data-collapsed"),
        }

    def _read_sections(self) -> list[SectionReading]:
        return [self._read_section(*s) for s in SECTIONS]

    def test_10_sections_collapse_while_passwords_are_not_saved(self):
        with self.step(
            "security-none.collapsed",
            "With 'Don't save passwords', Shared credentials and Credential vault backup are "
            "one muted line each (#5875)",
            expect="#5875: Settings ▸ Security with 'Don't save passwords' selected; Shared "
            "credentials and Credential vault backup each show only their heading and the "
            "line 'Credential storage is off — choose OS Keychain or Master password above …'",
        ):
            status = self.wait(self.credential_store_status, what="the credential store status")
            assert status.get("mode") == "none", f"the fresh profile has a store: {status}"
            self.open_settings_category("security")
            problems: list[str] = []
            for reading in self._read_sections():
                self.evidence(f"{reading['testId']}: {reading['text']!r}")
                problems += collapsed_section_problems(reading)
            assert not problems, problems

    def test_20_sections_keep_their_description_with_a_store(self):
        with self.step(
            "security-page.storing",
            "With a master-password vault, both sections keep their description (#5875)",
            expect="Settings ▸ Security with Master password selected; Shared credentials and "
            "Credential vault backup show their description and actions",
        ):
            self.setup_master_password_store(MASTER_PASSWORD)
            self.open_settings_category("security")
            self.wait(
                lambda: self.driver.exists("shared-credentials-description"),
                what="the description",
            )
            problems: list[str] = []
            for reading in self._read_sections():
                problems += storing_section_problems(reading)
            assert not problems, problems

    def test_30_touchid_hint_is_one_short_line(self):
        with self.step(
            "touchid-note.hint",
            "The Unlock with Touch ID toggle shows one short line; its conditions are not "
            "shown while it is off (#5876)",
            expect="#5876: Settings ▸ Security ▸ Master password options with a one-line "
            "'Use Touch ID instead of typing your master password.' under the toggle",
        ):
            self.setup_master_password_store(MASTER_PASSWORD)
            self.open_settings_category("security")
            if not self.driver.exists("biometric-unlock-toggle"):
                pytest.skip("Security shows no biometric unlock here (no Touch ID hardware?)")
            hint = self.driver.get_text(TOUCHID_HINT).strip()
            height = float(self.driver.measure_element(TOUCHID_HINT)["rect"]["height"])
            line = self.driver.get_computed_style("line-height", TOUCHID_HINT)
            line_height = float(line[:-2]) if line.endswith("px") else None
            toggle = self.driver.get_attribute("biometric-unlock-toggle", "aria-checked")
            unlock_on = toggle == "true"
            conditions = (
                self.driver.get_text(TOUCHID_CONDITIONS)
                if self.driver.exists(TOUCHID_CONDITIONS)
                else None
            )
            self.evidence(f"hint: {hint!r} ({height:.0f}px), conditions: {conditions!r}")
            problems = touchid_hint_problems(
                hint,
                hint_height=height,
                line_height=line_height,
                unlock_on=unlock_on,
                conditions=conditions,
            )
            assert not problems, problems

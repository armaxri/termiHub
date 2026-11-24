"""The product run's Settings ▸ Security page grades (#5875, #5876).

Pure functions over what the live run reads from Settings ▸ Security, so the
grades run without an app in the per-PR lane and on the live page in
``tests/test_product_run_security_page.py``.

- :func:`collapsed_section_problems` — with "Don't save passwords", Shared
  credentials and Credential vault backup are each their heading plus the one
  storage-off line: no description paragraph, no action (R-050).
- :func:`storing_section_problems` — with a store, the same sections keep their
  description, so the collapse is tied to the mode and not a lost paragraph.
- :func:`touchid_hint_problems` — the "Unlock with Touch ID" hint is one short
  line; when the master password is needed again shows only in the note once
  the unlock is on (R-157).
"""

from __future__ import annotations

import re
from typing import Optional, TypedDict

#: The two sections that depend on a credential store: (section, description,
#: storage-off line, heading).
SECTIONS: tuple[tuple[str, str, str, str], ...] = (
    (
        "shared-credentials",
        "shared-credentials-description",
        "shared-credentials-unavailable",
        "Shared credentials",
    ),
    (
        "credential-vault-backup",
        "credential-vault-description",
        "credential-vault-unavailable",
        "Credential vault backup",
    ),
)

#: How every storage-off line starts (``credentialStorageOffText``).
OFF_LINE_PREFIX = "Credential storage is off — choose "

#: Touch ID test ids.
TOUCHID_HINT = "biometric-unlock-hint"
TOUCHID_CONDITIONS = "biometric-unlock-conditions"

#: Words of the conditions that belong in the note, not the toggle's hint.
CONDITION_WORDS = ("enrollment", "needed again", "keeps working")

#: A hint taller than this many lines is a paragraph, not a one-line hint.
MAX_HINT_LINES = 1.5


class SectionReading(TypedDict, total=False):
    """One section as the live run reads it."""

    testId: str
    heading: str
    #: The section's whole visible text (heading, lines, buttons).
    text: str
    #: Whether the description paragraph rendered.
    description: bool
    #: The storage-off line's text, or ``None`` when it did not render.
    offLine: Optional[str]
    #: The section's ``data-collapsed`` attribute.
    collapsed: Optional[str]


def _words(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def collapsed_section_problems(s: SectionReading) -> list[str]:
    """Problems with one store-dependent section while passwords are not saved."""
    name = s.get("testId", "?")
    problems: list[str] = []
    if s.get("description"):
        problems.append(f"{name}: the description paragraph still shows with storage off (R-050)")
    off = s.get("offLine")
    if not off:
        problems.append(f"{name}: no storage-off line pointing at the storage options")
        return problems
    if not _words(off).startswith(OFF_LINE_PREFIX):
        problems.append(f"{name}: the storage-off line reads {off!r}")
    if s.get("collapsed") != "true":
        problems.append(f"{name}: the section is not marked collapsed")
    rest = _words(s.get("text", ""))
    heading = _words(s.get("heading", ""))
    if rest.startswith(heading):
        rest = rest[len(heading) :].strip()
    if rest != _words(off):
        problems.append(f"{name}: shows more than its heading and one line: {rest!r}")
    return problems


def storing_section_problems(s: SectionReading) -> list[str]:
    """Problems with one store-dependent section while a store is in use."""
    name = s.get("testId", "?")
    problems: list[str] = []
    if not s.get("description"):
        problems.append(f"{name}: the description is missing although passwords are saved")
    if s.get("offLine"):
        problems.append(f"{name}: a storage-off line shows with a store: {s['offLine']!r}")
    if s.get("collapsed") == "true":
        problems.append(f"{name}: collapsed although passwords are saved")
    return problems


def touchid_hint_problems(
    hint: Optional[str],
    *,
    hint_height: Optional[float] = None,
    line_height: Optional[float] = None,
    unlock_on: bool,
    conditions: Optional[str],
) -> list[str]:
    """Problems with the Touch ID toggle's hint and the conditions line."""
    problems: list[str] = []
    if not hint:
        return ["the Touch ID toggle has no hint"]
    found = [w for w in CONDITION_WORDS if w in hint]
    if found:
        problems.append(f"the toggle's hint still carries the conditions {found}: {hint!r} (R-157)")
    if hint_height and line_height and hint_height > line_height * MAX_HINT_LINES:
        problems.append(
            f"the toggle's hint wraps to {hint_height / line_height:.1f} lines, not one (R-157)"
        )
    if unlock_on and not conditions:
        problems.append("with the unlock on, the note does not say when the password is needed")
    if not unlock_on and conditions:
        problems.append(f"the conditions show before the unlock is on: {conditions!r}")
    if conditions and "enrollment" not in conditions:
        problems.append(f"the conditions line does not name the enrollment: {conditions!r}")
    return problems

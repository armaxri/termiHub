"""Product run: the restore preview is safe by default (#5824).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). The UI review of run ``20261123T215628Z`` (``backup``)
found the restore preview one click from overwriting the user's settings:

1. **R-004 (P1).** Settings, which can only be replaced, defaulted to ticked
   on "Replace" (anything not in the backup is removed, no undo), while
   Connections and Host keys defaulted to "Merge". Now no section starts on
   Replace: mergeable sections start ticked on Merge, and Settings starts
   unticked with "Your current settings stay as they are. Tick to replace
   them with the backup's." Restore is then the plain filled primary, and no
   replace warning shows until the user ticks Settings.
2. **R-084 (P3).** The Merge/Replace selects had different widths and right
   edges, and the preview did not say which backup it was showing. Now every
   select shares one width and right edge, and the preview opens with
   "Created … · termiHub … · <file>".
3. **R-131 (P3).** Nothing warned that restored passwords come back locked in
   the master-password vault. The Credentials row now says so.

The class runs in its own fresh profile: it sets a master-password store up,
backs up connections, settings and the (empty) vault, and previews the
restore. No sshd and no keychain write: only the master-password vault is
used. The grades are pure functions, graded without an app in the per-PR lane
by the tests at the bottom of this file.
"""

from __future__ import annotations

import tempfile
from collections.abc import Iterable, Mapping
from pathlib import Path

import pytest

from termihub_harness import CredentialStoreUi, SettingsUi, SidebarUi, SystemTest
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.creds_steps import CredsPhaseUi

MASTER_PASSWORD = "product-run-restore-defaults-pw"
BACKUP_PASSPHRASE = "product-run-restore-defaults-backup"
#: Sections restored by merging; Settings can only be replaced.
MERGEABLE = ("connections",)
REPLACE_ONLY = ("settings",)
#: Select boxes may differ by sub-pixel rounding, never more.
ALIGN_TOLERANCE_PX = 1.0


def default_choice_problems(sections: Mapping[str, Mapping[str, str | None]]) -> list[str]:
    """What is unsafe about the preview's default choices, or ``[]``.

    ``sections`` maps a section id to ``{"checked": "true"|"false",
    "mode": "Merge"|"Replace"|None}`` (``mode`` is ``None`` when the row shows
    no select, i.e. the section is not included).
    """
    problems: list[str] = []
    for sid, state in sections.items():
        checked = state.get("checked") == "true"
        mode = (state.get("mode") or "").strip()
        if checked and mode == "Replace":
            problems.append(f"'{sid}' defaults to Replace")
        if sid in MERGEABLE and not (checked and mode == "Merge"):
            problems.append(f"'{sid}' does not default to a ticked Merge ({state})")
        if sid in REPLACE_ONLY and checked:
            problems.append(f"replace-only '{sid}' is ticked by default")
    return problems


def select_alignment_problems(rects: Iterable[Mapping[str, float]]) -> list[str]:
    """Whether the restore selects share one width and one right edge, or ``[]``."""
    boxes = list(rects)
    if len(boxes) < 2:
        return []
    widths = [float(r["width"]) for r in boxes]
    rights = [float(r["x"]) + float(r["width"]) for r in boxes]
    problems = []
    if max(widths) - min(widths) > ALIGN_TOLERANCE_PX:
        problems.append(f"select widths differ: {sorted(round(w, 1) for w in widths)}")
    if max(rights) - min(rights) > ALIGN_TOLERANCE_PX:
        problems.append(f"select right edges differ: {sorted(round(r, 1) for r in rights)}")
    return problems


def origin_problems(origin: str, file_name: str) -> list[str]:
    """Whether the preview's origin line names the backup, or ``[]``."""
    problems = []
    if not origin.startswith("Created "):
        problems.append(f"origin line does not start with 'Created ': {origin!r}")
    if "termiHub" not in origin:
        problems.append(f"origin line does not name the termiHub version: {origin!r}")
    if file_name not in origin:
        problems.append(f"origin line does not name the file {file_name!r}: {origin!r}")
    return problems


@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunBackupRestoreDefaults(
    ProductRunUi,
    CredsPhaseUi,
    CredentialStoreUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
):
    phase = "Restore defaults"
    request_timeout = 90.0

    def reset_before_rerun(self) -> None:
        self.dismiss_modals("backup-restore-title")

    def _section_state(self, sid: str) -> dict[str, str | None]:
        mode_id = f"backup-restore-mode-{sid}"
        return {
            "checked": self.driver.get_attribute(f"backup-restore-include-{sid}", "aria-checked"),
            "mode": self.driver.get_text(mode_id) if self.driver.exists(mode_id) else None,
        }

    def test_10_restore_preview_defaults_are_safe(self):
        target = (
            Path(tempfile.mkdtemp(prefix="thub-pr-restore-defaults-")) / "termihub-backup.json"
        )
        with self.step(
            "backup.restore.defaults",
            "The restore preview never defaults to Replace; Settings starts unticked (#5824)",
            expect="#5824: the restore preview opening with 'Created … · termiHub … · "
            "termihub-backup.json'; Connections ticked on Merge; Settings unticked with 'Your "
            "current settings stay as they are. Tick to replace them with the backup's.'; "
            "Credentials ticked with 'Restored passwords stay locked with your master "
            "password …'; no replace warning; a filled blue 'Restore and restart'",
        ):
            self.setup_master_password_store(MASTER_PASSWORD)
            self.back_up(
                target, BACKUP_PASSPHRASE, credentials=True, master_password=MASTER_PASSWORD
            )
            self.wait_backup_written(target)
            rows = self.preview_restore(target, BACKUP_PASSPHRASE)
            self.evidence(f"preview: {rows}")

            states = {sid: self._section_state(sid) for sid in MERGEABLE + REPLACE_ONLY}
            self.evidence(f"default choices: {states}")
            problems = default_choice_problems(states)

            origin = self.driver.get_text("backup-restore-preview-origin").strip()
            self.evidence(f"origin: {origin!r}")
            problems += origin_problems(origin, target.name)

            if not self.driver.exists("backup-restore-keep-settings"):
                problems.append("no 'stay as they are' line under the unticked Settings")
            if self.driver.exists("backup-restore-replace-warning"):
                problems.append("a replace warning shows although nothing is replaced")
            submit = self.driver.get_attribute("backup-restore-submit", "class") or ""
            self.evidence(f"submit classes: {submit!r}")
            if "ui-btn--danger" in submit:
                problems.append("Restore is destructive by default")
            if self.driver.exists("backup-restore-include-credentials") and (
                self.driver.get_attribute("backup-restore-include-credentials", "aria-checked")
                == "true"
            ) and not self.driver.exists("backup-restore-credentials-locked"):
                problems.append("no 'restored passwords stay locked' line under Credentials")
            self.shot(label="preview")
            assert not problems, "; ".join(problems)

        with self.step(
            "backup.restore.defaults.replace",
            "Ticking Settings is the deliberate Replace: the warning and a red action appear, "
            "and every select shares one width (#5824)",
            expect="#5824: Settings ticked on Replace, the warning 'Replace overwrites your "
            "current settings: anything not in the backup is removed. This cannot be undone.', "
            "a red 'Restore and restart', and the Merge and Replace selects one width with one "
            "right edge",
        ):
            self.require("backup.restore.defaults")
            self.driver.click("backup-restore-include-settings")
            self.wait(
                lambda: self.driver.exists("backup-restore-replace-warning"),
                what="the replace warning",
            )
            problems = []
            mode = self.driver.get_text("backup-restore-mode-settings").strip()
            if mode != "Replace":
                problems.append(f"ticked Settings reads {mode!r}, not Replace")
            submit = self.driver.get_attribute("backup-restore-submit", "class") or ""
            if "ui-btn--danger" not in submit:
                problems.append(f"Restore is not destructive while replacing: {submit!r}")
            rects = [
                self.driver.measure_element(f"backup-restore-mode-{sid}")["rect"]
                for sid in MERGEABLE + REPLACE_ONLY
            ]
            self.evidence(f"select boxes: {rects}")
            problems += select_alignment_problems(rects)
            self.shot(label="replace")
            self.driver.click("modal-close")
            assert not problems, "; ".join(problems)


# ── Per-PR grade checks (no app) ─────────────────────────────────────────────
def _state(checked: bool, mode: str | None) -> dict[str, str | None]:
    return {"checked": "true" if checked else "false", "mode": mode}


def test_the_safe_defaults_pass():
    states = {"connections": _state(True, "Merge"), "settings": _state(False, None)}
    assert default_choice_problems(states) == []


def test_settings_ticked_on_replace_by_default_is_named():
    states = {"connections": _state(True, "Merge"), "settings": _state(True, "Replace")}
    assert default_choice_problems(states) == [
        "'settings' defaults to Replace",
        "replace-only 'settings' is ticked by default",
    ]


def test_a_mergeable_section_on_replace_is_named():
    problems = default_choice_problems({"connections": _state(True, "Replace")})
    assert problems[0] == "'connections' defaults to Replace"
    assert "does not default to a ticked Merge" in problems[1]


def test_aligned_selects_pass_and_ragged_ones_are_named():
    aligned = [{"x": 300, "width": 136}, {"x": 300.4, "width": 136}]
    assert select_alignment_problems(aligned) == []
    ragged = [{"x": 300, "width": 136}, {"x": 320, "width": 110}]
    assert select_alignment_problems(ragged) == [
        "select widths differ: [110.0, 136.0]",
        "select right edges differ: [430.0, 436.0]",
    ]


def test_the_origin_line_must_name_the_backup():
    good = "Created 23 Nov 2026 23:05 · termiHub 0.1.0 · termihub-backup.json"
    assert origin_problems(good, "termihub-backup.json") == []
    assert len(origin_problems("Created 23 Nov 2026", "termihub-backup.json")) == 2

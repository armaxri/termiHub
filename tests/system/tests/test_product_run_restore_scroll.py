"""Product run: the restore preview never nests its scrolling (#5935).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Back up stopped scrolling its section list inside the
dialog in #5847 (R-020); the restore preview still did, with the same list
style inside its own 320px scroll area, and clipped its rows. Now:

1. The dialog body is the only scroll area: the section list neither scrolls
   nor hides any of its content.
2. Kinds the backup holds nothing for fold into one short line under the list
   ("3 other kinds are empty in this backup.") that names them in its
   tooltip, and no listed row reads "0 in backup".
3. Credentials sit right after Connections, so they are never below the fold.
4. The #5824 safe defaults and the origin line stay (graded in full by
   ``test_product_run_backup_restore_defaults.py``; here only that Settings
   is unticked and nothing defaults to Replace).

The class runs in its own fresh profile: it sets a master-password store up
(never the OS keychain), saves one local connection, backs up and previews
the restore. No sshd. The grades are pure functions, graded without an app in
the per-PR lane by the tests at the bottom of this file.
"""

from __future__ import annotations

import re
import tempfile
from collections.abc import Sequence
from pathlib import Path

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

MASTER_PASSWORD = "product-run-restore-scroll-pw"
BACKUP_PASSPHRASE = "product-run-restore-scroll-backup"
EMPTY_LINE = re.compile(r"^\d+ other (kind is|kinds are) empty in this backup\.$")
EMPTY_TOOLTIP = re.compile(r"^Empty in this backup: \S.*$")
ZERO_ROW = re.compile(r"\b0 in backup\b")
#: Scroll extents may differ by sub-pixel rounding, never more.
SCROLL_TOLERANCE_PX = 1.0
ROW_PREFIX = "backup-restore-section-"
#: Every row the preview can list: the backend's sections (``backup/sections.rs``),
#: plugins and the credentials vault.
SECTION_IDS = (
    "connections",
    "credentials",
    "namedCredentials",
    "settings",
    "workspaces",
    "macros",
    "workflows",
    "schedules",
    "tunnels",
    "embeddedServers",
    "wolDevices",
    "httpMonitors",
    "networkToolHistory",
    "httpMonitorHistory",
    "fileBrowserBookmarks",
    "sshKnownHosts",
    "rdpKnownHosts",
    "plugins",
)


def nested_scroll_problems(
    overflow_y: str, scroll_height: float, client_height: float
) -> list[str]:
    """Whether the restore section list scrolls (or clips) inside the dialog, or ``[]``."""
    problems = []
    if overflow_y.strip() in ("auto", "scroll", "hidden", "clip"):
        problems.append(f"the section list is its own scroll area (overflow-y: {overflow_y})")
    if scroll_height - client_height > SCROLL_TOLERANCE_PX:
        problems.append(
            f"the section list hides {scroll_height - client_height:.0f}px of its content"
        )
    return problems


def empty_kinds_problems(
    list_text: str, line_text: str | None, tooltip: str | None, height: float, line_height: float
) -> list[str]:
    """Whether empty kinds fold into one short line with their names in its tooltip, or ``[]``.

    ``line_text`` is ``None`` when the backup holds no empty kinds (no line).
    """
    problems = []
    if ZERO_ROW.search(list_text):
        problems.append("a listed section reads '0 in backup' instead of folding")
    if line_text is None:
        return problems
    if not EMPTY_LINE.match(line_text.strip()):
        problems.append(f"empty kinds are not one short count line: {line_text!r}")
    if not EMPTY_TOOLTIP.match((tooltip or "").strip()):
        problems.append(f"the empty-kinds line does not name them in its tooltip: {tooltip!r}")
    if line_height > 0 and height > line_height * 1.5:
        problems.append(f"the empty-kinds line wraps ({height:.0f}px for {line_height:.0f}px)")
    return problems


def row_order_problems(row_ids: Sequence[str]) -> list[str]:
    """Whether Credentials sit right after Connections (or first without them), or ``[]``."""
    ids = [r.removeprefix(ROW_PREFIX) for r in row_ids]
    if "credentials" not in ids:
        return []
    expected = 1 if ids and ids[0] == "connections" else 0
    at = ids.index("credentials")
    if at != expected:
        return [f"Credentials is row {at + 1}, not right after Connections: {ids}"]
    return []


def _px(value: str) -> float:
    try:
        return float(str(value).strip().removesuffix("px"))
    except ValueError:
        return 0.0


@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunRestoreScroll(
    ProductRunUi,
    CredsPhaseUi,
    CredentialStoreUi,
    SettingsUi,
    ConnectionsUi,
    SidebarUi,
    SystemTest,
):
    phase = "Restore scroll"
    request_timeout = 90.0

    def reset_before_rerun(self) -> None:
        self.dismiss_modals("backup-restore-title")

    def _row_ids(self) -> list[str]:
        rows = [f"{ROW_PREFIX}{sid}" for sid in SECTION_IDS]
        present = [r for r in rows if self.driver.exists(r)]
        # Order them as they render, by their top edge.
        tops = {r: float(self.driver.measure_element(r)["rect"]["y"]) for r in present}
        return sorted(present, key=lambda r: tops[r])

    def test_10_restore_preview_has_one_scroll_area(self):
        target = Path(tempfile.mkdtemp(prefix="thub-pr-restore-scroll-")) / "termihub-backup.json"
        with self.step(
            "backup.restore.scroll",
            "The restore preview's section list never scrolls inside the dialog; empty kinds "
            "fold into one line (#5935)",
            expect="#5935: the restore preview opening with 'Created … · termiHub … · "
            "termihub-backup.json'; Connections, then Credentials, then Settings (unticked) as "
            "plain rows with no scroll bar of their own, every row fully visible, and no row "
            "reading '0 in backup'",
        ):
            self.setup_master_password_store(MASTER_PASSWORD)
            # A fresh profile has no connections, and the preview lists only the
            # sections the backup holds: save one so Connections is there.
            self.switch_to_connections_sidebar()
            self.create_local_connection(unique_name("pr-restore-scroll"))
            self.back_up(
                target, BACKUP_PASSPHRASE, credentials=True, master_password=MASTER_PASSWORD
            )
            self.wait_backup_written(target)
            rows = self.preview_restore(target, BACKUP_PASSPHRASE)
            self.evidence(f"preview: {rows}")

            overflow = self.driver.get_computed_style("overflow-y", "backup-restore-sections")
            box = self.driver.measure_element("backup-restore-sections")
            self.evidence(
                f"list overflow-y {overflow!r}; scrollHeight {box['scrollHeight']}, "
                f"clientHeight {box['clientHeight']}"
            )
            problems = nested_scroll_problems(
                overflow, float(box["scrollHeight"]), float(box["clientHeight"])
            )

            line_text = tooltip = None
            height = line_height = 0.0
            if self.driver.exists("backup-restore-empty-sections"):
                line = self.driver.measure_element("backup-restore-empty-sections")
                line_text = str(line["text"])
                tooltip = str(line.get("title") or "")
                height = float(line["rect"]["height"])
                line_height = _px(
                    self.driver.get_computed_style("line-height", "backup-restore-empty-sections")
                )
                self.evidence(f"empty line {line_text!r} (tooltip {tooltip!r}) {line['rect']}")
            problems += empty_kinds_problems(
                str(box["text"]), line_text, tooltip, height, line_height
            )

            order = self._row_ids()
            self.evidence(f"rows: {order}")
            problems += row_order_problems(order)

            settings = self.driver.get_attribute("backup-restore-include-settings", "aria-checked")
            if settings == "true":
                problems.append("Settings is ticked by default (#5824)")
            if self.driver.exists("backup-restore-replace-warning"):
                problems.append("a replace warning shows although nothing is replaced (#5824)")
            origin = self.driver.get_text("backup-restore-preview-origin").strip()
            self.evidence(f"origin: {origin!r}")
            if not origin.startswith("Created ") or target.name not in origin:
                problems.append(f"the origin line does not name the backup: {origin!r}")
            self.shot(label="preview", expect="backup-restore-sections")
            self.driver.click("modal-close")
            assert not problems, "; ".join(problems)


# ── Per-PR grade checks (no app) ─────────────────────────────────────────────
def test_a_list_that_does_not_scroll_passes():
    assert nested_scroll_problems("visible", 240.0, 240.0) == []
    assert nested_scroll_problems("visible", 240.4, 240.0) == []


def test_the_old_bounded_list_is_named():
    assert nested_scroll_problems("auto", 520.0, 320.0) == [
        "the section list is its own scroll area (overflow-y: auto)",
        "the section list hides 200px of its content",
    ]
    assert nested_scroll_problems("hidden", 320.0, 320.0) == [
        "the section list is its own scroll area (overflow-y: hidden)"
    ]


def test_folded_empty_kinds_pass():
    text = "Connections 1 in backup · 1 new Settings Not included"
    assert empty_kinds_problems(text, None, None, 0, 0) == []
    assert (
        empty_kinds_problems(
            text,
            "2 other kinds are empty in this backup.",
            "Empty in this backup: tunnels, macros",
            18,
            18,
        )
        == []
    )
    assert (
        empty_kinds_problems(
            text, "1 other kind is empty in this backup.", "Empty in this backup: tunnels", 18, 18
        )
        == []
    )


def test_listed_empty_rows_and_a_bad_line_are_named():
    problems = empty_kinds_problems(
        "Tunnels 0 in backup · 0 new", "Nothing saved yet: tunnels, macros", "", 40, 18
    )
    assert problems == [
        "a listed section reads '0 in backup' instead of folding",
        "empty kinds are not one short count line: 'Nothing saved yet: tunnels, macros'",
        "the empty-kinds line does not name them in its tooltip: ''",
        "the empty-kinds line wraps (40px for 18px)",
    ]
    # "10 in backup" is a real count, not an empty row.
    assert empty_kinds_problems("Macros 10 in backup", None, None, 0, 0) == []


def test_credentials_follow_connections():
    ok = [f"{ROW_PREFIX}connections", f"{ROW_PREFIX}credentials", f"{ROW_PREFIX}settings"]
    assert row_order_problems(ok) == []
    assert row_order_problems([f"{ROW_PREFIX}credentials", f"{ROW_PREFIX}settings"]) == []
    assert row_order_problems([f"{ROW_PREFIX}settings"]) == []
    late = [f"{ROW_PREFIX}connections", f"{ROW_PREFIX}settings", f"{ROW_PREFIX}credentials"]
    assert row_order_problems(late) == [
        "Credentials is row 3, not right after Connections: "
        "['connections', 'settings', 'credentials']"
    ]

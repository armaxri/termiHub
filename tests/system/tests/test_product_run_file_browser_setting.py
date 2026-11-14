"""Product run: the File browser setting's home (#5786).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). The global File browser toggle is a default for new SSH
connections (it enables the SFTP browser of SSH agent sessions), but it was the
last field left under Settings ▸ External files ▸ Advanced, where nobody looked
for it. Since #5786 it sits under General ▸ New connection defaults, next to
X11 forwarding by default; the setting key did not change. External files
keeps only the external connection file list.

The placement check is a pure function, graded without an app in the per-PR
lane by the tests at the bottom of this file.
"""

from __future__ import annotations

import pytest

from termihub_harness import SettingsUi, SystemTest
from termihub_harness.product_run import ProductRunUi

#: The File browser toggle's testid.
FILE_BROWSER = "toggle-file-browser"
#: A field the new home must also show: the other new-connection default.
X11_DEFAULT = "settings-default-x11-forwarding"
#: The External files page's own control (its Add file button).
EXTERNAL_ADD = "external-files-add"


def placement_problems(on_general: set[str], on_external_files: set[str]) -> list[str]:
    """What is wrong with the File browser toggle's placement, or ``[]``.

    Each set holds the testids (of :data:`FILE_BROWSER`, :data:`X11_DEFAULT` and
    :data:`EXTERNAL_ADD`) found on that category's page.
    """
    problems = []
    if FILE_BROWSER not in on_general:
        problems.append("File browser missing from General")
    if X11_DEFAULT not in on_general:
        problems.append("General shows no New connection defaults")
    if FILE_BROWSER in on_external_files:
        problems.append("File browser still under External files")
    if EXTERNAL_ADD not in on_external_files:
        problems.append("External files lost its connection file list")
    return problems


@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunFileBrowserSetting(ProductRunUi, SettingsUi, SystemTest):
    phase = "File browser setting"

    def _fields_on(self, category: str) -> set[str]:
        self.open_settings_category(category)
        self.wait(
            lambda: self.driver.exists(f"settings-nav-{category}"),
            what=f"the {category} settings page",
        )
        return {f for f in (FILE_BROWSER, X11_DEFAULT, EXTERNAL_ADD) if self.driver.exists(f)}

    def test_01_file_browser_sits_with_new_connection_defaults(self):
        with self.step(
            "settings.file-browser.placement",
            "The File browser toggle sits under General with the new-connection defaults (#5786)",
            expect="Settings ▸ General ▸ New connection defaults shows File browser; "
            "External files shows only the connection file list",
        ):
            on_external_files = self._fields_on("external-files")
            on_general = self._fields_on("general")
            self.evidence(f"general {sorted(on_general)}; external {sorted(on_external_files)}")
            problems = placement_problems(on_general, on_external_files)
            assert not problems, problems


# ── Per-PR grade checks (no app) ─────────────────────────────────────────────
def test_the_new_placement_passes():
    assert placement_problems({FILE_BROWSER, X11_DEFAULT}, {EXTERNAL_ADD}) == []


def test_the_old_placement_is_named():
    assert placement_problems({X11_DEFAULT}, {FILE_BROWSER, EXTERNAL_ADD}) == [
        "File browser missing from General",
        "File browser still under External files",
    ]


def test_a_lost_file_list_is_named():
    assert placement_problems({FILE_BROWSER, X11_DEFAULT}, set()) == [
        "External files lost its connection file list"
    ]

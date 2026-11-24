"""Product run: sidebar folder rows explain their marker and lead with the chevron (#5855).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` found two problems. A collapsed folder holding the active
connection showed only a 6 px dot that looked like an unread badge (R-058).
Folder chevrons sat on the right while the section headers had them on the
left (R-142). Folder rows now lead with the chevron. A marked folder's name is
tinted and bold, the dot follows the name, and the row's tooltip reads
"Contains the active connection".

The grade uses two local-shell connections, one inside a folder and one
outside it, plus an empty folder next to it. No servers needed.

The ``test_grade_*`` functions grade fixed measurements without an app and run
in the normal lane.
"""

from __future__ import annotations

from typing import Any, ClassVar

import pytest

from termihub_harness import (
    ConnectionsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    connection_item_testid,
    folder_toggle_testid,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.sidebar_folders import (
    CONTAINS_ACTIVE,
    chevron_side_problems,
    folder_marker_problems,
    measure_disclosure,
    measure_folder_marker,
)

#: The SAVED section header toggle (``ConnectionList.tsx``).
SAVED_TOGGLE = "connection-list-group-toggle"


# ── app-free grade tests ──────────────────────────────────────────────────
def _box(x: float, width: float) -> dict[str, float]:
    return {"x": x, "y": 10.0, "width": width, "height": 16.0}


def _row(row_id: str, chevron_x: float, label_x: float) -> dict:
    return {"id": row_id, "chevron": _box(chevron_x, 16.0), "label": _box(label_x, 80.0)}


def _marker(**overrides) -> dict:
    measured = {
        "row_title": CONTAINS_ACTIVE,
        "marker": {"rect": _box(132.0, 6.0)},
        "marker_label": CONTAINS_ACTIVE,
        "label_rect": _box(48.0, 80.0),
        "label_weight": "600",
        "label_color": "rgb(90, 166, 255)",
        "plain_color": "rgb(204, 204, 204)",
    }
    measured.update(overrides)
    return measured


def test_grade_chevrons_left_of_labels_pass():
    rows = [_row("saved-header", 8.0, 28.0), _row("folder", 8.0, 48.0)]
    assert chevron_side_problems(rows) == []


def test_grade_trailing_folder_chevron_fails():
    # The R-142 shape: the header leads with its chevron, the folder trails.
    problems = chevron_side_problems([_row("saved-header", 8.0, 28.0), _row("folder", 220.0, 28.0)])
    assert len(problems) == 1 and "folder" in problems[0]


def test_grade_missing_chevron_fails():
    row = {"id": "folder", "chevron": _box(0.0, 0.0), "label": _box(28.0, 80.0)}
    assert any("no visible chevron" in p for p in chevron_side_problems([row]))


def test_grade_explained_marker_passes():
    assert folder_marker_problems(_marker()) == []
    assert folder_marker_problems(_marker(label_weight="bold")) == []


def test_grade_bare_dot_fails():
    # The R-058 shape: a dot at the row's far end, the name unchanged, no tooltip.
    problems = folder_marker_problems(
        _marker(
            row_title="",
            marker={"rect": _box(230.0, 6.0)},
            label_weight="400",
            label_color="rgb(204, 204, 204)",
        )
    )
    assert any("tooltip" in p for p in problems)
    assert any("from the end of the name" in p for p in problems)
    assert any("not bold" in p for p in problems)
    assert any("not tinted" in p for p in problems)


def test_grade_missing_or_misnamed_marker_fails():
    assert folder_marker_problems(_marker(marker=None)) == [
        "the collapsed folder shows no contains-active marker"
    ]
    assert any("named" in p for p in folder_marker_problems(_marker(marker_label="New")))


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunSidebarFolders(
    ProductRunUi, TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SystemTest
):
    phase = "Sidebar folders"
    request_timeout = 90.0
    ids: ClassVar[dict[str, str]] = {}

    def _expanded(self, folder_id: str) -> bool:
        return self.driver.get_attribute(folder_toggle_testid(folder_id), "aria-expanded") == "true"

    def _collapse(self, folder_id: str) -> None:
        if self._expanded(folder_id):
            self.driver.click(folder_toggle_testid(folder_id))
        self.wait(lambda: not self._expanded(folder_id), what="the folder to collapse")

    def test_10_folder_chevrons_match_section_headers(self):
        with self.step(
            "sidebar.folders.chevron-side",
            "Folder rows put the chevron on the left, like the SAVED header (#5855)",
            expect="the SAVED header and both folder rows with the chevron before the name",
        ):
            self.close_all_tabs()
            self.switch_to_connections_sidebar()
            marked = self.create_folder(unique_name("pr-folders-marked"))
            plain = self.create_folder(unique_name("pr-folders-plain"))
            type(self).ids = {"marked": marked["id"], "plain": plain["id"]}
            rows = [measure_disclosure(self.driver, SAVED_TOGGLE, SAVED_TOGGLE)]
            for folder_id in (marked["id"], plain["id"]):
                row = folder_toggle_testid(folder_id)
                self.wait(lambda r=row: self.driver.exists(r), what=f"the {row} row")
                rows.append(measure_disclosure(self.driver, row, f"{row}-label"))
            for row in rows:
                self.evidence(
                    f"{row['id']}: chevron x={row['chevron']['x']:.0f}, "
                    f"label x={row['label']['x']:.0f}"
                )
            problems = chevron_side_problems(rows)
            assert not problems, problems

    def test_20_collapsed_folder_explains_the_marker(self):
        with self.step(
            "sidebar.folders.active-marker",
            "A collapsed folder holding the active connection says so: tinted bold name, "
            "a dot after it and a tooltip (#5855)",
            expect="the collapsed folder's name in the accent colour and bold with a small "
            "dot right after it; the empty folder below it in plain text",
        ):
            self.require("sidebar.folders.chevron-side")
            marked, plain = self.ids["marked"], self.ids["plain"]
            inside, outside = unique_name("pr-folders-inside"), unique_name("pr-folders-outside")
            self.folder_context_action(marked, "context-folder-new-connection")
            self.wait(self.editor_open, what="the new-connection editor")
            self.driver.type(self.EDITOR_NAME, inside)
            self._click_editor_save(True)
            inside_tab = self.tab_id_of(inside)
            self.create_local_connection(outside, connect=True)
            self.tab_id_of(outside)
            self._collapse(marked)
            self.switch_to_tab(inside_tab)

            def in_folder_tab_active() -> dict[str, Any] | None:
                tab = self.active_tab()
                return tab if tab and tab.get("id") == inside_tab else None

            active = self.wait(in_folder_tab_active, what="the in-folder tab to become active")
            connection_id = active.get("connectionId")
            assert connection_id, "the in-folder tab carries no saved-connection id"
            row = folder_toggle_testid(marked)
            self.wait(lambda: self.driver.exists(f"{row}-active-marker"), what="the marker")
            measured = measure_folder_marker(self.driver, row, folder_toggle_testid(plain))
            self.evidence(
                f"tooltip {measured['row_title']!r}; marker {measured['marker_label']!r}; "
                f"name weight {measured['label_weight']}, colour {measured['label_color']} "
                f"(plain folder {measured['plain_color']})"
            )
            assert not self._expanded(marked), "a tab switch expanded the folder"
            assert not self.driver.exists(connection_item_testid(connection_id))
            problems = folder_marker_problems(measured)
            assert not problems, problems
        self.close_all_tabs()

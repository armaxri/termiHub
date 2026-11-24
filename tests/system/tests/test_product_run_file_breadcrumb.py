"""Product run: the breadcrumb keeps the current folder whole (#5833).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` saw the current folder of a deep path truncated
("… > 5-a-rather-long-folder-name-for-the-…", R-034 / R-036), no affordance
on the "…" fold, and "Copy path" buried in a menu (R-118). The path bar now
folds earlier segments into the "…" menu first and wraps a current folder
wider than the bar onto more lines, never cutting it; the "…" menu lists the
folded folders and navigates; a "Copy path" button sits at the bar's end.

The grade opens the local file browser six long folders deep (the run's
shape, with a long current folder), then at the normal and the minimum
sidebar width checks the current folder is whole and inside the bar, the
middle folds, the tooltip is the full path and "Copy path" is in the bar. It
then opens the "…" menu, checks it lists the folded folders in order and
navigates to one. The copy click itself is graded by the component tests: the
live run must not overwrite the operator's clipboard. No servers needed.

The ``test_grade_*`` functions grade fixed measurements without an app and run
in the normal lane.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import pytest

from termihub_harness import FilesUi, SidebarUi, SystemTest, TabsUi, TerminalUi
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.breadcrumb import (
    CRUMB_MENU,
    CRUMB_OVERFLOW,
    breadcrumb_problems,
    crumb_testid,
    fold_menu_problems,
    measure_breadcrumb,
    menu_item_testid,
)

#: The run's deep path: six long folders, the last one the current folder.
SEGMENTS = [f"{i}-a-rather-long-folder-name-for-the-path-bar-check" for i in range(1, 7)]
LEAF = SEGMENTS[-1]
RESIZE_HANDLE = "sidebar-resize-handle"
PATH_EDIT = "file-browser-path-edit"
PATH_INPUT = "file-browser-path-input"


# ── app-free grade tests ──────────────────────────────────────────────────
def _box(x: float, width: float, y: float = 10.0, height: float = 20.0) -> dict[str, float]:
    return {"x": x, "y": y, "width": width, "height": height}


def _measured(x: float, width: float, *, text: str = "", sw: float | None = None,
              sh: float = 20.0, ch: float = 20.0) -> dict[str, Any]:
    return {"rect": _box(x, width), "scrollWidth": sw if sw is not None else width,
            "clientWidth": width, "scrollHeight": sh, "clientHeight": ch, "text": text}


def _bar(*, leaf: dict[str, Any] | None, overflow: bool = True, copy: bool = True,
         title: str = "/deep/" + LEAF, items: list[dict[str, Any]] | None = None) -> dict:
    nav = _measured(10.0, 180.0)
    nav["title"] = title
    nav["items"] = items or []
    return {
        "nav": nav,
        "leaf": leaf,
        "overflow": _measured(12.0, 18.0, text="…") if overflow else None,
        "copy": _measured(192.0, 20.0) if copy else None,
        "sidebar": _box(0.0, 220.0, 0.0, 800.0),
    }


def _wrapped_leaf() -> dict[str, Any]:
    # Three lines of a wrapped leaf: taller than one line, nothing hidden.
    leaf = _measured(34.0, 150.0, text=LEAF, sh=48.0, ch=48.0)
    leaf["rect"]["height"] = 48.0
    return leaf


def test_grade_wrapped_whole_leaf_passes():
    assert breadcrumb_problems(_bar(leaf=_wrapped_leaf()), full="/deep/" + LEAF, leaf=LEAF) == []


def test_grade_ellipsized_leaf_fails():
    # The R-034 / R-036 shape: the leaf's text is wider than its box.
    leaf = _measured(34.0, 150.0, text=LEAF, sw=360.0)
    problems = breadcrumb_problems(_bar(leaf=leaf), full="/deep/" + LEAF, leaf=LEAF)
    assert any("cut off sideways" in p for p in problems)


def test_grade_clamped_leaf_fails():
    leaf = _measured(34.0, 150.0, text=LEAF, sh=80.0, ch=48.0)
    problems = breadcrumb_problems(_bar(leaf=leaf), full="/deep/" + LEAF, leaf=LEAF)
    assert any("clamped" in p for p in problems)


def test_grade_missing_or_escaping_leaf_fails():
    assert any("no segment" in p for p in breadcrumb_problems(
        _bar(leaf=None), full="/deep/" + LEAF, leaf=LEAF))
    outside = _measured(150.0, 150.0, text=LEAF)
    assert any("outside the bar" in p for p in breadcrumb_problems(
        _bar(leaf=outside), full="/deep/" + LEAF, leaf=LEAF))


def test_grade_spilling_segment_fails():
    spill = {"text": "4-a-rather", "rect": _box(170.0, 60.0), "visible": True}
    problems = breadcrumb_problems(
        _bar(leaf=_wrapped_leaf(), items=[spill]), full="/deep/" + LEAF, leaf=LEAF
    )
    assert any("spill" in p for p in problems)


def test_grade_no_fold_no_copy_wrong_tooltip_fail():
    problems = breadcrumb_problems(
        _bar(leaf=_wrapped_leaf(), overflow=False, copy=False, title="/deep"),
        full="/deep/" + LEAF, leaf=LEAF,
    )
    assert any("'…' button" in p for p in problems)
    assert any("'Copy path'" in p for p in problems)
    assert any("tooltip" in p for p in problems)


def test_grade_short_path_needs_no_fold():
    bar = _bar(leaf=_measured(34.0, 40.0, text="home"), overflow=False, title="/home")
    assert breadcrumb_problems(bar, full="/home", leaf="home", expect_fold=False) == []


def test_grade_fold_menu_lists_hidden_in_order():
    hidden = ["/", "home", SEGMENTS[0]]
    assert fold_menu_problems([menu_item_testid(h) for h in hidden], hidden) == []
    assert any("missing" in p for p in fold_menu_problems([menu_item_testid("/")], hidden))
    shuffled = [menu_item_testid(h) for h in reversed(hidden)]
    assert any("out of order" in p for p in fold_menu_problems(shuffled, hidden))


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunFileBreadcrumb(ProductRunUi, FilesUi, TerminalUi, TabsUi, SidebarUi,
                                   SystemTest):
    phase = "File breadcrumb"
    request_timeout = 90.0
    deep: Path | None = None

    def _sidebar_min(self) -> float:
        before = float(self.driver.get_state("sidebarWidth"))
        self.driver.drag(RESIZE_HANDLE, -2000)  # clamps at the minimum
        time.sleep(0.8)  # let the bar re-measure and re-layout
        return before

    def _sidebar_restore(self, width: float) -> None:
        now = float(self.driver.get_state("sidebarWidth"))
        if abs(now - width) > 1:
            self.driver.drag(RESIZE_HANDLE, int(width - now))
            time.sleep(0.5)

    def _labels(self, path: Path) -> list[str]:
        return ["/", *path.parts[1:]]

    def _grade(self, where: str, full: Path) -> None:
        m = measure_breadcrumb(self.driver, LEAF)
        leaf = m["leaf"] or {}
        self.evidence(
            f"{where}: bar {m['nav']['rect']['width']:.0f}px; leaf "
            f"{leaf.get('rect', {}).get('width', 0):.0f}x{leaf.get('rect', {}).get('height', 0):.0f}"
            f"px scroll {leaf.get('scrollWidth')}x{leaf.get('scrollHeight')} / client "
            f"{leaf.get('clientWidth')}x{leaf.get('clientHeight')}; fold "
            f"{'yes' if m['overflow'] else 'no'}; copy {'yes' if m['copy'] else 'no'}"
        )
        problems = breadcrumb_problems(m, full=str(full), leaf=LEAF)
        assert not problems, f"{where}: " + "; ".join(problems)

    def test_10_long_current_folder_whole(self):
        with self.step(
            "file-breadcrumb.leaf",
            "Six long folders deep: the current folder shows whole, the middle folds, "
            "'Copy path' in the bar (#5833)",
            expect="#5833: the path bar reads '… > 6-a-rather-long-folder-name-for-the-path-"
            "bar-check' with the current folder wrapped onto more lines, never cut with "
            "'…'; a copy icon at the bar's end; also at the minimum sidebar width",
            screenshot=False,
        ):
            deep = self.recorder.run_dir.joinpath("breadcrumb-deep", *SEGMENTS)
            deep.mkdir(parents=True, exist_ok=True)
            type(self).deep = deep
            before = self.tab_ids()
            self.switch_to_connections_sidebar()
            self.open_new_terminal()
            self.wait(lambda: len(self.tab_ids()) == len(before) + 1, what="a local terminal")
            tab = next(t for t in self.tab_ids() if t not in before)
            self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the local prompt")
            self.run_command(f"cd '{deep}'")
            self.switch_to_files_sidebar()
            self.wait_for_path_contains(LEAF)
            problems = []
            for where in ("normal", "min-width"):
                restore = self._sidebar_min() if where == "min-width" else None
                try:
                    self._grade(where, deep)
                except AssertionError as exc:
                    problems.append(str(exc))
                finally:
                    self.shot("file-breadcrumb.leaf", label=where)
                    if restore is not None:
                        self._sidebar_restore(restore)
            assert not problems, " | ".join(problems)

    def test_20_fold_menu_navigates(self):
        with self.step(
            "file-breadcrumb.fold-menu",
            "The '…' button opens a menu of the folded folders that navigates (#5833)",
            expect="#5833: an open menu under '…' listing the hidden folders nearest the "
            "root first, plus 'Copy path'",
        ):
            self.require("file-breadcrumb.leaf")
            deep = type(self).deep
            assert deep is not None
            hidden = [lbl for lbl in self._labels(deep) if not self.driver.exists(crumb_testid(lbl))]
            self.evidence(f"folded: {hidden}")
            assert hidden, "nothing is folded at the normal width"
            self.driver.click(CRUMB_OVERFLOW)
            self.wait(lambda: self.driver.exists(CRUMB_MENU), what="the '…' menu")
            present = [h for h in hidden if self.driver.exists(menu_item_testid(h))]
            ordered = sorted(
                present,
                key=lambda h: self.driver.measure_element(menu_item_testid(h))["rect"]["y"],
            )
            self.shot(label="menu-open")
            problems = fold_menu_problems([menu_item_testid(h) for h in ordered], hidden)
            assert not problems, problems
            target = hidden[-1]
            # The nearest folded ancestor: labels and path parts line up ("/" first).
            target_path = str(Path(*deep.parts[: self._labels(deep).index(target) + 1]))
            self.driver.click(menu_item_testid(target))
            self.wait(
                lambda: self.file_browser_path().rstrip("/") == target_path.rstrip("/"),
                what=f"the browser at {target_path}",
            )
            self.evidence(f"navigated to {target_path}")
        self.close_all_tabs()

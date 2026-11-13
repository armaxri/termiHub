"""Product run: the maintainer's own UI complaints, auto-graded (#5535).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Each complaint is an explicit step with a window capture
and an ``expect`` line naming it, so the UI-review agents check it too. A step
fails until its fix lands; the grade is never weakened to pass.

1. **Automations list by name** (#5519): a macro and a workflow with three
   steps each. Their sidebar rows, run-history rows and command-palette
   entries lead with the automation's name and show no step count
   ("N steps", "3/3").
2. **File browser action row** (#5520): the header actions sit on one line
   inside the sidebar, at most six icon buttons, the rest in a "…" overflow
   menu, at the normal and at the minimum sidebar width.
3. **Long paths** (#5521): a deep remote and a deep local path longer than the
   field show the leaf folder in full (not ellipsized), let no rendered
   segment spill past the field, fold the middle into "…" and carry the
   full path in the tooltip, at the normal and at the minimum sidebar width.
4. **Toast stack** (#5618): two toasts raised while the connection editor is
   open stack without overlapping each other and stay clear of the editor's
   Save / Cancel footer.
5. **File list** (#5623): a long file / folder name ends in an ellipsis inside
   the list (no hard cut, no horizontal scrollbar), the Modified / Size headers
   only show above a column that has values, and the header names whose
   filesystem it is ("user@host (SFTP)" remote, "This computer" local), at the
   normal and at the minimum sidebar width.
6. **File browser menu and path polish** (#5624, #5671): at the minimum
   sidebar width the opened "…" menu stays inside the window and does not
   reach left of the sidebar (over the activity bar); Up and Upload use
   different icons; the menu offers "Sort by" (Name / Modified / Size) and
   "Copy path".

Geometry comes from the test bridge's ``measureElement`` verb (viewport CSS
pixels).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
import time
from typing import Any

import pytest

from termihub_harness import (
    SSH_HOST,
    ConnectionsUi,
    FilesUi,
    PasswordPromptUi,
    SettingsUi,
    SftpUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    WorkflowUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.ssh_steps import SshPhaseUi

pytestmark = [
    pytest.mark.product_run,
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only"),
]

#: A step count as the old rows showed it: "3 steps", "1 step", "3/3".
STEP_COUNT = re.compile(r"\b\d+\s+steps?\b|\b\d+\s*/\s*\d+\b", re.I)
MAX_INLINE_ACTIONS = 6
#: Header actions that must stay reachable (inline or in the "…" menu).
HEADER_ACTIONS = (
    "file-browser-up",
    "file-browser-refresh",
    "file-browser-new-file",
    "file-browser-new-folder",
    "file-browser-toggle-hidden",
    "file-browser-cd-here",
)
REMOTE_ONLY_ACTIONS = ("file-browser-upload",)
MORE_ACTIONS = "file-browser-more-actions"
MORE_MENU = "file-browser-more-menu"
CRUMB_OVERFLOW = "file-browser-crumb-overflow"
PATH_BAR = "file-browser-current-path"
PATH_EDIT = "file-browser-path-edit"
PATH_INPUT = "file-browser-path-input"
SIDEBAR = "sidebar"
RESIZE_HANDLE = "sidebar-resize-handle"
FILTER = "file-browser-filter"
#: A deep path: five long folders, then a leaf short enough to fit the field
#: even at the minimum sidebar width (a 50-character leaf cannot be "fully
#: visible" in a 150 px field, so it would grade nothing).
LONG_SEGMENTS = [f"{i}-a-rather-long-folder-name-for-the-path-bar-check" for i in range(1, 6)] + [
    "current-folder"
]
EPS = 0.5
FILE_LIST = "file-browser-list"
HOST_LABEL = "file-browser-host"
#: Column headers that must sit above a column of values (#5623).
DATA_COLUMNS = ("file-browser-sort-modified", "file-browser-sort-size")
#: A file name far wider than the sidebar, so the list must ellipsize it.
LONG_FILE = "a-rather-long-file-name-that-never-fits-the-sidebar-width-check.txt"
TOAST_REGION = "toast-region"
SORT_MENU = "file-browser-sort-menu"
SORT_SUBMENU = "file-browser-sort-submenu"
SORT_KEYS = ("name", "modified", "size")
COPY_PATH = "file-browser-copy-path"
EDITOR_FOOTER = "connection-editor-actions"


def _center_y(box: dict[str, float]) -> float:
    return box["y"] + box["height"] / 2


def _inside(inner: dict[str, float], outer: dict[str, float]) -> bool:
    return (
        inner["x"] >= outer["x"] - EPS
        and inner["x"] + inner["width"] <= outer["x"] + outer["width"] + EPS
    )


def _intersects(a: dict[str, float], b: dict[str, float]) -> bool:
    """The two viewport boxes overlap by more than the rounding slack."""
    return (
        a["x"] < b["x"] + b["width"] - EPS
        and b["x"] < a["x"] + a["width"] - EPS
        and a["y"] < b["y"] + b["height"] - EPS
        and b["y"] < a["y"] + a["height"] - EPS
    )


def _shown(item: dict[str, Any]) -> bool:
    """Rendered and bigger than a screen-reader-only 1 px box."""
    return bool(item["visible"]) and item["rect"]["width"] > 2 and item["rect"]["height"] > 2


class TestProductRunComplaints(
    ProductRunUi,
    SshPhaseUi,
    WorkflowUi,
    SettingsUi,
    FilesUi,
    SftpUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
):
    phase = "Maintainer UI complaints"
    request_timeout = 90.0

    # ── 1. automations by name (#5519) ───────────────────────────────────────
    def _row_grade(self, testid: str, name: str, where: str) -> None:
        """The row's first visible text is ``name``; no step count anywhere in it."""
        measured = self.driver.measure_element(testid, "text")
        texts = [i["text"] for i in measured["items"] if _shown(i)]
        self.evidence(f"{where}: visible texts {texts[:5]}")
        assert texts, f"{where}: no visible text"
        assert texts[0] == name, f"{where}: first text is {texts[0]!r}, not the name {name!r}"
        counts = STEP_COUNT.findall(measured["text"])
        assert not counts, f"{where}: shows a step count {counts} in {measured['text']!r}"

    def _show_macros(self) -> None:
        """Show the Macros sidebar (clicking its active icon would close it)."""
        showing = self.driver.get_state("sidebarView") == "macros" and not self.driver.get_state(
            "sidebarCollapsed"
        )
        if not showing:
            self.driver.click("activity-bar-macros")
        self.wait(lambda: self.driver.exists("macro-sidebar"), what="the Macros sidebar")

    def _create_macro(self, name: str, steps: list[str]) -> str:
        self.enable_experimental_features()
        self._show_macros()
        self.invoke_toolbar_action("macro-new-btn", overflow="macro-toolbar-overflow")
        self.wait(lambda: self.driver.exists("macro-editor-dialog"), what="the macro editor")
        self.driver.type("macro-editor-name", name)
        for index, data in enumerate(steps):
            field = f"macro-editor-step-data-{index}"
            if not self.driver.exists(field):
                self.driver.click("macro-editor-add-step")
                self.wait(lambda f=field: self.driver.exists(f), what=f"macro step {index}")
            self.driver.type(field, data)
        self.wait(lambda: not self.is_disabled("macro-editor-save"), what="Save to enable")
        self.driver.click("macro-editor-save")
        self.wait(lambda: not self.driver.exists("macro-editor-dialog"), what="the editor to close")
        macro = self.wait(
            lambda: next((m for m in self.driver.get_state("macros") or [] if m.get("name") == name), None),
            what=f"the saved macro {name!r}",
        )
        return macro["id"]

    def _create_workflow(self, name: str, commands: list[str]) -> str:
        self.enable_experimental_features()
        self.open_workflows_sidebar()
        self.open_new_workflow()
        for index, command in enumerate(commands):
            self.add_step("send-command")
            self.set_command(index, command)
        self.set_name(name)
        self.save_workflow()
        return self.workflow_id(name)

    def test_10_automations_by_name(self):
        tag = unique_name("pr").split("-")[-1]
        macro_name, workflow_name = f"Deploy notes {tag}", f"Nightly cleanup {tag}"
        ids: dict[str, str] = {}
        with self.step(
            "complaints.automations.create",
            "A macro and a workflow with three steps each are saved",
            expect="the Workflows sidebar listing the new three-step workflow",
        ):
            ids["macro"] = self._create_macro(
                macro_name, [f"echo PR_MACRO_{i}_{tag}\\r" for i in range(1, 4)]
            )
            ids["workflow"] = self._create_workflow(
                workflow_name, [f"echo PR_WF_{i}_{tag}" for i in range(1, 4)]
            )
            self.evidence(f"macro {ids['macro']}, workflow {ids['workflow']}")
        with self.step(
            "complaints.automations.list",
            "Sidebar rows lead with the automation's name and show no step count (#5519)",
            expect="#5519 complaint: the macro and workflow rows start with their names; no "
            "'3 steps' badge in front of or beside the name",
            screenshot=False,
        ):
            self.require("complaints.automations.create")
            self.open_workflows_sidebar()
            self._row_grade(f"workflow-item-{ids['workflow']}", workflow_name, "workflow row")
            self.shot(label="workflows")
            self._show_macros()
            self.wait(lambda: self.driver.exists(f"macro-item-{ids['macro']}"), what="the macro row")
            self._row_grade(f"macro-item-{ids['macro']}", macro_name, "macro row")
            self.shot(label="macros")
        with self.step(
            "complaints.automations.history",
            "Run-history rows lead with the name and show no '3/3' counter (#5519)",
            expect="#5519 complaint: the macro run-history row starts with the macro's name, "
            "no '3/3' in front of it",
            screenshot=False,
        ):
            self.require("complaints.automations.create")
            self.ensure_terminal()
            self._show_macros()
            self.wait(lambda: self.driver.exists(f"macro-play-{ids['macro']}"), what="Play")
            self.driver.click(f"macro-play-{ids['macro']}")
            self.wait_for_output(f"PR_MACRO_3_{tag}")
            self.driver.click(f"macro-history-{ids['macro']}")
            self.wait(lambda: self.driver.exists("macro-history-list"), what="the macro history")
            self._row_grade("macro-history-list", macro_name, "macro history")
            self.shot(label="macro-history")
            self.open_workflows_sidebar()
            self.run_workflow(ids["workflow"])
            self.wait_for_output(f"PR_WF_3_{tag}")
            self.wait(lambda: self.driver.exists("workflow-history-list"), what="the workflow history")
            self._row_grade("workflow-history-list", workflow_name, "workflow history")
            self.shot(label="workflow-history")
        with self.step(
            "complaints.automations.palette",
            "Command-palette entries show the bare name, no step count (#5519)",
            expect="#5519 complaint: the command palette lists the macro and the workflow by "
            "name only (no 'Run macro:' prefix in front, no step count)",
        ):
            self.require("complaints.automations.create")
            self.driver.press_key("p", meta=sys.platform == "darwin", ctrl=sys.platform != "darwin",
                                  shift=sys.platform != "darwin")
            self.wait(lambda: self.driver.exists("command-palette-input"), what="the palette")
            self.driver.type("command-palette-input", tag)
            for kind, name in (("macro", macro_name), ("workflow", workflow_name)):
                item = f"command-palette-item-{kind}:{ids[kind]}"
                self.wait(lambda i=item: self.driver.exists(i), what=f"the {kind} entry")
                self._row_grade(item, name, f"palette {kind}")
        if self.driver.exists("command-palette-input"):
            self.driver.press_key("Escape", "command-palette-input")

    # ── 2 + 3. file browser header (#5520) and long paths (#5521) ────────────
    def _sidebar_min(self) -> float:
        before = float(self.driver.get_state("sidebarWidth"))
        self.driver.drag(RESIZE_HANDLE, -2000)  # clamps at the minimum
        time.sleep(0.8)  # let the header re-measure and re-layout
        self.evidence(f"sidebar {before:.0f}px -> {float(self.driver.get_state('sidebarWidth')):.0f}px")
        return before

    def _sidebar_restore(self, width: float) -> None:
        now = float(self.driver.get_state("sidebarWidth"))
        if abs(now - width) > 1:
            self.driver.drag(RESIZE_HANDLE, int(width - now))
            time.sleep(0.5)

    def _header_buttons(self) -> list[dict[str, Any]]:
        """The visible header action buttons: between the sidebar top and the filter."""
        sidebar = self.driver.measure_element(SIDEBAR, "buttons")
        top = sidebar["rect"]["y"]
        bottom = self.driver.measure_element(FILTER)["rect"]["y"]
        nav = self.driver.measure_element(PATH_BAR)["rect"]
        found = []
        for item in sidebar["items"]:
            tid = item["testId"] or ""
            box = item["rect"]
            if not _shown(item) or tid.startswith("file-browser-crumb") or tid == PATH_EDIT:
                continue
            centre = _center_y(box)
            if not top <= centre < bottom or nav["y"] <= centre <= nav["y"] + nav["height"]:
                continue
            found.append(item)
        return found

    def _grade_action_row(self, where: str, *, remote: bool) -> None:
        sidebar = self.driver.measure_element(SIDEBAR)
        buttons = self._header_buttons()
        names = [b["testId"] or b["label"] for b in buttons]
        self.evidence(f"{where}: sidebar {sidebar['rect']['width']:.0f}px, {len(buttons)} visible: {names}")
        problems = []
        lines = sorted({round(_center_y(b["rect"]) / 6) for b in buttons})
        if len(lines) > 1:
            problems.append(f"{len(lines)} lines of icons")
        outside = [n for b, n in zip(buttons, names) if not _inside(b["rect"], sidebar["rect"])]
        if outside:
            problems.append(f"outside the sidebar: {outside}")
        inline = [b for b in buttons if b["testId"] != MORE_ACTIONS]
        if len(inline) > MAX_INLINE_ACTIONS:
            problems.append(f"{len(inline)} inline icon buttons (max {MAX_INLINE_ACTIONS})")
        wanted = HEADER_ACTIONS + (REMOTE_ONLY_ACTIONS if remote else ())
        hidden = [a for a in wanted if a not in names]
        if hidden:
            if not self.driver.exists(MORE_ACTIONS):
                problems.append(f"no '…' overflow menu, and {hidden} are not inline")
            else:
                self.driver.click(MORE_ACTIONS)
                self.wait(lambda: self.driver.exists(MORE_MENU), what="the '…' menu")
                self.shot(label=f"{where}-menu")
                missing = [a for a in hidden if not self.driver.exists(a)]
                self.driver.press_key("Escape")
                if missing:
                    problems.append(f"not inline and not in the '…' menu: {missing}")
        elif not self.driver.exists(MORE_ACTIONS):
            problems.append("no '…' overflow menu")
        assert not problems, f"{where}: " + "; ".join(problems)

    def _grade_long_path(self, where: str, full: str, leaf: str) -> None:
        nav = self.driver.measure_element(PATH_BAR, "text")
        texts = [i["text"] for i in nav["items"] if _shown(i)]
        self.evidence(
            f"{where}: bar {nav['rect']['width']:.0f}px, scroll {nav['scrollWidth']} / client "
            f"{nav['clientWidth']}; visible {texts}"
        )
        problems = []
        # What the user sees spill: a rendered segment reaching past the field.
        # (The bar's own scrollWidth also counts its invisible measuring copy of
        # every segment, so it is evidence, not the grade.)
        spill = [i["text"] for i in nav["items"] if _shown(i) and not _inside(i["rect"], nav["rect"])]
        if spill:
            problems.append(f"segments overflow the field: {spill[:4]}")
        crumb = f"file-browser-crumb-{leaf}"
        if not self.driver.exists(crumb):
            problems.append("no crumb for the leaf folder")
        else:
            leaf_box = self.driver.measure_element(crumb)
            if not _inside(leaf_box["rect"], nav["rect"]) or leaf_box["rect"]["width"] <= 2:
                problems.append("the leaf folder lies outside the visible field")
            if leaf_box["scrollWidth"] > leaf_box["clientWidth"]:
                problems.append("the leaf folder name is cut off")
        if not (self.driver.exists(CRUMB_OVERFLOW) or any(t in ("…", "...") for t in texts)):
            problems.append("no '…' folds the middle of the path")
        if (nav["title"] or "").rstrip("/") != full.rstrip("/"):
            problems.append(f"tooltip is {nav['title']!r}, not the full path")
        assert not problems, f"{where}: " + "; ".join(problems)

    def _go_to(self, path: str) -> None:
        self.driver.click(PATH_EDIT)
        self.wait(lambda: self.driver.exists(PATH_INPUT), what="the path field")
        self.driver.type(PATH_INPUT, path)
        self.driver.press_key("Enter", PATH_INPUT)
        self.wait(lambda: self.file_browser_path().rstrip("/") == path.rstrip("/"), what=f"the browser at {path}")

    def _both_widths(self, step_id: str, grade) -> None:
        """Run ``grade(where)`` at the current and at the minimum sidebar width."""
        problems = []
        for where in ("normal", "min-width"):
            restore = self._sidebar_min() if where == "min-width" else None
            try:
                grade(where)
            except AssertionError as exc:
                problems.append(str(exc))
            finally:
                self.shot(step_id, label=where)
                if restore is not None:
                    self._sidebar_restore(restore)
        assert not problems, " | ".join(problems)

    def _open_remote(self) -> Path:
        native = self.need_native()
        root = (native.session_home or Path(native.target.state_dir)) / "pr-complaints"
        deep = root.joinpath(*LONG_SEGMENTS)
        deep.mkdir(parents=True, exist_ok=True)
        (deep / "deep-file.txt").write_text("at the bottom\n", encoding="utf-8")
        name = unique_name("pr-complaints")
        self.switch_to_connections_sidebar()
        self.create_ssh_connection(
            name, host=SSH_HOST, port=native.target.port, username=native.target.username,
            auth_method="key", key_path=str(native.client_key), connect=True,
        )
        self.accept_all_hostkeys(timeout=15.0)
        tab_id = self.tab_id_of(name)
        self.wait_connected(tab_id)
        self.run_command(f"cd '{root}'")
        self.echo_round_trip(tab_id, "PR_COMPLAINTS_CD_OK")
        self.connect_sftp_browser()
        self.wait_for_path_contains("pr-complaints")
        return deep

    def test_20_file_browser_header(self):
        deep: dict[str, Path] = {}
        with self.step(
            "complaints.actions.remote",
            "Remote file browser: header actions on one line, at most 6 icons, rest in '…' (#5520)",
            expect="#5520 complaint: the file browser's action icons fit on ONE line inside the "
            "sidebar (at most ~6), the others behind a '…' menu; also at the minimum width",
            screenshot=False,
        ):
            deep["remote"] = self._open_remote()
            self._both_widths(
                "complaints.actions.remote", lambda w: self._grade_action_row(w, remote=True)
            )
        with self.step(
            "complaints.long-path.remote",
            "Deep remote path: leaf folder fully visible, no overflow, middle folded, tooltip (#5521)",
            expect="#5521 complaint: a long remote path shows the current (last) folder in full, "
            "folds the middle into '…', nothing clipped or spilling; also at the minimum width",
            screenshot=False,
        ):
            if "remote" not in deep:
                pytest.skip("blocked: the remote browser did not open")
            full = str(deep["remote"])
            self._go_to(full)
            self._both_widths(
                "complaints.long-path.remote",
                lambda w: self._grade_long_path(w, full, LONG_SEGMENTS[-1]),
            )
        with self.step(
            "complaints.long-path.local",
            "Deep local path: leaf folder fully visible, no overflow, middle folded, tooltip (#5521)",
            expect="#5521 complaint: a long local path shows the current (last) folder in full, "
            "folds the middle into '…', nothing clipped or spilling; also at the minimum width",
            screenshot=False,
        ):
            local = self.recorder.run_dir.joinpath("local-deep", *LONG_SEGMENTS)
            local.mkdir(parents=True, exist_ok=True)
            before = self.tab_ids()
            self.switch_to_connections_sidebar()
            self.open_new_terminal()
            self.wait(lambda: len(self.tab_ids()) == len(before) + 1, what="a local terminal")
            tab = next(t for t in self.tab_ids() if t not in before)
            self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the local prompt")
            self.run_command(f"cd '{local}'")
            self.switch_to_files_sidebar()
            self.wait_for_path_contains(LONG_SEGMENTS[-1])
            self._both_widths(
                "complaints.long-path.local",
                lambda w: self._grade_long_path(w, str(local), LONG_SEGMENTS[-1]),
            )
        with self.step(
            "complaints.actions.local",
            "Local file browser: header actions on one line, at most 6 icons, rest in '…' (#5520)",
            expect="#5520 complaint: the local file browser's action icons fit on ONE line, at "
            "most ~6, the others behind '…'; also at the minimum width",
            screenshot=False,
        ):
            self._both_widths(
                "complaints.actions.local", lambda w: self._grade_action_row(w, remote=False)
            )
        self.close_all_tabs()

    # ── 4. toast stack (#5618) ────────────────────────────────────────────────
    def _toast_items(self) -> list[dict[str, Any]]:
        """The visible text and button boxes inside the toast stack."""
        items = []
        for kind in ("text", "buttons"):
            items += [i for i in self.driver.measure_element(TOAST_REGION, kind)["items"] if _shown(i)]
        return items

    def _closed_toast_titles(self) -> list[dict[str, Any]] | None:
        """The 'Closed …' toast titles once at least two show, else ``None``."""
        titles = [i for i in self._toast_items() if i["text"].startswith("Closed")]
        return titles if len(titles) >= 2 else None

    def test_30_toast_stack(self):
        with self.step(
            "complaints.toasts.stack",
            "Two toasts over the connection editor: no overlap, editor footer clear (#5618)",
            expect="#5618 complaint: the two 'Closed …' toasts sit one above the other with a "
            "gap (no text showing through), and neither covers the editor's Save / Cancel "
            "buttons",
        ):
            self.switch_to_connections_sidebar()
            terminals: list[str] = []
            for _ in range(2):
                before = self.tab_ids()
                self.open_new_terminal()
                self.wait(lambda b=before: len(self.tab_ids()) == len(b) + 1, what="a local terminal")
                terminals.append(next(t for t in self.tab_ids() if t not in before))
            self.open_new_connection_editor()
            for tab in terminals:
                self.close_tab(tab)
            texts = self.wait(self._closed_toast_titles, what="both 'Closed' toasts", timeout=3.0)
            self.evidence(f"toast titles {[(t['text'], t['rect']) for t in texts]}")
            for i, a in enumerate(texts):
                for b in texts[i + 1:]:
                    assert not _intersects(a["rect"], b["rect"]), (
                        f"toasts overlap: {a['text']!r} {a['rect']} and {b['text']!r} {b['rect']}"
                    )
            footer = [
                b for b in self.driver.measure_element(EDITOR_FOOTER, "buttons")["items"] if _shown(b)
            ]
            assert footer, "the editor footer shows no buttons"
            for item in self._toast_items():
                for button in footer:
                    assert not _intersects(item["rect"], button["rect"]), (
                        f"toast {item['text'] or item['label']!r} {item['rect']} covers the footer "
                        f"button {button['text']!r} {button['rect']}"
                    )
        self.close_all_tabs()

    # ── 5. file list names, columns and host (#5623) ──────────────────────────
    def _grade_file_list(self, where: str, long_names: list[str], host: str) -> None:
        listing = self.driver.measure_element(FILE_LIST, "text")
        items = [i for i in listing["items"] if _shown(i)]
        self.evidence(
            f"{where}: list {listing['rect']['width']:.0f}px, scroll {listing['scrollWidth']} / "
            f"client {listing['clientWidth']}; visible {[i['text'] for i in items][:8]}"
        )
        problems = []
        if listing["scrollWidth"] > listing["clientWidth"]:
            problems.append(
                f"horizontal overflow: scrollWidth {listing['scrollWidth']} > "
                f"clientWidth {listing['clientWidth']}"
            )
        for name in long_names:
            cells = [i for i in items if i["text"] == name]
            if not cells:
                problems.append(f"no visible row text for {name!r}")
                continue
            cell = cells[0]
            if not _inside(cell["rect"], listing["rect"]):
                problems.append(f"{name!r} spills past the list")
            if cell["overflows"] and cell.get("textOverflow") != "ellipsis":
                problems.append(f"{name!r} is cut without an ellipsis")
        # Every shown data-column header sits above at least one visible value.
        for header in DATA_COLUMNS:
            if not self.driver.exists(header):
                continue
            head = self.driver.measure_element(header)
            if head["rect"]["width"] <= 2:  # hidden by the narrow-width rule
                continue
            left, right = head["rect"]["x"], head["rect"]["x"] + head["rect"]["width"]
            under = [
                i["text"] for i in items
                if i["text"] and i["rect"]["x"] < right and i["rect"]["x"] + i["rect"]["width"] > left
                and i["text"] not in long_names
            ]
            if not under:
                problems.append(f"header {header} shows without a column of values")
        label = self.driver.measure_element(HOST_LABEL)
        self.evidence(f"{where}: host label {label['text']!r}")
        if host not in label["text"]:
            problems.append(f"host label is {label['text']!r}, not naming {host!r}")
        assert not problems, f"{where}: " + "; ".join(problems)

    def test_40_file_list_names_columns_host(self):
        with self.step(
            "complaints.file-list.remote",
            "Remote file list: long names ellipsized, no sideways scroll, no empty columns, "
            "host named (#5623)",
            expect="#5623 complaint: long file/folder names end in '…' inside the list (full "
            "name on hover), no horizontal scrollbar, Modified/Size headers only over real "
            "values, and the header says 'user@host (SFTP)'; also at the minimum width",
            screenshot=False,
        ):
            deep = self._open_remote()
            root = deep.parents[len(LONG_SEGMENTS) - 1]
            (root / LONG_FILE).write_text("long name\n", encoding="utf-8")
            self._go_to(str(root))
            self.wait(lambda: self.driver.exists(f"file-row-{LONG_FILE}"), what="the long file row")
            user = self.need_native().target.username
            self._both_widths(
                "complaints.file-list.remote",
                lambda w: self._grade_file_list(
                    w, [LONG_SEGMENTS[0], LONG_FILE], f"{user}@{SSH_HOST} (SFTP)"
                ),
            )
        with self.step(
            "complaints.file-list.local",
            "Local file list: long names ellipsized, no sideways scroll, no empty columns, "
            "'This computer' (#5623)",
            expect="#5623 complaint: the local list ellipsizes long names, never scrolls "
            "sideways, shows no header without values, and says 'This computer'; also at the "
            "minimum width",
            screenshot=False,
        ):
            local = self.recorder.run_dir / "local-file-list"
            (local / LONG_SEGMENTS[0]).mkdir(parents=True, exist_ok=True)
            (local / LONG_FILE).write_text("long name\n", encoding="utf-8")
            before = self.tab_ids()
            self.switch_to_connections_sidebar()
            self.open_new_terminal()
            self.wait(lambda: len(self.tab_ids()) == len(before) + 1, what="a local terminal")
            tab = next(t for t in self.tab_ids() if t not in before)
            self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the local prompt")
            self.run_command(f"cd '{local}'")
            self.switch_to_files_sidebar()
            self.wait_for_path_contains("local-file-list")
            self.wait(lambda: self.driver.exists(f"file-row-{LONG_FILE}"), what="the long file row")
            self._both_widths(
                "complaints.file-list.local",
                lambda w: self._grade_file_list(
                    w, [LONG_SEGMENTS[0], LONG_FILE], "This computer"
                ),
            )
        self.close_all_tabs()

    # ── 6. file browser menu placement, icons, Sort by (#5624, #5671) ────────
    def _open_more_menu(self) -> dict[str, Any]:
        """Open the '…' menu and return its measured box."""
        if not self.driver.exists(MORE_MENU):
            self.driver.click(MORE_ACTIONS)
        self.wait(lambda: self.driver.exists(MORE_MENU), what="the '…' menu")
        time.sleep(0.3)  # let the popover settle at its collision-aware spot
        return self.driver.measure_element(MORE_MENU)

    def _grade_menu_placement(self, where: str) -> None:
        sidebar = self.driver.measure_element(SIDEBAR)["rect"]
        window_width = float(self.driver.os_input_probe()["innerWidth"])
        try:
            menu = self._open_more_menu()["rect"]
            self.shot(label=f"{where}-menu")
        finally:
            if self.driver.exists(MORE_MENU):
                self.driver.press_key("Escape")
        self.evidence(
            f"{where}: sidebar x={sidebar['x']:.0f} w={sidebar['width']:.0f}, menu "
            f"x={menu['x']:.0f} w={menu['width']:.0f}, window {window_width:.0f}px"
        )
        problems = []
        if menu["x"] < sidebar["x"] - EPS:
            problems.append(
                f"menu left edge {menu['x']:.0f} reaches left of the sidebar ({sidebar['x']:.0f}) "
                "over the activity bar"
            )
        if menu["x"] + menu["width"] > window_width + EPS:
            problems.append("menu spills past the window's right edge")
        assert not problems, f"{where}: " + "; ".join(problems)

    def _grade_menu_contents(self) -> None:
        problems = []
        up = self.driver.get_attribute("file-browser-up", "data-icon")
        upload = self.driver.get_attribute("file-browser-upload", "data-icon")
        self.evidence(f"Up icon {up!r}, Upload icon {upload!r}")
        if not up or up == upload:
            problems.append(f"Up and Upload share a glyph ({up!r} / {upload!r})")
        try:
            self._open_more_menu()
            if not self.driver.exists(COPY_PATH):
                problems.append("no 'Copy path' in the '…' menu")
            if not self.driver.exists(SORT_MENU):
                problems.append("no 'Sort by' in the '…' menu")
            else:
                self.driver.click(SORT_MENU)
                self.wait(lambda: self.driver.exists(SORT_SUBMENU), what="the Sort by sub-menu")
                self.shot(label="sort-menu")
                missing = [k for k in SORT_KEYS if not self.driver.exists(f"file-browser-sort-by-{k}")]
                if missing:
                    problems.append(f"'Sort by' lacks {missing}")
        finally:
            for _ in range(2):
                if self.driver.exists(MORE_MENU):
                    self.driver.press_key("Escape")
        assert not problems, "; ".join(problems)

    def test_50_file_browser_menu_and_sort(self):
        with self.step(
            "complaints.menu.placement",
            "The '…' menu stays inside the window and right of the activity bar (#5624)",
            expect="#5624 complaint: at the minimum sidebar width the open '…' menu starts at or "
            "right of the sidebar's left edge (never over the activity bar) and ends inside "
            "the window",
            screenshot=False,
        ):
            self._open_remote()
            self._both_widths("complaints.menu.placement", self._grade_menu_placement)
        with self.step(
            "complaints.menu.sort",
            "Up and Upload look different; the '…' menu offers Sort by and Copy path (#5624, #5671)",
            expect="#5624/#5671 complaint: Up is a parent-folder arrow distinct from Upload's tray "
            "arrow; the '…' menu has 'Sort by ▸' with Name / Modified / Size and 'Copy path'",
        ):
            restore = self._sidebar_min()
            try:
                self._grade_menu_contents()
            finally:
                self._sidebar_restore(restore)
        self.close_all_tabs()

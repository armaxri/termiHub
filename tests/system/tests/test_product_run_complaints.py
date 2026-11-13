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
   field show the leaf folder in full, clip or overflow nothing
   (``scrollWidth <= clientWidth``), fold the middle into "…" and carry the
   full path in the tooltip, at the normal and at the minimum sidebar width.

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
LONG_SEGMENTS = [f"{i}-a-rather-long-folder-name-for-the-path-bar-check" for i in range(1, 7)]
EPS = 0.5


def _center_y(box: dict[str, float]) -> float:
    return box["y"] + box["height"] / 2


def _inside(inner: dict[str, float], outer: dict[str, float]) -> bool:
    return (
        inner["x"] >= outer["x"] - EPS
        and inner["x"] + inner["width"] <= outer["x"] + outer["width"] + EPS
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
        if nav["scrollWidth"] > nav["clientWidth"]:
            problems.append(f"the path overflows its field ({nav['scrollWidth']} > {nav['clientWidth']})")
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


"""Save a layout, restart the app, and check it comes back (TIN-013, #3778).

The backend save/load round trips have unit tests. This suite drives the whole
user journey through the real app instead. It lays out tabs in a split, persists
the layout, kills the app, relaunches it against the **same config dir**, and
asserts what comes back: the panel tree, each tab's title and type, and which
group, panel and tab are active. It covers both ways a layout comes back:

* **Last-session restore.** "Restore Last Session on Startup" is ``always``.
  The debounced auto-save writes ``last-session.json`` on every layout change.
  The relaunch restores it without any user action.
* **Explicit workspace launch.** The layout is saved as a named workspace
  through the Workspaces sidebar's "Save Current" dialog. Restore mode is
  ``never``, so no last session can mask a failure. The app then comes back two
  ways: relaunched with ``--workspace <name>`` (the CLI launch), and relaunched
  plainly, then launched from the sidebar.
* **Multi-window workspace.** A workspace saved with a second native window
  respawns that window, with its tab, on a ``--workspace`` relaunch. (The
  multi-window *last-session* restore lives in ``test_multi_window``.)

Every tab is a local shell, so the suite needs no containers. Most tabs are
renamed to unique titles, so the assertions can tell the restored tabs apart
from the default tab a fresh app opens.

The saved formats keep no per-panel active tab. A workspace launch and a
last-session restore therefore both make the first group, its first panel and
each panel's first tab active. The suite asserts that contract, except that
last-session restore keeps the active *group*.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Optional

import pytest

from termihub_harness import (
    LayoutUi,
    ProjectionHarness,
    SETTINGS_REGION,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    WindowsUi,
)
from termihub_harness.bridge import Driver
from termihub_harness.ui.lookups import iter_tabs
from termihub_harness.ui.windows import window_tabs

pytestmark = pytest.mark.integration

SPLIT_H = "terminal-view-split-horizontal"
NEW_TERMINAL = "terminal-view-new-terminal"
GROUP_ADD = "tab-group-add"
LAST_SESSION_FILE = "last-session.json"
WORKSPACES_FILE = "workspaces.json"
#: Logged once per app launch; anchors a log read to the current launch.
LAUNCH_MARKER = "termiHub starting"
#: The debug-build panic of #3780.
PERF_006_PANIC = "PERF-006: incremental session delta diverged"

WORKSPACES_VIEW = "activity-bar-workspaces"
SAVE_CURRENT = "workspace-save-current-btn"
SAVE_DIALOG = "save-workspace-dialog"
SAVE_NAME = "save-workspace-name"
SAVE_CONFIRM = "save-workspace-confirm"
CONFIRM_LAUNCH_DIALOG = "confirm-launch-workspace-dialog"
CONFIRM_LAUNCH = "confirm-launch-workspace-confirm"


def _tag() -> str:
    return uuid.uuid4().hex[:6]


def _shape(node: Any) -> Any:
    """A panel tree reduced to what a restore must keep.

    It keeps the split directions and nesting, and each panel's tabs in order as
    (title, content type, connection type). Ids are left out because a restore
    mints fresh ones.
    """
    if not isinstance(node, dict):
        return None
    if node.get("type") == "leaf":
        return (
            "leaf",
            tuple(
                (t.get("title"), t.get("contentType"), t.get("connectionType"))
                for t in node.get("tabs") or []
            ),
        )
    return (
        "split",
        node.get("direction"),
        tuple(_shape(child) for child in node.get("children") or []),
    )


def _leaves(node: Any) -> list[dict[str, Any]]:
    if not isinstance(node, dict):
        return []
    if node.get("type") == "leaf":
        return [node]
    return [leaf for child in node.get("children") or [] for leaf in _leaves(child)]


def _saved_titles(node: Any) -> list[str]:
    """Every tab title anywhere under ``node`` (a parsed saved-layout document)."""
    if isinstance(node, list):
        return [title for value in node for title in _saved_titles(value)]
    if not isinstance(node, dict):
        return []
    tabs = node.get("tabs")
    found = [
        tab["title"]
        for tab in (tabs if isinstance(tabs, list) else [])
        if isinstance(tab, dict) and isinstance(tab.get("title"), str)
    ]
    return found + [t for key, value in node.items() if key != "tabs" for t in _saved_titles(value)]


class TestWorkspaceRestoreUi(
    ProjectionHarness, WindowsUi, SidebarUi, TerminalUi, TabsUi, LayoutUi, SystemTest
):
    """Last-session restore, then workspace launch (CLI, sidebar, multi-window)."""

    # ── Settings ─────────────────────────────────────────────────────────────
    def _restore_mode(self) -> Any:
        return self.projection_region_cache(SETTINGS_REGION).get("restoreLastSessionMode")

    def _set_restore_mode(self, mode: str) -> None:
        self.projection_dispatch_intent(
            "settings.patch", {"patch": {"restoreLastSessionMode": mode}}
        )
        self.wait(lambda: self._restore_mode() == mode, what=f"restore mode {mode!r}")

    # ── State reads ──────────────────────────────────────────────────────────
    def _groups(self, driver: Optional[Driver] = None) -> list[dict[str, Any]]:
        groups = (driver or self.driver).get_state("tabGroups")
        return groups if isinstance(groups, list) else []

    def _active_group_index(self) -> int:
        active = self.driver.get_state("activeTabGroupId")
        return next((i for i, g in enumerate(self._groups()) if g.get("id") == active), -1)

    def _group_tree(self, index: int) -> Any:
        """The panel tree of group ``index``. The active group reads live state."""
        if index == self._active_group_index():
            return self.driver.get_state("rootPanel")
        groups = self._groups()
        return groups[index].get("rootPanel") if index < len(groups) else None

    def _layout_shape(self) -> list[Any]:
        return [_shape(self._group_tree(i)) for i in range(len(self._groups()))]

    def _saved_last_session_titles(self) -> list[str]:
        try:
            return _saved_titles(
                json.loads((self.config_dir / LAST_SESSION_FILE).read_text(encoding="utf-8"))
            )
        except (OSError, ValueError):
            return []

    def _workspace_id(self, name: str) -> Optional[str]:
        for ws in self.driver.get_state("workspaces") or []:
            if isinstance(ws, dict) and ws.get("name") == name:
                return ws.get("id")
        return None

    def _saved_workspace(self, name: str) -> dict[str, Any]:
        """The workspace ``name`` as stored in ``workspaces.json``."""
        data = json.loads((self.config_dir / WORKSPACES_FILE).read_text(encoding="utf-8"))
        items = data.get("workspaces") if isinstance(data, dict) else data
        for ws in items or []:
            if isinstance(ws, dict) and ws.get("name") == name:
                return ws
        raise AssertionError(f"workspace {name!r} is not in {WORKSPACES_FILE}")

    # ── Building a layout ────────────────────────────────────────────────────
    def _new_terminal_in_active_panel(self) -> None:
        count = len(iter_tabs(self.driver.get_state("rootPanel")))
        self.driver.click(NEW_TERMINAL)
        self.wait(
            lambda: len(iter_tabs(self.driver.get_state("rootPanel"))) == count + 1,
            what="a new terminal tab",
        )

    def _rename(self, driver: Driver, tab_id: str, title: str) -> None:
        driver.context_menu(f"tab-{tab_id}")
        self.wait(lambda: driver.exists("tab-context-rename"), what="the tab rename item")
        driver.click("tab-context-rename")
        self.wait(lambda: driver.exists("rename-dialog-input"), what="the rename dialog")
        driver.type("rename-dialog-input", title)
        driver.click("rename-dialog-apply")
        self.wait(
            lambda: any(
                t.get("id") == tab_id and t.get("title") == title
                for t in iter_tabs(driver.get_state("rootPanel"))
            ),
            what=f"tab {tab_id} to be titled {title!r}",
        )

    def _rename_all(self, prefix: str) -> list[str]:
        """Give every tab of the active group a unique title, in tree order."""
        root = self.settled_root_panel()
        titles = []
        for index, tab in enumerate(iter_tabs(root)):
            title = f"{prefix}-{index + 1}"
            self._rename(self.driver, tab["id"], title)
            titles.append(title)
        return titles

    def _build_layout(self, prefix: str) -> list[str]:
        """Build a two-group layout of local shells; return every tab title.

        Group 1 is a left/right split. The left panel holds two renamed terminals
        and the right panel holds one with its default title. Group 2 holds one
        renamed terminal. Group 1 is left active.
        """
        self._fresh_app()
        self.close_all_tabs()
        self.ensure_terminal()
        self.wait(lambda: self.leaf_count() == 1, what="a single panel")
        self._new_terminal_in_active_panel()
        # Rename before splitting. Each panel's tab bar owns its own rename
        # dialog, and a closed dialog stays in the DOM until its exit animation
        # ends. A throttled webview (e.g. a locked macOS screen) never ends it, so
        # a rename in a second panel would type into the first panel's dialog.
        # The right panel's tab keeps its default title.
        titles = self._rename_all(f"{prefix}-g1")
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="a second panel")
        # The split's new panel is empty and focused, so give it a terminal.
        self._new_terminal_in_active_panel()

        origin = self.driver.get_state("activeTabGroupId")
        self.driver.click(GROUP_ADD)
        self.wait(
            lambda: self.driver.get_state("activeTabGroupId") != origin,
            what="the second tab group to become active",
        )
        self._new_terminal_in_active_panel()
        titles += self._rename_all(f"{prefix}-g2")
        self.driver.click(f"tab-group-chip-{origin}")
        self.wait(
            lambda: self.driver.get_state("activeTabGroupId") == origin,
            what="the first tab group to be active again",
        )
        shape = self._layout_shape()
        assert shape[0][0] == "split" and len(_leaves(self._group_tree(0))) == 2
        assert [len(leaf["tabs"]) for leaf in _leaves(self._group_tree(0))] == [2, 1]
        return titles

    def _write_restore_mode(self, mode: str) -> None:
        """Persist ``restoreLastSessionMode`` (run while the app is down)."""
        path = self.config_dir / "settings.json"
        data: dict[str, Any] = {}
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, ValueError):
            pass
        data.setdefault("version", "1")
        data["restoreLastSessionMode"] = mode
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _wipe_session(self) -> None:
        """Delete the stored last session and set restore mode ``never``.

        Runs while the app is down (a ``restart_app`` ``between`` hook).
        """
        (self.config_dir / LAST_SESSION_FILE).unlink(missing_ok=True)
        self._write_restore_mode("never")

    def _fresh_app(self) -> None:
        """Relaunch with no stored session and restore mode ``never``.

        Every journey starts from one tab group in one window. A relaunch gets
        there more reliably than closing live groups and windows one by one.
        """
        self.restart_app(between=self._wipe_session)
        self.wait(lambda: self._restore_mode() == "never", what="restore mode 'never'")
        self.wait(lambda: len(self._groups()) == 1, what="a single tab group")

    # ── Assertions ───────────────────────────────────────────────────────────
    def _assert_first_tabs_active(self, group_index: int) -> None:
        """Each panel shows its first tab (the saved formats keep no selection)."""
        for leaf in _leaves(self._group_tree(group_index)):
            tabs = leaf.get("tabs") or []
            assert tabs, f"panel {leaf.get('id')} restored empty"
            assert leaf.get("activeTabId") == tabs[0]["id"], (
                f"panel {leaf.get('id')} should show its first tab {tabs[0].get('title')!r}"
            )

    def _assert_restored(self, expected_shape: list[Any], *, active_group: int) -> None:
        self.wait(
            lambda: len(self._groups()) == len(expected_shape),
            what=f"{len(expected_shape)} tab groups to be restored",
        )
        self.wait(
            lambda: self._active_group_index() == active_group,
            what=f"group {active_group} to be active",
        )
        self.settled_root_panel()
        self.wait(
            lambda: self._layout_shape() == expected_shape,
            what="the restored panel tree, titles and tab types to match the saved ones",
        )
        # The first panel of the active group has focus, showing its first tab.
        first_leaf = _leaves(self._group_tree(active_group))[0]
        assert self.driver.get_state("activePanelId") == first_leaf["id"]
        active = self.active_tab()
        assert active is not None and active["id"] == first_leaf["tabs"][0]["id"]
        self._assert_first_tabs_active(active_group)
        # The tab each panel shows reconnects to a live shell. (Background tabs
        # are left out: only what the user sees has to be live right away.)
        terminals = [
            leaf["tabs"][0] for leaf in _leaves(self.driver.get_state("rootPanel"))
        ]
        assert all(t.get("contentType") == "terminal" for t in terminals)
        try:
            self.wait(
                lambda: all(self.driver.read_terminal(t["id"]).strip() for t in terminals),
                what="the restored terminals to reach a shell prompt",
            )
        except AssertionError:
            # Known debug-build bug #3780: several tabs connecting at once can trip
            # the PERF-006 cross-check, whose panic drops a session-lifecycle frame.
            # Only that case is an expected failure; anything else still fails.
            if PERF_006_PANIC in self._current_launch_log():
                pytest.xfail("#3780: PERF-006 debug panic dropped a session frame")
            raise

    def _current_launch_log(self) -> str:
        """The app log since the most recent launch (the log spans restarts)."""
        log = self.app.read_log()
        return log[log.rfind(LAUNCH_MARKER):] if LAUNCH_MARKER in log else log

    # ── Workspace sidebar ────────────────────────────────────────────────────
    def _save_workspace(self, name: str) -> str:
        """Save the current layout as workspace ``name``; return its id."""
        self._ensure_sidebar("workspaces", WORKSPACES_VIEW)
        self.wait(lambda: self.driver.exists(SAVE_CURRENT), what="the Save Current button")
        self.driver.click(SAVE_CURRENT)
        self.wait(lambda: self.driver.exists(SAVE_DIALOG), what="the save-workspace dialog")
        self.driver.type(SAVE_NAME, name)
        self.driver.click(SAVE_CONFIRM)
        self.wait(lambda: not self.driver.exists(SAVE_DIALOG), what="the save dialog to close")
        return self.wait(lambda: self._workspace_id(name), what=f"workspace {name!r} to be saved")

    # ── Journeys ─────────────────────────────────────────────────────────────
    def test_last_session_restores_panel_tree_titles_and_active_group(self):
        titles = self._build_layout(f"ls-{_tag()}")
        self._set_restore_mode("always")
        # Leave the *second* group active, so the restore has to keep the
        # active group rather than fall back to the first one.
        second = self._groups()[1]["id"]
        self.driver.click(f"tab-group-chip-{second}")
        self.wait(lambda: self._active_group_index() == 1, what="the second group active")
        expected = self._layout_shape()

        # Persisted on layout change, not on quit: wait until the file holds
        # every renamed tab so the ungraceful kill cannot race the save.
        tab_count = sum(len(_flat_titles(group)) for group in expected)
        self.wait(
            lambda: len(saved := self._saved_last_session_titles()) == tab_count
            and set(titles) <= set(saved),
            what="the last session to hold every tab",
        )
        # The live settings.patch intent does not write settings.json, which
        # _fresh_app left at "never". Pin "always" on disk for the relaunch.
        self.restart_app(between=lambda: self._write_restore_mode("always"))

        self._assert_restored(expected, active_group=1)
        self.delay4user(2, reason="last session restored after restart")

    def test_saved_workspace_is_launched_by_the_cli_flag_on_relaunch(self):
        # Restore mode stays "never" (see _fresh_app), so no stored last session
        # can bring the layout back: only the workspace can.
        name = f"ws-cli-{_tag()}"
        self._build_layout(name)
        expected = self._layout_shape()
        self._save_workspace(name)

        self.restart_app(args=["--workspace", name])

        self._assert_restored(expected, active_group=0)
        assert self.driver.get_state("activeWorkspaceName") == name
        self.delay4user(2, reason="workspace launched by --workspace")

    def test_saved_workspace_is_launched_from_the_sidebar_after_restart(self):
        name = f"ws-sidebar-{_tag()}"
        self._build_layout(name)
        expected = self._layout_shape()
        workspace_id = self._save_workspace(name)

        self.restart_app()
        # A plain relaunch in "never" mode must not bring the layout back.
        titles = {t for group in expected for t in _flat_titles(group) if t.startswith(name)}
        self.wait(lambda: self._groups(), what="the relaunched app's layout")
        assert not titles & {t.get("title") for t in iter_tabs(self.driver.get_state("rootPanel"))}

        self._ensure_sidebar("workspaces", WORKSPACES_VIEW)
        launch = f"workspace-launch-{workspace_id}"
        self.wait(lambda: self.driver.exists(launch), what="the saved workspace in the sidebar")
        self.driver.click(launch)
        # Launching over live sessions asks first (UX-026). Only confirm if asked.
        self.wait(
            lambda: self.driver.exists(CONFIRM_LAUNCH_DIALOG)
            or self._layout_shape() == expected,
            what="the launch to start or ask for confirmation",
        )
        if self.driver.exists(CONFIRM_LAUNCH_DIALOG):
            self.driver.click(CONFIRM_LAUNCH)

        self._assert_restored(expected, active_group=0)
        self.delay4user(2, reason="workspace launched from the sidebar")

    def test_multi_window_workspace_respawns_its_second_window(self):
        self._fresh_app()
        self.close_all_tabs()
        tag = _tag()
        name = f"ws-mw-{tag}"

        # "always" makes the main window auto-save the aggregated session,
        # which the wait before saving uses to see the second window's slice.
        self._set_restore_mode("always")
        # Open the second window first: the "New Window" shortcut goes through
        # the keyboard, which a rename dialog still closing (see _build_layout)
        # would swallow.
        second = self.open_new_window()

        # Main window: two terminals, one of which moves to the second window.
        self.ensure_terminal()
        self._new_terminal_in_active_panel()
        main_title, moved_title = f"{name}-main", f"{name}-moved"
        main_tab, moving_tab = [t["id"] for t in iter_tabs(self.settled_root_panel())][:2]
        self._rename(self.driver, main_tab, main_title)
        self._rename(self.driver, moving_tab, moved_title)
        session_id = self.live_session_id(self.driver, moving_tab)

        self.move_tab_to_window(self.driver, moving_tab, second.window_label)
        moved = self.wait_for_session_tab(second, session_id)
        assert moved.get("title") == moved_title
        self.wait(
            lambda: [t.get("title") for t in window_tabs(self.driver)] == [main_title],
            what="the main window to keep only its own tab",
        )

        # "Save Current" captures other windows from the slices they last
        # reported, and a window reports its slice on a debounced timer (which a
        # throttled, occluded window can stretch). Wait until the main window's
        # auto-saved session holds the moved tab: then the slice has arrived.
        self.wait(
            lambda: moved_title in self._saved_last_session_titles(),
            what="the second window to report its moved tab",
        )
        self._save_workspace(name)
        # The saved definition must already hold the second window and its tab,
        # so a failure below is a restore problem, not a save problem.
        saved = self._saved_workspace(name)
        assert len(saved.get("windows") or []) == 2, saved
        assert moved_title in _saved_titles(saved), saved
        # Drop the auto-saved session and go back to "never" while the app is
        # down, so only the workspace can bring the second window back.
        self.restart_app(between=self._wipe_session, args=["--workspace", name])

        restored = self.driver.wait_for_window(lambda label: label != "main")
        seen: dict[str, Any] = {}

        def restored_moved_tab() -> Optional[dict[str, Any]]:
            seen["groups"] = self._groups(restored)
            seen["tabs"] = [t.get("title") for t in window_tabs(restored)]
            return next((t for t in window_tabs(restored) if t.get("title") == moved_title), None)

        try:
            restored_tab = self.wait(
                restored_moved_tab, what="the second window's tab to be restored"
            )
        except AssertionError as exc:
            raise AssertionError(f"{exc}; second window held {seen!r}") from exc
        assert restored_tab.get("contentType") == "terminal"
        self.wait(
            lambda: [t.get("title") for t in window_tabs(self.driver)] == [main_title],
            what="the main window's tab to be restored",
        )
        self.wait(
            lambda: restored.read_terminal(restored_tab["id"]).strip(),
            what="a shell prompt in the restored second window",
        )
        self.delay4user(2, reason="multi-window workspace restored")


def _flat_titles(shape: Any) -> list[str]:
    """Every tab title in a :func:`_shape` tree."""
    if not isinstance(shape, tuple):
        return []
    if shape[0] == "leaf":
        return [tab[0] for tab in shape[1]]
    return [t for child in shape[2] for t in _flat_titles(child)]

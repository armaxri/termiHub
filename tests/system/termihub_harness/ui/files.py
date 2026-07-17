"""Local file-browser helpers (issue #809).

``FilesUi`` drives the **local** file browser the Files sidebar shows for a local
terminal: read the current path, list/enter directory rows, navigate up, refresh,
and create files/folders via the inline toolbar inputs. It builds on
:class:`~termihub_harness.ui.SidebarUi` (to show the Files view), so suites mix in
both alongside :class:`~termihub_harness.SystemTest`.

This is the local counterpart to :class:`~termihub_harness.ui.SftpUi` (remote SFTP
browsing): both read ``file-browser-current-path`` and ``file-row-<name>`` — via
the shared :class:`FileBrowserPathReads` — but a local browser needs no password
prompt and follows the terminal's CWD.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

from ..bridge import BridgeError
from ..systemtest import DEFAULT_WAIT_TIMEOUT
from .base import HarnessMixin


def file_row_testid(name: str) -> str:
    """The ``data-testid`` of the file-browser row for an entry ``name``.

    Present in the DOM only while the row is inside the virtualizer's mounted
    window — see :meth:`FilesUi.wait_for_file_row`, which filters to the entry
    rather than assuming every listed entry has a node.
    """
    return f"file-row-{name}"


class FileBrowserPathReads(HarnessMixin):
    """Read the path the file browser currently shows.

    Shared by :class:`FilesUi` (local) and :class:`~termihub_harness.ui.SftpUi`
    (remote): the two drive different backends but render the **same**
    ``FileBrowserPathBar``, so the read belongs in one place. It used to be
    copy-pasted into both, which is how it went stale in both at once (#1568).

    The bar is a breadcrumb: its text is the path *segmented* into per-crumb
    buttons, so ``get_text`` would yield the labels run together rather than a
    path. The nav's ``title`` — the tooltip the user sees — is the full path
    verbatim, so that is what these read.

    Deliberately **not** the store's ``currentPath``: that field is the SFTP
    browser's path only. ``useFileBrowser`` picks currentPath from one of three
    sub-hooks (local / sftp / session) by mode, so reading the store would
    silently return the wrong path for a local browser. The bar renders whichever
    mode is active, so reading the bar is correct for every mode.
    """

    CURRENT_PATH = "file-browser-current-path"

    def file_browser_path(self) -> str:
        """The path currently shown in the file browser (empty if none)."""
        if not self.driver.exists(self.CURRENT_PATH):
            return ""
        return self.driver.get_attribute(self.CURRENT_PATH, "title") or ""

    def wait_for_path_contains(self, needle: str, *, timeout: float = DEFAULT_WAIT_TIMEOUT) -> str:
        """Poll until the displayed path contains ``needle``; return the full path."""
        return self.wait(
            lambda: (lambda p: p if needle in p else None)(self.file_browser_path()),
            timeout=timeout,
            what=f"{needle!r} in the file-browser path",
        )


class FilesUi(FileBrowserPathReads):
    """Drive and read the local file browser for the active terminal."""

    # Stable file-browser toolbar / inline-input testids (entry-name-free).
    UP = "file-browser-up"
    REFRESH = "file-browser-refresh"
    FILTER = "file-browser-filter"
    FILTER_CLEAR = "file-browser-filter-clear"
    NEW_FILE = "file-browser-new-file"
    NEW_FILE_INPUT = "file-browser-new-file-input"
    NEW_FILE_CONFIRM = "file-browser-new-file-confirm"
    NEW_FOLDER = "file-browser-new-folder"
    NEW_FOLDER_INPUT = "file-browser-new-folder-input"
    NEW_FOLDER_CONFIRM = "file-browser-new-folder-confirm"

    if TYPE_CHECKING:  # provided by SidebarUi, with which suites combine this
        def switch_to_files_sidebar(self) -> None: ...

    # -- open / read -------------------------------------------------------------
    def open_file_browser(self) -> str:
        """Show the Files sidebar for the active local terminal; return its path.

        The local browser follows the terminal's CWD and needs no password, so it
        is ready once the path bar renders a non-empty path.
        """
        self.switch_to_files_sidebar()
        return self.wait(
            lambda: self.file_browser_path() or None,
            what="the local file-browser path",
        )

    # -- entries -----------------------------------------------------------------
    def file_row_exists(self, name: str) -> bool:
        """Whether a file-browser row for entry ``name`` is currently listed."""
        return self.driver.exists(file_row_testid(name))

    def wait_for_file_row(
        self, name: str, *, timeout: float = DEFAULT_WAIT_TIMEOUT, refresh_every: float = 2.0
    ) -> None:
        """Poll until entry ``name`` lists, filtering to it and refreshing as needed.

        Two app behaviors make the naive "refresh and look for the row" wait wrong,
        and this handles both:

        **The listing is virtualized** (``@tanstack/react-virtual``), so only the
        visible window of rows (+ ``ROW_OVERSCAN``) is ever mounted — roughly the
        first ~33 of them at the default sidebar height. An entry further down the
        sort order has **no DOM node at all**, so ``file-row-<name>`` would never
        appear no matter how long or how often we refreshed. A real home directory
        blows past that window easily (#1582: the sentinel sorted to index 80 of
        104), which is why every case that waits on a *newly created* entry failed
        while the ones that only read the path passed. So this types ``name`` into
        the browser's filter box — the same affordance a user reaches for — which
        narrows ``displayEntries`` until the row is inside the mounted window.

        **The directory is only re-read on navigation/refresh**, so a file created
        from the terminal (or while the Files sidebar was hidden) is not in the
        cached listing — and a terminal ``touch``/``printf`` runs async, so a
        single up-front refresh can fire before the file even exists. This
        refreshes every ``refresh_every`` seconds while polling, which reveals the
        entry without the per-tick refresh storm that overwhelmed the WebKit
        renderer. Set ``refresh_every`` to 0 to never refresh (the entry is
        expected to already be in the current listing).

        The filter is **left applied** on return: the row's DOM node exists only
        because of it, so clearing it here would unmount the very row the caller
        is about to click or assert on. Refreshing keeps the filter (only
        navigation resets it), so the two mechanisms compose. Call
        :meth:`clear_entry_filter` when a test needs the whole listing back.
        """
        deadline = time.monotonic() + timeout
        next_refresh = 0.0  # refresh immediately on the first tick
        while time.monotonic() < deadline:
            now = time.monotonic()
            if refresh_every and now >= next_refresh and self.driver.exists(self.REFRESH):
                self.refresh_file_browser()
                next_refresh = now + refresh_every
            # Re-applied every tick, not once up front: navigating (which some
            # callers do between ticks) clears the filter, and re-typing the same
            # value is a no-op for React's controlled input.
            if self.driver.exists(self.FILTER):
                self.filter_entries(name)
            if self.file_row_exists(name):
                return
            time.sleep(0.5)  # the directory only changes on a refresh, so poll gently
        raise AssertionError(f"timed out waiting for file row {name!r}")

    # -- filter ------------------------------------------------------------------
    def filter_entries(self, query: str) -> None:
        """Narrow the listing to entries whose name contains ``query``.

        Matching is case-insensitive and substring-based (``filterEntries`` in
        ``src/utils/fileBrowserNav.ts``). Passing ``""`` clears the filter.
        """
        self.driver.type(self.FILTER, query)

    def clear_entry_filter(self) -> None:
        """Drop any active filter so the full listing shows again."""
        self.filter_entries("")

    def refresh_file_browser(self) -> None:
        """Re-list the current directory via the toolbar refresh button."""
        self.driver.click(self.REFRESH)

    # -- navigation --------------------------------------------------------------
    def enter_directory(self, name: str) -> str:
        """Double-click directory row ``name`` to enter it; return the new path."""
        self.wait_for_file_row(name)
        self.driver.double_click(file_row_testid(name))
        return self.wait_for_path_contains(name)

    def navigate_up(self) -> str:
        """Click the Up button and return the resulting (parent) path."""
        before = self.file_browser_path()
        self.driver.click(self.UP)
        return self.wait(
            lambda: (lambda p: p if p != before else None)(self.file_browser_path()),
            what="the file-browser path to change after Up",
        )

    # -- create ------------------------------------------------------------------
    def open_new_file_input(self) -> bool:
        """Click New File and return whether its inline input appeared."""
        self.driver.click(self.NEW_FILE)
        return self.wait(
            lambda: self.driver.exists(self.NEW_FILE_INPUT), what="the new-file input"
        )

    def open_new_folder_input(self) -> bool:
        """Click New Folder and return whether its inline input appeared."""
        self.driver.click(self.NEW_FOLDER)
        return self.wait(
            lambda: self.driver.exists(self.NEW_FOLDER_INPUT), what="the new-folder input"
        )

    def create_file_via_browser(self, name: str) -> None:
        """Create a file through the New File inline input and wait for its row."""
        self.open_new_file_input()
        self.driver.type(self.NEW_FILE_INPUT, name)
        self.driver.click(self.NEW_FILE_CONFIRM)
        self.wait_for_file_row(name)

    def create_folder_via_browser(self, name: str) -> None:
        """Create a folder through the New Folder inline input and wait for its row."""
        self.open_new_folder_input()
        self.driver.type(self.NEW_FOLDER_INPUT, name)
        self.driver.click(self.NEW_FOLDER_CONFIRM)
        self.wait_for_file_row(name)

    # -- context menu ------------------------------------------------------------
    def open_file_menu(self, name: str) -> None:
        """Right-click the row for entry ``name`` and wait for its context menu."""
        self.wait_for_file_row(name)
        self.driver.context_menu(file_row_testid(name))
        self.wait(
            lambda: self.driver.exists("context-file-delete"),
            what=f"the {name!r} file context menu",
        )

    def delete_entry(self, name: str) -> None:
        """Delete entry ``name`` via its context menu, confirming the dialog.

        Deleting prompts a :class:`ConfirmDeleteDialog`; this confirms it and
        waits for the row to disappear (the listing refreshes after the delete).
        """
        self.open_file_menu(name)
        self.driver.click("context-file-delete")
        self.wait(
            lambda: self.driver.exists("confirm-delete-confirm"),
            what="the delete-confirm dialog",
        )
        self.driver.click("confirm-delete-confirm")
        self.wait(lambda: not self.file_row_exists(name), what=f"{name!r} to be deleted")

    def cancel_inline_input(self) -> None:
        """Dismiss an open inline new-file / new-folder input via Escape."""
        try:
            self.driver.press_key("Escape")
        except BridgeError:
            pass

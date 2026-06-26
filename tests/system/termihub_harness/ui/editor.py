"""Built-in (Monaco) file-editor helpers (issue #809).

``EditorUi`` opens a file in the editor, reads its status, and drives the status
-bar editor controls (indent, EOL, language). Assertions map to **store state**
rather than scraping Monaco's canvas:

- ``editorStatus`` (``get_state("editorStatus")``) — ``line``/``column``,
  ``tabSize``/``insertSpaces``, ``eol``, ``encoding``, ``language``. ``None`` when
  no editor tab is active, which is exactly the "status bar clears" signal.
- ``editorDirtyTabs`` — per-tab dirty flags that drive the tab dirty dot and the
  close-confirm dialog.

Monaco renders to a canvas with no test-addressable text input, so an "edit" is
made through a real user gesture that mutates the model: toggling the EOL via the
status bar (``status-bar-eol``). That is a genuine model change, so it dirties the
buffer exactly like typing — without needing to inject keystrokes into Monaco.

Suites combine this with :class:`~termihub_harness.ui.FilesUi` (to open the file),
:class:`~termihub_harness.ui.TabsUi` (to find/close the editor tab), and
:class:`~termihub_harness.SystemTest`.
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING, Any, Optional

from ..bridge import BridgeError
from .base import HarnessMixin
from .files import file_row_testid


class EditorUi(HarnessMixin):
    """Open files in the Monaco editor and drive its status-bar controls."""

    CTX_FILE_EDIT = "context-file-edit"
    SAVE = "file-editor-save"
    STATUS_TAB_SIZE = "status-bar-tab-size"
    STATUS_EOL = "status-bar-eol"
    STATUS_LANGUAGE = "status-bar-language"
    LANG_SEARCH = "lang-menu-search"
    #: The Monaco hidden input, tagged in FileEditor so pressKey can target it.
    INPUT = "editor-input"

    if TYPE_CHECKING:  # provided by FilesUi / TabsUi, with which suites combine this
        def wait_for_file_row(self, name: str, *, timeout: float = ...) -> None: ...

    # -- open --------------------------------------------------------------------
    def open_file_in_editor(self, name: str, *, via: str = "menu") -> None:
        """Open file ``name`` in the editor and wait for the editor status to mount.

        ``via="menu"`` right-clicks the row and clicks **Edit**; ``via="double"``
        double-clicks the row (PR #61's open-on-double-click). Either way the wait
        resolves once ``editorStatus`` is populated — the editor is mounted and
        active.
        """
        self.wait_for_file_row(name)
        row = file_row_testid(name)
        if via == "double":
            self.driver.double_click(row)
        else:
            self.driver.context_menu(row)
            self.wait(lambda: self.driver.exists(self.CTX_FILE_EDIT), what="the file Edit menu")
            self.driver.click(self.CTX_FILE_EDIT)
        self.wait_for_editor_status()

    # -- status ------------------------------------------------------------------
    def editor_status(self) -> Optional[dict[str, Any]]:
        """The current ``editorStatus`` store slice, or ``None`` when no editor."""
        try:
            return self.driver.get_state("editorStatus")
        except BridgeError:
            return None

    def wait_for_editor_status(self) -> dict[str, Any]:
        """Poll until an editor is active (``editorStatus`` populated); return it."""
        return self.wait(self.editor_status, what="the editor status to populate")

    def editor_status_present(self) -> bool:
        """Whether the status bar is showing editor items (an editor is active)."""
        return self.driver.exists(self.STATUS_TAB_SIZE)

    def editor_tab_dirty(self, tab_id: str) -> bool:
        """Whether the editor tab ``tab_id`` is flagged dirty in the store."""
        try:
            return bool(self.driver.get_state(f"editorDirtyTabs.{tab_id}"))
        except BridgeError:
            return False

    # -- edit / save -------------------------------------------------------------
    def dirty_editor(self) -> None:
        """Make the active editor dirty via a real model edit (EOL toggle).

        Toggling the end-of-line sequence mutates the Monaco model, so the buffer
        becomes modified exactly as typing would — the bridge-native stand-in for
        keystrokes a canvas editor cannot receive by ``data-testid``.
        """
        self.toggle_eol()

    def save_editor(self) -> None:
        """Click the toolbar Save button (clears the dirty flag)."""
        self.driver.click(self.SAVE)

    # -- status-bar controls -----------------------------------------------------
    def set_indent(self, size: int, *, spaces: bool = True) -> None:
        """Open the indent menu and choose ``size`` spaces (or a tab size)."""
        self.driver.click(self.STATUS_TAB_SIZE)
        item = f"indent-spaces-{size}" if spaces else f"indent-tabs-{size}"
        self.wait(lambda: self.driver.exists(item), what=f"the {item} indent option")
        self.driver.click(item)

    def toggle_eol(self) -> str:
        """Click the EOL indicator to flip LF↔CRLF; return the resulting EOL."""
        before = (self.editor_status() or {}).get("eol")
        self.driver.click(self.STATUS_EOL)
        return self.wait(
            lambda: (lambda eol: eol if eol and eol != before else None)(
                (self.editor_status() or {}).get("eol")
            ),
            what="the editor EOL to toggle",
        )

    def open_language_menu(self) -> None:
        """Open the language-mode dropdown and wait for its search field."""
        self.driver.click(self.STATUS_LANGUAGE)
        self.wait(lambda: self.driver.exists(self.LANG_SEARCH), what="the language menu")

    def filter_languages(self, text: str) -> None:
        """Type ``text`` into the open language-menu search field."""
        self.driver.type(self.LANG_SEARCH, text)

    def select_language(self, language_id: str) -> None:
        """Click the language-menu item for ``language_id`` (e.g. ``"javascript"``)."""
        item = f"lang-{language_id}"
        self.wait(lambda: self.driver.exists(item), what=f"the {item} language option")
        self.driver.click(item)

    # -- keyboard (drives Monaco via the tagged hidden input) --------------------
    def focus_editor(self) -> None:
        """Focus Monaco's hidden input so subsequent key presses reach the editor."""
        self.driver.click(self.INPUT)

    def move_cursor(self, key: str, *, times: int = 1) -> None:
        """Press an arrow key ``times`` times on the editor (e.g. ``"ArrowDown"``).

        Plain arrows are platform-agnostic and move the caret, which drives
        ``onDidChangeCursorPosition`` → ``editorStatus`` — no chord/modifier and so
        no per-OS keybinding difference.
        """
        for _ in range(times):
            self.driver.press_key(key, self.INPUT)

    def save_via_keybinding(self) -> None:
        """Save through Monaco's **Save** keybinding (``Cmd+S`` on macOS, else ``Ctrl+S``).

        The action is registered with ``CtrlCmd | KeyS``, which resolves to the
        platform's primary modifier — so the chord matches what a user presses on
        this OS, exercising the keybinding path the toolbar button bypasses.
        """
        if sys.platform == "darwin":
            self.driver.press_key("s", self.INPUT, meta=True)
        else:
            self.driver.press_key("s", self.INPUT, ctrl=True)

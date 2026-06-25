"""Built-in (Monaco) file editor: open, dirty/save, status bar, indent, language.

Ported from ``tests/e2e/editor.test.js`` onto the Python bridge harness (#809).

Monaco renders to a canvas with no test-addressable text input, so assertions map
to **store state** — ``editorStatus`` (Ln/Col, indent, EOL, encoding, language)
and ``editorDirtyTabs`` (the tab dirty dot) — instead of scraping the editor. An
"edit" is made through a genuine model-mutating gesture (toggling the EOL via the
status bar), which dirties the buffer exactly like typing.

Not ported (kept as manual tests in docs/testing.md): the Ctrl+S keybinding and
cursor-move Ln/Col updates (both need keystrokes routed *into* Monaco's canvas,
which the bridge cannot address by ``data-testid`` — the Save button and the
indent/EOL/language store assertions cover the same behavior); the binary/non-UTF
-8 graceful-error path (needs a non-UTF-8 file the bridge cannot author).
"""

import pytest

from termihub_harness import (
    EditorUi,
    FilesUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration


class TestEditor(TerminalUi, TabsUi, SidebarUi, FilesUi, EditorUi, SystemTest):
    def _open_editor(self, *, ext: str = ".ts", multiline: bool = True, via: str = "menu") -> str:
        """Fresh terminal → create a file in $HOME → open it in the editor.

        Files are created in the home directory — the directory the browser shows
        for a fresh shell — rather than ``cd``-ing elsewhere, so the test never
        depends on OSC 7 cwd-following (which a default zsh emits only after its
        prompt hook installs, racing the assertion). Multi-line content is needed
        wherever a test dirties the buffer by toggling the EOL: the dirty signal
        is ``content != savedContent``, unchanged by an LF↔CRLF flip on empty text.
        """
        # A pristine app per editor test: opening/closing many Monaco editors in
        # one long-lived app churns the WebKit renderer (and closing to zero tabs
        # leaves the file browser on a stale directory). Restarting is the
        # reliable isolation seam — each test starts from the same clean state.
        self.restart_app()
        self.ensure_terminal()
        # Remove any files left by earlier tests/runs so $HOME's listing stays
        # small — a bloated home directory slows every later browser refresh
        # (the file list is not virtualized).
        self.run_command('rm -f "$HOME"/e2e_ed_*')
        name = f"e2e_ed_{unique_name('f')}{ext}"
        body = r"line one\nline two\nline three\n" if multiline else ""
        self.run_command(f'printf "{body}" > "$HOME/{name}"')
        self.open_file_browser()
        self.open_file_in_editor(name, via=via)
        return name

    # ── EDITOR-01: open / dirty / save (PR #54) ─────────────────────────────
    @pytest.mark.parametrize("via", ["menu", "double"])
    def test_opens_a_file_in_the_editor(self, via):
        # "menu" = right-click → Edit; "double" = double-click the row (PR #61).
        name = self._open_editor(via=via)
        assert self.find_tab(name) is not None
        assert self.editor_status() is not None

    def test_dirty_dot_appears_on_edit_and_clears_on_save(self):
        name = self._open_editor()
        tab = self.find_tab(name)
        assert self.editor_tab_dirty(tab["id"]) is False
        self.dirty_editor()
        self.wait(lambda: self.editor_tab_dirty(tab["id"]), what="the tab to become dirty")
        self.save_editor()
        self.wait(
            lambda: not self.editor_tab_dirty(tab["id"]),
            what="the dirty flag to clear after save",
        )

    def test_closing_a_dirty_tab_prompts_to_confirm(self):
        name = self._open_editor()
        tab = self.find_tab(name)
        self.dirty_editor()
        self.wait(lambda: self.editor_tab_dirty(tab["id"]), what="the tab to become dirty")
        # Closing a dirty editor must raise the unsaved-changes dialog.
        self.driver.click(f"tab-close-{tab['id']}")
        self.wait(
            lambda: self.driver.exists("unsaved-changes-just-close"),
            what="the unsaved-changes dialog",
        )
        # Discard so the suite can continue cleanly.
        self.driver.click("unsaved-changes-just-close")

    def test_closing_a_clean_tab_needs_no_confirmation(self):
        name = self._open_editor()
        before = self.tab_count()
        tab = self.find_tab(name)
        self.driver.click(f"tab-close-{tab['id']}")
        self.wait(lambda: self.tab_count() == before - 1, what="the clean tab to close")
        assert not self.driver.exists("unsaved-changes-just-close")

    def test_reopening_the_same_file_reuses_its_tab(self):
        name = self._open_editor()
        count = self.tab_count()
        # Re-open the same file from the browser; no new tab should appear.
        self.switch_to_connections_sidebar()
        self.switch_to_files_sidebar()
        self.open_file_in_editor(name)
        assert self.tab_count() == count

    # ── EDITOR-STATUS: status bar (PR #65) ──────────────────────────────────
    def test_status_bar_reflects_a_typescript_file(self):
        self._open_editor(ext=".ts")
        status = self.wait_for_editor_status()
        assert status["line"] >= 1 and status["column"] >= 1
        assert status["encoding"] == "UTF-8"
        assert status["eol"] == "LF"
        assert status["language"] == "typescript"
        assert isinstance(status["tabSize"], int)

    def test_status_bar_items_hide_on_a_terminal_tab(self):
        self._open_editor()
        assert self.editor_status_present() is True
        # A terminal tab has no editor status.
        self.switch_to_connections_sidebar()
        self.ensure_terminal()
        self.wait(
            lambda: self.editor_status() is None,
            what="the editor status to clear on the terminal tab",
        )
        assert self.editor_status_present() is False

    def test_status_bar_items_return_when_switching_back_to_the_editor(self):
        name = self._open_editor()
        editor_tab = self.find_tab(name)
        self.switch_to_connections_sidebar()
        self.ensure_terminal()
        self.wait(lambda: self.editor_status() is None, what="status to clear")
        self.switch_to_tab(editor_tab["id"])
        self.wait(lambda: self.editor_status() is not None, what="status to return")

    def test_status_bar_clears_when_the_editor_tab_closes(self):
        name = self._open_editor()
        tab = self.find_tab(name)
        self.close_tab(tab["id"])
        self.wait(lambda: self.editor_status() is None, what="status to clear on close")

    # ── EDITOR-INDENT: indent selection (PR #111) ───────────────────────────
    def test_indent_menu_lists_options_and_applies_a_choice(self):
        self._open_editor()
        # The menu exposes the spaces/tabs options …
        self.driver.click(self.STATUS_TAB_SIZE)
        self.wait(
            lambda: self.driver.exists("indent-spaces-2"), what="the indent options"
        )
        self.driver.press_key("Escape")
        # … and choosing one updates the editor status.
        self.set_indent(2, spaces=True)
        self.wait(
            lambda: (self.editor_status() or {}).get("tabSize") == 2,
            what="the indent size to become 2",
        )
        assert self.editor_status()["insertSpaces"] is True

    def test_toggling_eol_flips_the_indicator(self):
        self._open_editor()
        before = self.editor_status()["eol"]
        after = self.toggle_eol()
        assert after != before
        assert after in ("LF", "CRLF")

    # ── EDITOR-LANG: language mode selector (PR #113) ───────────────────────
    def test_language_menu_opens_with_a_search_field(self):
        self._open_editor()
        self.open_language_menu()
        assert self.driver.exists(self.LANG_SEARCH)
        self.driver.press_key("Escape")

    def test_language_menu_filters_as_you_type(self):
        self._open_editor()
        self.open_language_menu()
        self.filter_languages("javascript")
        self.wait(
            lambda: self.driver.exists("lang-javascript"),
            what="the filtered JavaScript option",
        )
        self.driver.press_key("Escape")

    def test_selecting_a_language_updates_the_status_and_closes_the_menu(self):
        self._open_editor(ext=".ts")
        assert self.editor_status()["language"] == "typescript"
        self.open_language_menu()
        self.filter_languages("javascript")
        self.select_language("javascript")
        self.wait(
            lambda: (self.editor_status() or {}).get("language") == "javascript",
            what="the language to switch to JavaScript",
        )
        # The dropdown closes on selection.
        self.wait(
            lambda: not self.driver.exists(self.LANG_SEARCH),
            what="the language menu to close",
        )

"""IME composition commits exactly once in the terminal and the editor (#3059).

Follow-up of I18N-016 (PR #3058), which covered composition through the
``useEditorKeyboard`` hook in jsdom. This replays an input method's DOM event
sequence in the **real WebView** of each OS through the ``compose`` bridge verb —
``keydown`` 229, ``compositionstart``, ``compositionupdate`` + ``input`` per
preedit, the commit's ``input`` and ``compositionend``, with the control's value
updated in place as an IME does — and asserts the committed text arrives once,
with no preedit leaking through and no duplicate or partial commit:

- **terminal**: composed into xterm's input textarea while the shell runs
  ``read``; the shell's echo of the line it received is exactly the commit;
- **editor**: composed into Monaco's input (``editor-input``); after saving, the
  file on disk holds the commit once, at the caret, and nothing else changed.

What this cannot drive is the OS input method itself — its preedit underline and
candidate window are native UI. Those stay release-gating manual checks
(MT-NIN-10..14 in ``tests/manual/native-input.yaml``).

``src/testbridge/composition.test.ts`` pins the same replay against the real
xterm per PR. Terminal cases need a POSIX shell (Git Bash on Windows, skipped
without it). Integration lane (nightly), not per-PR CI.
"""

from __future__ import annotations

import re

import pytest

from termihub_harness import (
    ConnectionsUi,
    EditorUi,
    FilesUi,
    ShellFsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

#: Matches the shell's answer only: the echoed command line holds ``%s``.
GOT = re.compile(r"IME3059\[([^%\]]*)\]")
#: The command that reads one line and echoes exactly what it received.
READ_AND_ECHO = "read -r l; printf 'IME3059[%s]\\n' \"$l\""


class TestTerminalImeComposition(TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SystemTest):
    def _open_shell(self) -> str:
        """Open a fresh POSIX local shell and return its tab id."""
        self.close_all_tabs()
        shell = self.posix_shell_name()
        name = unique_name("ime")
        self.switch_to_connections_sidebar()
        self.create_local_connection(name, shell=shell, connect=True)
        tab = self.wait(lambda: self.find_tab(name), what=f"the {name!r} terminal tab")
        tab_id = tab["id"]
        self.wait(lambda: self.driver.read_terminal(tab_id).strip(), what="the shell prompt")
        return tab_id

    def _line_received(self, tab_id: str, compositions: list[tuple[list[str], str]]) -> str:
        """Compose each ``(updates, commit)`` into ``read``; return what it got."""
        self.run_command(READ_AND_ECHO)
        for updates, commit in compositions:
            self.driver.compose(updates, commit, tab_id=tab_id)
        # A bare newline ends the line ``read`` is collecting.
        self.driver.terminal_input("")
        match = self.wait(
            lambda: GOT.search(self.driver.read_terminal(tab_id)),
            what="the shell's echo of the composed line",
        )
        return match.group(1)

    def test_terminal_receives_the_commit_once(self):
        """A Japanese conversion reaches the PTY as the commit only."""
        tab_id = self._open_shell()
        received = self._line_received(tab_id, [(["に", "にほ", "にほん", "日本"], "日本語")])
        assert received == "日本語"

    def test_terminal_receives_back_to_back_commits_in_order(self):
        """Consecutive compositions (CJK, then a reshaping Korean syllable) each commit once."""
        tab_id = self._open_shell()
        received = self._line_received(
            tab_id, [(["か", "かん"], "漢"), (["じ"], "字"), (["ㅎ", "하", "한"], "한")]
        )
        assert received == "漢字한"


class TestEditorImeComposition(
    TerminalUi, TabsUi, SidebarUi, FilesUi, EditorUi, ShellFsUi, SystemTest
):
    ORIGINAL = "line one\nline two\n"

    def _open_editor(self) -> str:
        """A pristine app with a two-line file open in the editor (see test_editor.py)."""
        self.restart_app()
        self.ensure_terminal()
        self.remove_home_glob("e2e_ime_*")
        name = f"e2e_ime_{unique_name('f')}.txt"
        self.write_home_file(name, self.ORIGINAL)
        self.open_file_browser()
        self.open_file_in_editor(name)
        self.wait_for_editor_status()
        return name

    def test_editor_commits_the_composition_once(self):
        """The saved file holds the commit once at the caret, no preedit residue."""
        name = self._open_editor()
        tab = self.find_tab(name)
        self.focus_editor()
        self.driver.compose(["に", "にほ", "にほん", "日本"], "日本語", test_id=self.INPUT)
        self.wait(lambda: self.editor_tab_dirty(tab["id"]), what="the composition to edit")
        self.save_editor()
        self.wait(lambda: not self.editor_tab_dirty(tab["id"]), what="the save to finish")

        saved = (self.home_dir() / name).read_bytes().decode("utf-8")
        assert saved.count("日本語") == 1, saved
        assert "に" not in saved and "ほ" not in saved, saved
        assert saved.replace("日本語", "", 1) == self.ORIGINAL, saved

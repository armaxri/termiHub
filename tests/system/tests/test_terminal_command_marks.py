"""OSC 133 command marks with a real bash / zsh (#3415, #4013).

termiHub's shell integration makes bash and zsh bracket every prompt and command
with OSC 133 marks; the terminal turns them into tracked commands (exit-status
gutter, prompt jumps, "Copy Last Command Output"). None of that reaches the
reconstructed terminal text, so these tests read it through the
``inspect_terminal`` bridge verb:

- with a real ``bash`` / ``zsh`` local shell, ``seq 3`` and ``false`` are
  recorded as finished commands with exit codes ``0`` and ``1``, and what "Copy
  Last Command Output" copies after ``seq 3`` is exactly ``1\\n2\\n3``;
- a plain ``sh`` gets no integration, so it records no marks at all.

The lower layers are proven locally: the Rust real-PTY test
``core/src/backends/local_shell_osc133_tests.rs`` (the shells emit the marks)
and the vitest replay ``src/services/commandMarks.real-shell.test.ts`` (the
tracker reads those real byte streams). This suite proves the whole app path.

The commands are the behaviour under test, so they are typed into the shell.
The only setup — an empty ``~/.zshrc`` when the home has no zsh startup files,
so zsh shows a prompt instead of its new-user menu — is written on disk (#4025).
POSIX shells only, so the suite is skipped on Windows.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    ShellFsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        sys.platform.startswith("win"), reason="bash/zsh/sh local shells are POSIX-only"
    ),
]


def shell_installed(shell: str) -> bool:
    """Whether the app offers ``shell`` — mirrors ``detect_available_shells``."""
    return any(Path(f"{d}/{shell}").exists() for d in ("/bin", "/usr/bin"))


#: zsh's startup files. With none of them in the home directory, zsh (on Linux)
#: starts its interactive ``zsh-newuser-install`` menu instead of a prompt.
ZSH_STARTUP_FILES = (".zshenv", ".zprofile", ".zshrc", ".zlogin")


class TestTerminalCommandMarks(
    TerminalUi, TabsUi, SidebarUi, ConnectionsUi, ShellFsUi, SystemTest
):
    def _keep_zsh_out_of_its_new_user_menu(self, request: pytest.FixtureRequest) -> None:
        """Create an empty ``~/.zshrc`` for this test when home has no zsh files.

        An on-disk fixture (#4025): a fresh CI home has no zsh startup files.
        Only a file this test created is removed again.
        """
        if any((self.home_dir() / f).exists() for f in ZSH_STARTUP_FILES):
            return
        self.write_home_file_empty(".zshrc")
        request.addfinalizer(lambda: self.remove_home(".zshrc"))

    def _open_shell(self, shell: str, request: pytest.FixtureRequest) -> str:
        """Open a local connection running ``shell``; return its tab id."""
        if not shell_installed(shell):
            pytest.skip(f"{shell} is not installed on this host")
        if shell == "zsh":
            self._keep_zsh_out_of_its_new_user_menu(request)
        self.close_all_tabs()
        name = unique_name(f"marks-{shell}")
        self.switch_to_connections_sidebar()
        self.create_local_connection(name, shell=shell, connect=True)
        tab = self.wait(lambda: self.find_tab(name), what=f"the {name!r} tab")
        self.wait(lambda: self.driver.read_terminal(tab["id"]).strip(), what="the shell prompt")
        return tab["id"]

    def _send(self, tab_id: str, command: str) -> None:
        """Type ``command`` into the tab's shell (retries while it registers)."""
        self.wait(
            lambda: self.driver.terminal_input(command, tab_id) is None,
            what=f"the shell to accept {command!r}",
        )

    def _marks(self, tab_id: str) -> Optional[dict[str, Any]]:
        return self.driver.inspect_terminal(tab_id)["commandMarks"]

    def _finished_exit_codes(self, tab_id: str) -> list[Any]:
        marks = self._marks(tab_id) or {"commands": []}
        return [c["exitCode"] for c in marks["commands"] if c["state"] == "finished"]

    @pytest.mark.parametrize("shell", ["bash", "zsh"])
    def test_marks_record_exit_codes_and_copy_exact_output(
        self, shell: str, request: pytest.FixtureRequest
    ):
        tab_id = self._open_shell(shell, request)
        # The integration snippet is typed into the shell at start-up; once it
        # has run, every prompt is marked.
        self.wait(
            lambda: (self._marks(tab_id) or {}).get("commands"),
            what=f"{shell}'s first marked prompt",
        )

        self._send(tab_id, "seq 3")
        self.wait(
            lambda: self._finished_exit_codes(tab_id) == [0],
            what="`seq 3` to be recorded with exit code 0",
        )
        marks = self.wait(
            lambda: (lambda m: m if m and m["lastCommandOutput"] is not None else None)(
                self._marks(tab_id)
            ),
            what="the last command output",
        )
        assert marks["lastCommandOutput"] == "1\n2\n3"

        self._send(tab_id, "false")
        self.wait(
            lambda: self._finished_exit_codes(tab_id) == [0, 1],
            what="`false` to be recorded with exit code 1",
        )
        # `false` printed nothing, so there is nothing to copy any more.
        assert self._marks(tab_id)["lastCommandOutput"] is None

    def test_sh_records_no_marks(self, request: pytest.FixtureRequest):
        tab_id = self._open_shell("sh", request)
        # Split the marker so only the command's output, not its echo, matches.
        self._send(tab_id, "seq 3; false; echo TH_SH_''DONE")
        self.wait_for_output("TH_SH_DONE", tab_id=tab_id)
        marks = self._marks(tab_id)
        assert marks is not None, "the tab must have a command-mark tracker"
        assert marks["commands"] == []
        assert marks["lastCommandOutput"] is None

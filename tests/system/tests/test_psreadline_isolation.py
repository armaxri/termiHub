"""Two Windows test apps never share PowerShell history (#5055).

Every PowerShell on a Windows machine saves its PSReadLine history to one file.
The bulk lane runs two test apps at once, so a grade's prompt could show the
other app's command as a history prediction (``echo PERF05-40`` in a dead-key
grade, run 40582427588). The harness now gives each test app a private history
file and turns predictions off (:mod:`termihub_harness.psreadline`).

Graded with two apps running side by side: the suite's app (A) runs a unique
command; a second app (B) checks that its PowerShell saves to another file,
inside its own instance, with predictions off, and that Up+Enter at a fresh
prompt does not bring back A's command. A positive control then shows that
Up+Enter does recall B's own command, so the negative check is not vacuous.
"""

from __future__ import annotations

import ntpath
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path

import pytest

from termihub_harness import Bridge, SystemTest, TerminalUi
from termihub_harness.bridge import BridgeError, Driver
from termihub_harness.orchestrator import AppInstance
from termihub_harness.ui.terminal import NEW_TERMINAL

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not sys.platform.startswith("win"),
        reason="PSReadLine history isolation is a Windows test-harness concern",
    ),
]

#: Up arrow, as xterm sends it. ``terminalInput`` appends Enter, so this runs
#: whatever history recalls at an empty prompt (nothing, if it recalls nothing).
UP = "\x1b[A"

#: How long a recalled command gets to show up before the check calls it absent.
RECALL_SETTLE = 5.0


def _inside(path: str, root: Path) -> bool:
    child = ntpath.normcase(ntpath.normpath(path))
    parent = ntpath.normcase(ntpath.normpath(str(root)))
    return child.startswith(parent + "\\")


def _dump_options(out: Path) -> str:
    """A PowerShell line that writes the PSReadLine options this test grades."""
    return (
        "$o = Get-PSReadLineOption; "
        f"@($o.HistorySavePath, \"$($o.PredictionSource)\") | Set-Content -LiteralPath '{out}'"
    )


class TestPsReadLineIsolation(TerminalUi, SystemTest):
    def _wait_text(self, read, needle: str, count: int = 1) -> str:
        return self.wait(
            lambda: (lambda t: t if t.count(needle) >= count else None)(read()),
            what=f"{count}x {needle!r} in the terminal",
        )

    def _read_options(self, out: Path) -> list[str]:
        self.wait(lambda: out.is_file() and out.stat().st_size > 0, what=f"{out}")
        return out.read_text(encoding="utf-8-sig").splitlines()

    def _start_second_app(self, request) -> Driver:
        second = AppInstance(echo_logs=False)
        bridge = Bridge().start()
        request.addfinalizer(second.cleanup)
        request.addfinalizer(bridge.close)
        second.start(bridge.port)
        driver = bridge.wait_for_app(request_timeout=self.request_timeout)
        self.second = second
        return driver

    def _read(self, driver: Driver) -> str:
        try:
            return driver.read_terminal()
        except BridgeError:
            return ""

    def test_two_apps_keep_separate_history(self, request):
        scratch = Path(tempfile.mkdtemp(prefix="thub_5055_"))
        request.addfinalizer(lambda: shutil.rmtree(scratch, ignore_errors=True))
        marker = f"ISO5055A-{uuid.uuid4().hex[:10]}"

        # App A: a PowerShell prompt, its options, then the unique command.
        self.ensure_terminal()
        self.wait(lambda: "PS " in self.driver.read_terminal(), what="a PowerShell prompt")
        self.run_command(_dump_options(scratch / "a.txt"))
        a_history, a_prediction = self._read_options(scratch / "a.txt")
        assert _inside(a_history, self.app.config_dir), a_history
        assert a_prediction in ("None", ""), a_prediction  # "" = PSReadLine 2.0
        self.run_command(f"echo {marker}")
        self._wait_text(self.driver.read_terminal, marker, count=2)
        self.wait(
            lambda: marker in Path(a_history).read_text(encoding="utf-8", errors="replace"),
            what="A's command saved to A's own history file",
        )

        # App B, running alongside A.
        driver_b = self._start_second_app(request)
        driver_b.click(NEW_TERMINAL)
        self.wait(lambda: "PS " in self._read(driver_b), what="a PowerShell prompt in app B")
        driver_b.terminal_input(_dump_options(scratch / "b.txt"))
        b_history, b_prediction = self._read_options(scratch / "b.txt")
        assert _inside(b_history, self.second.config_dir), b_history
        assert ntpath.normcase(b_history) != ntpath.normcase(a_history)
        assert b_prediction in ("None", ""), b_prediction

        # B's history holds only the dump line, so Up+Enter twice runs it and
        # then nothing older; A's command must never come back.
        before = self._read(driver_b).count("Get-PSReadLineOption")
        driver_b.terminal_input(UP)
        self._wait_text(lambda: self._read(driver_b), "Get-PSReadLineOption", before + 1)
        driver_b.terminal_input(UP + UP)
        time.sleep(RECALL_SETTLE)
        assert marker not in self._read(driver_b), "app B recalled app A's command"

        # Positive control: B recalls its own command.
        own = f"ISO5055B-{uuid.uuid4().hex[:10]}"
        driver_b.terminal_input(f"echo {own}")
        self._wait_text(lambda: self._read(driver_b), own, count=2)
        driver_b.terminal_input(UP)
        self._wait_text(lambda: self._read(driver_b), own, count=4)
        assert marker not in self._read(driver_b)

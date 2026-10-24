"""PATH shims that record what the app hands to external apps (#4932).

termiHub hands work to programs it does not own: ``code`` for "Open in VS
Code" (a file, a folder workspace, or a remote file with ``--wait`` and a
re-upload when the editor closes), and on Linux ``xdg-open`` for "Open in File
Manager". A guided-manual check used to ask an operator whether VS Code or the
file manager opened. The interesting half of that question is machine-checkable:
*what did the app ask the external program to do?*

:class:`HandoffShims` answers it without touching the machine:

* It writes one small launcher per tool into a fresh temp directory — a POSIX
  ``sh`` script, or a ``.cmd`` batch file on Windows (the app runs ``cmd /c
  code`` there, which resolves ``code.cmd`` through ``PATHEXT``).
* Each launcher execs the harness's own Python with ``-I`` on a recorder that
  appends the tool name and its argv to a JSON-lines log, and exits 0. For
  ``code --version`` it prints a fake version, so the app's ``vscodeAvailable``
  probe sees an installed VS Code. For ``code --wait <file>`` it appends the
  configured :attr:`HandoffShims.wait_edit` text to the file first — the
  "edit" a real editor would make before closing — so a test can see the app
  re-upload it.
* :meth:`HandoffShims.app_env` puts that directory first on the **app's**
  ``PATH`` only. Nothing is installed, no OS default handler changes, and the
  developer's own ``code`` / ``xdg-open`` are never run or touched. The
  directory is removed by :meth:`close`.

The shims are executed by the app in the integration lane, and directly (on
the host's own platform) by ``tests/test_external_shims.py`` in the normal lane.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Sequence

#: Version string the ``code`` shim prints for ``code --version``.
FAKE_CODE_VERSION = "1.99.0-termihub-shim"

_LOG_NAME = "invocations.jsonl"
_WAIT_EDIT_NAME = "wait-edit.txt"
_RECORDER_NAME = "_record_handoff.py"

#: The recorder each launcher runs (``python -I <recorder> <log> <tool> args…``).
_RECORDER_SOURCE = f'''\
"""Record one external-app hand-off (written by termihub_harness.external_shims)."""
import json
import os
import sys
import time

log_path, tool, *args = sys.argv[1:]
with open(log_path, "a", encoding="utf-8") as log:
    log.write(json.dumps({{"tool": tool, "argv": args, "cwd": os.getcwd(),
                          "time": time.time()}}) + "\\n")
if tool == "code" and "--version" in args:
    print("{FAKE_CODE_VERSION}")
elif tool == "code" and "--wait" in args and args[-1] != "--wait":
    edit = os.path.join(os.path.dirname(log_path), "{_WAIT_EDIT_NAME}")
    if os.path.exists(edit):
        with open(edit, encoding="utf-8") as src, open(args[-1], "a", encoding="utf-8") as dst:
            dst.write(src.read())
sys.exit(0)
'''


@dataclass(frozen=True)
class Invocation:
    """One recorded launch of a shimmed tool."""

    tool: str
    argv: tuple[str, ...]
    cwd: str

    @property
    def is_probe(self) -> bool:
        """Whether this is an availability probe (``--version``), not a hand-off."""
        return "--version" in self.argv

    @property
    def target(self) -> Optional[str]:
        """The path or URL handed over (the last argument), if any."""
        return self.argv[-1] if self.argv else None


class HandoffShims:
    """Recording launchers for ``tools``, placed first on the app's ``PATH``."""

    def __init__(self, tools: Sequence[str], *, platform: str = sys.platform) -> None:
        if not tools:
            raise ValueError("HandoffShims needs at least one tool name")
        self.tools = tuple(tools)
        self.dir = Path(tempfile.mkdtemp(prefix="termihub-handoff-shims-"))
        self.log_path = self.dir / _LOG_NAME
        self._wait_edit_path = self.dir / _WAIT_EDIT_NAME
        recorder = self.dir / _RECORDER_NAME
        recorder.write_text(_RECORDER_SOURCE, encoding="utf-8")
        for tool in self.tools:
            write_launcher(self.dir, tool, recorder, self.log_path, platform=platform)

    # -- configuration -----------------------------------------------------------
    @property
    def wait_edit(self) -> Optional[str]:
        """Text ``code --wait <file>`` appends to ``<file>`` before it exits."""
        try:
            return self._wait_edit_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None

    @wait_edit.setter
    def wait_edit(self, text: Optional[str]) -> None:
        if text is None:
            self._wait_edit_path.unlink(missing_ok=True)
        else:
            self._wait_edit_path.write_text(text, encoding="utf-8")

    def app_env(self, base_path: Optional[str] = None) -> dict[str, str]:
        """The ``PATH`` override that makes the app find these shims first."""
        rest = os.environ.get("PATH", "") if base_path is None else base_path
        return {"PATH": os.pathsep.join(p for p in (str(self.dir), rest) if p)}

    # -- reading -----------------------------------------------------------------
    def invocations(self, tool: Optional[str] = None) -> list[Invocation]:
        """Every recorded launch, oldest first; only ``tool``'s when given."""
        try:
            lines = self.log_path.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            return []
        found = []
        for line in lines:
            try:
                rec = json.loads(line)
            except ValueError:
                continue  # a launch still mid-write; the next read sees it whole
            if tool is None or rec.get("tool") == tool:
                found.append(Invocation(rec["tool"], tuple(rec["argv"]), rec.get("cwd", "")))
        return found

    def handoffs(self, tool: str) -> list[Invocation]:
        """``tool``'s launches minus availability probes (``--version``)."""
        return [inv for inv in self.invocations(tool) if not inv.is_probe]

    def wait_for_handoff(
        self,
        tool: str,
        matches: Callable[[Invocation], bool],
        *,
        after: int = 0,
        timeout: float = 15.0,
        poll: float = 0.2,
    ) -> Invocation:
        """Poll until a hand-off of ``tool`` (index ``>= after``) satisfies ``matches``.

        Raises :class:`AssertionError` listing what *was* recorded on timeout, so a
        wrong argument reads as "handed X instead of Y", not just "timed out".
        """
        deadline = time.monotonic() + timeout
        while True:
            for inv in self.handoffs(tool)[after:]:
                if matches(inv):
                    return inv
            if time.monotonic() >= deadline:
                seen = [list(inv.argv) for inv in self.handoffs(tool)]
                raise AssertionError(
                    f"no matching {tool!r} hand-off within {timeout:.0f}s; recorded: {seen}"
                )
            time.sleep(poll)

    def close(self) -> None:
        """Remove the shim directory and its log."""
        shutil.rmtree(self.dir, ignore_errors=True)


def write_launcher(
    directory: Path, tool: str, recorder: Path, log_path: Path, *, platform: str = sys.platform
) -> Path:
    """Write ``tool``'s launcher into ``directory`` and return its path.

    Windows gets only ``<tool>.cmd`` (an extensionless file there would never be
    run); everything else gets an executable ``sh`` script named ``tool``.
    """
    python = sys.executable
    if platform == "win32":
        path = directory / f"{tool}.cmd"
        path.write_text(
            "@echo off\r\n"
            f'"{python}" -I "{recorder}" "{log_path}" {tool} %*\r\n'
            "exit /b %ERRORLEVEL%\r\n",
            encoding="utf-8",
        )
        return path
    path = directory / tool
    q = shlex.quote
    path.write_text(
        "#!/bin/sh\n"
        f'exec {q(python)} -I {q(str(recorder))} {q(str(log_path))} {q(tool)} "$@"\n',
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path


def same_path(a: str, b: str) -> bool:
    """Whether two local paths name the same file or folder.

    Compares by identity where both exist (macOS ``/var`` vs ``/private/var``,
    Windows 8.3 short names), and by normalised spelling otherwise.
    """
    try:
        return os.path.samefile(a, b)
    except OSError:
        return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


# -- OS file-manager queries ---------------------------------------------------
#
# Linux's "Open in File Manager" goes through ``xdg-open`` on ``PATH``, so the
# shim above records it. Windows (``ShellExecuteW``) and macOS (``/usr/bin/open``)
# use no ``PATH`` lookup, so there the harness asks the file manager which
# folders it shows instead.

#: Opt-in for a local macOS run to query Finder over Apple Events. It triggers
#: the Automation permission prompt for the terminal app, so it is off unless
#: asked for; hosted macOS runners refuse it anyway (error -1743).
FINDER_QUERY_OPT_IN_ENV = "TERMIHUB_ALLOW_FINDER_QUERY"

_SHELL_WINDOWS_PS = (
    "(New-Object -ComObject Shell.Application).Windows() | ForEach-Object "
    "{ try { $_.Document.Folder.Self.Path } catch {} }"
)
_SHELL_WINDOWS_CLOSE_PS = (
    "(New-Object -ComObject Shell.Application).Windows() | ForEach-Object "
    "{ try { if ($_.Document.Folder.Self.Path -ieq $env:TERMIHUB_CLOSE_FOLDER) "
    "{ $_.Quit() } } catch {} }"
)
_FINDER_WINDOWS_OSA = """\
set out to ""
tell application "Finder"
  repeat with w in Finder windows
    try
      set out to out & POSIX path of (target of w as alias) & linefeed
    end try
  end repeat
end tell
return out
"""


def _query_lines(argv: list[str], env: Optional[dict[str, str]] = None) -> Optional[list[str]]:
    try:
        done = subprocess.run(
            argv, capture_output=True, text=True, timeout=30, env=env, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if done.returncode != 0:
        return None
    return [line.strip() for line in done.stdout.splitlines() if line.strip()]


def file_manager_folders(platform: str = sys.platform) -> Optional[list[str]]:
    """Folders the OS file manager currently shows, or ``None`` if it cannot say.

    Windows asks Explorer through the ``Shell.Application`` COM object (no
    permission needed). macOS asks Finder only with
    :data:`FINDER_QUERY_OPT_IN_ENV` set. Linux returns ``None``: use the
    ``xdg-open`` shim there.
    """
    if platform == "win32":
        return _query_lines(["powershell", "-NoProfile", "-Command", _SHELL_WINDOWS_PS])
    if platform == "darwin" and os.environ.get(FINDER_QUERY_OPT_IN_ENV, "").lower() in (
        "1",
        "true",
        "yes",
    ):
        return _query_lines(["osascript", "-e", _FINDER_WINDOWS_OSA])
    return None


def close_file_manager_folder(folder: str, platform: str = sys.platform) -> None:
    """Close the Explorer windows showing ``folder`` (Windows; no-op elsewhere).

    Best effort: the test opened them, so it tidies them up; a failure here
    never fails the test.
    """
    if platform != "win32":
        return
    env = {**os.environ, "TERMIHUB_CLOSE_FOLDER": os.path.realpath(folder)}
    _query_lines(["powershell", "-NoProfile", "-Command", _SHELL_WINDOWS_CLOSE_PS], env=env)

"""Git Bash detection for the Windows-only shell suite (#1016).

The Windows-shells port (``tests/system/tests/test_windows_shells.py``) can drive
a local connection with ``shell="gitbash"``, but Git Bash — unlike PowerShell and
cmd.exe — is only present when Git for Windows is installed. The backend detects
it by probing a fixed set of install paths (``GIT_BASH_PATHS`` in
``core/src/session/shell.rs``); if none exist, ``gitbash`` never appears among the
detected shells and the editor's ``field-shell`` dropdown omits it.

So the suite gates its Git Bash case on the host directly — exactly as the backend
does — by checking the same paths. :func:`git_bash_installed_at` is a pure
function of its path list (no I/O beyond ``os.path.exists``), so it is unit-tested
on any host; :func:`detect_git_bash` is the thin Windows-only wrapper that feeds
it :data:`GIT_BASH_PATHS` and returns ``False`` off Windows.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Iterable

# Mirror of the Rust ``GIT_BASH_PATHS`` (``core/src/session/shell.rs``): the fixed
# install locations the backend probes for Git Bash. Keep in lockstep with the
# backend so the Python gate and the app agree on availability.
GIT_BASH_PATHS: tuple[str, ...] = (
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files (x86)\Git\bin\bash.exe",
)


def git_bash_installed_at(paths: Iterable[str]) -> bool:
    """Whether any of ``paths`` names an existing file (a Git Bash executable).

    Pure over its input (only ``os.path.exists``), mirroring the backend's
    ``GIT_BASH_PATHS.iter().any(|p| Path::new(p).exists())`` so the gate and the
    app agree on what counts as an installed Git Bash.
    """
    return any(os.path.exists(path) for path in paths)


def detect_git_bash() -> bool:
    """Return whether Git Bash is installed, or ``False`` off Windows.

    Probes :data:`GIT_BASH_PATHS` with :func:`git_bash_installed_at`. Git Bash is
    a Windows-only shell (an MSYS bash bundled with Git for Windows), so on any
    non-Windows host this short-circuits to ``False`` and the suite skips its
    Git Bash case cleanly.
    """
    if not sys.platform.startswith("win"):
        return False
    return git_bash_installed_at(GIT_BASH_PATHS)

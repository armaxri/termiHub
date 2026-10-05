"""Moved-binary staging for the shell-integration staleness test (#3691, SI-5/6/7).

The app shows an "Executable moved — reinstall to update" banner when the
shell integration was registered from a different executable path than the one
now running. To reproduce that for real, a test:

1. copies the built executable to a temp dir with :func:`stage_moved_copy`;
2. runs ``install-shell-integration`` from that copy (so the registration names
   the copy), then deletes it, as if the user had moved the app;
3. launches the normal build, which now runs from a different path.

Step 2 and the Reinstall button make **real** per-user OS registration writes.
Only Linux can redirect them (``XDG_DATA_HOME``, see
``AppInstance(sandbox_profile=True)``). macOS writes ``~/Library/Services`` and
Windows writes HKCU, so :func:`real_registration_skip_reason` only lets the test
run there on a throwaway CI runner, or when a developer opts in explicitly.

Pure path / env logic, unit-tested in the normal lane by
``tests/test_moved_binary_staging.py``.
"""

from __future__ import annotations

import os
import platform
from pathlib import Path
from typing import Mapping, Optional

from .portable import _link_or_copy

#: Opt-in for a local macOS / Windows run that may touch the real registration.
ALLOW_REAL_REGISTRATION_ENV = "TERMIHUB_ALLOW_REAL_SHELL_REGISTRATION"


def stage_moved_copy(binary: Path, dest_dir: Path) -> Path:
    """Copy the bare executable ``binary`` into ``dest_dir``; return the copy.

    Only the executable is copied, even inside a macOS ``.app`` bundle: the copy
    is only run for the pre-init shell-integration CLI, which exits before any
    window or bundle resource is needed. A hard link is used where possible, so
    the copy's own path is its ``current_exe``.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    staged = dest_dir / binary.name
    _link_or_copy(str(binary), str(staged))
    return staged


def _truthy(value: Optional[str]) -> bool:
    return (value or "").strip().lower() not in ("", "0", "false", "no")


def real_registration_skip_reason(
    system: Optional[str] = None, env: Optional[Mapping[str, str]] = None
) -> Optional[str]:
    """Why a real shell-integration registration must not run here, or ``None``.

    Linux is always allowed: the harness redirects the XDG data dir into the
    instance's scratch dir. macOS and Windows write the real per-user
    registration, so they need ``CI`` (a disposable runner) or
    :data:`ALLOW_REAL_REGISTRATION_ENV` set.
    """
    system = system or platform.system()
    env = os.environ if env is None else env
    if system == "Linux":
        return None
    if _truthy(env.get("CI")) or _truthy(env.get(ALLOW_REAL_REGISTRATION_ENV)):
        return None
    return (
        f"shell-integration registration on {system} writes the real per-user "
        f"registration; runs on CI only (set {ALLOW_REAL_REGISTRATION_ENV}=1 to opt in)"
    )

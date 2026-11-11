"""The native sshd as the system-test SSH target on macOS and Windows (#5176).

The Docker SSH fixtures need a Linux container daemon, which the hosted macOS
and Windows runners do not have, so every SSH/SFTP suite used to skip there.
The macOS/Windows lanes therefore bring up the platform's own OpenSSH server
(``scripts/internal/native-sshd-fixture.sh up --password-login [--jump-host]``)
and set :data:`TARGET_ENV` to ``native``. Then:

* :mod:`.fixtures` points the SSH coordinates (``SSH_PASSWORD_PORT``,
  ``SSH_KEYS_PORT``, ``SSH_USERNAME``, ``SSH_PASSWORD``, the jump-host bastion
  and target) at that sshd when it is imported, so the suites need no change;
* the ``ssh_fixtures`` / ``ssh_password_fixtures`` / ``ssh_bastion_fixtures``
  fixtures return the :class:`NativeSshTarget` instead of starting containers;
* only suites marked ``@pytest.mark.native_sshd`` (optionally
  ``platforms=(...)``) run against it. They are the ones that need nothing but
  an sshd: password or key login, a POSIX shell (macOS) and SFTP. Every other
  test that asks for one of those fixtures is skipped with
  :data:`NOT_PORTED_REASON`, which the skip guard budgets per lane.

Off those lanes (``TARGET_ENV`` unset or ``compose``) nothing changes.
"""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Optional, Sequence

#: Env switch: ``native`` points the SSH suites at the native sshd fixture.
TARGET_ENV = "TERMIHUB_SYSTEM_SSH_TARGET"

#: The marker a suite opts in with (registered in ``pyproject.toml``).
MARKER = "native_sshd"

#: Where an unqualified ``native_sshd`` marker runs.
DEFAULT_PLATFORMS: tuple[str, ...] = ("darwin", "win32")

#: The conftest fixtures that the native target replaces.
SSH_FIXTURES = frozenset({"ssh_fixtures", "ssh_password_fixtures", "ssh_bastion_fixtures"})

#: Skip reason of a suite that still needs a Docker SSH fixture on this lane.
NOT_PORTED_REASON = "SSH suite not ported to the native sshd fixture (#5176)"

#: Skip reason of the jump-host suite when the fixture has no bastion.
NO_BASTION_REASON = "the native sshd fixture runs no jump-host bastion (up --jump-host)"

_REQUIRED = (
    "TERMIHUB_NATIVE_SSHD_PORT",
    "TERMIHUB_NATIVE_SSHD_USER",
    "TERMIHUB_NATIVE_SSHD_PASSWORD",
    "TERMIHUB_NATIVE_SSHD_DIR",
)

_FIXTURE_SH = Path(__file__).resolve().parents[3] / "scripts" / "internal" / "native-sshd-fixture.sh"


class NativeSshTargetError(RuntimeError):
    """``TARGET_ENV`` asks for the native sshd but its env is incomplete."""


@dataclass(frozen=True)
class NativeSshTarget:
    """The native sshd the SSH suites log in to (see the module docstring)."""

    port: int
    username: str
    password: str
    state_dir: str
    #: The jump-host bastion's port, when the fixture runs one.
    jump_port: Optional[int] = None


def target_from_env(env: Mapping[str, str] = os.environ) -> Optional[NativeSshTarget]:
    """The native target :data:`TARGET_ENV` selects, or None for the compose fixtures.

    Raises :class:`NativeSshTargetError` when it asks for ``native`` but the
    fixture's exports are missing: a lane that meant to run the SSH suites must
    not quietly fall back to skipping them.
    """
    value = env.get(TARGET_ENV, "").strip().lower()
    if value in ("", "compose"):
        return None
    if value != "native":
        raise NativeSshTargetError(f"{TARGET_ENV}={value!r}: expected 'native' or 'compose'")
    missing = [name for name in _REQUIRED if not env.get(name)]
    if missing:
        raise NativeSshTargetError(
            f"{TARGET_ENV}=native but {', '.join(missing)} unset: bring the fixture up with "
            "`scripts/internal/native-sshd-fixture.sh up --password-login` and export its env"
        )
    jump = env.get("TERMIHUB_NATIVE_SSHD_JUMP_PORT")
    return NativeSshTarget(
        port=int(env["TERMIHUB_NATIVE_SSHD_PORT"]),
        username=env["TERMIHUB_NATIVE_SSHD_USER"],
        password=env["TERMIHUB_NATIVE_SSHD_PASSWORD"],
        state_dir=env["TERMIHUB_NATIVE_SSHD_DIR"],
        jump_port=int(jump) if jump else None,
    )


def skip_reason(
    fixturenames: Iterable[str],
    marker_platforms: Optional[Sequence[str]],
    *,
    target: NativeSshTarget,
    platform: str = sys.platform,
) -> Optional[str]:
    """Why a test cannot run against ``target`` on ``platform``, or None.

    ``marker_platforms`` is None for a test without the ``native_sshd`` marker.
    Tests that use none of :data:`SSH_FIXTURES` are never affected.
    """
    names = set(fixturenames)
    if not names & SSH_FIXTURES:
        return None
    if marker_platforms is None or platform not in marker_platforms:
        return NOT_PORTED_REASON
    if "ssh_bastion_fixtures" in names and target.jump_port is None:
        return NO_BASTION_REASON
    return None


def apply_markers(items, target: Optional[NativeSshTarget], platform: str = sys.platform) -> None:
    """Skip, at collection, every SSH test the native target cannot serve."""
    if target is None:
        return
    import pytest

    for item in items:
        marker = item.get_closest_marker(MARKER)
        platforms = None
        if marker is not None:
            platforms = tuple(marker.kwargs.get("platforms", DEFAULT_PLATFORMS))
        reason = skip_reason(
            getattr(item, "fixturenames", ()), platforms, target=target, platform=platform
        )
        if reason:
            item.add_marker(pytest.mark.skip(reason=reason))


def per_connection_children(pgrep_output: str) -> int:
    """How many processes ``pgrep -P <sshd master>`` listed.

    An sshd master forks one handler per client connection (``sshd-session``,
    or ``sshd: user [priv]`` before OpenSSH 9.8) and nothing else, so its
    direct children are its connections -- one per gateway session.
    """
    return sum(1 for line in pgrep_output.split() if line.strip().isdigit())


class NativeBastionControl:
    """:class:`~termihub_harness.fixtures.BastionControl` for the native bastion.

    The fixture's ``--jump-host`` bastion is a second sshd: ``stop`` drops it
    (and every session riding it) with ``jump-stop``, ``restore`` brings it back
    with ``jump-start``, and :meth:`gateway_sessions` counts the connections
    its master sshd is serving -- one per gateway session.
    """

    available = True

    def __init__(self, target: NativeSshTarget) -> None:
        if target.jump_port is None:
            raise NativeSshTargetError(NO_BASTION_REASON)
        self._target = target
        self.port: int = target.jump_port
        self.container = f"native bastion sshd 127.0.0.1:{self.port}"

    def _fixture(self, action: str) -> None:
        result = subprocess.run(
            ["bash", str(_FIXTURE_SH), action, "--dir", self._target.state_dir],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"native sshd fixture '{action}' failed ({result.returncode}): "
                f"{result.stderr.strip() or result.stdout.strip()}"
            )

    def stop(self) -> None:
        self._fixture("jump-stop")

    def start(self) -> None:
        self._fixture("jump-start")

    def restore(self, *, timeout: float = 90.0) -> None:
        """Start the bastion (a no-op when running) and wait for its port."""
        from .fixtures import SSH_HOST, wait_for_port

        self.start()
        wait_for_port(SSH_HOST, self.port, timeout=timeout)

    def gateway_sessions(self) -> int:
        """Connections the bastion is serving right now (0 while it is down)."""
        pid_file = Path(self._target.state_dir) / "jump_sshd.pid"
        try:
            pid = pid_file.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return 0
        if not pid.isdigit():
            return 0
        output = subprocess.run(
            ["pgrep", "-P", pid], capture_output=True, text=True, timeout=30
        ).stdout
        return per_connection_children(output)

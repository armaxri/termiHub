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

import hashlib
import os
import re
import shlex
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

#: The deployed-agent fixture the native target also serves (#5424): it
#: installs a host-OS ``termihub-agent`` for the fixture user instead of
#: baking a Linux agent into a container. The armed, keyboard-interactive and
#: real-swap variants stay container-only.
AGENT_FIXTURES = frozenset({"remote_agent_fixtures"})

#: Where the native target serves :data:`AGENT_FIXTURES`: the agent is built
#: for the host and installed over a POSIX ``sh`` exec, so macOS only (the
#: Windows fixture's login shell is ``cmd.exe``).
AGENT_PLATFORMS: tuple[str, ...] = ("darwin",)


def serves_agent(platform: str = sys.platform) -> bool:
    """Whether the native target stands in for :data:`AGENT_FIXTURES` here."""
    return platform in AGENT_PLATFORMS


def served_fixtures(platform: str = sys.platform) -> frozenset[str]:
    """The fixtures the native target replaces on ``platform``."""
    return SSH_FIXTURES | AGENT_FIXTURES if serves_agent(platform) else SSH_FIXTURES


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
    #: The fixture's unencrypted client key (``TERMIHUB_NATIVE_SSHD_KEY``): it
    #: is in the login user's ``authorized_keys``, so
    #: :class:`NativeSshServerControl` logs in with it to inspect the server.
    key: Optional[str] = None


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
        key=env.get("TERMIHUB_NATIVE_SSHD_KEY") or None,
    )


def skip_reason(
    fixturenames: Iterable[str],
    marker_platforms: Optional[Sequence[str]],
    *,
    target: NativeSshTarget,
    platform: str = sys.platform,
    container_fixtures: Iterable[str] = (),
) -> Optional[str]:
    """Why a test cannot run against ``target`` on ``platform``, or None.

    ``marker_platforms`` is None for a test without the ``native_sshd`` marker.
    Tests that use none of :func:`served_fixtures` (:data:`SSH_FIXTURES`, plus
    :data:`AGENT_FIXTURES` on macOS) are never affected, and neither
    are tests that also need another container fixture (``container_fixtures``,
    e.g. a VNC server reached over SSH): that fixture skips them with its own,
    more precise reason at setup, so the SSH side is not what keeps them off.
    """
    names = set(fixturenames)
    served = served_fixtures(platform)
    if not names & served:
        return None
    if names & (set(container_fixtures) - served):
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

    from .tool_preflight import FIXTURE_TOOLS

    containers = {name for name, tools in FIXTURE_TOOLS.items() if "docker" in tools}
    for item in items:
        marker = item.get_closest_marker(MARKER)
        platforms = None
        if marker is not None:
            platforms = tuple(marker.kwargs.get("platforms", DEFAULT_PLATFORMS))
        reason = skip_reason(
            getattr(item, "fixturenames", ()),
            platforms,
            target=target,
            platform=platform,
            container_fixtures=containers,
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


# ── Server-side control of the native sshd (#5421) ────────────────────────────
#: Title of an sshd per-connection process that serves an authenticated user:
#: ``sshd-session: user@ttys003`` (OpenSSH 9.8+) or ``sshd: user@pts/0``
#: (older); ``notty`` when no channel of that connection has a terminal.
_SESSION_TITLE = re.compile(r"^sshd(?:-session)?: (?P<user>[^\s@]+)@(?P<tty>\S+)")


def terminal_session_pids(
    ps_output: str, *, master_pid: str, username: str, uid: int
) -> set[str]:
    """The PIDs serving ``username``'s terminal connections to one sshd master.

    ``ps_output`` is ``ps -A -o pid=,ppid=,uid=,args=``. The master forks one
    handler per connection (``sshd-session: user [priv]``), and that handler
    forks the process that runs as the user (``sshd-session: user@ttys003``).
    A connection counts when its user process has a terminal: an app's SSH
    tab does, while the ``notty`` exec sessions this module opens to inspect
    the server do not, so one test's helper session never lands in another
    test's before/after diff. Both processes of a counted connection are
    returned when they run as ``uid``; a root-owned handler (the
    ``--password-login`` fixture's sshd runs as root) is left out, as the
    login user cannot signal it. Killing the user process drops the
    connection anyway: its handler exits with it.
    """
    rows: list[tuple[str, str, int, str]] = []
    for line in ps_output.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4 or not (parts[0].isdigit() and parts[1].isdigit()):
            continue
        try:
            row_uid = int(parts[2])
        except ValueError:
            continue
        rows.append((parts[0], parts[1], row_uid, parts[3].strip()))
    handlers = {pid: row_uid for pid, ppid, row_uid, _ in rows if ppid == master_pid}
    found: set[str] = set()
    for pid, ppid, row_uid, args in rows:
        if ppid not in handlers or row_uid != uid:
            continue
        match = _SESSION_TITLE.match(args)
        if match is None or match["user"] != username or match["tty"] == "notty":
            continue
        found.add(pid)
        if handlers[ppid] == uid:
            found.add(ppid)
    return found


class NativeSshExecError(RuntimeError):
    """A command run on the native sshd over ``ssh`` failed.

    Not a ``ContainerRuntimeUnavailable``: the native target was asked for, so
    a broken server-side check fails the test instead of skipping it.
    """


class NativeSshServerControl:
    """:class:`~termihub_harness.fixtures.SshServerControl` for the native sshd.

    The Docker twin execs into the container as root. Here every server-side
    step is a key-auth ``ssh`` exec as the fixture's login user, with the
    fixture's client key: the login user owns its home, so it can write, read
    and remove the files a test seeds or checks there, and it can signal its
    own per-connection sshd process. Session processes are found locally with
    ``ps`` as the descendants of the fixture's master sshd (its PID file), so
    only this fixture's connections are ever touched.

    The commands are POSIX ``sh`` with BSD/GNU-neutral tools, so the twin
    serves the macOS fixture; on Windows (``cmd.exe`` login shell, no ``ps``)
    it reports itself unavailable.
    """

    def __init__(self, target: NativeSshTarget, *, platform: str = sys.platform) -> None:
        self._target = target
        self._platform = platform
        self._home: Optional[str] = None

    @property
    def available(self) -> bool:
        """Whether the fixture exported a client key and the host is POSIX."""
        return self._target.key is not None and self._platform != "win32"

    @property
    def username(self) -> str:
        return self._target.username

    def home(self) -> str:
        """The login user's home: where its SSH session and SFTP browser start.

        sshd changes into the passwd home before it runs the command, so
        ``pwd -P`` there is the directory the app's SFTP browser lists first
        (symlinks resolved, as SFTP ``realpath`` does).
        """
        if self._home is None:
            self._home = self._run("pwd -P").strip()
        return self._home

    def env_home(self) -> str:
        """``$HOME`` of the login user's sessions.

        The passwd home on the ``--password-login`` fixture; the scratch home a
        ``--scratch-home`` fixture's sshd ``SetEnv``s. The app runs the agent
        as ``$HOME/.local/bin/termihub-agent``, so this is where it goes.
        """
        return self._run('printf "%s" "$HOME"')

    def agent_crash_dir(self) -> str:
        """The deployed agent's crash-report dir (``<config>/logs/crash-reports``).

        Mirrors the agent's ``config_dir``: ``$XDG_CONFIG_HOME`` when set,
        else ``~/Library/Application Support`` on macOS and ``~/.config``
        elsewhere.
        """
        return self._run(
            'if [ -n "${XDG_CONFIG_HOME:-}" ]; then c="$XDG_CONFIG_HOME"; '
            'elif [ "$(uname -s)" = Darwin ]; then c="$HOME/Library/Application Support"; '
            'else c="$HOME/.config"; fi; '
            'printf "%s" "$c/termihub-agent/logs/crash-reports"'
        )

    def install_agent(self, binary: Path) -> str:
        """Install ``binary`` as the login user's ``$HOME/.local/bin/termihub-agent``.

        Skipped when the installed one already has the same SHA-256. Otherwise
        the binary is streamed to a temp name beside it and renamed over it, so
        a parallel worker's install or an agent already running from the old
        file never sees a half-written binary. Returns the installed path.
        """
        data = Path(binary).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        dest = f"{self.env_home()}/.local/bin/termihub-agent"
        if self.path_exists(dest) and self.sha256(dest) == digest:
            return dest
        self._run(
            'mkdir -p "$(dirname "$1")" && t="$1.tmp.$$" && cat > "$t" '
            '&& chmod 755 "$t" && mv -f "$t" "$1"',
            dest,
            stdin=data,
            timeout=300.0,
        )
        installed = self.sha256(dest)
        if installed != digest:
            raise NativeSshExecError(
                f"installed agent {dest} has SHA-256 {installed}, expected {digest}"
            )
        return dest

    # -- sessions ------------------------------------------------------------
    def _master_pid(self) -> str:
        pid_file = Path(self._target.state_dir) / "sshd.pid"
        try:
            pid = pid_file.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise NativeSshExecError(f"cannot read the native sshd's PID file: {exc}") from exc
        if not pid.isdigit():
            raise NativeSshExecError(f"{pid_file} holds no PID: {pid!r}")
        return pid

    def session_pids(self) -> set[str]:
        """PIDs serving the login user's terminal connections to the fixture."""
        import pwd  # POSIX only; this module is imported on Windows too.

        output = subprocess.run(
            ["ps", "-A", "-o", "pid=,ppid=,uid=,args="],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        ).stdout
        return terminal_session_pids(
            output,
            master_pid=self._master_pid(),
            username=self._target.username,
            uid=pwd.getpwnam(self._target.username).pw_uid,
        )

    def kill_sessions(self, pids: Iterable[str]) -> None:
        """``SIGKILL`` the given session PIDs as the login user: a server-side drop."""
        targets = [pid for pid in pids if pid]
        if not targets:
            return
        if not all(pid.isdigit() for pid in targets):
            raise ValueError(f"not PIDs: {targets!r}")
        self._run('kill -9 "$@"', *targets)

    # -- files ---------------------------------------------------------------
    def read_file(self, path: str) -> str:
        """The contents of ``path``, newlines kept exactly."""
        return self._run('cat -- "$1"', path, text=False).decode("utf-8")

    def path_exists(self, path: str) -> bool:
        out = self._run('if [ -e "$1" ]; then echo yes; else echo no; fi', path)
        return out.strip() == "yes"

    def file_size(self, path: str) -> int | None:
        """The size of ``path`` in bytes, ``None`` if absent (``wc -c``, not GNU ``stat``)."""
        out = self._run('if [ -f "$1" ]; then wc -c < "$1"; else echo none; fi', path).strip()
        return None if out == "none" else int(out)

    def inode(self, path: str) -> int | None:
        """The inode number of ``path``, ``None`` if absent (``ls -di``, not GNU ``stat``)."""
        out = self._run('if [ -e "$1" ]; then ls -di -- "$1"; else echo none; fi', path).strip()
        return None if out == "none" else int(out.split()[0])

    def write_file(self, path: str, content: str, *, user: str) -> None:
        """Write ``content`` to ``path`` as the login user (the only user it can be)."""
        self._check_user(user)
        self._run(
            'mkdir -p "$(dirname "$1")" && cat > "$1"', path, stdin=content.encode("utf-8")
        )

    def sha256(self, path: str) -> str:
        """The SHA-256 hex digest of ``path`` (``sha256sum``, else ``shasum -a 256``)."""
        out = self._run(
            'if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1"; '
            'else shasum -a 256 < "$1"; fi',
            path,
        )
        return out.split()[0]

    def write_random_file(self, path: str, size: int, *, user: str) -> None:
        """Write ``size`` random bytes to ``path`` as the login user."""
        self._check_user(user)
        self._run('head -c "$2" /dev/urandom > "$1"', path, str(int(size)))

    def remove_path(self, path: str) -> None:
        """Remove ``path`` (file or directory tree), if present."""
        self._run('rm -rf -- "$1"', path)

    # -- plumbing --------------------------------------------------------------
    def _check_user(self, user: str) -> None:
        if user != self._target.username:
            raise ValueError(
                f"the native sshd fixture can only write as its login user "
                f"{self._target.username!r}, not {user!r}"
            )

    def ssh_argv(self, script: str, *args: str) -> list[str]:
        """The ``ssh`` command that runs ``sh -c script`` with ``args`` as ``$1``...

        ``-F /dev/null`` and ``IdentitiesOnly`` keep the caller's own ssh
        config, agent and keys out of it; the host key is not recorded anywhere.
        """
        if self._target.key is None:
            raise NativeSshExecError(
                "the native sshd fixture exported no client key (TERMIHUB_NATIVE_SSHD_KEY)"
            )
        remote = shlex.join(["sh", "-c", script, "sh", *args])
        return [
            "ssh",
            "-F",
            "/dev/null",
            "-T",
            "-p",
            str(self._target.port),
            "-i",
            self._target.key,
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "GlobalKnownHostsFile=/dev/null",
            "-o",
            "LogLevel=ERROR",
            "-o",
            "ConnectTimeout=10",
            f"{self._target.username}@127.0.0.1",
            remote,
        ]

    def _run(
        self,
        script: str,
        *args: str,
        text: bool = True,
        stdin: Optional[bytes] = None,
        timeout: float = 60.0,
    ):
        """Run ``script`` on the fixture as the login user; return its stdout."""
        try:
            result = subprocess.run(
                self.ssh_argv(script, *args),
                capture_output=True,
                input=stdin if stdin is not None else b"",
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise NativeSshExecError(
                f"ssh to the native sshd timed out after {timeout}s: {script}"
            ) from exc
        if result.returncode != 0:
            err = result.stderr.decode("utf-8", "replace").strip()
            raise NativeSshExecError(
                f"ssh to the native sshd failed (exit {result.returncode}) running "
                f"{script!r}: {err}"
            )
        return result.stdout.decode("utf-8") if text else result.stdout

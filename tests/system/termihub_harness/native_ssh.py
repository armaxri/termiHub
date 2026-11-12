"""The native sshd as the system-test SSH target on macOS and Windows (#5176).

The Docker SSH fixtures need a Linux container daemon, which the hosted macOS
and Windows runners do not have, so every SSH/SFTP suite used to skip there.
The macOS/Windows lanes therefore bring up the platform's own OpenSSH server
(``scripts/internal/native-sshd-fixture.sh up --password-login --jump-host``,
plus ``--default-shell bash`` on Windows, #5422) and set :data:`TARGET_ENV` to
``native``. Then:

* :mod:`.fixtures` points the SSH coordinates (``SSH_PASSWORD_PORT``,
  ``SSH_KEYS_PORT``, ``SSH_USERNAME``, ``SSH_PASSWORD``, the jump-host bastion
  and target) at that sshd when it is imported, so the suites need no change;
* the ``ssh_fixtures`` / ``ssh_password_fixtures`` / ``ssh_bastion_fixtures``
  fixtures return the :class:`NativeSshTarget` instead of starting containers;
* only suites marked ``@pytest.mark.native_sshd`` (optionally
  ``platforms=(...)``) run against it. They are the ones that need nothing but
  an sshd: password or key login, a POSIX shell (macOS, and Git Bash as the
  Windows login shell) and SFTP. Every other
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

#: The deployed-agent fixtures the native target also serves (#5424, #5444):
#: they install a host-OS ``termihub-agent`` for the fixture user instead of
#: baking a Linux agent into a container.
AGENT_FIXTURES = frozenset(
    {
        "remote_agent_fixtures",
        # #5444: the variants run on their own sshd of the fixture
        # (``variant-up``), so their env never reaches the plain agent suites.
        "remote_agent_pending_fixtures",
        "remote_agent_update_swap_fixtures",
        "remote_agent_kbdint_fixtures",
    }
)

#: Each agent-host variant's port, as an offset from the fixture's main port
#: (#5444). Fixed, because the suites import the ports as module constants
#: before any fixture runs; the jump-host bastion takes the first free port
#: above the main one, well below these.
VARIANT_PORT_OFFSETS: Mapping[str, int] = {
    "pending": 10,
    "swap": 11,
    "kbdint": 12,
    # #5423: the fixture-specific SSH hosts.
    "sudo": 13,
    "nosudo": 14,
    "banner": 15,
    "sftponly": 16,
}

#: The fixture-specific SSH hosts the native target serves on macOS (#5423):
#: conftest fixture -> the variants it brings up.
HOST_FIXTURES: Mapping[str, tuple[str, ...]] = {
    "ssh_permission_fixtures": ("sudo", "nosudo"),
    "ssh_banner_fixtures": ("banner",),
    "ssh_sftp_only_fixtures": ("sftponly",),
}

#: The ``variant-up`` flags of each fixture-specific host (#5423). ``sudo``,
#: ``nosudo`` and the root-owned file change system config, so the fixture
#: script runs them only on CI, with the ``--password-login`` root sshd.
HOST_VARIANT_FLAGS: Mapping[str, tuple[str, ...]] = {
    "sudo": ("--sudoer", "--elevated-target"),
    "nosudo": ("--second-user", "--elevated-target"),
    "banner": ("--banner",),
    "sftponly": ("--sftp-only",),
}

#: Where the native target serves :data:`HOST_FIXTURES`: the macOS fixture.
HOST_PLATFORMS: tuple[str, ...] = ("darwin",)

#: The ``nosudo`` host's login user: the fixture's second dedicated user,
#: with the same password and keys and no sudo rule (``--second-user``).
SECOND_USER = "termihubnosudo"

#: Where the native target serves :data:`AGENT_FIXTURES`: the agent is built
#: for the host and installed over a POSIX ``sh`` exec into ``~/.local/bin``,
#: so macOS only (a Windows host gets a ``.exe`` under Windows paths, which
#: this installer does not do).
AGENT_PLATFORMS: tuple[str, ...] = ("darwin",)


def serves_agent(platform: str = sys.platform) -> bool:
    """Whether the native target stands in for :data:`AGENT_FIXTURES` here."""
    return platform in AGENT_PLATFORMS


def serves_hosts(platform: str = sys.platform) -> bool:
    """Whether the native target stands in for :data:`HOST_FIXTURES` here.

    macOS only, like the agent: the hosts are variants of the macOS fixture's
    root sshd, and the suites type POSIX shell commands.
    """
    return platform in HOST_PLATFORMS


def served_fixtures(platform: str = sys.platform) -> frozenset[str]:
    """The fixtures the native target replaces on ``platform``."""
    served = set(SSH_FIXTURES)
    if serves_agent(platform):
        served |= AGENT_FIXTURES
    if serves_hosts(platform):
        served |= set(HOST_FIXTURES)
    return frozenset(served)


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
#: Its PowerShell twin, which the ``.sh`` hands over to on Windows (#5422).
_FIXTURE_PS1 = _FIXTURE_SH.with_suffix(".ps1")


def fixture_argv(
    action: str, state_dir: str, *extra: str, platform: str = sys.platform
) -> list[str]:
    """The command that runs fixture ``action`` on the fixture in ``state_dir``.

    On Windows the PowerShell twin is called directly: a bare ``bash`` from a
    Windows Python can resolve to ``System32\\bash.exe`` (WSL) ahead of Git
    Bash, and the ``.sh`` only hands over to the ``.ps1`` anyway.
    """
    if platform == "win32":
        return [
            "pwsh",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(_FIXTURE_PS1),
            "-Action",
            action,
            "-Dir",
            state_dir,
            *extra,
        ]
    return ["bash", str(_FIXTURE_SH), action, "--dir", state_dir, *extra]


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


def gateway_count_from_output(output: str) -> int:
    """The count the Windows fixture's ``jump-sessions`` printed (its last line)."""
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines or not lines[-1].isdigit():
        raise RuntimeError(f"native sshd fixture 'jump-sessions' printed no count: {output!r}")
    return int(lines[-1])


class NativeBastionControl:
    """:class:`~termihub_harness.fixtures.BastionControl` for the native bastion.

    The fixture's ``--jump-host`` bastion is a second sshd: ``stop`` drops it
    (and every session riding it) with ``jump-stop``, ``restore`` brings it back
    with ``jump-start``, and :meth:`gateway_sessions` counts the connections
    its master sshd is serving -- one per gateway session. On Windows (#5422)
    the bastion is a second scheduled-task sshd and the PowerShell fixture
    counts them (``jump-sessions``).
    """

    available = True

    def __init__(self, target: NativeSshTarget, *, platform: str = sys.platform) -> None:
        if target.jump_port is None:
            raise NativeSshTargetError(NO_BASTION_REASON)
        self._target = target
        self._platform = platform
        self.port: int = target.jump_port
        self.container = f"native bastion sshd 127.0.0.1:{self.port}"

    def _fixture(self, action: str) -> str:
        result = subprocess.run(
            fixture_argv(action, self._target.state_dir, platform=self._platform),
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"native sshd fixture '{action}' failed ({result.returncode}): "
                f"{result.stderr.strip() or result.stdout.strip()}"
            )
        return result.stdout

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
        if self._platform == "win32":
            return gateway_count_from_output(self._fixture("jump-sessions"))
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


#: The argument the Windows twin's own exec sessions carry (``sh -s <it>``), so
#: they never count as a test's terminal connection (#5449).
WINDOWS_EXEC_MARKER = "termihub_server_control"

#: The remote command of a Windows exec: the script arrives on stdin. No
#: quotes or backslashes, which Win32-OpenSSH's hand-over to the
#: ``DefaultShell`` does not keep intact (the app's own side-channel reads use
#: ``sh -s`` the same way, ``core/src/backends/ssh/remote_cwd.rs``).
WINDOWS_EXEC_COMMAND = f"sh -s {WINDOWS_EXEC_MARKER}"

_SFTP_DRIVE_PATH = re.compile(r"^/(?P<drive>[A-Za-z]):(?P<rest>/.*)?$")


def git_bash_path(path: str) -> str:
    """An SFTP path of a Win32-OpenSSH host (``/C:/Users/u``) as Git Bash takes it.

    Git Bash opens ``C:/Users/u`` as it is; any other path is returned unchanged.
    """
    match = _SFTP_DRIVE_PATH.match(path)
    if match is None:
        return path
    return f"{match['drive']}:{match['rest'] or '/'}"


def windows_terminal_connections(sessions_json: str, *, marker: str = WINDOWS_EXEC_MARKER) -> set[str]:
    """The Windows fixture's connections that serve a session, from ``sessions``.

    ``sessions_json`` is ``native-sshd-fixture.ps1 -Action sessions``: the main
    sshd's master PID and every process below it. Each direct ``sshd*`` child
    of the master is one connection. One counts when something other than
    sshd runs below it (its login shell) and none of those processes carries
    ``marker``: the twin's own exec sessions, so one test's helper session
    never lands in another test's before/after diff. A connection still in
    pre-auth (sshd processes only) does not count either.
    """
    import json

    data = json.loads(sessions_json or "{}")
    master = data.get("master")
    procs = data.get("processes") or []
    if master is None:
        return set()
    children: dict[int, list[dict]] = {}
    for proc in procs:
        children.setdefault(int(proc["ppid"]), []).append(proc)

    def subtree(pid: int) -> list[dict]:
        out: list[dict] = []
        stack = [pid]
        seen = {pid}
        while stack:
            for child in children.get(stack.pop(), []):
                cpid = int(child["pid"])
                if cpid not in seen:
                    seen.add(cpid)
                    out.append(child)
                    stack.append(cpid)
        return out

    found: set[str] = set()
    for handler in children.get(int(master), []):
        if not str(handler.get("name", "")).lower().startswith("sshd"):
            continue
        below = subtree(int(handler["pid"]))
        if any(marker in str(proc.get("cmd") or "") for proc in below):
            continue
        if any(not str(proc.get("name", "")).lower().startswith("sshd") for proc in below):
            found.add(str(handler["pid"]))
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

    The commands are POSIX ``sh`` with BSD/GNU-neutral tools. On Windows
    (#5449) they run in the fixture's Git Bash login shell (``--default-shell
    bash``): the script goes over stdin to ``sh -s`` (:data:`WINDOWS_EXEC_COMMAND`),
    with Win32-OpenSSH's own ``ssh.exe``; paths come in SFTP form
    (``/C:/Users/u``, what the app's browser shows) and are handed to Git
    Bash as ``C:/Users/u``. Sessions are listed and dropped by the
    PowerShell fixture (``sessions`` / ``kill-sessions``), which sees the
    SYSTEM-run sshd's processes.
    """

    def __init__(self, target: NativeSshTarget, *, platform: str = sys.platform) -> None:
        self._target = target
        self._platform = platform
        self._home: Optional[str] = None

    @property
    def available(self) -> bool:
        """Whether the fixture exported a client key to log in with."""
        return self._target.key is not None

    @property
    def _windows(self) -> bool:
        return self._platform == "win32"

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
            if self._windows:
                # The SFTP form of the profile dir Win32-OpenSSH starts in.
                self._home = "/" + self._run('cygpath -m "$(pwd -P)"').strip()
            else:
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

    def install_agent(self, binary: Path, *, home: Optional[str] = None) -> str:
        """Install ``binary`` as the login user's ``$HOME/.local/bin/termihub-agent``.

        Skipped when the installed one already has the same SHA-256. Otherwise
        the binary is streamed to a temp name beside it and renamed over it, so
        a parallel worker's install or an agent already running from the old
        file never sees a half-written binary. Returns the installed path.
        """
        data = Path(binary).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        dest = f"{home or self.env_home()}/.local/bin/termihub-agent"
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

    def _windows_fixture(self, action: str, *extra: str) -> str:
        result = subprocess.run(
            fixture_argv(action, self._target.state_dir, *extra, platform=self._platform),
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise NativeSshExecError(
                f"native sshd fixture '{action}' failed ({result.returncode}): "
                f"{result.stderr.strip() or result.stdout.strip()}"
            )
        return result.stdout

    def session_pids(self) -> set[str]:
        """PIDs serving the login user's terminal connections to the fixture."""
        if self._windows:
            return windows_terminal_connections(self._windows_fixture("sessions"))
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
        if self._windows:
            # The connection processes run as SYSTEM: the elevated fixture
            # ends them, checking each is a connection of its sshd.
            self._windows_fixture("kill-sessions", "-Pids", " ".join(targets))
            return
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

    def write_bytes(self, path: str, data: bytes, *, mode: str = "644") -> None:
        """Write ``data`` to ``path`` as the login user, then ``chmod mode``."""
        if not re.fullmatch(r"[0-7]{3,4}", mode):
            raise ValueError(f"not an octal mode: {mode!r}")
        self._run(
            'mkdir -p "$(dirname "$1")" && cat > "$1" && chmod "$2" "$1"',
            path,
            mode,
            stdin=data,
            timeout=300.0,
        )

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
        On Windows the remote command is :data:`WINDOWS_EXEC_COMMAND` and the
        script comes on stdin (:meth:`windows_script`).
        """
        if self._target.key is None:
            raise NativeSshExecError(
                "the native sshd fixture exported no client key (TERMIHUB_NATIVE_SSHD_KEY)"
            )
        if self._windows:
            # Win32-OpenSSH's own client: a Git Bash `ssh` on PATH would read
            # `NUL` as a file name.
            ssh = str(Path(os.environ.get("WINDIR", r"C:\Windows")) / "System32" / "OpenSSH" / "ssh.exe")
            null = "NUL"
            remote = WINDOWS_EXEC_COMMAND
        else:
            ssh, null = "ssh", "/dev/null"
            remote = shlex.join(["sh", "-c", script, "sh", *args])
        return [
            ssh,
            "-F",
            null,
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
            f"UserKnownHostsFile={null}",
            "-o",
            f"GlobalKnownHostsFile={null}",
            "-o",
            "LogLevel=ERROR",
            "-o",
            "ConnectTimeout=10",
            f"{self._target.username}@127.0.0.1",
            remote,
        ]

    @staticmethod
    def windows_script(script: str, *args: str, stdin: Optional[bytes] = None) -> bytes:
        """The stdin of a Windows exec: ``args`` as ``$1``..., then ``script``.

        Paths among ``args`` in SFTP form become Git Bash paths
        (:func:`git_bash_path`). Data the script reads from stdin is inlined as
        base64 and piped into it, since stdin itself carries the script.
        """
        import base64

        lines = [shlex.join(["set", "--", *(git_bash_path(arg) for arg in args)])]
        if stdin is None:
            lines.append(script)
        else:
            data = base64.b64encode(stdin).decode("ascii")
            lines.append(f"printf %s {data} | base64 -d | {{ {script}\n}}")
        return ("\n".join(lines) + "\n").encode("utf-8")

    def _run(
        self,
        script: str,
        *args: str,
        text: bool = True,
        stdin: Optional[bytes] = None,
        timeout: float = 60.0,
    ):
        """Run ``script`` on the fixture as the login user; return its stdout."""
        if self._windows:
            stdin = self.windows_script(script, *args, stdin=stdin)
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


# ── Agent-host variants (#5444) ───────────────────────────────────────────────
def variant_port(target: NativeSshTarget, name: str) -> int:
    """The port the ``name`` agent-host variant listens on."""
    return target.port + VARIANT_PORT_OFFSETS[name]


class NativeAgentVariant:
    """One variant sshd of the fixture (``variant-up``, #5444, #5423).

    The same login user and keys on its own port, with its own ``HOME`` /
    XDG dirs and agent registry, and the ``env`` the variant needs (the
    pending-update test hook), all through sshd ``SetEnv``. Server-side files
    are written through the main sshd's :class:`NativeSshServerControl`, so a
    keyboard-interactive-only variant needs no key login of its own.

    The fixture-specific SSH hosts (#5423) are variants too, told apart by
    their ``variant-up`` flags (:data:`HOST_VARIANT_FLAGS`).
    """

    def __init__(self, target: NativeSshTarget, name: str) -> None:
        self.target = target
        self.name = name
        self.port = variant_port(target, name)
        self.control = NativeSshServerControl(target)
        self._dir = Path(target.state_dir) / "variants" / name

    def _fixture(self, *args: str, timeout: float = 120.0) -> str:
        result = subprocess.run(
            ["bash", str(_FIXTURE_SH), *args, "--dir", self.target.state_dir],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode != 0:
            raise NativeSshExecError(
                f"native sshd fixture {args[0]} {self.name} failed ({result.returncode}): "
                f"{result.stderr.strip() or result.stdout.strip()}"
            )
        return result.stdout

    def running(self) -> bool:
        """Whether this variant's sshd answers on its port."""
        import socket

        try:
            with socket.create_connection(("127.0.0.1", self.port), timeout=2):
                return True
        except OSError:
            return False

    def home(self) -> str:
        """The variant's home (the ``HOME`` its sessions get)."""
        try:
            return (self._dir / "home_path").read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise NativeSshExecError(f"variant {self.name} is not up: {exc}") from exc

    def up(
        self,
        env: Optional[Mapping[str, str]] = None,
        *,
        kbdint: bool = False,
        flags: Sequence[str] = (),
    ) -> str:
        """Start, or restart with a fresh config, the variant; return its home.

        A restart drops every session the variant was serving. ``flags`` are
        more ``variant-up`` flags (:data:`HOST_VARIANT_FLAGS`).
        """
        args = ["variant-up", "--variant", self.name, "--port", str(self.port)]
        for key, value in (env or {}).items():
            args += ["--setenv", f"{key}={value}"]
        if kbdint:
            args.append("--kbdint")
        args += list(flags)
        lines = self._fixture(*args).strip().splitlines()
        if not lines:
            raise NativeSshExecError(f"variant-up {self.name} printed no home")
        return lines[-1].strip()

    def ensure(
        self,
        env: Optional[Mapping[str, str]] = None,
        *,
        kbdint: bool = False,
        flags: Sequence[str] = (),
    ) -> str:
        """:meth:`up` unless it already runs (parallel workers share it)."""
        if self.running() and (self._dir / "home_path").is_file():
            return self.home()
        return self.up(env, kbdint=kbdint, flags=flags)

    def logs(self) -> str:
        """The variant sshd's log (``LogLevel VERBOSE``)."""
        return self._fixture("variant-log", "--variant", self.name)

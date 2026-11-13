"""SSH hosts the product run brings up itself (#5535).

The SSH and file-browser phases need real servers. Two sources, both owned by
the run and torn down at its end:

* **The native sshd fixture** (``scripts/internal/native-sshd-fixture.sh up
  --jump-host --scratch-home``): the platform's own OpenSSH server, run
  unprivileged as the current user on a loopback port, plus a second sshd as a
  jump-host bastion. It accepts the repo's fixture keys and its own client key
  (key auth only: an unprivileged sshd cannot check a password). Sessions get a
  scratch ``HOME``/``XDG_*``/``HISTFILE`` inside the fixture's state dir, which
  lives under the run dir; ``down`` deletes it. Works on macOS and Linux with
  no container runtime and no root.
* **The Docker SSH fixtures** (``tests/docker``), only when a container runtime
  already works: the password host (``ssh-password``) and the two-factor host
  (``ssh-mfa``, keyboard-interactive one-time code). Without a runtime their
  steps are *not tested* with the reason; the run never starts a VM.

The export parser and the leg bookkeeping are pure and unit-tested in the
normal lane (``tests/test_product_run_machinery.py``).
"""

from __future__ import annotations

import shlex
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Optional

from ..native_ssh import NativeSshTarget, fixture_argv

#: How long ``up`` may take (it self-tests an ssh login and SFTP).
FIXTURE_TIMEOUT = 120.0


class HostUnavailable(RuntimeError):
    """A host the run wanted could not be brought up (the reason is the message)."""


def parse_exports(text: str) -> dict[str, str]:
    """The ``export NAME='value'`` lines the fixture prints, as a dict.

    Other lines (log output) are ignored; values are shell-unquoted.
    """
    found: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("export "):
            continue
        try:
            words = shlex.split(line[len("export ") :])
        except ValueError:
            continue
        for word in words:
            name, sep, value = word.partition("=")
            if sep and name.isidentifier():
                found[name] = value
    return found


def target_from_exports(env: Mapping[str, str]) -> NativeSshTarget:
    """The :class:`NativeSshTarget` of a fixture's exports (no password login)."""
    missing = [
        name
        for name in ("TERMIHUB_NATIVE_SSHD_PORT", "TERMIHUB_NATIVE_SSHD_USER", "TERMIHUB_NATIVE_SSHD_DIR")
        if not env.get(name)
    ]
    if missing:
        raise HostUnavailable("the native sshd fixture did not export " + ", ".join(missing))
    jump = env.get("TERMIHUB_NATIVE_SSHD_JUMP_PORT")
    return NativeSshTarget(
        port=int(env["TERMIHUB_NATIVE_SSHD_PORT"]),
        username=env["TERMIHUB_NATIVE_SSHD_USER"],
        password=env.get("TERMIHUB_NATIVE_SSHD_PASSWORD", ""),
        state_dir=env["TERMIHUB_NATIVE_SSHD_DIR"],
        jump_port=int(jump) if jump else None,
        key=env.get("TERMIHUB_NATIVE_SSHD_KEY") or None,
    )


@dataclass
class NativeSshd:
    """The run's native sshd (+ bastion): its target, host key and scratch home."""

    target: NativeSshTarget
    exports: dict[str, str] = field(default_factory=dict)

    @property
    def host_pubkey(self) -> Optional[Path]:
        value = self.exports.get("TERMIHUB_NATIVE_SSHD_HOST_PUBKEY")
        return Path(value) if value else None

    @property
    def session_home(self) -> Optional[Path]:
        """The ``HOME`` every SSH session gets (inside the state dir)."""
        value = self.exports.get("TERMIHUB_NATIVE_SSHD_HOME")
        return Path(value) if value else None

    @property
    def client_key(self) -> Optional[Path]:
        return Path(self.target.key) if self.target.key else None


def _fixture(action: str, state_dir: Path, *extra: str) -> str:
    try:
        result = subprocess.run(
            fixture_argv(action, str(state_dir), *extra),
            capture_output=True,
            text=True,
            timeout=FIXTURE_TIMEOUT,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HostUnavailable(f"native sshd fixture '{action}': {exc}") from exc
    if result.returncode != 0:
        tail = (result.stderr.strip() or result.stdout.strip()).splitlines()[-3:]
        raise HostUnavailable(f"native sshd fixture '{action}' failed: {' | '.join(tail)}")
    return result.stdout


def native_sshd_up(state_dir: Path) -> NativeSshd:
    """Start the run's native sshd and bastion in ``state_dir``.

    Raises :class:`HostUnavailable` with the reason when the platform cannot
    (Windows needs an elevated shell and a dedicated user, so the run does not
    try there).
    """
    if sys.platform == "win32":
        raise HostUnavailable(
            "the native sshd fixture needs an elevated shell and a local test user on "
            "Windows; the product run does not create one"
        )
    state_dir.parent.mkdir(parents=True, exist_ok=True)
    out = _fixture("up", state_dir, "--jump-host", "--scratch-home")
    exports = parse_exports(out)
    return NativeSshd(target=target_from_exports(exports), exports=exports)


def native_sshd_down(state_dir: Path) -> None:
    """Stop the sshd and bastion and delete their state (keys, scratch home)."""
    if (state_dir / "sshd.pid").exists() or (state_dir / "sshd_config").exists():
        try:
            _fixture("down", state_dir)
        except HostUnavailable as exc:
            print(f"[product-run] {exc}")


#: The Docker services the SSH phase uses when a container runtime works.
COMPOSE_PASSWORD = "ssh-password"
COMPOSE_MFA = "ssh-mfa"


@dataclass
class ComposeHosts:
    """Which Docker SSH services came up, and why the others did not."""

    up: set[str] = field(default_factory=set)
    reasons: dict[str, str] = field(default_factory=dict)

    def missing(self, service: str) -> Optional[str]:
        """Why ``service`` cannot be used (a not-tested reason), or ``None``."""
        if service in self.up:
            return None
        return self.reasons.get(service, f"the Docker service {service} is not up")


def compose_hosts(services: Mapping[str, tuple[str, int]]) -> ComposeHosts:
    """Bring up each Docker ``service`` (name -> (host, port)) that can come up.

    Never starts a container runtime: with none running, every service is
    reported missing with that reason.
    """
    from ..fixtures import (
        ComposeFixture,
        ComposeFixtureFailed,
        ContainerRuntimeUnavailable,
        container_runtime,
    )

    hosts = ComposeHosts()
    if container_runtime() is None:
        for service in services:
            hosts.reasons[service] = (
                f"no container runtime is running, so the Docker SSH fixture {service} "
                "cannot start (the run never starts a VM itself)"
            )
        return hosts
    fixture = ComposeFixture()
    for service, (host, port) in services.items():
        try:
            fixture.ensure(service, ports=[(host, port)])
        except (ContainerRuntimeUnavailable, ComposeFixtureFailed, RuntimeError) as exc:
            hosts.reasons[service] = f"Docker SSH fixture {service} did not start: {exc}"
            continue
        hosts.up.add(service)
    return hosts


def host_key_fingerprint(pubkey: Path) -> Optional[str]:
    """``SHA256:…`` of a public key file (``ssh-keygen -lf``), or ``None``."""
    try:
        out = subprocess.run(
            ["ssh-keygen", "-lf", str(pubkey)], capture_output=True, text=True, timeout=10
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for word in out.split():
        if word.startswith("SHA256:"):
            return word
    return None


@dataclass
class RunHosts:
    """Everything the SSH and file-browser phases connect to, for one run.

    Brought up once per pytest process (:func:`run_hosts`) and torn down at
    its end. Each ``*_reason`` is the not-tested reason when that part is
    missing.
    """

    native: Optional[NativeSshd] = None
    native_reason: Optional[str] = None
    #: A private ``ssh-agent`` holding the fixture key (agent auth); the app's
    #: ``SSH_AUTH_SOCK`` points at it, so the user's own agent is never used.
    agent: Optional[object] = None
    agent_reason: Optional[str] = None
    compose: ComposeHosts = field(default_factory=ComposeHosts)

    def app_env(self) -> dict[str, str]:
        """The app's ``SSH_AUTH_SOCK``: the private agent, or a dead path.

        Never the user's agent: with no private agent the app gets a socket
        path that does not exist, so agent auth fails instead of offering the
        user's keys.
        """
        if self.agent is not None:
            return self.agent.app_env()  # type: ignore[attr-defined]
        return {"SSH_AUTH_SOCK": "/nonexistent/termihub-product-run-agent.sock"}

    def close(self, state_dir: Path) -> None:
        if self.agent is not None:
            self.agent.close()  # type: ignore[attr-defined]
            self.agent = None
        if self.native is not None:
            native_sshd_down(state_dir)
            self.native = None


_RUN_HOSTS: Optional[RunHosts] = None


def run_hosts(config, run_dir: Path) -> RunHosts:
    """The run's hosts, brought up on first use; ``config`` tears them down.

    ``config`` is pytest's config (its ``add_cleanup`` runs at session end,
    after every suite's app has exited).
    """
    global _RUN_HOSTS
    if _RUN_HOSTS is not None:
        return _RUN_HOSTS
    from ..fixtures import SSH_HOST, SSH_MFA_PORT, SSH_PASSWORD_PORT
    from ..ssh_agent import PrivateSshAgent, PrivateSshAgentUnavailable

    hosts = RunHosts()
    state_dir = run_dir / "sshd"
    try:
        hosts.native = native_sshd_up(state_dir)
    except HostUnavailable as exc:
        hosts.native_reason = str(exc)
    config.add_cleanup(lambda: hosts.close(state_dir))
    if hosts.native is not None and hosts.native.client_key is not None:
        try:
            agent = PrivateSshAgent()
            hosts.agent = agent
            agent.add_key(hosts.native.client_key)
        except PrivateSshAgentUnavailable as exc:
            hosts.agent_reason = f"private ssh-agent unavailable: {exc}"
    else:
        hosts.agent_reason = hosts.native_reason or "the native sshd exported no client key"
    hosts.compose = compose_hosts(
        {
            COMPOSE_PASSWORD: (SSH_HOST, SSH_PASSWORD_PORT),
            COMPOSE_MFA: (SSH_HOST, SSH_MFA_PORT),
        }
    )
    _RUN_HOSTS = hosts
    return hosts

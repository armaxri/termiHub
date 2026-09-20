"""Container fixture orchestration for the system-test harness.

The SSH / telnet / serial integration tests reuse the comprehensive containers
in [`tests/docker/docker-compose.yml`](../../docker/docker-compose.yml) as
black-box **fixtures** (epic #799: "Docker fixtures stay; only the driver
changes"). The harness owns bringing them up so a single ``pytest -m
integration`` run is self-contained — and when no container runtime is available
the dependent suites **skip cleanly** instead of failing.

Runtime-agnostic: works with **Docker or Podman**. The runtime is detected the
same way as ``scripts/test-system.sh`` — honor a ``CONTAINER_CMD`` override,
otherwise prefer Docker and fall back to Podman, picking whichever CLI exists
*and* whose daemon/machine answers ``<cmd> info``. Containers are started with
``<runtime> compose up -d`` (not ``--wait``: Podman's compose provider may not
support that flag) and readiness is then confirmed by **probing each published
TCP port** — the same signal the Rust integration tests use.
"""

from __future__ import annotations

import os
import platform
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Iterable, Optional, Sequence

from . import dev_local

REPO_ROOT = Path(__file__).resolve().parents[3]
COMPOSE_FILE = REPO_ROOT / "tests" / "docker" / "docker-compose.yml"

# ── SSH fixture coordinates (mirror tests/docker/docker-compose.yml) ──────────
# Ports honour the per-checkout offset (see ``termihub_harness.dev_local`` and
# ``docs/testing.md`` → Parallel test isolation): each is ``base + test_port_offset``
# (or an explicit ``TERMIHUB_TEST_*_PORT`` env override), matching the port the
# compose file publishes under this checkout's project, so parallel checkouts
# never share a container.
#: Host the published container ports are reachable on.
SSH_HOST = "127.0.0.1"
#: Service + host port for the password-auth SSH container.
SSH_PASSWORD_SERVICE = "ssh-password"
SSH_PASSWORD_PORT = dev_local.service_port("TERMIHUB_TEST_SSH_PASSWORD_PORT", 2201)
#: Service + host port for the key-auth-only SSH container.
SSH_KEYS_SERVICE = "ssh-keys"
SSH_KEYS_PORT = dev_local.service_port("TERMIHUB_TEST_SSH_KEYS_PORT", 2203)
#: Service + host port for the pre-auth-banner / MOTD SSH container.
SSH_BANNER_SERVICE = "ssh-banner"
SSH_BANNER_PORT = dev_local.service_port("TERMIHUB_TEST_SSH_BANNER_PORT", 2206)
#: Service + host port for the tunnel-target SSH container (internal HTTP :8080).
SSH_TUNNEL_SERVICE = "ssh-tunnel-target"
SSH_TUNNEL_PORT = dev_local.service_port("TERMIHUB_TEST_SSH_TUNNEL_PORT", 2207)
#: Service + host port for the X11-forwarding SSH container (``X11Forwarding yes``
#: with ``xauth`` + ``x11-apps``/``xdpyinfo`` installed — see
#: ``tests/docker/ssh-x11/Dockerfile``). Lets the guided-manual X11 test
#: auto-assert that the server allocates a forwarded ``$DISPLAY`` (#957).
SSH_X11_SERVICE = "ssh-x11"
SSH_X11_PORT = dev_local.service_port("TERMIHUB_TEST_SSH_X11_PORT", 2208)
#: Credentials shared by the test SSH containers.
SSH_USERNAME = "testuser"
SSH_PASSWORD = "testpass"
#: Private key accepted by the ``ssh-keys`` container (key auth only).
SSH_KEY_PATH = REPO_ROOT / "tests" / "fixtures" / "ssh-keys" / "ed25519"
#: Passphrase-protected private key (same container) and its passphrase.
SSH_KEY_PASSPHRASE_PATH = REPO_ROOT / "tests" / "fixtures" / "ssh-keys" / "ed25519_passphrase"
SSH_KEY_PASSPHRASE = "testpass123"

# ── Telnet fixture coordinates (mirror tests/docker/docker-compose.yml) ───────
#: Host the published container ports are reachable on (shared with SSH).
TELNET_HOST = "127.0.0.1"
#: Service + host port for the telnet container (in.telnetd via xinetd on :23).
TELNET_SERVICE = "telnet-server"
TELNET_PORT = dev_local.service_port("TERMIHUB_TEST_TELNET_PORT", 2301)

# ── Remote-agent fixture coordinates (mirror tests/docker/docker-compose.yml) ──
#: Service + host port for the deployed-agent SSH container (compose profile
#: ``agent``). Unlike ``ssh-password``, this image ships the ``termihub-agent``
#: binary at the POSIX default install path, so a live connect finds it without
#: running the setup wizard (see :func:`stage_remote_agent_binary` and #995).
REMOTE_AGENT_SERVICE = "remote-agent"
REMOTE_AGENT_PORT = dev_local.service_port("TERMIHUB_TEST_REMOTE_AGENT_PORT", 2211)
#: Service + host port for the *armed* deployed-agent container (compose profile
#: ``agent``). Built from the same context as ``remote-agent`` but with
#: ``PENDING_UPDATE_VERSION`` set, so the agent it launches holds a
#: ``pending_update`` and announces it on attach — the live driver for the
#: deferred-update banner's "Apply Now → deferred/busy" path (#1520 / #1546).
REMOTE_AGENT_PENDING_SERVICE = "remote-agent-pending-update"
REMOTE_AGENT_PENDING_PORT = dev_local.service_port(
    "TERMIHUB_TEST_REMOTE_AGENT_PENDING_PORT", 2214
)
#: Version the armed image advertises (mirrors the compose build arg), so the test
#: can assert the banner names it.
REMOTE_AGENT_PENDING_VERSION = "9.9.9"
#: Build context the harness stages the per-arch agent binary into before the
#: image is built (git-ignored — see the sibling ``.gitignore``). Shared by both
#: the plain and the armed deployed-agent images (same context, different build
#: arg), so :func:`stage_remote_agent_binary` stages the binary once for both.
_REMOTE_AGENT_BUILD_CONTEXT = REPO_ROOT / "tests" / "docker" / "remote-agent"

#: Map a ``platform.machine()`` value to the static-musl target triple whose
#: binary runs in a Linux container of the same architecture. Static musl is used
#: so the binary has no glibc/arch coupling to the ``ubuntu:24.04`` base image —
#: it runs on any Linux of the matching arch (see ``scripts/build-agents.sh``).
_MUSL_TARGET_BY_MACHINE = {
    "x86_64": "x86_64-unknown-linux-musl",
    "amd64": "x86_64-unknown-linux-musl",
    "aarch64": "aarch64-unknown-linux-musl",
    "arm64": "aarch64-unknown-linux-musl",
    "armv7l": "armv7-unknown-linux-musleabihf",
}


class ContainerRuntimeUnavailable(RuntimeError):
    """Raised when no container runtime is reachable, or a service fails to come
    up. Callers turn this into ``pytest.skip(...)``."""


def container_runtime() -> Optional[str]:
    """Return the container CLI to use (``"docker"`` / ``"podman"``), or None.

    Honors a ``CONTAINER_CMD`` override; otherwise prefers Docker and falls back
    to Podman — the same order as ``scripts/test-system.sh``. A runtime counts as
    available only when its CLI exists *and* its daemon/machine answers
    ``<cmd> info`` (so a Docker CLI with no daemon, or a stopped Podman machine,
    is correctly treated as unavailable).
    """
    override = os.environ.get("CONTAINER_CMD")
    candidates = [override] if override else ["docker", "podman"]
    for cmd in candidates:
        if cmd and _runtime_works(cmd):
            return cmd
    return None


def _runtime_works(cmd: str) -> bool:
    """Whether ``cmd`` exists on PATH and its daemon answers ``<cmd> info``."""
    if shutil.which(cmd) is None:
        return False
    try:
        result = subprocess.run(
            [cmd, "info"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


# ── Pre-run stale-fixture reaper (audit finding TIN-011) ──────────────────────
# A normal run tears its compose containers down via the run script's EXIT trap
# (``scripts/test-system-linux.sh``) — but a crash, a ``SIGKILL``, or
# ``--keep-infra`` bypasses that trap, leaving this checkout's containers behind
# to pin the Docker VM. On the *next* run those orphans cause flaky cross-run
# failures (a wedged sshd the fresh run silently reuses, a name still held). The
# reaper removes them BEFORE bring-up so a normal run self-heals from a prior
# crash.
#
# Scope is STRICT: only containers carrying THIS checkout's label are ever
# touched. The machine runs up to ten parallel checkouts, each with a distinct
# project name (``termihub-test-6`` …), so a sibling checkout's containers — and
# any unrelated Docker/Podman workload — are never in scope. Two kinds of orphan
# are reaped, each matched by a *label* (never a container-name glob, which would
# hit a sibling):
#
# * **Compose fixtures** — the ``tests/docker`` SSH/telnet/… containers, carrying
#   ``com.docker.compose.project=<compose_project>``.
# * **App-backend containers** — the app's own ``termihub-<ts>-<pid>`` containers
#   from a crashed run. They carry no compose label, but the Docker backend now
#   stamps ``com.termihub.checkout=<compose_project>`` on every container it
#   creates under the test harness (see ``core/src/backends/docker/mod.rs``), so
#   they too are attributable to exactly one checkout (TIN-011 follow-up, #3049).

#: Compose-project label every ``compose``-managed container carries. Matching on
#: it (rather than the container *name*) is what keeps the reap strictly within
#: one checkout's project — a sibling's containers carry a different value.
_COMPOSE_PROJECT_LABEL = "com.docker.compose.project"

#: Checkout label the app stamps on every Docker-backend container it creates
#: under the test harness, valued with this checkout's compose-project (mirrors
#: ``CHECKOUT_LABEL_KEY`` in ``core/src/backends/docker/mod.rs``). Matching on it
#: — not the shared ``termihub-`` name prefix — is what lets a crashed run's
#: orphaned ``termihub-<ts>-<pid>`` containers be reaped for THIS checkout only.
_APP_CHECKOUT_LABEL = "com.termihub.checkout"

#: Process-once guard. The reaper runs at most once per pytest process (keyed by
#: ``(runtime, project)``), so the *first* :meth:`ComposeFixture.ensure` heals a
#: prior crash while later ``ensure`` calls in the same run never remove the
#: containers *this* run just created — preserving warm within-run reuse.
_reaped_projects: set[tuple[str, str]] = set()


def _containers_with_label(runtime: str, label_selector: str) -> list[str]:
    """Names of containers (any state) matching a single ``label=…`` selector.

    The one query both reaper listings share. Matching on a **label** — never a
    container-name glob — is what keeps every reap strictly within one checkout.
    Returns ``[]`` (never raises) when the runtime query fails, so a flaky ``ps``
    degrades to a no-op reap.
    """
    try:
        result = subprocess.run(
            [
                runtime,
                "ps",
                "-a",
                "--filter",
                f"label={label_selector}",
                "--format",
                "{{.Names}}",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def stale_fixture_containers(runtime: str, project: str) -> list[str]:
    """Names of ``project``'s compose containers currently present (any state).

    Selected by the ``com.docker.compose.project`` **label**, so only
    compose-managed fixtures of *exactly* this checkout match — never a sibling
    checkout, and never an unrelated container that merely shares the
    ``termihub`` name prefix.
    """
    return _containers_with_label(runtime, f"{_COMPOSE_PROJECT_LABEL}={project}")


def stale_app_containers(runtime: str, project: str) -> list[str]:
    """Names of ``project``'s app-spawned Docker-backend containers (any state).

    These are the app's own ``termihub-<ts>-<pid>`` containers a crashed/killed
    run leaked. They are selected by the ``com.termihub.checkout`` **label** the
    Docker backend stamps with this checkout's project value — never by the
    ``termihub-<ts>-<pid>`` name glob, which would also match a sibling
    checkout's app containers on the shared machine (that is exactly what makes a
    name-glob reap unsafe here — finding TIN-011 follow-up, #3049).
    """
    return _containers_with_label(runtime, f"{_APP_CHECKOUT_LABEL}={project}")


def reap_stale_fixtures(
    project: Optional[str] = None, *, runtime: Optional[str] = None
) -> list[str]:
    """Remove stale containers left by a crashed/killed prior run.

    Covers both kinds of this checkout's orphan — the ``tests/docker`` compose
    fixtures *and* the app's own ``termihub-<ts>-<pid>`` Docker-backend
    containers — each selected strictly by a per-checkout **label** (see the
    module note above), never by a container-name glob. Scoped to ``project``
    (this checkout's compose project by default). A no-op that returns ``[]``
    when no container runtime is available or nothing matches, so it is always
    safe to call unconditionally before bring-up. Returns the names of the
    containers it removed.
    """
    if runtime is None:
        runtime = container_runtime()
    if runtime is None:
        return []
    if project is None:
        project = dev_local.compose_project()
    # Both label-scoped listings for this checkout; de-duplicate while preserving
    # order (a container carries at most one of the two labels, but be defensive).
    names = list(
        dict.fromkeys(
            stale_fixture_containers(runtime, project)
            + stale_app_containers(runtime, project)
        )
    )
    if not names:
        return []
    # ``rm -f`` stops-then-removes running orphans too (a crash leaves them
    # *running*, having bypassed the teardown trap). Scoped to the names we just
    # resolved for this project, so nothing outside it is affected. Best-effort:
    # a container that vanished between the list and the remove is not an error.
    try:
        subprocess.run(
            [runtime, "rm", "-f", *names],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        pass
    return names


def _reap_stale_fixtures_once(runtime: str, project: str) -> None:
    """Reap ``project``'s stale containers the first time this run bring-up runs.

    Idempotent per pytest process (guarded by :data:`_reaped_projects`), so the
    reap self-heals a prior crash without ever tearing down containers the
    current run created in an earlier suite.
    """
    key = (runtime, project)
    if key in _reaped_projects:
        return
    _reaped_projects.add(key)
    reap_stale_fixtures(project, runtime=runtime)


class ComposeFixture:
    """On-demand access to the ``tests/docker`` compose services via Docker/Podman.

    Does **not** tear containers down — they are shared fixtures that survive
    across suites and runs (matching ``scripts/test-system.sh`` semantics, where
    the infra is brought up once and torn down by the run script, not the tests).

    Before the *first* bring-up of a run it reaps any of **this checkout's**
    stale fixture containers left over from a crashed/killed prior run (finding
    TIN-011); see :func:`reap_stale_fixtures`.
    """

    def __init__(self, compose_file: Path = COMPOSE_FILE) -> None:
        self._compose_file = compose_file

    def ensure(
        self,
        *services: str,
        ports: Sequence[tuple[str, int]] = (),
        build: bool = False,
        up_timeout: float = 300.0,
        ready_timeout: float = 90.0,
    ) -> None:
        """Start ``services`` detached, then block until each ``ports`` entry is
        reachable.

        ``<runtime> compose up -d`` is a no-op for containers already running, so
        repeated calls within a session are cheap; the first call may build
        images, hence the generous ``up_timeout``. Readiness is confirmed by a TCP
        probe of each ``(host, port)`` rather than ``--wait`` (Podman's compose
        provider may not support it). Raises :class:`ContainerRuntimeUnavailable`
        when no runtime is reachable, the compose up fails, or a port never opens.

        When ``build`` is set, the image is (re)built first with ``compose build``
        — needed for the ``remote-agent`` fixture, whose Dockerfile ``COPY``s a
        freshly-staged agent binary that ``up -d`` alone would not pick up if the
        image already exists (Docker rebuilds only the changed layer, so this is
        cheap when the binary is unchanged).
        """
        runtime = container_runtime()
        if runtime is None:
            raise ContainerRuntimeUnavailable(
                "no container runtime available — need Docker or Podman "
                "(override the choice with CONTAINER_CMD=podman)"
            )
        # Run compose under this checkout's project name and with its offset port
        # overlay, so parallel checkouts bring up isolated containers on distinct
        # host ports (see ``dev_local`` / docs "Parallel test isolation"). The
        # ``ports`` we then probe are computed from the same offset, so they match.
        project = dev_local.compose_project()
        # Self-heal from a prior crash/kill (or --keep-infra) that left this
        # checkout's containers behind: reap them once, before the first
        # bring-up, so ``compose up -d`` starts clean (finding TIN-011).
        _reap_stale_fixtures_once(runtime, project)
        base = [runtime, "compose", "-p", project, "-f", str(self._compose_file)]
        env = {**os.environ, **dev_local.compose_env()}
        services = list(services)
        if build:
            self._run_compose(
                [*base, "build", *services], services, env=env, timeout=up_timeout, action="build"
            )
        self._run_compose(
            [*base, "up", "-d", *services], services, env=env, timeout=up_timeout, action="up"
        )
        for host, port in ports:
            wait_for_port(host, port, timeout=ready_timeout)

    @staticmethod
    def _run_compose(
        cmd: list[str], services: list[str], *, env: dict, timeout: float, action: str
    ) -> None:
        """Run a compose subcommand, mapping any failure to a clean skip signal."""
        try:
            subprocess.run(
                cmd, check=True, timeout=timeout, capture_output=True, text=True, env=env
            )
        except subprocess.CalledProcessError as exc:
            raise ContainerRuntimeUnavailable(
                f"`compose {action}` failed for {services} "
                f"(exit {exc.returncode}):\n{_tail(exc.stderr or exc.stdout)}"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise ContainerRuntimeUnavailable(
                f"`compose {action}` timed out after {timeout}s for {services}:"
                f"\n{_tail(exc.stderr)}"
            ) from exc


def _tail(output: Optional[str], lines: int = 15) -> str:
    """The last ``lines`` non-empty lines of captured subprocess output.

    Surfacing the real compose error (e.g. "additional_contexts is not allowed"
    from an outdated Compose) makes the skip reason actionable instead of a bare
    exit code.
    """
    text = (output or "").strip()
    if not text:
        return "(no output captured)"
    return "\n".join(text.splitlines()[-lines:])


def wait_for_port(host: str, port: int, *, timeout: float) -> None:
    """Block until ``host:port`` accepts a TCP connection, or raise on timeout."""
    deadline = time.monotonic() + timeout
    last_error: Optional[OSError] = None
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1.0):
                return
        except OSError as exc:
            last_error = exc
            time.sleep(0.25)
    raise ContainerRuntimeUnavailable(
        f"container port {host}:{port} did not become reachable within {timeout}s: {last_error}"
    )


def _container_musl_target() -> str:
    """The static-musl target triple matching the container's architecture.

    Docker/Podman build and run native-arch images by default, so the container
    arch equals the host arch; map that to the musl triple whose binary runs in
    the Linux container. Raises :class:`ContainerRuntimeUnavailable` (→ skip) on
    an unmapped arch rather than shipping a binary that cannot execute.
    """
    machine = platform.machine().lower()
    target = _MUSL_TARGET_BY_MACHINE.get(machine)
    if target is None:
        raise ContainerRuntimeUnavailable(
            f"no known static-musl agent target for host architecture {machine!r} — "
            f"supported: {sorted(set(_MUSL_TARGET_BY_MACHINE.values()))}"
        )
    return target


def stage_remote_agent_binary(*, build_timeout: float = 900.0) -> Path:
    """Build (if needed) and stage the agent binary into the remote-agent context.

    Produces a static-musl ``termihub-agent`` for the container architecture via
    ``scripts/build-agents.sh`` and copies it to
    ``tests/docker/remote-agent/termihub-agent`` so the image ``COPY`` picks it
    up. An existing per-target build is reused (a fresh musl cross-build is slow),
    and the copy into the context is always refreshed so a stale image is rebuilt.

    The build enables ``--features test-hooks`` so this release binary still
    carries the env-gated ``pending_update`` test hook that the armed
    ``remote-agent-pending-update`` container drives (#1546). That hook is
    compiled out of default release builds for security (audit finding AGT-008),
    so a plain ``build-agents.sh`` would stage a binary the armed suite cannot
    arm. The feature only *compiles the hook in*; it stays inert unless
    ``TERMIHUB_AGENT_TEST_PENDING_UPDATE`` is set, which only the armed image
    does — the shared ``remote-agent`` container is unaffected.

    Raises :class:`ContainerRuntimeUnavailable` — turned into a ``pytest.skip`` by
    the fixture — when the arch is unmapped or the cross-build is unavailable
    (e.g. ``cross``/Docker not set up on this host). This keeps the deployed-agent
    suite skipping cleanly instead of failing where the toolchain is missing.
    """
    target = _container_musl_target()
    built = REPO_ROOT / "target" / target / "release" / "termihub-agent"
    if not built.exists():
        script = REPO_ROOT / "scripts" / "build-agents.sh"
        try:
            subprocess.run(
                ["bash", str(script), "--targets", target, "--features", "test-hooks"],
                check=True,
                timeout=build_timeout,
                capture_output=True,
                text=True,
                cwd=REPO_ROOT,
            )
        except FileNotFoundError as exc:
            raise ContainerRuntimeUnavailable(
                f"cannot build the agent binary: {exc}"
            ) from exc
        except subprocess.CalledProcessError as exc:
            raise ContainerRuntimeUnavailable(
                f"`build-agents.sh --targets {target}` failed (exit {exc.returncode}) — "
                f"is the cross toolchain set up (`scripts/setup-agent-cross.sh`)?\n"
                f"{_tail(exc.stderr or exc.stdout)}"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise ContainerRuntimeUnavailable(
                f"`build-agents.sh --targets {target}` timed out after {build_timeout}s:"
                f"\n{_tail(exc.stderr)}"
            ) from exc
    if not built.exists():
        raise ContainerRuntimeUnavailable(
            f"agent binary still missing after build: {built}"
        )
    staged = _REMOTE_AGENT_BUILD_CONTEXT / "termihub-agent"
    shutil.copy2(built, staged)
    staged.chmod(0o755)
    return staged


# ── Server-side SSH disconnect control (issue #1650) ──────────────────────────
#: Process-title fragment every sshd session process for the test user carries
#: (``sshd: testuser [priv]`` / ``sshd: testuser@pts/0``). Matched against
#: ``/proc/<pid>/cmdline`` so no ``procps`` is needed in the minimal image.
_SSHD_SESSION_MATCH = f"sshd: {SSH_USERNAME}"

#: POSIX-shell one-liner that prints the PID of every process whose cmdline
#: contains :data:`_SSHD_SESSION_MATCH`. ``tr`` turns the NUL-separated cmdline
#: into spaces; ``case`` avoids depending on ``grep``/``pgrep`` (absent from the
#: container base image). The scanning shell itself is skipped (``$$``): its own
#: cmdline embeds the match literal below, so it would otherwise self-match. Runs
#: under the container's ``/bin/sh`` (dash).
_SSHD_PID_SCAN = (
    'for p in /proc/[0-9]*; do '
    'pid=${p#/proc/}; '
    '[ "$pid" = "$$" ] && continue; '
    'c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null) || continue; '
    f'case "$c" in *"{_SSHD_SESSION_MATCH}"*) echo "$pid";; esac; '
    "done"
)


class SshServerControl:
    """Server-side control of a shared SSH container for the disconnect test.

    Lets one test drop *its own* live SSH connection at the server without
    disturbing sibling sessions on the same shared container (issue #1650). The
    per-connection sshd process is identified by diffing the session-PID set
    around the connect, so only this test's session is killed — no container is
    stopped or restarted, so every suite sharing the container is unaffected.

    The abrupt ``SIGKILL`` (rather than a clean SSH logout) is what makes this a
    *server-side drop*: the TCP connection is severed with no protocol-level
    close, which the client observes as a dropped session (``terminal-exit`` →
    the disconnect overlay), i.e. the SSH-06 scenario.
    """

    def __init__(self, service: str = SSH_PASSWORD_SERVICE) -> None:
        self._service = service
        #: The container name compose publishes for ``service`` under this
        #: checkout (mirrors ``container_name`` in the compose file).
        self._container = f"{dev_local.compose_project()}-{service}"
        self._runtime = container_runtime()

    @property
    def available(self) -> bool:
        """Whether a container runtime is reachable to exec into the container."""
        return self._runtime is not None

    def session_pids(self) -> set[str]:
        """PIDs of the sshd session processes currently serving the test user."""
        out = self._exec(["sh", "-c", _SSHD_PID_SCAN])
        return {line.strip() for line in out.split() if line.strip()}

    def kill_sessions(self, pids: Iterable[str]) -> None:
        """``SIGKILL`` the given sshd session PIDs — an abrupt server-side drop."""
        targets = [pid for pid in pids if pid]
        if not targets:
            return
        # -9 so the connection is severed at once; the container's sshd keeps
        # listening for other/future sessions (only these PIDs die).
        self._exec(["kill", "-9", *targets])

    def _exec(self, argv: Sequence[str], *, timeout: float = 30.0) -> str:
        """Run ``argv`` inside the container via the detected runtime.

        Raises :class:`ContainerRuntimeUnavailable` (→ a clean ``pytest.skip`` at
        the call site) when no runtime is reachable or the exec fails.
        """
        if self._runtime is None:
            raise ContainerRuntimeUnavailable(
                "no container runtime available to exec into "
                f"{self._container} (need Docker or Podman)"
            )
        cmd = [self._runtime, "exec", self._container, *argv]
        try:
            result = subprocess.run(
                cmd, check=True, timeout=timeout, capture_output=True, text=True
            )
        except subprocess.CalledProcessError as exc:
            raise ContainerRuntimeUnavailable(
                f"`exec` into {self._container} failed (exit {exc.returncode}):\n"
                f"{_tail(exc.stderr or exc.stdout)}"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise ContainerRuntimeUnavailable(
                f"`exec` into {self._container} timed out after {timeout}s:\n"
                f"{_tail(exc.stderr)}"
            ) from exc
        return result.stdout

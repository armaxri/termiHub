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
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Optional, Sequence

REPO_ROOT = Path(__file__).resolve().parents[3]
COMPOSE_FILE = REPO_ROOT / "tests" / "docker" / "docker-compose.yml"

# ── SSH fixture coordinates (mirror tests/docker/docker-compose.yml) ──────────
#: Host the published container ports are reachable on.
SSH_HOST = "127.0.0.1"
#: Service + host port for the password-auth SSH container.
SSH_PASSWORD_SERVICE = "ssh-password"
SSH_PASSWORD_PORT = 2201
#: Service + host port for the key-auth-only SSH container.
SSH_KEYS_SERVICE = "ssh-keys"
SSH_KEYS_PORT = 2203
#: Service + host port for the pre-auth-banner / MOTD SSH container.
SSH_BANNER_SERVICE = "ssh-banner"
SSH_BANNER_PORT = 2206
#: Service + host port for the tunnel-target SSH container (internal HTTP :8080).
SSH_TUNNEL_SERVICE = "ssh-tunnel-target"
SSH_TUNNEL_PORT = 2207
#: Credentials shared by the test SSH containers.
SSH_USERNAME = "testuser"
SSH_PASSWORD = "testpass"
#: Private key accepted by the ``ssh-keys`` container (key auth only).
SSH_KEY_PATH = REPO_ROOT / "tests" / "fixtures" / "ssh-keys" / "ed25519"
#: Passphrase-protected private key (same container) + its passphrase.
SSH_KEY_PASSPHRASE_PATH = REPO_ROOT / "tests" / "fixtures" / "ssh-keys" / "ed25519_passphrase"
SSH_KEY_PASSPHRASE = "testpass123"


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


class ComposeFixture:
    """On-demand access to the ``tests/docker`` compose services via Docker/Podman.

    Does **not** tear containers down — they are shared fixtures that survive
    across suites and runs (matching ``scripts/test-system.sh`` semantics, where
    the infra is brought up once and torn down by the run script, not the tests).
    """

    def __init__(self, compose_file: Path = COMPOSE_FILE) -> None:
        self._compose_file = compose_file

    def ensure(
        self,
        *services: str,
        ports: Sequence[tuple[str, int]] = (),
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
        """
        runtime = container_runtime()
        if runtime is None:
            raise ContainerRuntimeUnavailable(
                "no container runtime available — need Docker or Podman "
                "(override the choice with CONTAINER_CMD=podman)"
            )
        cmd = [runtime, "compose", "-f", str(self._compose_file), "up", "-d", *services]
        try:
            subprocess.run(
                cmd, check=True, timeout=up_timeout, capture_output=True, text=True
            )
        except subprocess.CalledProcessError as exc:
            raise ContainerRuntimeUnavailable(
                f"`{runtime} compose up` failed for {list(services)} "
                f"(exit {exc.returncode}):\n{_tail(exc.stderr or exc.stdout)}"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise ContainerRuntimeUnavailable(
                f"`{runtime} compose up` timed out after {up_timeout}s for {list(services)}:"
                f"\n{_tail(exc.stderr)}"
            ) from exc
        for host, port in ports:
            wait_for_port(host, port, timeout=ready_timeout)


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

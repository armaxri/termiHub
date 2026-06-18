"""Docker fixture orchestration for the system-test harness.

The SSH / telnet / serial integration tests reuse the comprehensive Docker
containers in ``tests/docker/docker-compose.yml`` as black-box **fixtures**
(epic #799: "Docker fixtures stay; only the driver changes"). The harness owns
bringing them up so a single ``pytest -m integration`` run is self-contained —
and when Docker is not available the dependent suites **skip cleanly** instead
of failing, so a plain ``pytest`` never errors on a machine without Docker.

Reuses the healthchecks already declared per container in the compose file:
``docker compose up -d --wait`` blocks until those report healthy, so a test
never races a half-started sshd.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
COMPOSE_FILE = REPO_ROOT / "tests" / "docker" / "docker-compose.yml"

# ── SSH fixture coordinates (mirror tests/docker/docker-compose.yml) ──────────
#: Service + host port for the password-auth SSH container.
SSH_PASSWORD_SERVICE = "ssh-password"
SSH_PASSWORD_PORT = 2201
#: Service + host port for the key-auth-only SSH container.
SSH_KEYS_SERVICE = "ssh-keys"
SSH_KEYS_PORT = 2203
#: Credentials shared by the test SSH containers.
SSH_USERNAME = "testuser"
SSH_PASSWORD = "testpass"
#: Private key accepted by the ``ssh-keys`` container (key auth only).
SSH_KEY_PATH = REPO_ROOT / "tests" / "fixtures" / "ssh-keys" / "ed25519"


class DockerUnavailable(RuntimeError):
    """Raised when Docker (or its daemon) cannot be reached, or a service fails
    to come up. Callers turn this into ``pytest.skip(...)``."""


def docker_available() -> bool:
    """Whether a Docker CLI with a reachable daemon is present.

    ``docker version`` (unlike ``--version``) contacts the daemon, so it returns
    non-zero when Docker is installed but the daemon is down — exactly the case
    we want to skip on.
    """
    if shutil.which("docker") is None:
        return False
    try:
        result = subprocess.run(
            ["docker", "version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


class DockerComposeFixture:
    """On-demand access to the ``tests/docker`` compose services.

    Does **not** tear containers down — they are shared fixtures that survive
    across suites and runs (matching ``scripts/test-system.sh`` semantics, where
    the infra is brought up once). Explicit cleanup is opt-in via :meth:`down`.
    """

    def __init__(self, compose_file: Path = COMPOSE_FILE) -> None:
        self._compose_file = compose_file

    def ensure(self, *services: str, timeout: float = 300.0) -> None:
        """Start ``services`` detached and block until healthy (idempotent).

        ``docker compose up -d --wait`` is a no-op for containers already running
        and healthy, so repeated calls within a session are cheap. The first call
        may build images, which is why ``timeout`` is generous. Raises
        :class:`DockerUnavailable` when Docker is unreachable or a service fails.
        """
        if not docker_available():
            raise DockerUnavailable("docker CLI or daemon is not available")
        cmd = [
            "docker",
            "compose",
            "-f",
            str(self._compose_file),
            "up",
            "-d",
            "--wait",
            *services,
        ]
        try:
            subprocess.run(cmd, check=True, timeout=timeout)
        except subprocess.CalledProcessError as exc:
            raise DockerUnavailable(
                f"`docker compose up` failed for {list(services)}: exit {exc.returncode}"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise DockerUnavailable(
                f"`docker compose up` timed out after {timeout}s for {list(services)}"
            ) from exc

    def down(self, *services: str) -> None:
        """Stop the given services (best-effort cleanup; never raises)."""
        if not docker_available():
            return
        subprocess.run(
            ["docker", "compose", "-f", str(self._compose_file), "stop", *services],
            check=False,
        )

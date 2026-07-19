"""Per-checkout test settings resolved from ``dev.local.json`` (parallel isolation).

Several checkouts of termiHub can run all of their test environments at once on
one machine. Every shared host resource — Docker container/network names,
published ports, the ``tauri-driver`` port, the virtual serial device paths — is
derived from a single gitignored ``dev.local.json`` so two checkouts never
contend. This module is the Python half of the resolver (the shell half is
``scripts/internal/dev-local-env.sh``); both read the same keys and apply the
same defaults, which reproduce the historical single-checkout behaviour exactly.

Resolution precedence for every value: an explicit **environment variable** wins
(so a caller / the shell resolver can override), then the ``dev.local.json`` key,
then the built-in default. See ``docs/testing.md`` → *Parallel test isolation*.

Plain functions reading a JSON file — no app, no polling — so they stay
unit-testable against a temp file in ``test_dev_local.py``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

#: Repo root: ``tests/system/termihub_harness/dev_local.py`` → up three.
REPO_ROOT = Path(__file__).resolve().parents[3]

#: Default Compose project name (historical container/network prefix).
DEFAULT_PROJECT = "termihub"

#: Base host port of every test container/service, keyed by its canonical env
#: var. The effective port is ``base + offset`` unless the env var overrides it.
#: Mirrors ``tests/docker/docker-compose.yml`` and ``dev-local-env.sh``.
BASE_PORTS: dict[str, int] = {
    "TERMIHUB_TEST_SSH_PASSWORD_PORT": 2201,
    "TERMIHUB_TEST_SSH_SUDO_PORT": 2212,
    "TERMIHUB_TEST_SSH_NOSUDO_PORT": 2213,
    "TERMIHUB_TEST_SSH_LEGACY_PORT": 2202,
    "TERMIHUB_TEST_SSH_KEYS_PORT": 2203,
    "TERMIHUB_TEST_SSH_BASTION_PORT": 2204,
    "TERMIHUB_TEST_SSH_RESTRICTED_PORT": 2205,
    "TERMIHUB_TEST_SSH_BANNER_PORT": 2206,
    "TERMIHUB_TEST_SSH_TUNNEL_PORT": 2207,
    "TERMIHUB_TEST_SSH_X11_PORT": 2208,
    "TERMIHUB_TEST_NETWORK_FAULT_PORT": 2209,
    "TERMIHUB_TEST_SFTP_STRESS_PORT": 2210,
    "TERMIHUB_TEST_REMOTE_AGENT_PORT": 2211,
    "TERMIHUB_TEST_REMOTE_AGENT_PENDING_PORT": 2214,
    "TERMIHUB_TEST_TELNET_PORT": 2301,
    "TERMIHUB_TEST_VNC_PORT": 2501,
    "TERMIHUB_TEST_NETWORK_TARGET_PORT": 8080,
}


def _load(repo_root: Path = REPO_ROOT) -> dict[str, Any]:
    """Parse ``dev.local.json`` from ``repo_root``; ``{}`` if absent or invalid.

    A missing or malformed file is not an error — it just means "use defaults"
    (the single-checkout case), so callers never need a try/except.
    """
    path = repo_root / "dev.local.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def compose_project(repo_root: Path = REPO_ROOT) -> str:
    """The Docker Compose project name (env > ``dev.local.json`` > ``termihub``)."""
    env = os.environ.get("COMPOSE_PROJECT_NAME")
    if env:
        return env
    value = _load(repo_root).get("compose_project")
    return value if isinstance(value, str) and value else DEFAULT_PROJECT


def port_offset(repo_root: Path = REPO_ROOT) -> int:
    """The integer added to every base port (env > ``dev.local.json`` > ``0``)."""
    env = os.environ.get("TERMIHUB_TEST_PORT_OFFSET")
    if env is not None:
        try:
            return int(env)
        except ValueError:
            return 0
    value = _load(repo_root).get("test_port_offset")
    return value if isinstance(value, int) else 0


def service_port(env_var: str, base: int, repo_root: Path = REPO_ROOT) -> int:
    """Effective host port for a service: env override, else ``base + offset``."""
    env = os.environ.get(env_var)
    if env is not None:
        try:
            return int(env)
        except ValueError:
            pass
    return base + port_offset(repo_root)


def compose_env(repo_root: Path = REPO_ROOT) -> dict[str, str]:
    """Env overlay for invoking ``compose``: project name + every service port.

    Merge this into the subprocess environment so the compose file's
    ``${TERMIHUB_TEST_*_PORT:-<base>}`` / ``${COMPOSE_PROJECT_NAME:-termihub}``
    interpolations publish this checkout's offset ports under its own project.
    """
    project = compose_project(repo_root)
    env = {
        # ``COMPOSE_PROJECT_NAME`` groups the containers (up/down/ps);
        # ``TERMIHUB_TEST_PROJECT`` is what the compose file interpolates into
        # container_name / network name. A dedicated var (not COMPOSE_PROJECT_NAME,
        # which compose auto-sets to the dir name) keeps the ``:-termihub`` default
        # intact for a direct ``docker compose up``.
        "COMPOSE_PROJECT_NAME": project,
        "TERMIHUB_TEST_PROJECT": project,
        "TERMIHUB_TEST_PORT_OFFSET": str(port_offset(repo_root)),
    }
    for var, base in BASE_PORTS.items():
        env[var] = str(service_port(var, base, repo_root))
    return env

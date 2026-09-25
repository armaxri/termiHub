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
import re
from pathlib import Path
from typing import Any

#: Repo root: ``tests/system/termihub_harness/dev_local.py`` → up three.
REPO_ROOT = Path(__file__).resolve().parents[3]

#: Default Compose project name (historical container/network prefix).
DEFAULT_PROJECT = "termihub"

#: Step between checkouts' ``test_port_offset`` values (docs/testing.md →
#: *Parallel test isolation*: dev0→0, dev1→1000, …). Used only by the
#: self-consistency check below, never by the offset math itself.
OFFSET_PER_SLOT = 1000

#: A ``dev<N>`` slot name — matches both the ``dev_name`` key and the coordinator's
#: ``…/dev<N>/termiHub`` checkout directories.
_SLOT_RE = re.compile(r"^dev(\d+)$")

#: A standard per-checkout Compose project (``termihub-test-<N>``).
_TEST_PROJECT_RE = re.compile(r"^termihub-test-(\d+)$")


def _env_flag(name: str) -> bool:
    """True when env var ``name`` is set to a truthy value (``1``/``true``/``yes``/``on``)."""
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _sibling_checkouts_exist(repo_root: Path) -> bool:
    """True when ``repo_root`` sits in a parallel ``…/dev<N>/termiHub`` tree.

    Detects the coordinator's multi-checkout layout: this checkout's parent is a
    ``dev<N>`` slot dir and at least one *other* ``dev<M>/<same-leaf>`` checkout
    exists alongside it. A lone checkout (CI, a single dev machine) has no such
    siblings, so the caller keeps the historical single-checkout default.
    """
    try:
        slot_dir = repo_root.parent
        if not _SLOT_RE.match(slot_dir.name):
            return False
        me = repo_root.resolve()
        for sibling in slot_dir.parent.glob("dev*/" + repo_root.name):
            if not sibling.is_dir() or not _SLOT_RE.match(sibling.parent.name):
                continue
            if sibling.resolve() != me:
                return True
    except OSError:
        return False
    return False


def _would_collide(repo_root: Path) -> bool:
    """Whether defaulting to offset 0 here would silently collide (TIN-016).

    Only when a parallel checkout tree is detected *and* nothing else already
    isolates this checkout's ports: an explicit ``TERMIHUB_TEST_PORT_OFFSET`` (a
    caller / the shell resolver) makes the file optional, and
    ``TERMIHUB_ALLOW_DEFAULT_DEV_LOCAL`` is an explicit opt-out escape hatch.
    """
    if _env_flag("TERMIHUB_ALLOW_DEFAULT_DEV_LOCAL"):
        return False
    if os.environ.get("TERMIHUB_TEST_PORT_OFFSET") is not None:
        return False
    return _sibling_checkouts_exist(repo_root)


def _guard_silent_collision(repo_root: Path, path: Path, reason: str) -> None:
    """Raise when a missing/malformed config would silently steal checkout 0's ports."""
    if not _would_collide(repo_root):
        return
    raise RuntimeError(
        f"dev.local.json is {reason} at {path}, but this checkout sits in a parallel "
        f"dev*/termiHub tree. Defaulting to test_port_offset 0 / project '{DEFAULT_PROJECT}' "
        f"would silently collide with checkout 0's ports and containers (flaky "
        f"cross-checkout test failures). Create {path} with a distinct dev_name and "
        f"test_port_offset (see docs/testing.md → 'Parallel test isolation'), or set "
        f"TERMIHUB_TEST_PORT_OFFSET / TERMIHUB_ALLOW_DEFAULT_DEV_LOCAL to opt out."
    )


def _check_consistency(data: dict[str, Any], repo_root: Path) -> None:
    """Assert a declared ``dev<N>`` identity lines up with the ports it resolves to.

    Catches a half-applied config — e.g. a checkout renamed to ``dev3`` whose
    ``test_port_offset`` still reads ``1000`` — which would otherwise resolve to a
    *different* slot's ports/containers with no warning. Only fires when the file
    declares a ``dev<N>`` ``dev_name``; a custom name or a bare offset is left alone.
    """
    dev_name = data.get("dev_name")
    if not isinstance(dev_name, str):
        return
    match = _SLOT_RE.match(dev_name)
    if not match:
        return
    slot = int(match.group(1))
    expected_offset = slot * OFFSET_PER_SLOT
    raw_offset = data.get("test_port_offset")
    actual_offset = raw_offset if isinstance(raw_offset, int) else 0
    if actual_offset != expected_offset:
        raise RuntimeError(
            f"dev.local.json in {repo_root} is inconsistent: dev_name={dev_name!r} "
            f"implies test_port_offset {expected_offset}, but it is {actual_offset}. "
            f"This checkout would use checkout {actual_offset // OFFSET_PER_SLOT}'s test "
            f"ports and silently collide — set test_port_offset to {expected_offset}."
        )
    project = data.get("compose_project")
    if isinstance(project, str):
        project_match = _TEST_PROJECT_RE.match(project)
        if project_match and int(project_match.group(1)) != slot:
            raise RuntimeError(
                f"dev.local.json in {repo_root} is inconsistent: dev_name={dev_name!r} "
                f"but compose_project={project!r} names checkout "
                f"{int(project_match.group(1))}. Its containers would collide — set "
                f"compose_project to 'termihub-test-{slot}'."
            )

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
    """Parse ``dev.local.json`` from ``repo_root``; ``{}`` when legitimately absent.

    A missing or malformed file means "use defaults" (the single-checkout case) —
    *unless* this checkout sits in a parallel ``dev*/termiHub`` tree, where those
    defaults would silently steal checkout 0's ports and containers (TIN-016). In
    that case we raise instead of colliding. A present, well-formed file is also
    checked for ``dev_name`` ↔ offset/project consistency.
    """
    path = repo_root / "dev.local.json"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        # Missing (or unreadable): fall back to defaults, but fail loud if that
        # would collide with a sibling checkout.
        _guard_silent_collision(repo_root, path, "missing")
        return {}
    try:
        data = json.loads(text)
    except ValueError:
        _guard_silent_collision(repo_root, path, "malformed")
        return {}
    if not isinstance(data, dict):
        _guard_silent_collision(repo_root, path, "malformed")
        return {}
    _check_consistency(data, repo_root)
    return data


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

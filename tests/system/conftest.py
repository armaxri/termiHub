"""Shared pytest fixtures and CLI options for the system-test harness."""

import pytest

from termihub_harness import (
    SSH_BANNER_PORT,
    SSH_BANNER_SERVICE,
    SSH_HOST,
    SSH_KEYS_PORT,
    SSH_KEYS_SERVICE,
    SSH_PASSWORD_PORT,
    SSH_PASSWORD_SERVICE,
    SSH_TUNNEL_PORT,
    SSH_TUNNEL_SERVICE,
    AgentInstance,
    AppInstance,
    Bridge,
    ComposeFixture,
    ContainerRuntimeUnavailable,
)


def pytest_addoption(parser):
    """Add ``--delay4user`` to enable the watch-along delays (see SystemTest.delay4user).

    A boolean: off by default, so CI / AI-agent / normal runs skip every delay
    and run at full speed. Pass ``--delay4user`` to insert the sleeps so a human
    can follow the UI; the duration of each is set per call in the test.
    """
    parser.addoption(
        "--delay4user",
        action="store_true",
        default=False,
        help="Enable SystemTest.delay4user() sleeps for human watch-along. "
        "Skipped entirely without the flag.",
    )


@pytest.fixture
def bridge():
    """A started bridge server; closed after the test."""
    server = Bridge().start()
    yield server
    server.close()


@pytest.fixture
def app():
    """An (unstarted) :class:`AppInstance`; skipped if the app is not built.

    The test starts it with ``app.start(bridge.port)`` so it can control launch
    ordering; the process tree is torn down afterward.
    """
    try:
        instance = AppInstance()
    except FileNotFoundError as exc:
        pytest.skip(str(exc))
    with instance as started:
        yield started


@pytest.fixture
def agent():
    """An (unstarted) :class:`AgentInstance`; skipped if the agent is not built."""
    try:
        instance = AgentInstance()
    except FileNotFoundError as exc:
        pytest.skip(str(exc))
    with instance as started:
        yield started


def _ensure_ssh_services(services_and_ports):
    """Bring up the given SSH services or skip the suite when no runtime exists.

    Session-scoped callers share the (slow, image-building) bring-up. Requesting
    such a fixture before the per-class app fixture means the suite **skips before
    even launching the app** when no container runtime is available. Containers
    are left running afterward (shared fixtures, like ``scripts/test-system.sh``).
    """
    fixture = ComposeFixture()
    services = [s for s, _ in services_and_ports]
    ports = [(SSH_HOST, port) for _, port in services_and_ports]
    try:
        fixture.ensure(*services, ports=ports)
    except ContainerRuntimeUnavailable as exc:
        pytest.skip(f"SSH container fixtures unavailable: {exc}")
    return fixture


@pytest.fixture(scope="session")
def ssh_fixtures():
    """Password- and key-auth SSH containers (ports 2201 / 2203)."""
    return _ensure_ssh_services(
        [(SSH_PASSWORD_SERVICE, SSH_PASSWORD_PORT), (SSH_KEYS_SERVICE, SSH_KEYS_PORT)]
    )


@pytest.fixture(scope="session")
def ssh_banner_fixtures():
    """Pre-auth-banner / MOTD SSH container (port 2206)."""
    return _ensure_ssh_services([(SSH_BANNER_SERVICE, SSH_BANNER_PORT)])


@pytest.fixture(scope="session")
def ssh_tunnel_fixtures():
    """Tunnel-target SSH container with internal HTTP (port 2207)."""
    return _ensure_ssh_services([(SSH_TUNNEL_SERVICE, SSH_TUNNEL_PORT)])

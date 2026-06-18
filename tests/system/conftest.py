"""Shared pytest fixtures and CLI options for the system-test harness."""

import pytest

from termihub_harness import (
    SSH_KEYS_SERVICE,
    SSH_PASSWORD_SERVICE,
    AgentInstance,
    AppInstance,
    Bridge,
    DockerComposeFixture,
    DockerUnavailable,
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


@pytest.fixture(scope="session")
def ssh_fixtures():
    """Ensure the SSH Docker containers are up for the whole session.

    Session-scoped so the (potentially slow, image-building) bring-up happens
    once. Because it is requested by the SSH suites — and is session-scoped, so
    pytest sets it up before the per-class app fixture — the suite **skips before
    even launching the app** when Docker is unavailable. Containers are left
    running afterward (shared fixtures, like ``scripts/test-system.sh``).
    """
    fixture = DockerComposeFixture()
    try:
        fixture.ensure(SSH_PASSWORD_SERVICE, SSH_KEYS_SERVICE)
    except DockerUnavailable as exc:
        pytest.skip(f"SSH Docker fixtures unavailable: {exc}")
    return fixture

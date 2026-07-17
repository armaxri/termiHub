"""Shared pytest fixtures and CLI options for the system-test harness."""

import datetime
import sys

import pytest

from termihub_harness.artifacts import (
    ARTIFACT_ROOT,
    sanitize_nodeid,
    write_failure_artifacts,
)
from termihub_harness.manual import (
    ManualSession,
    detect_platform,
    manual_skip_reason,
    write_manual_report,
)

from termihub_harness import (
    REMOTE_AGENT_PORT,
    REMOTE_AGENT_SERVICE,
    SSH_BANNER_PORT,
    SSH_BANNER_SERVICE,
    SSH_HOST,
    SSH_KEYS_PORT,
    SSH_KEYS_SERVICE,
    SSH_PASSWORD_PORT,
    SSH_PASSWORD_SERVICE,
    SSH_TUNNEL_PORT,
    SSH_TUNNEL_SERVICE,
    SSH_X11_PORT,
    SSH_X11_SERVICE,
    TELNET_HOST,
    TELNET_PORT,
    TELNET_SERVICE,
    AgentInstance,
    AppInstance,
    Bridge,
    ComposeFixture,
    ContainerRuntimeUnavailable,
    stage_remote_agent_binary,
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
    parser.addoption(
        "--manual",
        action="store_true",
        default=False,
        help="Run @pytest.mark.manual guided tests interactively (needs a TTY). "
        "Without it they skip, so CI / AI-agent / normal runs stay green.",
    )
    parser.addoption(
        "--manual-platform",
        action="store",
        default=None,
        metavar="OS",
        help="Override the platform used to select platform-scoped manual tests "
        "(macos / linux / windows). Defaults to the host platform.",
    )
    parser.addoption(
        "--app-log-echo",
        action="store_true",
        default=False,
        help="Echo the app's stdout/stderr live to the console. Off by default "
        "in guided-manual (--manual) runs so the operator prompts stay readable; "
        "the app log is always captured to the per-instance app.log regardless. "
        "Pass this to force the live echo back on even under --manual.",
    )


# ── Guided-manual mode (issue #914) ──────────────────────────────────────────
def pytest_configure(config):
    """Register the ``manual`` marker and start the per-run report collector."""
    config.addinivalue_line(
        "markers",
        "manual: guided-manual test — automated setup then an operator prompt. "
        "Skipped unless --manual is passed with an interactive TTY.",
    )
    config._manual_session = ManualSession()
    config._manual_started = datetime.datetime.now(datetime.timezone.utc)


def pytest_collection_modifyitems(config, items):
    """Skip ``manual`` tests unless ``--manual`` + a TTY + the platform all match.

    Done at collection time (not in a fixture) so a skipped guided test never
    pays the cost of launching the real app — the skip marker is evaluated before
    any class-scoped app fixture runs. A test scopes itself to platforms via the
    marker, e.g. ``@pytest.mark.manual(platforms=["macos", "windows"])``; omitting
    ``platforms`` runs it everywhere.
    """
    enabled = bool(config.getoption("manual"))
    interactive = sys.stdin.isatty()
    selected = config.getoption("manual_platform") or detect_platform()
    config._manual_platform = selected  # reused by pytest_sessionfinish
    for item in items:
        marker = item.get_closest_marker("manual")
        if marker is None:
            continue
        reason = manual_skip_reason(
            enabled=enabled,
            interactive=interactive,
            selected_platform=selected,
            platforms=marker.kwargs.get("platforms"),
        )
        if reason:
            item.add_marker(pytest.mark.skip(reason=reason))


def pytest_sessionfinish(session, exitstatus):
    """Flush the guided-manual report to ``tests/reports/`` if any prompt ran."""
    config = session.config
    collector = getattr(config, "_manual_session", None)
    if collector is None or not collector.records:
        return
    # ARTIFACT_ROOT is tests/system/artifacts; reports live at tests/reports.
    path = write_manual_report(
        collector.records,
        ARTIFACT_ROOT.parents[1] / "reports",
        started_at=config._manual_started,
        completed_at=datetime.datetime.now(datetime.timezone.utc),
        selected_platform=getattr(config, "_manual_platform", None) or detect_platform(),
    )
    if path is not None:
        print(f"\n[manual] wrote guided-manual report to {path}")


@pytest.fixture
def bridge():
    """A started bridge server; closed after the test."""
    server = Bridge().start()
    yield server
    server.close()


@pytest.fixture
def app(request):
    """An (unstarted) :class:`AppInstance`; skipped if the app is not built.

    The test starts it with ``app.start(bridge.port)`` so it can control launch
    ordering; the process tree is torn down afterward.

    In guided-manual runs the app's live log echo is suppressed by default so it
    does not interleave with the operator prompts (``--app-log-echo`` forces it
    back on); the log is always captured to ``app.log`` either way (#957).
    """
    manual = bool(request.config.getoption("manual"))
    force_echo = bool(request.config.getoption("app_log_echo"))
    echo_logs = force_echo or not manual
    try:
        instance = AppInstance(echo_logs=echo_logs)
    except FileNotFoundError as exc:
        pytest.skip(str(exc))
    if manual and not echo_logs:
        print(f"\n[manual] app logs are captured (not echoed) at: {instance.log_path}")
        print("[manual] tail them in another window: " f"tail -f {instance.log_path}\n")
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


def _ensure_services(host_services_and_ports, *, label):
    """Bring up the given compose services or skip the suite when no runtime exists.

    Session-scoped callers share the (slow, image-building) bring-up. Requesting
    such a fixture before the per-class app fixture means the suite **skips before
    even launching the app** when no container runtime is available. Containers
    are left running afterward (shared fixtures, like ``scripts/test-system.sh``).

    ``host_services_and_ports`` is an iterable of ``(host, service, port)`` so a
    fixture can target whichever host its ports are published on; ``label`` only
    shapes the skip message.
    """
    fixture = ComposeFixture()
    services = [service for _, service, _ in host_services_and_ports]
    ports = [(host, port) for host, _, port in host_services_and_ports]
    try:
        fixture.ensure(*services, ports=ports)
    except ContainerRuntimeUnavailable as exc:
        pytest.skip(f"{label} container fixtures unavailable: {exc}")
    return fixture


def _ensure_ssh_services(services_and_ports):
    """Bring up SSH services on :data:`SSH_HOST`, skipping when no runtime exists."""
    return _ensure_services(
        [(SSH_HOST, service, port) for service, port in services_and_ports],
        label="SSH",
    )


@pytest.fixture(scope="session")
def ssh_fixtures():
    """Password- and key-auth SSH containers (ports 2201 / 2203)."""
    return _ensure_ssh_services(
        [(SSH_PASSWORD_SERVICE, SSH_PASSWORD_PORT), (SSH_KEYS_SERVICE, SSH_KEYS_PORT)]
    )


@pytest.fixture(scope="session")
def ssh_password_fixtures():
    """Password-auth SSH container only (port 2201).

    ``ssh_fixtures`` also brings up ``ssh-keys``; suites that never authenticate
    with a key should ask for this instead, so they neither wait for that image
    to build nor skip when only *it* fails to.
    """
    return _ensure_ssh_services([(SSH_PASSWORD_SERVICE, SSH_PASSWORD_PORT)])


@pytest.fixture(scope="session")
def ssh_x11_fixtures():
    """X11-forwarding SSH container (port 2208).

    The image ships ``X11Forwarding yes`` plus ``xauth`` and ``x11-apps`` /
    ``xdpyinfo`` (see ``tests/docker/ssh-x11/Dockerfile``), so a connection with
    X11 forwarding enabled gets a server-allocated ``$DISPLAY``. This lets the
    guided-manual X11 test auto-assert the forwarded display instead of leaving
    the whole check to the operator (#957).
    """
    return _ensure_ssh_services([(SSH_X11_SERVICE, SSH_X11_PORT)])


@pytest.fixture(scope="session")
def ssh_banner_fixtures():
    """Pre-auth-banner / MOTD SSH container (port 2206)."""
    return _ensure_ssh_services([(SSH_BANNER_SERVICE, SSH_BANNER_PORT)])


@pytest.fixture(scope="session")
def ssh_tunnel_fixtures():
    """Tunnel-target SSH container with internal HTTP (port 2207)."""
    return _ensure_ssh_services([(SSH_TUNNEL_SERVICE, SSH_TUNNEL_PORT)])


@pytest.fixture(scope="session")
def telnet_fixtures():
    """Telnet container (in.telnetd via xinetd, published on port 2301)."""
    return _ensure_services(
        [(TELNET_HOST, TELNET_SERVICE, TELNET_PORT)], label="telnet"
    )


@pytest.fixture(scope="session")
def remote_agent_fixtures():
    """Deployed-agent SSH container (compose profile ``agent``, port 2211).

    Unlike ``ssh_fixtures``, this bakes a freshly-built ``termihub-agent`` binary
    into the image, so a live connect finds the agent already installed (#995).
    Stages the per-arch static-musl binary into the build context, then builds and
    brings up the ``remote-agent`` service. Skips the suite cleanly when no
    container runtime is reachable *or* the agent cross-build is unavailable — the
    same contract as the other container fixtures, so hosts without the cross
    toolchain (or without Docker) stay green.
    """
    try:
        stage_remote_agent_binary()
        fixture = ComposeFixture()
        fixture.ensure(
            REMOTE_AGENT_SERVICE, ports=[(SSH_HOST, REMOTE_AGENT_PORT)], build=True
        )
    except ContainerRuntimeUnavailable as exc:
        pytest.skip(f"deployed-agent container fixture unavailable: {exc}")
    return fixture


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """On an integration test *failure*, write a failure-artifact bundle.

    Snapshots the live app state (store + terminal buffer) and the captured app
    log into ``tests/system/artifacts/<nodeid>/`` so a failure is diagnosable
    after teardown — essential for CI / headless agent runs where no one watched
    the window. A no-op for passing tests and for non-integration tests (which
    have no app/driver to capture). Capture itself never raises (see
    :func:`write_failure_artifacts`), so it cannot mask the real failure.
    """
    outcome = yield
    report = outcome.get_result()
    if report.when != "call" or not report.failed:
        return
    instance = getattr(item, "instance", None)
    if instance is None:
        return  # function-style tests manage their own driver/app locally
    driver = getattr(instance, "driver", None)
    app = getattr(instance, "app", None)
    if driver is None and app is None:
        return  # not an integration suite — nothing app-side to capture
    dest = write_failure_artifacts(
        ARTIFACT_ROOT / sanitize_nodeid(item.nodeid), driver, app
    )
    print(f"\n[artifacts] wrote failure bundle to {dest}")

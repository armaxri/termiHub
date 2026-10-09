"""Shared pytest fixtures and CLI options for the system-test harness."""

import datetime
import os
import sys

import pytest

from termihub_harness import hang_guard, skip_guard, timing
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
    RDP_HELPER_ENV,
    RDP_HOST,
    RDP_NLA_PORT,
    RDP_PORT,
    RDP_SERVICE,
    REMOTE_AGENT_KBDINT_PORT,
    REMOTE_AGENT_KBDINT_SERVICE,
    REMOTE_AGENT_PENDING_PORT,
    REMOTE_AGENT_PENDING_SERVICE,
    REMOTE_AGENT_PORT,
    REMOTE_AGENT_SERVICE,
    REMOTE_AGENT_UPDATE_SWAP_CONTAINER_SUFFIX,
    REMOTE_AGENT_UPDATE_SWAP_PORT,
    REMOTE_AGENT_UPDATE_SWAP_SERVICE,
    SSH_BANNER_PORT,
    SSH_BANNER_SERVICE,
    SSH_BASTION_PORT,
    SSH_BASTION_SERVICE,
    SSH_HOST,
    SSH_JUMP_TARGET_SERVICE,
    SSH_KEYS_PORT,
    SSH_KEYS_SERVICE,
    SSH_MFA_PORT,
    SSH_MFA_SERVICE,
    SSH_PASSWORD_PORT,
    SSH_PASSWORD_SERVICE,
    SSH_NOSUDO_PORT,
    SSH_NOSUDO_SERVICE,
    SSH_SUDO_PORT,
    SSH_SUDO_SERVICE,
    SSH_TUNNEL_PORT,
    SSH_TUNNEL_SERVICE,
    SSH_X11_PORT,
    SSH_X11_SERVICE,
    TELNET_HOST,
    TELNET_PORT,
    TELNET_SERVICE,
    VNC_HOST,
    VNC_PORT,
    VNC_SERVICE,
    VNC_VENCRYPT_PORT,
    VNC_VENCRYPT_SERVICE,
    AgentInstance,
    AppInstance,
    Bridge,
    ComposeFixture,
    ContainerControl,
    ContainerRuntimeUnavailable,
    SerialEchoPair,
    SerialEchoUnavailable,
    require_test_bridge_build,
    find_rdp_helper,
    stage_remote_agent_binary,
    wait_for_banner,
    wait_for_rdp,
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
    _SESSION_CONFIG["config"] = config
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


# ── Hang guard (#4017) ───────────────────────────────────────────────────────
# A blocking call with no timeout froze the macOS lane on 2026-10-06 until the
# job ceiling cancelled it. On xdist workers each test phase now runs under a
# faulthandler watchdog: an overrun dumps all stacks, the running processes and
# the app's failure bundle into the artifacts dir and exits the worker, so xdist
# reports the hung test and the lane carries on. The nightly runs every lane
# under xdist (the serial ones with ``-n 1``) so all of them are guarded (#4315).
# See termihub_harness/hang_guard.py.

#: Bridge-probe timeout for the hang diagnostics — three probes must fit in
#: hang_guard.ON_HANG_BUDGET, and a hung webview will not answer late anyway.
_HANG_PROBE_TIMEOUT = 20.0
_HANG_LOG_TAIL_LINES = 80


def _hang_diagnostics(item):
    """Capture the hung test's app state for the hang dump (runs off-thread)."""
    instance = getattr(item, "instance", None)
    driver = getattr(instance, "driver", None)
    app = getattr(instance, "app", None) or getattr(item, "funcargs", {}).get("app")
    if driver is None and app is None:
        return "no app or driver attached to this test"
    dest = ARTIFACT_ROOT / sanitize_nodeid(item.nodeid) / "hang"
    write_failure_artifacts(dest, driver, app, probe_timeout=_HANG_PROBE_TIMEOUT)
    lines = [f"failure bundle (state, terminal, screenshot, app log): {dest}"]
    if app is not None:
        try:
            tail = app.read_log().splitlines()[-_HANG_LOG_TAIL_LINES:]
        except Exception as exc:  # noqa: BLE001 - diagnostics must never raise
            tail = [f"<app log unreadable: {exc!r}>"]
        lines.append(f"--- app log tail (last {_HANG_LOG_TAIL_LINES} lines) ---")
        lines.extend(tail)
    return "\n".join(lines)


def _guarded_phase(phase, item):
    if not hang_guard.enabled():
        yield
        return
    hang_guard.arm(
        phase, ARTIFACT_ROOT, nodeid=item.nodeid, on_hang=lambda: _hang_diagnostics(item)
    )
    try:
        yield
    finally:
        hang_guard.disarm()


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_setup(item):
    yield from _guarded_phase("setup", item)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item):
    yield from _guarded_phase("call", item)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_teardown(item, nextitem):
    yield from _guarded_phase("teardown", item)


# ── Skip report + skip guard (#4315) ─────────────────────────────────────────
# A skip is green, so a lane whose fixtures never came up looks healthy. Every
# run lists its skips and reasons in the terminal summary (and the GitHub step
# summary when the guard is on); a nightly lane that names itself in
# TERMIHUB_SKIP_GUARD_LANE fails on a skip its committed allowlist
# (skip-allowlist.json) does not expect, on more skips than its baseline, and
# when it ran nothing. Under xdist the controller sees every worker's reports,
# so this runs there only. See termihub_harness/skip_guard.py.
#: The running session's config, for the report hooks (which receive none).
_SESSION_CONFIG = {}


class _SkipRecorder:
    def __init__(self):
        self.skips = {}
        self.collected = set()
        self.ran = set()
        self.verdict = None

    def add_test_report(self, report):
        if report.when == "setup":
            self.collected.add(report.nodeid)
        if report.skipped and not hasattr(report, "wasxfail"):
            reason = skip_guard.skip_reason(report.longrepr)
            self.skips[report.nodeid] = skip_guard.Skip(report.nodeid, reason)
        elif report.when == "call":
            self.ran.add(report.nodeid)


def _skip_recorder(config):
    recorder = getattr(config, "_termihub_skips", None)
    if recorder is None:
        recorder = config._termihub_skips = _SkipRecorder()
    return recorder


def pytest_runtest_logreport(report):
    config = _SESSION_CONFIG.get("config")
    if config is not None and not hasattr(config, "workerinput"):
        _skip_recorder(config).add_test_report(report)


def pytest_collectreport(report):
    config = _SESSION_CONFIG.get("config")
    if config is None or hasattr(config, "workerinput") or not report.skipped:
        return
    reason = skip_guard.skip_reason(report.longrepr)
    _skip_recorder(config).skips[report.nodeid] = skip_guard.Skip(report.nodeid, reason)


def _enforce_skip_guard(session):
    """Controller only: evaluate the lane's skips and red the run on a problem."""
    config = session.config
    lane = skip_guard.lane_from_env()
    if lane is None or hasattr(config, "workerinput"):
        return
    recorder = _skip_recorder(config)
    verdict = skip_guard.evaluate(
        lane,
        collected=len(recorder.collected),
        skips=list(recorder.skips.values()),
        allowlist=skip_guard.load_allowlist(),
        require_fixtures=skip_guard.require_fixtures(),
    )
    recorder.verdict = verdict
    if not verdict.ok and session.exitstatus == pytest.ExitCode.OK:
        session.exitstatus = pytest.ExitCode.TESTS_FAILED


def _report_skips(terminalreporter, config):
    recorder = getattr(config, "_termihub_skips", None)
    if recorder is None or (not recorder.skips and recorder.verdict is None):
        return
    skips = sorted(recorder.skips.values(), key=lambda skip: skip.nodeid)
    lines = skip_guard.format_summary(
        skips,
        fully_skipped=skip_guard.fully_skipped_modules(skips, recorder.ran),
        verdict=recorder.verdict,
    )
    terminalreporter.section("termihub skipped tests (#4315)")
    for line in lines:
        terminalreporter.write_line(line)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary and recorder.verdict is not None:
        try:
            with open(summary, "a", encoding="utf-8") as fh:
                fh.write(f"## Skipped tests ({recorder.verdict.lane})\n\n```\n")
                fh.write("\n".join(lines) + "\n```\n\n")
        except OSError:
            pass


# ── Per-operation timing summary (#3660) ─────────────────────────────────────
_TIMING_KEY = "termihub_timing"


@pytest.hookimpl(optionalhook=True)
def pytest_testnodedown(node, error):
    """xdist controller: fold a finished worker's timing samples into this process."""
    samples = getattr(node, "workeroutput", {}).get(_TIMING_KEY)
    if samples:
        timing.merge(samples)


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    """Print one ``[termihub-test-timing]`` line per operation (CI, or opted in).

    ``scripts/system-test-timing.py`` aggregates these across runs to size the
    per-operation deadlines in ``termihub_harness/deadlines.py``.
    """
    if hasattr(config, "workerinput"):
        return
    _report_skips(terminalreporter, config)
    if not timing.enabled():
        return
    lines = timing.format_lines(timing.summarize(timing.os_name()))
    if not lines:
        return
    terminalreporter.section("termihub per-operation timing")
    for line in lines:
        terminalreporter.write_line(line)


def pytest_sessionfinish(session, exitstatus):
    """Enforce the skip guard; hand timing samples to the xdist controller;
    flush the guided-manual report."""
    hang_guard.close()
    _enforce_skip_guard(session)
    config = session.config
    if hasattr(config, "workeroutput"):
        config.workeroutput[_TIMING_KEY] = timing.snapshot()
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
    # A bridgeless build must fail loudly here, not time out 30s later (#3664).
    require_test_bridge_build(instance.binary)
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
def ssh_bastion_fixtures():
    """Jump-host bastion (port 2204) plus its internal target (no host port).

    The target lives only on the isolated ``jumphost-net``, so readiness is
    probed on the bastion's port alone; a connect through the bastion proves the
    target is up (MT-SSH-44, #3688).
    """
    fixture = ComposeFixture()
    try:
        fixture.ensure(
            SSH_BASTION_SERVICE,
            SSH_JUMP_TARGET_SERVICE,
            ports=[(SSH_HOST, SSH_BASTION_PORT)],
        )
    except ContainerRuntimeUnavailable as exc:
        pytest.skip(f"SSH jump-host container fixtures unavailable: {exc}")
    return fixture


@pytest.fixture(scope="session")
def ssh_tunnel_fixtures():
    """Tunnel-target SSH container with internal HTTP (port 2207)."""
    return _ensure_ssh_services([(SSH_TUNNEL_SERVICE, SSH_TUNNEL_PORT)])


@pytest.fixture(scope="session")
def ssh_mfa_fixtures():
    """Two-factor SSH container (port 2216) plus the key-auth ``ssh-keys`` (2203).

    ``ssh-mfa`` asks a keyboard-interactive one-time code after a password or key
    (#3384), driving the in-app SSH Authentication dialog (#3371). ``ssh-keys`` is
    the jump-host *target* the ProxyJump test reaches through it — by its compose
    service name on the shared ``test-net``.
    """
    return _ensure_ssh_services(
        [(SSH_MFA_SERVICE, SSH_MFA_PORT), (SSH_KEYS_SERVICE, SSH_KEYS_PORT)]
    )


@pytest.fixture(scope="session")
def ssh_permission_fixtures():
    """The editor-permission SSH containers: ``ssh-sudo`` (2212, a
    password-required sudoer) and ``ssh-nosudo`` (2213, a shell but no
    ``sudo``). Both ship the root-owned ``/etc/termihub-elevated-target.txt``.
    """
    return _ensure_ssh_services(
        [
            (SSH_SUDO_SERVICE, SSH_SUDO_PORT),
            (SSH_NOSUDO_SERVICE, SSH_NOSUDO_PORT),
        ]
    )


@pytest.fixture(scope="session")
def telnet_fixtures():
    """Telnet container (in.telnetd via xinetd, published on port 2301)."""
    return _ensure_services(
        [(TELNET_HOST, TELNET_SERVICE, TELNET_PORT)], label="telnet"
    )


def _ensure_vnc_service(service, port):
    """Bring up one ``vnc``-profile server and wait for its RFB greeting.

    Naming the service activates its compose profile, so this works in the
    nightly Linux lane even though that lane's bulk bring-up starts only the
    profile-less fixtures. The published port answers as soon as the container
    runs, before the server inside listens, so readiness is the server's own
    ``RFB 003.00x`` greeting rather than a bare TCP connect. Skips cleanly when
    no container runtime is reachable (the macOS/Windows CI legs).
    """
    fixture = _ensure_services([(VNC_HOST, service, port)], label="VNC")
    try:
        wait_for_banner(VNC_HOST, port, b"RFB ", timeout=90.0)
    except ContainerRuntimeUnavailable as exc:
        pytest.skip(f"VNC container fixture unavailable: {exc}")
    return fixture


@pytest.fixture(scope="session")
def vnc_fixtures():
    """Classic-VncAuth VNC server (x11vnc + Xvfb, profile ``vnc``, port 2501)."""
    return _ensure_vnc_service(VNC_SERVICE, VNC_PORT)


@pytest.fixture(scope="session")
def vnc_vencrypt_fixtures():
    """VeNCrypt X509 VNC server (TigerVNC Xvnc, profile ``vnc``, port 2502).

    The one fixture that honours client ``SetDesktopSize`` requests, so a
    dynamic-resolution session's remote desktop really follows the tab.
    """
    return _ensure_vnc_service(VNC_VENCRYPT_SERVICE, VNC_VENCRYPT_PORT)


@pytest.fixture(scope="session")
def rdp_fixtures():
    """xrdp (TLS, port 2601) + FreeRDP shadow (NLA, port 2602), profile ``rdp``.

    RDP decodes through the separately built ``termihub-rdp-helper`` sidecar,
    which a harness-built app has no copy of next to its executable. So this
    points the app at the sidecar via ``$TERMIHUB_RDP_HELPER`` (inherited by
    every app the harness launches afterwards) and skips the suite when none is
    built — build it with ``./scripts/build-rdp-sidecar.sh`` (the nightly Linux
    lane does, via ``scripts/internal/build-system-test-app.sh``). Readiness is
    an answered X.224 Connection Request on each port, not a bare TCP connect.
    """
    helper = find_rdp_helper()
    if helper is None:
        message = (
            "RDP sidecar not built: run ./scripts/build-rdp-sidecar.sh "
            f"or set {RDP_HELPER_ENV}"
        )
        # The Linux nightly builds the sidecar (build-system-test-app.sh), so a
        # missing one there is a build gap, not an environment gap (#4315).
        # Keyed on the lane's TERMIHUB_REQUIRE_FIXTURES opt-in rather than on
        # CI alone: the scheduled nightly runs main's copy of the workflow,
        # which lags develop's, and must not red before its copy installs
        # libasound2-dev.
        if sys.platform.startswith("linux") and skip_guard.require_fixtures():
            pytest.fail(f"{message} ({skip_guard.REQUIRE_FIXTURES_ENV}=1, #4315)")
        pytest.skip(message)
    os.environ[RDP_HELPER_ENV] = str(helper)
    fixture = ComposeFixture()
    try:
        # build=True: the session's input probe lives in the image (startwm.sh),
        # so a stale local image without it must be rebuilt (cached layers make
        # this cheap when nothing changed).
        fixture.ensure(
            RDP_SERVICE,
            ports=[(RDP_HOST, RDP_PORT), (RDP_HOST, RDP_NLA_PORT)],
            build=True,
        )
        wait_for_rdp(RDP_HOST, RDP_PORT, timeout=90.0)
        wait_for_rdp(RDP_HOST, RDP_NLA_PORT, timeout=90.0)
    except ContainerRuntimeUnavailable as exc:
        pytest.skip(f"RDP container fixture unavailable: {exc}")
    return fixture


@pytest.fixture
def serial_echo_pair():
    """A host ``socat`` PTY pair with an echo loop on one end (#3682).

    Yields a started :class:`~termihub_harness.SerialEchoPair`: point the app at
    ``pair.app_port`` and every byte it sends is echoed back. Function-scoped
    because a test may kill ``socat`` (``pair.kill_socat()``) to simulate the
    device vanishing. Teardown stops only the processes this fixture started.
    Skips cleanly where ``socat`` is unavailable (Windows, or not installed).
    """
    pair = SerialEchoPair()
    try:
        pair.start()
    except SerialEchoUnavailable as exc:
        pytest.skip(f"virtual serial fixture unavailable: {exc}")
    try:
        yield pair
    finally:
        pair.stop()


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


@pytest.fixture(scope="session")
def remote_agent_pending_fixtures():
    """Armed deployed-agent container (compose profile ``agent``, port 2214).

    Same image as ``remote-agent`` but built with ``PENDING_UPDATE_VERSION`` set,
    so every agent it launches stages a ``pending_update`` and announces it on
    attach (the #1546 env hook, delivered via sshd's per-user environment). This
    is the only way to drive the deferred-update banner's "Apply Now →
    deferred/busy" path against a live agent (#1520). Reuses the shared agent
    binary staging, and skips cleanly on the same contract as
    :func:`remote_agent_fixtures`.
    """
    try:
        stage_remote_agent_binary()
        fixture = ComposeFixture()
        fixture.ensure(
            REMOTE_AGENT_PENDING_SERVICE,
            ports=[(SSH_HOST, REMOTE_AGENT_PENDING_PORT)],
            build=True,
        )
    except ContainerRuntimeUnavailable as exc:
        pytest.skip(f"armed deployed-agent container fixture unavailable: {exc}")
    return fixture


@pytest.fixture
def remote_agent_update_swap_fixtures():
    """Armed agent container that can REALLY apply its staged update (port 2218).

    The ``update-swap`` build target of the ``remote-agent`` image (#4083): the
    hook stages a distinguishable copy of the agent signed with the committed
    TEST-ONLY key, with its digest, so the apply passes the production AGT-004 /
    AGT-005 gates and swaps the installed binary for real. A run mutates the
    container, so it is force-recreated from the image — per *test attempt*, not
    per session (#4092): the lane re-runs a failed test (``--reruns``), and a
    session-scoped container stays swapped after the first attempt, so every
    rerun failed up front on "the staged update must differ from the installed
    agent" and masked the first attempt's real failure. The image build is
    cached, so the recreate costs only a container restart. Returns a
    :class:`ContainerControl` for server-side evidence (installed binary digest,
    ``state.json``). Skips cleanly on the same contract as
    :func:`remote_agent_fixtures`.
    """
    try:
        stage_remote_agent_binary()
        ComposeFixture().ensure(
            REMOTE_AGENT_UPDATE_SWAP_SERVICE,
            ports=[(SSH_HOST, REMOTE_AGENT_UPDATE_SWAP_PORT)],
            build=True,
            force_recreate=True,
        )
    except ContainerRuntimeUnavailable as exc:
        pytest.skip(f"real-swap deployed-agent container fixture unavailable: {exc}")
    return ContainerControl(REMOTE_AGENT_UPDATE_SWAP_CONTAINER_SUFFIX)


@pytest.fixture(scope="session")
def remote_agent_kbdint_fixtures():
    """Deployed-agent container behind a keyboard-interactive-only sshd (port 2217).

    Same image as ``remote-agent`` built with ``KBDINT_ONLY``: PAM asks the
    password as a keyboard-interactive prompt, so an agent whose auth method is
    "Keyboard-Interactive" connects only once the in-app dialog is answered
    (#3377 / #4005). Reuses the shared agent binary staging, and skips cleanly on
    the same contract as :func:`remote_agent_fixtures`.
    """
    try:
        stage_remote_agent_binary()
        fixture = ComposeFixture()
        fixture.ensure(
            REMOTE_AGENT_KBDINT_SERVICE,
            ports=[(SSH_HOST, REMOTE_AGENT_KBDINT_PORT)],
            build=True,
        )
    except ContainerRuntimeUnavailable as exc:
        pytest.skip(f"keyboard-interactive deployed-agent fixture unavailable: {exc}")
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

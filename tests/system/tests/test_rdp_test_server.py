"""Unit tests for the scripted RDP server wrapper (#5175).

:mod:`termihub_harness.rdp_test_server` drives ``rdp-sidecar``'s
``rdp_test_server`` example. Its stdout protocol, binary lookup and process
lifecycle are exercised here against a small Python stand-in that speaks the
same protocol, so these run in the normal (non-integration) lane on every OS
with nothing built.
"""

from __future__ import annotations

import sys
import textwrap
import time
from pathlib import Path

import pytest

from termihub_harness.rdp_test_server import (
    RDP_TEST_SERVER_NAME,
    RdpTestServer,
    RdpTestServerUnavailable,
    ServerEvent,
    find_rdp_test_server,
    parse_line,
)


@pytest.mark.parametrize(
    ("line", "event"),
    [
        ("listening 4242\n", ServerEvent("listening", 4242)),
        ("dial #3", ServerEvent("dial", 3)),
        ("client-info #2 alice", ServerEvent("client-info", 2, "alice")),
        ("client-info #2 CORP alice", ServerEvent("client-info", 2, "CORP alice")),
        ("listening", None),
        ("listening abc", None),
        ("dial 3", None),
        ("dial #x", None),
        ("rdp_test_server: cannot listen", None),
        ("", None),
    ],
)
def test_parse_line(line: str, event):
    assert parse_line(line) == event


def test_find_prefers_the_debug_build(tmp_path: Path):
    assert find_rdp_test_server(tmp_path) is None
    release = tmp_path / "rdp-sidecar" / "target" / "release" / "examples"
    release.mkdir(parents=True)
    (release / RDP_TEST_SERVER_NAME).write_bytes(b"")
    assert find_rdp_test_server(tmp_path) == release / RDP_TEST_SERVER_NAME
    debug = tmp_path / "rdp-sidecar" / "target" / "debug" / "examples"
    debug.mkdir(parents=True)
    (debug / RDP_TEST_SERVER_NAME).write_bytes(b"")
    assert find_rdp_test_server(tmp_path) == debug / RDP_TEST_SERVER_NAME


def test_for_binary_builds_the_command_and_rejects_unknown_acts(tmp_path: Path):
    server = RdpTestServer.for_binary(tmp_path / "srv", act="hangup")
    assert server._command == [str(tmp_path / "srv"), "--bind", "127.0.0.1:0", "--act", "hangup"]
    with pytest.raises(ValueError):
        RdpTestServer.for_binary(tmp_path / "srv", act="redirect")


#: A stand-in speaking the example's stdout protocol: it reports a port and two
#: connections, then (like the real server) runs until its stdin closes.
_STAND_IN = textwrap.dedent(
    """
    import sys
    print("listening 4242", flush=True)
    print("dial #1", flush=True)
    print("dial #2", flush=True)
    print("client-info #2 alice", flush=True)
    sys.stdin.read()
    print("bye", flush=True)
    """
)


def _wait(predicate, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.02)


def test_lifecycle_reports_port_dials_and_client_infos():
    server = RdpTestServer([sys.executable, "-c", _STAND_IN])
    with pytest.raises(RdpTestServerUnavailable):
        server.port  # not started yet
    with server:
        assert server.port == 4242
        _wait(lambda: server.client_infos() == ["alice"])
        assert server.dials() == 2
        process = server._process
    # Leaving the block closed stdin: the stand-in ran to its end and exited.
    assert process is not None and process.returncode == 0
    assert server.output()[-1] == "bye"
    server.stop()  # idempotent


def test_start_fails_when_the_server_never_reports_a_port():
    server = RdpTestServer([sys.executable, "-c", "print('cannot listen', flush=True)"])
    with pytest.raises(RdpTestServerUnavailable, match="cannot listen"):
        server.start(timeout=10.0)


def test_start_fails_for_a_missing_binary(tmp_path: Path):
    server = RdpTestServer.for_binary(tmp_path / "missing")
    with pytest.raises(RdpTestServerUnavailable, match="cannot start"):
        server.start()

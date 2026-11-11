"""Machinery tests for the egress probe (#5388, TST-005).

Classification, diffing, allowlist matching and the modes are pure, so they run
against fakes here. One end-to-end check runs a throwaway pytest session in a
subprocess to prove the conftest wiring fails (or only annotates) a test whose
"app" (the session's own process) connects a socket to a non-fixture address.
The socket is UDP to a documentation address (RFC 5737): ``connect`` only sets
the peer, so nothing leaves the machine.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import textwrap
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from termihub_harness import egress as eg

# ── mode ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "value, mode",
    [("", "annotate"), ("fail", "fail"), (" FAIL ", "fail"), ("off", "off")],
)
def test_gate_mode_reads_the_env_and_defaults_to_annotate(value, mode):
    assert eg.gate_mode({eg.GATE_ENV: value}) == mode
    assert eg.gate_mode({}) == "annotate"


def test_gate_mode_rejects_an_unknown_value():
    with pytest.raises(eg.GateConfigError, match="TERMIHUB_EGRESS_GATE"):
        eg.gate_mode({eg.GATE_ENV: "strict"})


# ── fixture allowlist ────────────────────────────────────────────────────────

_GITHUB = eg.Endpoint("140.82.121.6", 443)
_DOC = eg.Endpoint("192.0.2.1", 9)


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",  # native sshd, local_http, the bridge
        "10.231.1.3",  # a traceroute fixture subnet
        "172.18.0.5",  # a Docker bridge network
        "192.168.65.2",  # Docker Desktop's VM
        "100.64.0.1",  # carrier-grade NAT (VM networking)
        "169.254.1.1",
        "::1",
        "fd00::1",
        "fe80::1%en0",
        "::ffff:127.0.0.1",
    ],
)
def test_fixture_destinations_are_never_egress(ip):
    assert eg.is_fixture(eg.Endpoint(ip, 22))


@pytest.mark.parametrize("ip", ["140.82.121.6", "8.8.8.8", "2606:4700::1111", "not-an-ip"])
def test_internet_destinations_are_egress(ip):
    assert not eg.is_fixture(eg.Endpoint(ip, 443))


def test_extra_allow_takes_cidrs_and_ip_ports():
    extra = eg.parse_extra_allow(" 140.82.0.0/16 , 8.8.8.8:53,[2606:4700::1111]:443,, ")
    assert eg.is_fixture(_GITHUB, extra)
    assert eg.is_fixture(eg.Endpoint("8.8.8.8", 53), extra)
    assert not eg.is_fixture(eg.Endpoint("8.8.8.8", 443), extra)
    assert eg.is_fixture(eg.Endpoint("2606:4700::1111", 443), extra)
    assert not eg.is_fixture(eg.Endpoint("2606:4700::1111", 80), extra)
    assert eg.parse_extra_allow("") == []
    with pytest.raises(eg.GateConfigError, match="TERMIHUB_EGRESS_ALLOW"):
        eg.parse_extra_allow("api.github.com")


def test_endpoint_key_brackets_ipv6():
    assert _GITHUB.key == "140.82.121.6:443"
    assert eg.Endpoint("::1", 22).key == "[::1]:22"


# ── diffing ──────────────────────────────────────────────────────────────────


def test_new_endpoints_drops_what_was_connected_at_the_start():
    ssh = eg.Endpoint("127.0.0.1", 2222)
    assert eg.new_endpoints({ssh}, {ssh, _GITHUB, _DOC}) == [_GITHUB, _DOC]
    assert eg.new_endpoints({ssh, _GITHUB}, {ssh, _GITHUB}) == []
    assert eg.new_endpoints(set(), set()) == []


class FakeSockets:
    """A lister whose answer the test changes between samples."""

    def __init__(self) -> None:
        self.now: set[eg.Endpoint] = set()
        self.pids: list = []

    def __call__(self, pid):
        self.pids.append(pid)
        return set(self.now) if pid is not None else set()


def test_sampler_unions_samples_and_diffs_against_its_baseline():
    sockets = FakeSockets()
    held = eg.Endpoint("127.0.0.1", 2222)
    sockets.now = {held, _GITHUB}
    sampler = eg.Sampler(lambda: 42, lister=sockets, interval=0.01)
    sockets.now = {held, _DOC}
    time.sleep(0.1)
    sockets.now = {held}  # the _DOC connection closed before the test ended
    assert sampler.stop() == [_DOC]
    assert set(sockets.pids) == {42}


def test_sampler_survives_a_failing_lister():
    def broken(pid):
        raise RuntimeError("psutil denied")

    assert eg.Sampler(lambda: 1, lister=broken, interval=0.01).stop() == []


def test_connected_endpoints_of_no_or_a_gone_process_is_empty():
    assert eg.connected_endpoints(None) == set()
    assert eg.connected_endpoints(2**22 + 12345) == set()


def test_connected_endpoints_sees_a_connected_socket_of_this_process():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect(("192.0.2.1", 9))
        assert _DOC in eg.connected_endpoints(os.getpid())


def test_app_pid_reads_the_pid_property():
    assert eg.app_pid(SimpleNamespace(pid=7)) == 7
    assert eg.app_pid(SimpleNamespace(pid=None)) is None
    assert eg.app_pid(None) is None


# ── test allowlist ───────────────────────────────────────────────────────────

_ALLOW = [
    eg.AllowEntry("4961-x.json", 4961, "real index", nodeid=r"test_plugin_discovery_https\.py"),
    eg.AllowEntry("1-y.json", 1, "doc net", remote=r"^192\.0\.2\."),
]


def test_evaluate_drops_fixtures_and_splits_new_from_allowlisted():
    ssh = eg.Endpoint("127.0.0.1", 2222)
    verdict = eg.evaluate("tests/test_a.py::T::t", [ssh, _GITHUB, _DOC, _GITHUB], _ALLOW)
    assert verdict.new == [_GITHUB]
    assert [(e, a.issue) for e, a in verdict.allowed] == [(_DOC, 1)]
    https = eg.evaluate("tests/test_plugin_discovery_https.py::T::t", [_GITHUB], _ALLOW)
    assert https.new == [] and https.allowed[0][1].issue == 4961
    assert eg.evaluate("t", [ssh], _ALLOW).empty


@pytest.mark.parametrize(
    "raw, error",
    [
        ([], "JSON object"),
        ({"issue": 1, "reason": "r"}, "'nodeid' or 'remote'"),
        ({"nodeid": "x", "reason": "r"}, "'issue'"),
        ({"nodeid": "x", "issue": True, "reason": "r"}, "'issue'"),
        ({"nodeid": "x", "issue": 1}, "'reason'"),
        ({"nodeid": "(", "issue": 1, "reason": "r"}, "bad regex"),
        ({"remote": "", "issue": 1, "reason": "r"}, "must be a regex"),
        ({"nodeid": "x", "issue": 1, "reason": "r", "host": "y"}, "unknown key"),
    ],
)
def test_parse_fragment_rejects_bad_entries(raw, error):
    with pytest.raises(eg.GateConfigError, match=error):
        eg.parse_fragment("f.json", raw)


def test_committed_allowlist_loads_and_covers_the_https_suite():
    entries = eg.load_allowlist()
    assert any(
        e.matches(_GITHUB, "tests/test_plugin_discovery_https.py::T::test_x") for e in entries
    )
    assert not any(e.matches(_GITHUB, "tests/test_local_shell.py::T::test_x") for e in entries)


def test_load_allowlist_rejects_stray_files(tmp_path):
    (tmp_path / "notes.txt").write_text("x", encoding="utf-8")
    with pytest.raises(eg.GateConfigError, match="notes.txt"):
        eg.load_allowlist(tmp_path)
    assert eg.load_allowlist(tmp_path / "missing") == []


# ── modes ────────────────────────────────────────────────────────────────────


def _item(nodeid, app):
    return SimpleNamespace(nodeid=nodeid, instance=SimpleNamespace(driver=None, app=app), cls=None)


def _run(gate, sockets, endpoints, *, passed=True):
    item = _item("tests/test_x.py::T::test_a", SimpleNamespace(pid=99))
    gate.start(item)
    sockets.now = set(endpoints)
    time.sleep(0.05)
    outcome = "passed" if passed else "failed"
    report = SimpleNamespace(passed=passed, outcome=outcome, longrepr="original")
    gate.finish(item, report)
    return report


@pytest.mark.parametrize(
    "mode, endpoints, outcome, recorded",
    [
        ("fail", [_GITHUB], "failed", 1),
        ("fail", [_DOC], "passed", 1),  # allowlisted: reported, never failed
        ("fail", [eg.Endpoint("172.17.0.2", 22)], "passed", 0),
        ("annotate", [_GITHUB], "passed", 1),
        ("off", [_GITHUB], "passed", 0),
        ("fail", [], "passed", 0),
    ],
)
def test_gate_modes(mode, endpoints, outcome, recorded):
    sockets = FakeSockets()
    gate = eg.Gate(mode, _ALLOW, lister=sockets, interval=0.01)
    report = _run(gate, sockets, endpoints)
    assert report.outcome == outcome
    assert len(gate.records) == recorded
    if outcome == "failed":
        assert "Egress probe" in report.longrepr and "140.82.121.6:443" in report.longrepr


def test_fail_mode_does_not_rewrite_an_already_failed_test():
    sockets = FakeSockets()
    gate = eg.Gate("fail", [], lister=sockets, interval=0.01)
    report = _run(gate, sockets, [_GITHUB], passed=False)
    assert report.longrepr == "original" and gate.records


def test_abandon_stops_a_sampler_whose_test_never_ran():
    gate = eg.Gate("fail", [], lister=FakeSockets(), interval=0.01)
    item = _item("t::setup_failed", None)
    gate.start(item)
    gate.abandon(item)
    gate.abandon(item)  # idempotent; and finish has nothing left to judge
    gate.finish(item, SimpleNamespace(passed=True, outcome="passed", longrepr=None))
    assert gate.records == []


def test_gate_from_env_reads_the_extra_allowlist():
    gate = eg.Gate.from_env({eg.GATE_ENV: "fail", eg.ALLOW_ENV: "140.82.0.0/16"})
    assert gate.mode == "fail" and eg.is_fixture(_GITHUB, gate.extra)
    assert eg.Gate.from_env({eg.GATE_ENV: "off"}).allowlist == []


# ── reporting ────────────────────────────────────────────────────────────────


def test_summary_lists_each_destination_once_with_its_tests(tmp_path):
    records = [
        eg.evaluate("t::a", [_GITHUB, _DOC], _ALLOW).to_json(),
        eg.evaluate("t::b", [_GITHUB], _ALLOW).to_json(),
    ]
    lines = eg.format_summary(records, "annotate")
    assert lines[0] == "mode=annotate: 2 non-fixture destination(s) in 2 test(s); 1 not allowlisted"
    assert lines[1] == "[NEW] 140.82.121.6:443  (2 test(s))"
    assert lines[2:4] == ["    t::a", "    t::b"]
    assert lines[4] == "[allowlisted #1] 192.0.2.1:9  (1 test(s))"
    assert eg.format_summary([], "annotate") == []

    path = eg.write_report(eg.report_path(tmp_path, "bulk linux"), records, "annotate")
    assert path == tmp_path / "egress" / "bulk_linux.json"
    data = json.loads(path.read_text("utf-8"))
    assert data["mode"] == "annotate" and len(data["tests"]) == 2
    assert eg.report_path(tmp_path, None).name == "local.json"


# ── end to end through conftest.py ───────────────────────────────────────────


@pytest.mark.parametrize(
    "mode, expected_rc, summary",
    [("fail", 1, True), ("annotate", 0, True), ("off", 0, False)],
)
def test_the_conftest_hook_probes_a_test_whose_app_connects_out(
    tmp_path, mode, expected_rc, summary
):
    """A real pytest session with this conftest: a test whose (fake) app is the
    session's own process connects a socket to a documentation address. It fails
    only in ``fail`` mode, and is reported unless the probe is off."""
    harness_root = Path(eg.__file__).resolve().parents[1]
    test_file = tmp_path / "test_probed.py"
    test_file.write_text(
        textwrap.dedent("""
            import os
            import socket
            import time
            from types import SimpleNamespace

            class TestSuite:
                app = SimpleNamespace(
                    pid=os.getpid(), log_path=os.devnull, read_log=lambda: ""
                )
                driver = None
                sock = None

                def test_clean(self):
                    pass

                def test_connects_out(self):
                    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                    sock.connect(("192.0.2.77", 9))
                    TestSuite.sock = sock  # held open until the session ends
                    time.sleep(0.5)
            """),
        encoding="utf-8",
    )
    env = {**os.environ, eg.GATE_ENV: mode}
    for name in (
        "TERMIHUB_SKIP_GUARD_LANE",
        "GITHUB_STEP_SUMMARY",
        "PYTEST_XDIST_WORKER",
        eg.ALLOW_ENV,
    ):
        env.pop(name, None)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-p",
            "no:cacheprovider",
            "-p",
            "conftest",
            "--rootdir",
            str(harness_root),
            "-c",
            str(harness_root / "pyproject.toml"),
            str(test_file),
        ],
        cwd=harness_root,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    out = result.stdout + result.stderr
    assert result.returncode == expected_rc, out
    assert ("192.0.2.77:9" in out) is summary, out
    if mode == "fail":
        assert "1 failed, 1 passed" in out, out

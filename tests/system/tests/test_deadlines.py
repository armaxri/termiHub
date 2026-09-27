"""Unit tests for the per-operation deadlines and timing recorder (#3660, WA-CI-006).

Machinery group (no app): pure functions plus a ``FakeApp`` round trip, so these
run anywhere without a build.
"""

import json

import pytest

from termihub_harness import deadlines, timing
from termihub_harness.systemtest import SystemTest

from fake_app import FakeApp, dispatcher_like


@pytest.fixture(autouse=True)
def _clean_samples():
    timing.reset()
    yield
    timing.reset()


# ── Slow category: only a parallel macOS/Windows worker is "contended" ───────
@pytest.mark.parametrize(
    "platform,workers,expected",
    [
        ("darwin", 2, True),
        ("win32", 2, True),
        ("darwin", 1, False),  # serial display grades / local runs
        ("win32", 1, False),
        ("linux", 2, False),  # Linux passes at 1x even under xdist
        ("linux", 1, False),
    ],
)
def test_contended_is_scoped_to_parallel_macos_and_windows(platform, workers, expected):
    assert deadlines.contended(platform, workers) is expected


def test_contended_reads_the_xdist_worker_count(monkeypatch):
    monkeypatch.setenv("PYTEST_XDIST_WORKER_COUNT", "2")
    assert deadlines.contended("darwin") is True
    monkeypatch.delenv("PYTEST_XDIST_WORKER_COUNT")
    assert deadlines.contended("darwin") is False
    monkeypatch.setenv("PYTEST_XDIST_WORKER_COUNT", "junk")
    assert deadlines.contended("darwin") is False


# ── Local-only debugging override ────────────────────────────────────────────
@pytest.mark.parametrize(
    "value,expected",
    [
        (None, 1.0),
        ("1", 1.0),
        ("0.5", 0.5),  # fail a suspected hang faster
        ("3", 3.0),
        ("0", 1.0),  # non-positive never zeroes a budget
        ("-2", 1.0),
        ("nonsense", 1.0),
        ("", 1.0),
    ],
)
def test_debug_scale_parses_and_defends_defaults(value, expected):
    environ = {} if value is None else {"TERMIHUB_WAIT_SCALE": value}
    assert deadlines.debug_scale(environ) == expected


def test_debug_scale_is_ignored_in_ci():
    # The whole point of #3660: no CI lane can reintroduce a global multiplier.
    with pytest.warns(UserWarning, match="ignored in CI"):
        scale = deadlines.debug_scale({"TERMIHUB_WAIT_SCALE": "2", "GITHUB_ACTIONS": "true"})
    assert scale == 1.0


def test_budgets_apply_only_their_own_category(monkeypatch):
    monkeypatch.setattr(deadlines, "DEBUG_SCALE", 1.0)
    monkeypatch.setattr(deadlines, "UI_FACTOR", 1.0)
    assert deadlines.ui_budget(20.0) == 20.0
    assert deadlines.app_connect() == deadlines.APP_CONNECT
    # Contended worker: UI ops get the slow category, app-connect does not.
    monkeypatch.setattr(deadlines, "UI_FACTOR", deadlines.CONTENDED_UI_FACTOR)
    assert deadlines.ui_budget(20.0) == 20.0 * deadlines.CONTENDED_UI_FACTOR
    assert deadlines.app_connect() == deadlines.APP_CONNECT
    # The local override multiplies everything.
    monkeypatch.setattr(deadlines, "DEBUG_SCALE", 0.5)
    assert deadlines.app_connect() == deadlines.APP_CONNECT * 0.5


def test_deadlines_respect_the_headroom_rule():
    # Observed maxima behind the current values (see deadlines.py). A deadline
    # must never be tighter than HEADROOM x the slowest observation.
    observed_max = {"APP_CONNECT": 28.3}
    for name, seconds in observed_max.items():
        assert getattr(deadlines, name) >= deadlines.HEADROOM * seconds


# ── Timing recorder ──────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "what,expected",
    [
        ("the default user to persist", "wait:the default user to persist"),
        ("'mk-3f9a' in terminal output", "wait:'…' in terminal output"),
        ('connection "ssh 12"', 'wait:connection "…"'),
        ("the cursor to reach line 42", "wait:the cursor to reach line N"),
    ],
)
def test_wait_label_collapses_dynamic_parts(what, expected):
    assert timing.wait_label(what) == expected


def test_summarize_reports_percentiles_deadline_and_timeouts():
    for elapsed in [0.1] * 18 + [0.5, 2.0]:
        timing.record("command:click", elapsed, 10.0)
    timing.record("command:click", 20.0, 20.0, timed_out=True)
    (record,) = timing.summarize("macos")
    assert record == {
        "op": "command:click",
        "n": 21,
        "timeouts": 1,
        "deadline": 20.0,
        "p50": 0.1,
        "p95": 0.5,
        "max": 2.0,  # the expired sample is not a timing
        "os": "macos",
    }


def test_summarize_all_timeouts_has_no_percentiles():
    timing.record("app-connect", 60.0, 60.0, timed_out=True)
    (record,) = timing.summarize()
    assert record["max"] is None and record["timeouts"] == 1


def test_snapshot_merge_round_trip_is_json_safe():
    timing.record("wait:x", 0.3, 20.0)
    payload = json.loads(json.dumps(timing.snapshot()))  # what xdist ships
    timing.reset()
    timing.merge(payload)
    timing.merge(payload)
    (record,) = timing.summarize()
    assert record["n"] == 2


def test_format_lines_are_tagged_json():
    timing.record("wait:x", 0.3, 20.0)
    (line,) = timing.format_lines(timing.summarize("linux"))
    tag, payload = line.split(" ", 1)
    assert tag == "[termihub-test-timing]"
    assert json.loads(payload)["op"] == "wait:x"


@pytest.mark.parametrize(
    "environ,expected",
    [
        ({}, False),
        ({"TERMIHUB_TEST_TIMING": "1"}, True),
        ({"GITHUB_ACTIONS": "true"}, True),  # every CI run feeds the data
        ({"GITHUB_ACTIONS": "true", "TERMIHUB_TEST_TIMING": "0"}, False),
    ],
)
def test_timing_enabled(environ, expected):
    assert timing.enabled(environ) is expected


@pytest.mark.parametrize(
    "platform,expected",
    [("darwin", "macos"), ("win32", "windows"), ("linux", "linux")],
)
def test_os_name(platform, expected):
    assert timing.os_name(platform) == expected


# ── The chokepoints actually record ──────────────────────────────────────────
def test_bridge_round_trip_records_app_connect_and_commands(bridge):
    with FakeApp(bridge.port, dispatcher_like(state={"activePanelId": "p1"})):
        driver = bridge.wait_for_app(timeout=5)
        assert driver.get_state("activePanelId") == "p1"
    ops = {r["op"]: r for r in timing.summarize()}
    assert ops["app-connect"]["n"] == 1
    assert ops["command:getState"]["n"] == 1
    assert ops["command:getState"]["timeouts"] == 0


def test_systemtest_wait_records_success_and_timeout(monkeypatch):
    monkeypatch.setattr(deadlines, "UI_FACTOR", 1.0)
    monkeypatch.setattr(deadlines, "DEBUG_SCALE", 1.0)
    suite = SystemTest()
    assert suite.wait(lambda: True, timeout=1, what="the thing 7") is True
    with pytest.raises(AssertionError, match="timed out waiting for never"):
        suite.wait(lambda: False, timeout=0.05, interval=0.01, what="never")
    ops = {r["op"]: r for r in timing.summarize()}
    assert ops["wait:the thing N"]["timeouts"] == 0
    assert ops["wait:never"]["timeouts"] == 1
    assert ops["wait:never"]["deadline"] == 0.05

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
    monkeypatch.setattr(deadlines, "CONTENDED", False)
    assert deadlines.ui_budget(20.0, "wait:the shell prompt") == 20.0  # serial: no raise
    assert deadlines.app_connect() == deadlines.APP_CONNECT
    # Contended worker: a listed op gets its own deadline, app-connect does not.
    monkeypatch.setattr(deadlines, "CONTENDED", True)
    assert deadlines.ui_budget(20.0, "wait:the shell prompt") == 70.0
    assert deadlines.app_connect() == deadlines.APP_CONNECT
    # The local override multiplies everything.
    monkeypatch.setattr(deadlines, "DEBUG_SCALE", 0.5)
    assert deadlines.app_connect() == deadlines.APP_CONNECT * 0.5
    assert deadlines.ui_budget(20.0, "wait:the shell prompt") == 35.0


def test_contended_worker_drops_the_blanket_factor_for_measured_ops(monkeypatch):
    # #3663: an op whose contended max x HEADROOM fits its serial budget keeps it.
    monkeypatch.setattr(deadlines, "DEBUG_SCALE", 1.0)
    monkeypatch.setattr(deadlines, "CONTENDED", True)
    assert deadlines.ui_budget(10.0, "command:exists") == 10.0
    assert deadlines.ui_budget(20.0, "wait:a terminal with a shell prompt") == 20.0
    # A listed op never lowers a call site's larger serial budget.
    assert deadlines.ui_budget(60.0, "command:getState") == 60.0
    assert deadlines.ui_budget(10.0, "command:getState") == 20.0


def test_blanket_contended_factor_is_gone():
    # #4216: every webview-bound op is named, so no unnamed 2x fallback remains.
    assert not hasattr(deadlines, "CONTENDED_UI_FACTOR")
    assert not hasattr(deadlines, "UI_FACTOR")
    with pytest.raises(TypeError):
        deadlines.ui_budget(20.0)  # op is required


@pytest.mark.parametrize("op", [deadlines.FILE_ROW_OP, deadlines.HOST_KEY_PROMPT_OP])
def test_formerly_unmeasured_loops_keep_their_effective_budget(monkeypatch, op):
    # #4216: the file-row and host-key loops trade the 2x factor for a named,
    # provisional deadline equal to what the factor gave their 20 s default.
    monkeypatch.setattr(deadlines, "DEBUG_SCALE", 1.0)
    assert op in deadlines.CONTENDED_OP_DEADLINES
    assert deadlines.PROVISIONAL_CONTENDED_OP_DEADLINES[op] == 2 * deadlines.UI_WAIT
    monkeypatch.setattr(deadlines, "CONTENDED", False)
    assert deadlines.ui_budget(deadlines.UI_WAIT, op) == deadlines.UI_WAIT
    monkeypatch.setattr(deadlines, "CONTENDED", True)
    assert deadlines.ui_budget(deadlines.UI_WAIT, op) == 2 * deadlines.UI_WAIT
    assert deadlines.ui_budget(60.0, op) == 60.0  # never lowers a larger call-site budget


def test_contended_op_names_are_timing_op_names():
    # Keys must match what the harness records, or the lookup silently misses.
    for op in deadlines.CONTENDED_OP_DEADLINES:
        kind, _, label = op.partition(":")
        assert kind in ("wait", "command"), op
        if kind == "wait":
            assert timing.wait_label(label) == op, op


# Slowest completed contended (macOS/Windows, 2 xdist workers) sample per op,
# 2026-09-30 → 2026-10-06 (#3663). Every listed deadline must clear HEADROOM x it.
OBSERVED_CONTENDED_MAX = {
    "wait:'…' in terminal output": 39.11,
    "wait:the shell prompt": 34.39,
    "wait:the terminal to report it exited": 33.98,
    "wait:the '…' row in the terminal buffer": 33.27,
    "wait:the active terminal's shell prompt": 32.22,
    "wait:the shell's echo of the composed line": 27.45,
    "wait:the PTY to report N rows x N cols": 25.94,
    "wait:the PTYSZN stty answer": 25.92,
    "wait:the DOM renderer to paint '…'": 24.64,
    "wait:the new terminal's shell prompt": 15.25,
    "wait:the restored terminals to reach a shell prompt": 10.23,
    "wait:connection '…'": 19.16,
    "wait:'…' in window '…'": 13.17,
    "wait:the editor status to populate": 10.06,
    "command:projectionSubscribe": 18.89,
    "command:getState": 8.61,
    "command:click": 5.31,
    "command:screenshot": 5.18,
}


def test_deadlines_respect_the_headroom_rule():
    # Observed maxima behind the current values (see deadlines.py). A deadline
    # must never be tighter than HEADROOM x the slowest observation.
    observed_max = {"APP_CONNECT": 15.95}  # serial Windows display lane
    for name, seconds in observed_max.items():
        assert getattr(deadlines, name) >= deadlines.HEADROOM * seconds
    # Provisional entries have no contended data yet (#4216); everything else must.
    assert set(OBSERVED_CONTENDED_MAX) == set(deadlines.CONTENDED_OP_DEADLINES) - set(
        deadlines.PROVISIONAL_CONTENDED_OP_DEADLINES
    )
    for op, seconds in OBSERVED_CONTENDED_MAX.items():
        budget = deadlines.CONTENDED_OP_DEADLINES[op]
        assert budget >= deadlines.HEADROOM * seconds, op
        assert budget % 5 == 0, op  # rounded up to 5 s


def test_every_deadline_trips_before_the_hang_guard():
    # A bounded wait must fail with its own message long before the per-phase
    # hang guard (#4017/#4173) kills the worker without one.
    from termihub_harness import hang_guard

    shortest_phase = min(hang_guard.DEFAULT_BUDGETS.values())
    budgets = [
        deadlines.APP_CONNECT,
        deadlines.LIVE_COMMAND,
        deadlines.DIAGNOSTIC_PROBE,
        *deadlines.CONTENDED_OP_DEADLINES.values(),
    ]
    assert max(budgets) * deadlines.HEADROOM < shortest_phase


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
    monkeypatch.setattr(deadlines, "CONTENDED", False)
    monkeypatch.setattr(deadlines, "DEBUG_SCALE", 1.0)
    suite = SystemTest()
    assert suite.wait(lambda: True, timeout=1, what="the thing 7") is True
    with pytest.raises(AssertionError, match="timed out waiting for never"):
        suite.wait(lambda: False, timeout=0.05, interval=0.01, what="never")
    ops = {r["op"]: r for r in timing.summarize()}
    assert ops["wait:the thing N"]["timeouts"] == 0
    assert ops["wait:never"]["timeouts"] == 1
    assert ops["wait:never"]["deadline"] == 0.05


class _RowDriver:
    """Driver double: a file browser whose listing holds ``names`` (all mounted)."""

    def __init__(self, names=()):
        self.names = set(names)

    def exists(self, test_id):
        if test_id.startswith("file-row-"):
            return test_id[len("file-row-") :] in self.names
        return test_id in ("file-browser-refresh", "file-browser-filter")

    def type(self, test_id, text):
        pass

    def click(self, test_id):
        pass


class _HostKeyDriver:
    """Driver double for the host-key loop: an optional prompt, an optional shell."""

    def __init__(self, *, prompt=False, output=""):
        self.prompt = prompt
        self.output = output
        self.clicked = []

    def exists(self, test_id):
        return self.prompt and test_id == "ssh-hostkey-prompt"

    def click(self, test_id):
        self.clicked.append(test_id)

    def read_terminal(self):
        return self.output


def _bound(cls, driver):
    obj = cls.__new__(cls)
    obj.driver = driver
    return obj


def test_file_row_wait_records_its_named_op(monkeypatch):
    # #4216: the loop bypasses SystemTest.wait, so it must record its own sample.
    from termihub_harness.ui import FilesUi

    monkeypatch.setattr(deadlines, "CONTENDED", False)
    monkeypatch.setattr(deadlines, "DEBUG_SCALE", 1.0)
    _bound(FilesUi, _RowDriver(["a.txt"])).wait_for_file_row("a.txt", timeout=1)
    with pytest.raises(AssertionError, match="timed out waiting for file row 'ghost 7'"):
        _bound(FilesUi, _RowDriver()).wait_for_file_row("ghost 7", timeout=0.05)
    row = {r["op"]: r for r in timing.summarize()}[deadlines.FILE_ROW_OP]
    assert (row["n"], row["timeouts"], row["deadline"]) == (2, 1, 1.0)
    # The timeout message normalises to the same op the sample is recorded under.
    assert timing.wait_label("file row 'ghost 7'") == deadlines.FILE_ROW_OP


@pytest.mark.parametrize(
    "driver,accepted",
    [
        (_HostKeyDriver(prompt=True), True),
        (_HostKeyDriver(output="$ "), False),
    ],
)
def test_host_key_loop_records_its_named_op(monkeypatch, driver, accepted):
    from termihub_harness.ui.passwordprompt import PasswordPromptUi

    monkeypatch.setattr(deadlines, "CONTENDED", False)
    monkeypatch.setattr(deadlines, "DEBUG_SCALE", 1.0)
    assert _bound(PasswordPromptUi, driver).accept_host_key_prompt(timeout=1) is accepted
    row = {r["op"]: r for r in timing.summarize()}[deadlines.HOST_KEY_PROMPT_OP]
    assert (row["n"], row["timeouts"], row["deadline"]) == (1, 0, 1.0)


def test_host_key_loop_records_an_expired_wait(monkeypatch):
    from termihub_harness.ui.passwordprompt import PasswordPromptUi

    monkeypatch.setattr(deadlines, "CONTENDED", False)
    monkeypatch.setattr(deadlines, "DEBUG_SCALE", 1.0)
    prompt = _bound(PasswordPromptUi, _HostKeyDriver())
    assert prompt.accept_host_key_prompt(timeout=0.05) is False
    row = {r["op"]: r for r in timing.summarize()}[deadlines.HOST_KEY_PROMPT_OP]
    assert (row["n"], row["timeouts"]) == (1, 1)

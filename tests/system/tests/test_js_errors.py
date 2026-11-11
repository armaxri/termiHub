"""Machinery tests for the JS error gate (#5364, TST-011).

Parsing, diffing, allowlist matching and the modes are pure, so they run
against fakes here; one end-to-end check runs a throwaway pytest session in a
subprocess to prove the conftest wiring fails (or only annotates) a test whose
app logged a new unhandled rejection.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path
from types import SimpleNamespace

import pytest

from termihub_harness import js_errors as je

# ── mode ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "value, mode",
    [
        ("", "annotate"),
        ("fail", "fail"),
        (" FAIL ", "fail"),
        ("off", "off"),
        ("annotate", "annotate"),
    ],
)
def test_gate_mode_reads_the_env_and_defaults_to_annotate(value, mode):
    assert je.gate_mode({je.GATE_ENV: value}) == mode
    assert je.gate_mode({}) == "annotate"


def test_gate_mode_rejects_an_unknown_value():
    with pytest.raises(je.GateConfigError, match="expected one of fail, annotate, off"):
        je.gate_mode({je.GATE_ENV: "strict"})


# ── app.log parsing ──────────────────────────────────────────────────────────

_LOG = textwrap.dedent("""\
    2026-11-11T10:00:00Z  INFO termihub: started
    2026-11-11T10:00:01Z ERROR frontend: [unhandled] unhandled promise rejection: Canceled window="main"
    \x1b[2m2026-11-11T10:00:01Z\x1b[0m \x1b[31mERROR\x1b[0m frontend: [unhandled] uncaught error (app.js:3:9): boom
        at f (app.js:3:9)
    CONSOLE JS ERROR Unhandled Promise Rejection: Canceled
    CONSOLE JS ERROR NotAllowedError: The request is not allowed by the user agent
    2026-11-11T10:00:02Z ERROR frontend: [ssh] connect failed
    """)


def test_parse_log_reads_unhandled_and_console_lines_only():
    errors = je.parse_log(_LOG)
    assert [(e.kind, e.message, e.source) for e in errors] == [
        ("unhandledrejection", "Canceled", "log"),
        ("error", "(app.js:3:9): boom", "log"),
        ("unhandledrejection", "Canceled", "log"),
        ("console.error", "NotAllowedError: The request is not allowed by the user agent", "log"),
    ]


def test_webkit_echo_and_handler_line_dedup_to_one_error():
    keys = [e.key for e in je.unique(je.parse_log(_LOG))]
    assert keys.count("unhandledrejection: Canceled") == 1
    assert len(keys) == 3


def test_key_uses_the_first_message_line_only():
    error = je.JsError("error", "boom\n    at f (x.js:1:1)", "bridge")
    assert error.key == "error: boom"


def test_from_bridge_maps_records():
    errors = je.from_bridge(
        [{"seq": 0, "kind": "console.error", "message": "x", "stack": "at a"}, {"message": "y"}]
    )
    assert errors == [
        je.JsError("console.error", "x", "bridge", "at a"),
        je.JsError("error", "y", "bridge", None),
    ]


# ── diffing: cursor + collect ────────────────────────────────────────────────


class FakeDriver:
    """A bridge driver whose page buffer the test fills."""

    def __init__(self, page_id="p1", records=None, *, connected=True, fails=False):
        self.page_id = page_id
        self.records = list(records or [])
        self.is_connected = connected
        self.fails = fails
        self.calls = []

    def add(self, message, kind="unhandledrejection"):
        self.records.append({"seq": len(self.records), "kind": kind, "message": message})

    def get_js_errors(self, since=None, *, timeout=None):
        self.calls.append(since)
        if self.fails:
            raise RuntimeError("unknown action getJsErrors")
        since = since or 0
        return {
            "pageId": self.page_id,
            "cursor": len(self.records),
            "dropped": 0,
            "errors": [r for r in self.records if r["seq"] >= since],
        }


def fake_app(tmp_path, text=""):
    log = tmp_path / "app.log"
    log.write_text(text, encoding="utf-8")
    return SimpleNamespace(log_path=log)


def test_bridge_diff_returns_only_errors_after_the_cursor(tmp_path):
    driver = FakeDriver()
    driver.add("old")
    app = fake_app(tmp_path)
    cursor = je.take_cursor(driver, app)
    assert (cursor.page_id, cursor.seq) == ("p1", 1)
    driver.add("new")
    errors, source = je.collect(cursor, driver, app)
    assert source == "bridge"
    assert [e.message for e in errors] == ["new"]


def test_bridge_diff_rereads_from_zero_after_a_page_reload(tmp_path):
    driver = FakeDriver()
    driver.add("before reload")
    app = fake_app(tmp_path)
    cursor = je.take_cursor(driver, app)
    reloaded = FakeDriver(page_id="p2")
    reloaded.add("after reload")
    errors, _ = je.collect(cursor, reloaded, app)
    assert [e.message for e in errors] == ["after reload"]
    assert reloaded.calls == [1, 0]


def test_no_bridge_at_start_counts_everything_on_the_page(tmp_path):
    cursor = je.take_cursor(None, None)
    driver = FakeDriver()
    driver.add("during launch")
    errors, _ = je.collect(cursor, driver, fake_app(tmp_path))
    assert [e.message for e in errors] == ["during launch"]


def test_log_fallback_reads_from_the_start_offset(tmp_path):
    app = fake_app(tmp_path, "ERROR frontend: [unhandled] unhandled promise rejection: old\n")
    driver = FakeDriver(fails=True)
    cursor = je.take_cursor(driver, app)
    assert cursor.page_id is None and cursor.log_offset > 0
    with open(app.log_path, "a", encoding="utf-8") as fh:
        fh.write("CONSOLE JS ERROR new one\n")
    errors, source = je.collect(cursor, driver, app)
    assert source == "log"
    assert [e.key for e in errors] == ["console.error: new one"]


def test_log_fallback_used_when_the_socket_is_closed(tmp_path):
    app = fake_app(tmp_path)
    driver = FakeDriver(connected=False)
    cursor = je.take_cursor(driver, app)
    with open(app.log_path, "a", encoding="utf-8") as fh:
        fh.write("ERROR frontend: [unhandled] unhandled promise rejection: x\n")
    errors, source = je.collect(cursor, driver, app)
    assert (source, [e.key for e in errors]) == ("log", ["unhandledrejection: x"])
    assert driver.calls == []


def test_a_relaunched_app_is_read_from_the_start_of_its_log(tmp_path):
    first = fake_app(tmp_path, "CONSOLE JS ERROR first app\n")
    cursor = je.take_cursor(None, first)
    second_dir = tmp_path / "second"
    second_dir.mkdir()
    second = fake_app(second_dir, "CONSOLE JS ERROR second app\n")
    errors, _ = je.collect(cursor, None, second)
    assert [e.message for e in errors] == ["second app"]


def test_collect_without_driver_or_app_reports_nothing():
    assert je.collect(je.Cursor(), None, None) == ([], None)


# ── allowlist ────────────────────────────────────────────────────────────────


def _fragment(**overrides):
    return {
        "pattern": r"^unhandledrejection: Canceled$",
        "issue": 1234,
        "reason": "tracked",
        **overrides,
    }


def test_allowlist_entry_matches_the_key_and_optional_nodeid():
    entry = je.parse_fragment("1234-canceled.json", _fragment(nodeid=r"test_ssh_jump_host\.py"))
    canceled = je.JsError("unhandledrejection", "Canceled", "bridge")
    assert entry.matches(canceled, "tests/test_ssh_jump_host.py::T::test_a")
    assert not entry.matches(canceled, "tests/test_ssh.py::T::test_a")
    assert not entry.matches(je.JsError("console.error", "Canceled", "bridge"), "x")


@pytest.mark.parametrize(
    "fragment, message",
    [
        ([], "must be a JSON object"),
        (_fragment(pattern=""), "needs a 'pattern'"),
        (_fragment(issue=None), "needs an 'issue'"),
        (_fragment(issue=True), "needs an 'issue'"),
        (_fragment(issue=0), "needs an 'issue'"),
        (_fragment(reason=" "), "needs a 'reason'"),
        (_fragment(pattern="("), "bad regex"),
        (_fragment(nodeid="["), "bad regex"),
        (_fragment(lanes=["x"]), "unknown key"),
    ],
)
def test_allowlist_fragment_validation(fragment, message):
    with pytest.raises(je.GateConfigError, match=message):
        je.parse_fragment("f.json", fragment)


def test_allowlist_fragment_accepts_comment_keys():
    assert je.parse_fragment("f.json", _fragment(_comment="why")).issue == 1234


def test_load_allowlist_reads_json_and_tolerates_the_readme(tmp_path):
    (tmp_path / "1234-canceled.json").write_text(json.dumps(_fragment()), "utf-8")
    (tmp_path / "README.md").write_text("docs", "utf-8")
    assert [e.name for e in je.load_allowlist(tmp_path)] == ["1234-canceled.json"]
    assert je.load_allowlist(tmp_path / "missing") == []


def test_load_allowlist_rejects_stray_files(tmp_path):
    (tmp_path / "notes.txt").write_text("x", "utf-8")
    with pytest.raises(je.GateConfigError, match="only \\*.json"):
        je.load_allowlist(tmp_path)


def test_committed_allowlist_is_valid():
    for entry in je.load_allowlist():
        assert entry.issue > 0


# ── verdicts + modes ─────────────────────────────────────────────────────────

_ALLOW = [je.parse_fragment("1234-canceled.json", _fragment())]
_CANCELED = je.JsError("unhandledrejection", "Canceled", "bridge")
_NEW = je.JsError("console.error", "NotAllowedError: nope", "bridge", "at x\nat y")


def test_evaluate_splits_new_from_allowlisted_and_dedups():
    verdict = je.evaluate("t::a", [_CANCELED, _NEW, _CANCELED, _NEW], _ALLOW, source="bridge")
    assert verdict.new == [_NEW]
    assert [(e, entry.issue) for e, entry in verdict.allowed] == [(_CANCELED, 1234)]
    data = verdict.to_json()
    assert data["allowed"][0]["issue"] == 1234
    assert data["new"][0]["stack"] == "at x\nat y"


def test_failure_message_only_for_new_errors():
    assert je.failure_message(je.evaluate("t", [_CANCELED], _ALLOW)) is None
    message = je.failure_message(je.evaluate("t", [_NEW], _ALLOW, source="bridge"))
    assert "console.error: NotAllowedError: nope" in message
    assert "at y" in message and "js-error-allowlist.d" in message


def _item(nodeid, driver, app):
    suite = SimpleNamespace(driver=driver, app=app)
    return SimpleNamespace(nodeid=nodeid, instance=suite, cls=None, funcargs={})


@pytest.mark.parametrize(
    "mode, errors, outcome, recorded",
    [
        ("fail", ["NotAllowedError: nope"], "failed", 1),
        ("fail", ["Canceled"], "passed", 1),
        ("annotate", ["NotAllowedError: nope"], "passed", 1),
        ("off", ["NotAllowedError: nope"], "passed", 0),
        ("fail", [], "passed", 0),
    ],
)
def test_gate_modes(tmp_path, mode, errors, outcome, recorded):
    gate = je.Gate(mode, _ALLOW)
    driver = FakeDriver()
    item = _item("tests/test_x.py::T::test_a", driver, fake_app(tmp_path))
    gate.start(item)
    for message in errors:
        driver.add(message)
    report = SimpleNamespace(passed=True, outcome="passed", longrepr=None)
    gate.finish(item, report)
    assert report.outcome == outcome
    assert len(gate.records) == recorded
    if outcome == "failed":
        assert "JS error gate" in report.longrepr


def test_fail_mode_does_not_rewrite_an_already_failed_test(tmp_path):
    gate = je.Gate("fail", [])
    driver = FakeDriver()
    item = _item("t::a", driver, fake_app(tmp_path))
    gate.start(item)
    driver.add("boom")
    report = SimpleNamespace(passed=False, outcome="failed", longrepr="original")
    gate.finish(item, report)
    assert report.longrepr == "original"
    assert gate.records


def test_gate_ignores_tests_without_an_app(tmp_path):
    gate = je.Gate("fail", [])
    item = SimpleNamespace(nodeid="t::m", instance=None, cls=None, funcargs={})
    gate.start(item)
    report = SimpleNamespace(passed=True, outcome="passed", longrepr=None)
    gate.finish(item, report)
    assert report.outcome == "passed" and gate.records == []


def test_suite_handles_falls_back_to_the_app_funcarg():
    app = object()
    item = SimpleNamespace(instance=None, cls=None, funcargs={"app": app})
    assert je.suite_handles(item) == (None, app)


# ── reporting ────────────────────────────────────────────────────────────────


def test_summary_lists_each_unique_error_once_with_its_tests(tmp_path):
    records = [
        je.evaluate("t::a", [_CANCELED, _NEW], _ALLOW, source="bridge").to_json(),
        je.evaluate("t::b", [_NEW], _ALLOW, source="log").to_json(),
    ]
    lines = je.format_summary(records, "annotate")
    assert lines[0] == "mode=annotate: 2 unique JS error(s) in 2 test(s); 1 not allowlisted"
    assert lines[1] == "[NEW] console.error: NotAllowedError: nope  (2 test(s))"
    assert lines[2:4] == ["    t::a", "    t::b"]
    assert lines[4] == "[allowlisted #1234] unhandledrejection: Canceled  (1 test(s))"
    assert je.format_summary([], "annotate") == []

    path = je.write_report(je.report_path(tmp_path, "bulk linux"), records, "annotate")
    assert path == tmp_path / "js-errors" / "bulk_linux.json"
    data = json.loads(path.read_text("utf-8"))
    assert data["mode"] == "annotate" and len(data["tests"]) == 2
    assert je.report_path(tmp_path, None).name == "local.json"


# ── end to end through conftest.py ───────────────────────────────────────────


@pytest.mark.parametrize(
    "mode, expected_rc, summary",
    [("fail", 1, True), ("annotate", 0, True), ("off", 0, False)],
)
def test_the_conftest_hook_gates_a_test_that_logged_a_js_error(
    tmp_path, mode, expected_rc, summary
):
    """A real pytest session with this conftest: a test whose (fake) app logs an
    unhandled rejection fails only in ``fail`` mode, and is reported unless off."""
    harness_root = Path(je.__file__).resolve().parents[1]
    log = tmp_path / "app.log"
    log.write_text("CONSOLE JS ERROR launched before the test\n", encoding="utf-8")
    test_file = tmp_path / "test_gated.py"
    test_file.write_text(
        textwrap.dedent(f"""
            from pathlib import Path
            from types import SimpleNamespace

            LOG = Path({str(log)!r})

            class TestSuite:
                app = SimpleNamespace(log_path=LOG, read_log=lambda: LOG.read_text())
                driver = None

                def test_clean(self):
                    pass

                def test_throws(self):
                    with open(LOG, "a") as fh:
                        fh.write(
                            "ERROR frontend: [unhandled] unhandled promise rejection: "
                            "e2e-canary\\n"
                        )
            """),
        encoding="utf-8",
    )
    env = {**os.environ, je.GATE_ENV: mode}
    for name in ("TERMIHUB_SKIP_GUARD_LANE", "GITHUB_STEP_SUMMARY", "PYTEST_XDIST_WORKER"):
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
    assert ("termihub JS errors in the app under test" in out) is summary, out
    if summary:
        assert "[NEW] unhandledrejection: e2e-canary  (1 test(s))" in out
        # The line already in the log before the test started is not its error.
        assert "launched before the test" not in out
    if mode == "fail":
        assert "1 failed, 1 passed" in out


def test_an_invalid_mode_is_a_usage_error(tmp_path):
    harness_root = Path(je.__file__).resolve().parents[1]
    test_file = tmp_path / "test_nothing.py"
    test_file.write_text("def test_ok():\n    pass\n", encoding="utf-8")
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
        env={**os.environ, je.GATE_ENV: "bogus"},
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 4, result.stdout + result.stderr
    assert "JS error gate (#5364)" in result.stderr

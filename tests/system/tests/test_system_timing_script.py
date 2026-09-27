"""Unit tests for ``scripts/system-test-timing.py`` (#3660, WA-CI-006).

Loads the script directly (it is a script, not a package) and feeds it synthetic
GitHub Actions job logs — no network, no ``gh``.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

from termihub_harness import timing

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "system-test-timing.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("system_test_timing", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module  # @dataclass resolves its module by name
    spec.loader.exec_module(module)
    return module


mod = _load_module()

TS = "2026-09-09T20:52:31.8070190Z "


def _log(os_header: str, *lines: str) -> str:
    body = [
        "Current runner version: '2.337.0'",
        "##[group]Operating System",
        os_header,
        "##[endgroup]",
        *lines,
    ]
    return "\n".join(TS + line for line in body) + "\n"


def _timing(op: str, **fields) -> str:
    record = {"op": op, "n": 10, "p50": 0.1, "p95": 0.5, "max": 1.0, "deadline": 20.0, "timeouts": 0}
    record.update(fields)
    return f"[termihub-test-timing] {json.dumps(record)}"


def test_parse_timing_lines_skips_free_text_and_bad_json():
    text = _log(
        "macOS",
        _timing("app-connect", max=12.5),
        "[termihub-test-timing] initialize first-response 1.2s",  # Rust agent format
        "[termihub-test-timing] {not json",
    )
    (record,) = mod.parse_timing_lines(text)
    assert record["op"] == "app-connect" and record["max"] == 12.5


def test_harness_output_round_trips_through_the_parser():
    timing.reset()
    try:
        timing.record(timing.wait_label("'x' in terminal output"), 0.4, 20.0)
        lines = timing.format_lines(timing.summarize("linux"))
    finally:
        timing.reset()
    (record,) = mod.parse_timing_lines(_log("Ubuntu", *lines))
    assert record["op"] == "wait:'…' in terminal output"
    assert record["max"] == 0.4


def test_normalize_label_matches_the_harness_wait_label():
    for what in ["'mk-1' in terminal output", "the cursor to reach line 42", 'row "a b"']:
        assert "wait:" + mod.normalize_label(what) == timing.wait_label(what)


def test_parse_durations_reads_only_the_table():
    text = _log(
        "Ubuntu",
        "12.00s call     tests/test_early.py::T::t",  # before the table: ignored
        "============================= slowest 25 durations =============================",
        "53.40s call     tests/test_editor.py::TestEditor::test_dirty",
        "35.02s setup    tests/test_net.py::TestNet::test_http",
        "7.57s teardown tests/test_x.py::TestX::test_y",
        "=========================== short test summary info ============================",
        "9.99s call     tests/test_after.py::T::t",
    )
    assert mod.parse_durations(text) == [
        (53.40, "call", "tests/test_editor.py::TestEditor::test_dirty"),
        (35.02, "setup", "tests/test_net.py::TestNet::test_http"),
        (7.57, "teardown", "tests/test_x.py::TestX::test_y"),
    ]


def test_parse_deadline_hits_classifies_each_chokepoint():
    text = _log(
        "Microsoft Windows Server 2025",
        "E           TimeoutError: no app connected to the bridge within 30.0s",
        '    raise TimeoutError(f"no app connected to the bridge within {timeout}s")',  # source
        "E   termihub_harness.bridge.BridgeError: command timed out after 10.0s",
        "E       AssertionError: timed out waiting for 'mk-3' in terminal output (last error: None)",
        "E       AssertionError: timed out waiting for the cursor to reach line 12",
    )
    hits = mod.parse_deadline_hits(text)
    assert hits[:2] == [("app-connect", 30.0), ("command", 10.0)]
    assert [op for op, _ in hits[2:]] == [
        "wait:'…' in terminal output",
        "wait:the cursor to reach line N",
    ]


def test_detect_log_os_reads_the_runner_header():
    assert mod.detect_log_os(_log("macOS")) == "macos"
    assert mod.detect_log_os(_log("Ubuntu")) == "linux"
    assert mod.detect_log_os(_log("Microsoft Windows Server 2025")) == "windows"
    assert mod.detect_log_os(TS + "no header\n") == "unknown"


def test_aggregate_timings_is_conservative_across_sessions():
    logs = [
        ("macos", _log("macOS", _timing("app-connect", n=3, p50=5.0, p95=8.0, max=9.0))),
        ("macos", _log("macOS", _timing("app-connect", n=4, p50=7.0, p95=15.0, max=18.5, timeouts=1))),
        ("macos", _log("macOS", _timing("app-connect", n=2, p50=6.0, p95=6.5, max=7.0))),
    ]
    row = mod.aggregate_timings(logs)[("macos", "app-connect")].row()
    assert row["sessions"] == 3 and row["n"] == 9 and row["timeouts"] == 1
    assert row["p50"] == 6.0  # median of per-session p50s
    assert row["p95"] == 15.0  # largest per-session p95
    assert row["max"] == 18.5


def test_percentile_is_nearest_rank():
    values = [float(v) for v in range(1, 21)]
    assert mod.percentile(values, 50) == 10.0
    assert mod.percentile(values, 95) == 19.0
    assert mod.percentile([3.0], 95) == 3.0


def test_main_renders_markdown_from_a_log_dir(tmp_path, capsys):
    (tmp_path / "a.log").write_text(
        _log(
            "Ubuntu",
            _timing("command:click", max=0.9),
            "============================= slowest 25 durations =============================",
            "28.28s setup    tests/test_csp.py::TestCsp::test_boot",
            "E           TimeoutError: no app connected to the bridge within 60.0s",
        ),
        encoding="utf-8",
    )
    assert mod.main(["--log-dir", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "Parsed 1 job log(s)." in out
    assert "| linux | `command:click` | 1 | 10 | 0.10 | 0.50 | 0.90 | 20.00 | 0 |" in out
    assert "| linux | setup | 1 | 28.28 | 28.28 | 28.28 |" in out
    assert "| linux | `app-connect` | 1 | 60.00 |" in out

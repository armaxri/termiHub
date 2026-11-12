"""Machinery tests for the rerun report and the per-lane rerun budget (#5167).

The budget parsing, the recorder and the verdict are pure, so they run against
fake reports here; one end-to-end check runs a throwaway pytest session (with
``--reruns``) in a subprocess to prove the conftest wiring publishes the rerun
table and reds a lane over its budget.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path
from types import SimpleNamespace

import pytest

from termihub_harness import rerun_budget as rb
from termihub_harness import skip_guard as sg
from termihub_harness.artifacts import ARTIFACT_ROOT

_WORKFLOW = Path(rb.__file__).resolve().parents[3] / ".github/workflows/system-integration.yml"


def _report(nodeid, outcome, when="call", longrepr=None):
    return SimpleNamespace(
        nodeid=nodeid,
        outcome=outcome,
        when=when,
        longrepr=longrepr,
        failed=outcome == "failed",
        skipped=outcome == "skipped",
    )


def _crash(message):
    return SimpleNamespace(reprcrash=SimpleNamespace(message=message))


def _record(*reports):
    recorder = rb.Recorder()
    for report in reports:
        recorder.add_report(report)
    return recorder


def _retried_then(nodeid, final, reruns=1, message="BridgeError: no element"):
    reports = [_report(nodeid, "rerun", longrepr=_crash(f"{message} #{i}")) for i in range(reruns)]
    reports.append(_report(nodeid, "passed", when="setup"))
    reports.append(_report(nodeid, final))
    reports.append(_report(nodeid, "passed", when="teardown"))
    return reports


# ── Budget fragments ──────────────────────────────────────────────────────────


def test_budgets_sum_over_the_fragments_that_name_a_lane():
    budget = rb.parse_fragments(
        {
            "bulk-linux.json": {"why": "seed", "max_reruns": {"bulk-linux": 5}},
            "5200-new-flaky.json": {
                "why": "known flake, tracked",
                "max_reruns": {"bulk-linux": 2, "bulk-macos": 1, "_comment": "ignored"},
            },
        }
    )
    assert budget.for_lane("bulk-linux") == 7
    assert budget.for_lane("bulk-macos") == 1
    assert budget.for_lane("display-linux") == 0
    assert "bulk-linux.json: 5" in budget.describe("bulk-linux")
    assert budget.describe("display-linux") == "none"


@pytest.mark.parametrize(
    "fragment, error",
    [
        ([], "must be a JSON object"),
        ({"max_reruns": {"bulk-linux": 1}}, "needs a 'why'"),
        ({"why": " ", "max_reruns": {"bulk-linux": 1}}, "needs a 'why'"),
        ({"why": "x"}, "non-empty 'max_reruns'"),
        ({"why": "x", "max_reruns": {}}, "non-empty 'max_reruns'"),
        ({"why": "x", "max_reruns": {"*": 3}}, "not '\\*'"),
        ({"why": "x", "max_reruns": {"bulk-linux": -1}}, "non-negative integer"),
        ({"why": "x", "max_reruns": {"bulk-linux": True}}, "non-negative integer"),
        ({"why": "x", "max_reruns": {"bulk-linux": "3"}}, "non-negative integer"),
        ({"why": "x", "max_reruns": {"bulk-linux": 1}, "lanes": []}, "unknown key"),
    ],
)
def test_an_invalid_fragment_is_rejected(fragment, error):
    with pytest.raises(ValueError, match=error):
        rb.parse_fragments({"bad.json": fragment})


def test_load_budget_rejects_a_stray_file(tmp_path):
    (tmp_path / "bulk-linux.json").write_text(
        json.dumps({"why": "x", "max_reruns": {"bulk-linux": 1}}), encoding="utf-8"
    )
    (tmp_path / "notes.txt").write_text("x", encoding="utf-8")
    with pytest.raises(ValueError, match="only \\*.json"):
        rb.load_budget(tmp_path)


def _workflow_lanes() -> set[str]:
    lanes: set[str] = set()
    for line in _WORKFLOW.read_text(encoding="utf-8").splitlines():
        if f"{sg.LANE_ENV}:" in line:
            lanes.update(re.findall(r"(?:&&|\|\|) '([a-z0-9-]+)'", line))
    return lanes


def test_the_committed_budgets_name_only_workflow_lanes_and_cover_the_rerun_lanes():
    """A lane typo would budget nothing; a --reruns 2 lane without a fragment
    would fail on its first absorbed rerun."""
    budget = rb.load_budget()
    workflow = _workflow_lanes()
    assert budget.lanes <= workflow, budget.lanes - workflow
    rerun_lanes = {
        "bulk-linux",
        "bulk-linux-arm64",
        "bulk-macos",
        "bulk-windows",
        "os-input-macos",
        "os-input-windows",
    }
    assert rerun_lanes <= workflow
    assert budget.lanes == rerun_lanes
    for lane in rerun_lanes:
        assert budget.for_lane(lane) > 0
    # The --reruns 0 lanes never retry, so they carry no budget.
    assert budget.for_lane("display-linux") == 0


def test_each_seed_fragment_is_named_after_the_one_lane_it_budgets():
    for path in sorted(rb.BUDGET_DIR.glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        lanes = [lane for lane in raw["max_reruns"] if not lane.startswith("_")]
        if path.stem in _workflow_lanes():
            assert lanes == [path.stem], path.name


# ── Recorder ──────────────────────────────────────────────────────────────────

_THEME = "tests/test_theme_layout.py::TestThemeLayout::test_switching_theme"
_JUMP = "tests/test_ssh_jump_host.py::T::test_reconnect"


def test_a_test_that_passes_on_a_retry_is_absorbed_with_its_first_failure():
    recorder = _record(*_retried_then(_THEME, "passed", reruns=2))
    (test,) = recorder.sorted()
    assert (test.reruns, test.attempts, test.outcome, test.absorbed) == (2, 3, "passed", True)
    assert test.first_failure == "BridgeError: no element #0"


def test_a_test_that_fails_after_every_retry_is_listed_but_not_absorbed():
    recorder = _record(*_retried_then(_JUMP, "failed", reruns=2))
    (test,) = recorder.sorted()
    assert (test.outcome, test.absorbed) == ("failed", False)


def test_a_setup_error_after_a_retry_is_an_error_not_absorbed():
    recorder = _record(
        _report(_JUMP, "rerun", when="setup", longrepr=_crash("fixture died")),
        _report(_JUMP, "failed", when="setup"),
        _report(_JUMP, "passed", when="teardown"),
    )
    (test,) = recorder.sorted()
    assert (test.outcome, test.absorbed, test.first_failure) == ("error", False, "fixture died")


def test_tests_that_never_reran_are_not_recorded():
    recorder = _record(_report("tests/test_a.py::test_ok", "passed"))
    assert recorder.tests == {}


def test_failure_message_prefers_the_crash_line_and_cuts_long_text():
    assert rb.failure_message(_crash("AssertionError: x\n  more")) == "AssertionError: x more"
    text = "def test():\n>   assert 1 == 2\nE   assert 1 == 2\n\ntest_x.py:3: AssertionError"
    assert rb.failure_message(text) == "assert 1 == 2"
    assert rb.failure_message("only line") == "only line"
    assert rb.failure_message(None) == ""
    assert len(rb.failure_message("x" * 1000)) == rb.MESSAGE_LIMIT


# ── Verdict + summary ─────────────────────────────────────────────────────────

_BUDGET = rb.parse_fragments({"seed.json": {"why": "seed", "max_reruns": {"bulk-linux": 2}}})


def test_absorbed_reruns_within_the_budget_pass():
    recorder = _record(*_retried_then(_THEME, "passed", reruns=2), *_retried_then(_JUMP, "failed"))
    verdict = rb.evaluate("bulk-linux", recorder.tests.values(), _BUDGET)
    assert verdict.ok
    assert (verdict.absorbed, verdict.total, verdict.budget) == (2, 3, 2)


def test_absorbed_reruns_over_the_budget_fail_and_name_the_tests():
    recorder = _record(*_retried_then(_THEME, "passed", reruns=2), *_retried_then(_JUMP, "passed"))
    verdict = rb.evaluate("bulk-linux", recorder.tests.values(), _BUDGET)
    assert not verdict.ok
    (problem,) = verdict.problems
    assert "3 absorbed rerun(s) exceed the rerun budget of 2 for lane 'bulk-linux'" in problem
    assert "seed.json: 2" in problem
    assert _THEME in problem and _JUMP in problem


def test_an_unbudgeted_lane_allows_no_absorbed_rerun():
    recorder = _record(*_retried_then(_THEME, "passed"))
    assert not rb.evaluate("display-linux", recorder.tests.values(), _BUDGET).ok
    assert rb.evaluate("display-linux", [], _BUDGET).ok


def test_the_summary_lists_each_retried_test_and_the_verdict():
    recorder = _record(*_retried_then(_THEME, "passed", reruns=2), *_retried_then(_JUMP, "passed"))
    verdict = rb.evaluate("bulk-linux", recorder.tests.values(), _BUDGET)
    text = "\n".join(rb.format_summary(recorder.sorted(), verdict))
    assert "2 test(s) needed a rerun: 3 rerun(s), 3 absorbed" in text
    assert f"- {_THEME}  [3 attempts, passed]" in text
    assert "first failure: BridgeError: no element #0" in text
    assert "rerun budget (bulk-linux): FAILED — 3 absorbed of 2 allowed" in text
    assert "rerun-budget.d/" in text


def test_the_markdown_table_has_a_row_per_test_and_escapes_pipes():
    recorder = _record(*_retried_then(_THEME, "passed", message="a | b"))
    verdict = rb.evaluate("bulk-linux", recorder.tests.values(), _BUDGET)
    table = rb.markdown_summary("bulk-linux", recorder.sorted(), verdict)
    assert table.startswith("## Pytest reruns (bulk-linux)")
    assert "1 absorbed rerun(s), within the budget of 2" in table
    assert "| Test | Attempts | Final | First failure |" in table
    assert f"| `{_THEME}` | 2 | passed | a \\| b #0 |" in table


def test_a_lane_with_no_rerun_still_publishes_its_table():
    verdict = rb.evaluate("bulk-linux", [], _BUDGET)
    table = rb.markdown_summary("bulk-linux", [], verdict)
    assert "0 absorbed rerun(s), within the budget of 2" in table
    assert "No test needed a rerun." in table


def test_the_gate_writes_the_json_artifact_and_the_step_summary(tmp_path):
    gate = rb.Gate("bulk-linux")
    for report in _retried_then(_THEME, "passed"):
        gate.recorder.add_report(report)
    gate.finish(budget_loader=lambda: _BUDGET)
    summary = tmp_path / "summary.md"
    lines: list[str] = []
    path = gate.report(tmp_path, lines.append, env={"GITHUB_STEP_SUMMARY": str(summary)})
    assert path == tmp_path / "reruns" / "bulk-linux.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["lane"] == "bulk-linux" and payload["ok"] is True
    assert payload["absorbed"] == 1 and payload["budget"] == 2
    assert payload["tests"][0] == {
        "nodeid": _THEME,
        "attempts": 2,
        "reruns": 1,
        "outcome": "passed",
        "absorbed": True,
        "first_failure": "BridgeError: no element #0",
    }
    assert f"`{_THEME}`" in summary.read_text(encoding="utf-8")
    assert any(line.startswith("details: ") for line in lines)


def test_outside_a_lane_the_gate_stays_quiet_unless_something_reran(tmp_path):
    gate = rb.Gate(None)
    assert gate.finish() is None
    assert gate.report(tmp_path, lambda _line: None, env={}) is None
    assert not (tmp_path / "reruns").exists()


# ── End to end through conftest.py ────────────────────────────────────────────


@pytest.mark.parametrize(
    "lane, expected_rc",
    [("bulk-linux", 0), ("machinery-unbudgeted", 1), ("", 0)],
    ids=["within-budget", "over-budget", "no-lane"],
)
def test_the_conftest_hook_publishes_reruns_and_reds_a_lane_over_budget(
    tmp_path, lane, expected_rc
):
    """A real session with this conftest and ``--reruns 1``: a test that fails
    once and then passes is published, and reds only a lane with no budget."""
    harness_root = Path(rb.__file__).resolve().parents[1]
    marker = tmp_path / "attempted"
    test_file = tmp_path / "test_flaky.py"
    test_file.write_text(
        textwrap.dedent(f"""
            from pathlib import Path

            MARKER = Path({str(marker)!r})

            def test_steady():
                pass

            def test_flaky():
                if not MARKER.exists():
                    MARKER.write_text("1")
                    raise AssertionError("first-attempt-race")
            """),
        encoding="utf-8",
    )
    summary = tmp_path / "summary.md"
    env = {**os.environ, sg.LANE_ENV: lane, "GITHUB_STEP_SUMMARY": str(summary)}
    for name in (sg.REQUIRE_FIXTURES_ENV, "PYTEST_XDIST_WORKER"):
        env.pop(name, None)
    artifact = rb.report_path(ARTIFACT_ROOT, lane or None)
    try:
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
                "--reruns",
                "1",
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
        assert "termihub pytest reruns (#5167)" in out
        # The file sits outside the rootdir, so its node id is just "::test_flaky".
        assert "::test_flaky  [2 attempts, passed]" in out
        assert "first failure: AssertionError: first-attempt-race" in out
        payload = json.loads(artifact.read_text(encoding="utf-8"))
        assert payload["tests"][0]["first_failure"] == "AssertionError: first-attempt-race"
        if lane:
            assert payload["ok"] is (expected_rc == 0)
            assert "## Pytest reruns" in summary.read_text(encoding="utf-8")
        if expected_rc:
            assert "exceed the rerun budget of 0 for lane 'machinery-unbudgeted'" in out
    finally:
        artifact.unlink(missing_ok=True)

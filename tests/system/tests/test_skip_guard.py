"""Machinery tests for the nightly skip guard (#4315, TIN2-001 / WA-CI2-003).

The guard's decision is pure, so it runs against fake collections here; one
pytester-free end-to-end check runs a throwaway pytest session in a subprocess
to prove the conftest wiring turns an unexpected skip into a failed run.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from termihub_harness import skip_guard as sg

_ALLOWLIST = sg.parse_allowlist(
    {
        "max_skips": {"_comment": "ignored", "bulk-linux": 3},
        "allowed": [
            {
                "reason": r"^guided-manual test: pass --manual to run",
                "lanes": ["*"],
                "why": "needs an operator",
            },
            {
                "reason": r"no container runtime available",
                "lanes": ["bulk-macos"],
                "why": "macOS runners ship no Docker",
            },
            {
                "reason": r"^zsh is not installed",
                "nodeid": r"test_terminal_command_marks\.py",
                "lanes": ["bulk-linux"],
                "why": "no zsh on the runner",
            },
        ],
    }
)

_MANUAL = sg.Skip("tests/test_a.py::T::test_manual", "guided-manual test: pass --manual to run")
_NO_RUNTIME = sg.Skip(
    "tests/test_ssh.py::T::test_x",
    "SSH container fixtures unavailable: no container runtime available — need Docker",
)


def _evaluate(lane, skips, collected=10, **kwargs):
    return sg.evaluate(lane, collected=collected, skips=skips, allowlist=_ALLOWLIST, **kwargs)


def test_an_allowlisted_skip_passes():
    verdict = _evaluate("bulk-linux", [_MANUAL])
    assert verdict.ok, verdict.problems
    assert verdict.unexpected == []


def test_an_unexpected_skip_fails():
    sidecar = sg.Skip("tests/test_rdp.py::T::test_y", "RDP sidecar not built: run ...")
    verdict = _evaluate("bulk-linux", [_MANUAL, sidecar])
    assert not verdict.ok
    assert verdict.unexpected == [sidecar]
    assert any("not allowlisted" in problem for problem in verdict.problems)


def test_an_entry_applies_only_to_its_lanes():
    """A macOS-only gap (no Docker) is a real failure on the Linux lane."""
    assert _evaluate("bulk-macos", [_NO_RUNTIME]).ok
    assert not _evaluate("bulk-linux", [_NO_RUNTIME]).ok


def test_an_entry_with_a_nodeid_matches_only_that_suite():
    zsh = "zsh is not installed on this host"
    assert _evaluate("bulk-linux", [sg.Skip("tests/test_terminal_command_marks.py::t", zsh)]).ok
    assert not _evaluate("bulk-linux", [sg.Skip("tests/test_other.py::t", zsh)]).ok


def test_zero_collected_fails():
    verdict = _evaluate("bulk-linux", [], collected=0)
    assert not verdict.ok
    assert any("collected no tests" in problem for problem in verdict.problems)


def test_a_lane_where_every_test_skipped_fails_even_when_allowlisted():
    verdict = _evaluate("bulk-linux", [_MANUAL], collected=1)
    assert not verdict.ok
    assert any("all 1 collected tests skipped" in problem for problem in verdict.problems)


def test_a_skipped_module_does_not_count_as_a_skipped_collected_test():
    module = sg.Skip("tests/test_gone.py", "guided-manual test: pass --manual to run")
    assert _evaluate("bulk-linux", [module], collected=1).ok


def test_more_skips_than_the_baseline_fails():
    skips = [sg.Skip(f"tests/test_a.py::t{i}", _MANUAL.reason) for i in range(4)]
    verdict = _evaluate("bulk-linux", skips)
    assert not verdict.ok
    assert any("exceed the committed baseline of 3" in problem for problem in verdict.problems)
    assert _evaluate("bulk-linux", skips[:3]).ok


def test_require_fixtures_fails_on_a_fixture_skip_even_when_allowlisted():
    assert _evaluate("bulk-macos", [_NO_RUNTIME]).ok
    verdict = _evaluate("bulk-macos", [_NO_RUNTIME], require_fixtures=True)
    assert not verdict.ok
    assert verdict.unexpected == [_NO_RUNTIME]


@pytest.mark.parametrize(
    "longrepr, expected",
    [
        (("/x/test_a.py", 12, "Skipped: no zsh"), "no zsh"),
        (("/x/test_a.py", 12, "already bare"), "already bare"),
        ("Skipped: module gone", "module gone"),
    ],
)
def test_skip_reason_extracts_the_message(longrepr, expected):
    assert sg.skip_reason(longrepr) == expected


def test_an_entry_without_a_why_is_rejected():
    with pytest.raises(ValueError, match="'why'"):
        sg.parse_allowlist({"allowed": [{"reason": "x"}]})


def test_an_entry_with_a_bad_regex_is_rejected():
    with pytest.raises(Exception):
        sg.parse_allowlist({"allowed": [{"reason": "(", "why": "broken"}]})


def test_the_committed_allowlist_parses_and_never_admits_linux_fixture_skips():
    """Every entry carries a why, and none lets a Linux fixture outage pass."""
    allowlist = sg.load_allowlist()
    assert allowlist.entries
    fixture_skip = sg.Skip(
        "tests/test_ssh.py::T::test_x",
        "SSH container fixtures unavailable: `compose up` timed out after 300.0s",
    )
    verdict = sg.evaluate(
        "bulk-linux", collected=100, skips=[fixture_skip], allowlist=allowlist
    )
    assert not verdict.ok


def test_fully_skipped_modules_lists_suites_that_ran_nothing():
    skips = [sg.Skip("tests/test_rdp.py::T::a", "r"), sg.Skip("tests/test_ssh.py::T::b", "r")]
    assert sg.fully_skipped_modules(skips, ran=["tests/test_ssh.py::T::c"]) == [
        "tests/test_rdp.py"
    ]


def test_the_summary_lists_each_skip_and_flags_unexpected_ones():
    sidecar = sg.Skip("tests/test_rdp.py::T::test_y", "RDP sidecar not built")
    verdict = _evaluate("bulk-linux", [_MANUAL, sidecar])
    lines = sg.format_summary([_MANUAL, sidecar], fully_skipped=["tests/test_rdp.py"], verdict=verdict)
    text = "\n".join(lines)
    assert "2 skipped test(s)" in text
    assert "[UNEXPECTED] RDP sidecar not built" in text
    assert "tests/test_rdp.py::T::test_y" in text
    assert "fully skipped module(s): tests/test_rdp.py" in text
    assert "skip guard (bulk-linux): FAILED" in text


@pytest.mark.parametrize(
    "reason, lane_env, expected_rc",
    [
        ("guided-manual test: pass --manual to run (skipped by default)", "bulk-linux", 0),
        ("RDP sidecar not built", "bulk-linux", 1),
        ("RDP sidecar not built", "", 0),
    ],
    ids=["allowlisted", "unexpected", "guard-off"],
)
def test_the_conftest_hook_reds_a_run_with_an_unexpected_skip(
    tmp_path, reason, lane_env, expected_rc
):
    """End to end: a real pytest session with this conftest and one passing +
    one skipped test exits non-zero only when the guard is on and the skip
    reason is not allowlisted."""
    harness_root = Path(sg.__file__).resolve().parents[1]
    test_file = tmp_path / "test_guarded.py"
    test_file.write_text(
        textwrap.dedent(
            f"""
            import pytest

            def test_runs():
                pass

            def test_skips():
                pytest.skip({reason!r})
            """
        ),
        encoding="utf-8",
    )
    env = {**os.environ, sg.LANE_ENV: lane_env}
    env.pop(sg.REQUIRE_FIXTURES_ENV, None)
    env.pop("GITHUB_STEP_SUMMARY", None)
    env.pop("PYTEST_XDIST_WORKER", None)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-p",
            "no:cacheprovider",
            # The test file lives outside the harness tree, so load the
            # harness conftest explicitly (importable via pythonpath = ".").
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
    assert result.returncode == expected_rc, result.stdout + result.stderr
    assert "termihub skipped tests" in result.stdout
    assert reason in result.stdout


def test_skip_allowlist_json_is_valid_json():
    path = sg.ALLOWLIST_PATH
    data = json.loads(path.read_text(encoding="utf-8"))
    assert set(data["max_skips"]) - {"_comment"} == {
        "bulk-linux",
        "bulk-macos",
        "bulk-windows",
        "display-linux",
        "display-macos",
        "display-windows",
    }

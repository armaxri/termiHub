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
from termihub_harness.manual import manual_skip_reason

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


def _manual_gate(i):
    return sg.Skip(f"tests/test_m.py::t{i}", _MANUAL.reason, manual=True)


def test_guided_manual_gate_skips_do_not_count_against_the_baseline():
    """#4921: the guided-manual port added ~129 manual tests; their gate skips
    must not push a lane over max_skips, however many there are."""
    verdict = _evaluate("bulk-linux", [_manual_gate(i) for i in range(50)], collected=100)
    assert verdict.ok, verdict.problems


def test_the_baseline_still_counts_every_other_skip_next_to_manual_ones():
    zsh = "zsh is not installed on this host"
    others = [sg.Skip(f"tests/test_terminal_command_marks.py::t{i}", zsh) for i in range(4)]
    manual = [_manual_gate(i) for i in range(20)]
    verdict = _evaluate("bulk-linux", manual + others, collected=100)
    assert not verdict.ok
    assert any(
        "4 skips exceed the committed baseline of 3" in problem
        and "20 guided-manual skip(s) not counted" in problem
        for problem in verdict.problems
    ), verdict.problems
    assert _evaluate("bulk-linux", manual + others[:3], collected=100).ok


def test_a_manual_gate_reason_without_the_marker_still_counts():
    """The exemption needs the marker, not just a lookalike reason string."""
    lookalike = [sg.Skip(f"tests/test_a.py::t{i}", _MANUAL.reason) for i in range(4)]
    assert not any(skip.is_manual_gate for skip in lookalike)
    assert not _evaluate("bulk-linux", lookalike).ok


def test_a_manual_test_skipped_for_another_reason_still_counts():
    """A manual test that passed its gate but then skipped on an environment
    gap is a real skip, not a gate skip."""
    zsh = "zsh is not installed on this host"
    skips = [
        sg.Skip(f"tests/test_terminal_command_marks.py::t{i}", zsh, manual=True) for i in range(4)
    ]
    assert not any(skip.is_manual_gate for skip in skips)
    verdict = _evaluate("bulk-linux", skips)
    assert any("exceed the committed baseline" in problem for problem in verdict.problems)


def test_manual_gate_skips_still_need_their_allowlist_entry():
    strict = sg.parse_allowlist({"max_skips": {"bulk-linux": 100}, "allowed": []})
    gate = _manual_gate(0)
    verdict = sg.evaluate("bulk-linux", collected=10, skips=[gate], allowlist=strict)
    assert not verdict.ok
    assert verdict.unexpected == [gate]


@pytest.mark.parametrize(
    "enabled, interactive, platforms",
    [(False, True, None), (True, False, None), (True, True, ["windows"])],
    ids=["no-manual-flag", "no-tty", "wrong-platform"],
)
def test_every_manual_gate_reason_is_recognised(enabled, interactive, platforms):
    """Keeps MANUAL_GATE_REASON in step with manual.manual_skip_reason."""
    reason = manual_skip_reason(
        enabled=enabled, interactive=interactive, selected_platform="linux", platforms=platforms
    )
    assert reason is not None
    assert sg.Skip("tests/test_m.py::t", reason, manual=True).is_manual_gate


def test_the_committed_allowlist_admits_the_default_manual_gate_reason_on_every_lane():
    allowlist = sg.load_allowlist()
    reason = manual_skip_reason(
        enabled=False, interactive=False, selected_platform="linux", platforms=None
    )
    gate = sg.Skip("tests/test_m.py::T::t", reason, manual=True)
    for lane in allowlist.max_skips:
        assert any(entry.matches(gate) for entry in allowlist.for_lane(lane)), lane


def test_the_summary_notes_uncounted_manual_skips():
    skips = [_manual_gate(0), _manual_gate(1), _NO_RUNTIME]
    lines = sg.format_summary(skips, fully_skipped=[], verdict=None)
    assert "3 skipped test(s), 2 distinct reason(s) (2 guided-manual, not counted" in lines[0]


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


#: The exact skip reasons the container-fixture suites gave on a windows-latest
#: runner whose Docker daemon was unreachable (#4842, run 38847806014). The em
#: dashes are real U+2014 characters: the skip guard reads the reason from the
#: in-process report, so the Windows console's mangled ``�`` never reaches it.
_WINDOWS_NO_DAEMON_SKIPS = [
    sg.Skip(
        f"tests/test_{name}.py::T::test_x",
        f"{prefix} unavailable: no container runtime available — need Docker or Podman "
        "(override the choice with CONTAINER_CMD=podman)",
    )
    for name, prefix in [
        ("ssh", "SSH container fixtures"),
        ("ssh_jump", "SSH jump-host container fixtures"),
        ("telnet", "telnet container fixtures"),
        ("vnc", "VNC container fixtures"),
        ("ftp", "FTP container fixture"),
    ]
] + [
    sg.Skip(
        f"tests/test_remote_agent_{index}.py::T::test_x",
        f"{prefix} unavailable: no container runtime (Docker/Podman) reachable — the "
        "deployed-agent suites need one that runs Linux containers",
    )
    for index, prefix in enumerate(
        [
            "deployed-agent container fixture",
            "armed deployed-agent container fixture",
            "keyboard-interactive deployed-agent fixture",
            "real-swap deployed-agent container fixture",
        ]
    )
]


def test_bulk_windows_admits_container_fixture_skips_when_the_daemon_is_unreachable():
    """#4842: a windows-latest runner without a reachable Docker daemon must not
    red the skip guard — those Linux fixtures can never run on Windows."""
    verdict = sg.evaluate(
        "bulk-windows",
        collected=500,
        skips=_WINDOWS_NO_DAEMON_SKIPS,
        allowlist=sg.load_allowlist(),
    )
    assert verdict.ok, verdict.problems


def test_bulk_windows_still_fails_an_unexpected_skip():
    unexpected = sg.Skip("tests/test_x.py::T::test_y", "some brand-new environment gap")
    verdict = sg.evaluate(
        "bulk-windows",
        collected=500,
        skips=[*_WINDOWS_NO_DAEMON_SKIPS, unexpected],
        allowlist=sg.load_allowlist(),
    )
    assert not verdict.ok
    assert verdict.unexpected == [unexpected]


def test_bulk_windows_does_not_admit_a_container_fixture_failure():
    """Only the "no runtime" reason is admitted, not a broken fixture."""
    broken = sg.Skip(
        "tests/test_ssh.py::T::test_x",
        "SSH container fixtures unavailable: `compose up` timed out after 300.0s",
    )
    verdict = sg.evaluate(
        "bulk-windows", collected=500, skips=[broken], allowlist=sg.load_allowlist()
    )
    assert not verdict.ok


def test_the_windows_no_daemon_entries_do_not_leak_into_linux():
    verdict = sg.evaluate(
        "bulk-linux",
        collected=500,
        skips=_WINDOWS_NO_DAEMON_SKIPS[:1],
        allowlist=sg.load_allowlist(),
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
        "bulk-linux-arm64",
        "bulk-macos",
        "bulk-windows",
        "display-linux",
        "display-linux-arm64",
        "display-macos",
        "display-windows",
    }


@pytest.mark.parametrize(
    "marked, expected_rc",
    [(True, 0), (False, 1)],
    ids=["manual-marker-exempt", "unmarked-counts"],
)
def test_the_conftest_hook_exempts_manual_gate_skips_from_the_baseline(
    tmp_path, marked, expected_rc
):
    """End to end (#4921): on a lane whose committed baseline is 0, a real
    ``@pytest.mark.manual`` test gated off by conftest keeps the run green,
    while an unmarked test skipping with the same reason still reds it."""
    harness_root = Path(sg.__file__).resolve().parents[1]
    assert sg.load_allowlist().max_skips["display-linux"] == 0
    reason = "guided-manual test: pass --manual to run (skipped by default)"
    body = (
        "@pytest.mark.manual\ndef test_guided():\n    pass\n"
        if marked
        else f"def test_guided():\n    pytest.skip({reason!r})\n"
    )
    test_file = tmp_path / "test_guarded_manual.py"
    source = f"import pytest\n\ndef test_runs():\n    pass\n\n{body}"
    test_file.write_text(source, encoding="utf-8")
    env = {**os.environ, sg.LANE_ENV: "display-linux"}
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
    assert reason in result.stdout

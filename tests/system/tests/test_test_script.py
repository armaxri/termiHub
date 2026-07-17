"""Unit tests for the verdict reporting of ``scripts/test.sh`` (#1572).

The script's job is to turn two runners' exit codes into one unambiguous
verdict. That is worth testing precisely because a runner's *own* summary can
contradict its exit code: vitest exits non-zero when the run hit an unhandled
error even though every test passed, so the output reads ``3223 passed``
alongside pnpm's ``ELIFECYCLE`` (#1572, found via #1335 / PR #1558).

``pnpm`` and ``cargo`` are stubbed on ``PATH`` so the suites' exit codes can be
driven directly — no real test run, no build. The stub reproduces the
contradicting-summary shape so the guard covers the actual bug, not a
simplification of it.

Skipped when no POSIX ``bash`` is available (e.g. native Windows without Git
Bash); the script itself is exercised through its ``.cmd`` twin there.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "test.sh"

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None, reason="POSIX bash unavailable"
)

# What vitest prints on a run where every test passed but an unhandled error
# failed the run. The pass line is the trap: it is accurate and it is not the
# verdict.
VITEST_CONTRADICTING_SUMMARY = """\
 Test Files  1 passed (1)
      Tests  3223 passed (3223)
     Errors  1 error
 ELIFECYCLE  Test failed. See above for more details.
"""


def _stub_bin(tmp_path: Path, pnpm_exit: int, cargo_exit: int) -> Path:
    """Create a bin dir with fake ``pnpm``/``cargo`` that exit as instructed."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()

    # `pnpm install` must stay successful: test.sh runs it when node_modules is
    # absent (as on the machinery CI runner), and that is not what we are testing.
    pnpm = bin_dir / "pnpm"
    pnpm.write_text(
        "#!/usr/bin/env bash\n"
        'if [ "${1:-}" = "install" ]; then exit 0; fi\n'
        f"cat <<'EOF'\n{VITEST_CONTRADICTING_SUMMARY}EOF\n"
        f"exit {pnpm_exit}\n"
    )

    cargo = bin_dir / "cargo"
    cargo.write_text(f"#!/usr/bin/env bash\necho 'test result: ok'\nexit {cargo_exit}\n")

    for stub in (pnpm, cargo):
        stub.chmod(0o755)
    return bin_dir


def _run(tmp_path: Path, pnpm_exit: int, cargo_exit: int) -> subprocess.CompletedProcess[str]:
    bin_dir = _stub_bin(tmp_path, pnpm_exit, cargo_exit)
    env = dict(os.environ)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    return subprocess.run(
        ["bash", str(SCRIPT)],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        env=env,
    )


def test_script_exists_and_is_executable():
    assert SCRIPT.is_file(), f"test script missing at {SCRIPT}"


def test_all_passing_reports_success_and_exits_zero(tmp_path: Path):
    result = _run(tmp_path, pnpm_exit=0, cargo_exit=0)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ALL TESTS PASSED." in result.stdout
    assert "FAIL" not in result.stdout


def test_failing_frontend_exits_non_zero(tmp_path: Path):
    result = _run(tmp_path, pnpm_exit=1, cargo_exit=0)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "ALL TESTS PASSED." not in result.stdout


def test_failing_frontend_prints_a_verdict_beside_the_passing_summary(tmp_path: Path):
    """The bug: a passing count and a failing run, with no verdict between them.

    vitest's own summary says "3223 passed" on this run. Without an explicit
    per-suite verdict the next thing printed is the *next section header*, so
    the failure scrolls away under minutes of cargo output and a reader
    scrolling back lands on the pass line.
    """
    result = _run(tmp_path, pnpm_exit=1, cargo_exit=0)

    assert "3223 passed" in result.stdout, "stub should reproduce the contradicting summary"
    # The verdict must appear, name the suite, and carry the exit code.
    assert "FAIL: Frontend: Vitest (exit 1)" in result.stdout

    # ...and it must come *after* the misleading pass line, so the last word on
    # that suite is the verdict rather than the count.
    assert result.stdout.index("FAIL: Frontend: Vitest") > result.stdout.index("3223 passed")


def test_summary_names_which_suite_failed(tmp_path: Path):
    """"SOME TESTS FAILED." alone does not say which — so the reader goes hunting."""
    result = _run(tmp_path, pnpm_exit=1, cargo_exit=0)
    tail = result.stdout[result.stdout.index("SOME TESTS FAILED") :]
    assert "Frontend: Vitest (exit 1)" in tail
    assert "Rust workspace" not in tail, "a passing suite must not be listed as failed"


def test_summary_names_only_the_failing_rust_suite(tmp_path: Path):
    result = _run(tmp_path, pnpm_exit=0, cargo_exit=101)
    assert result.returncode == 1
    tail = result.stdout[result.stdout.index("SOME TESTS FAILED") :]
    assert "Rust workspace: cargo test (exit 101)" in tail
    assert "Frontend" not in tail


def test_summary_names_every_failing_suite(tmp_path: Path):
    result = _run(tmp_path, pnpm_exit=1, cargo_exit=101)
    assert result.returncode == 1
    tail = result.stdout[result.stdout.index("SOME TESTS FAILED") :]
    assert "Frontend: Vitest (exit 1)" in tail
    assert "Rust workspace: cargo test (exit 101)" in tail


def test_a_failing_suite_does_not_stop_the_next_one(tmp_path: Path):
    """set -e must not abort the run: both suites report even when the first fails."""
    result = _run(tmp_path, pnpm_exit=1, cargo_exit=0)
    assert "=== Rust workspace: cargo test ===" in result.stdout
    assert "PASS: Rust workspace: cargo test" in result.stdout

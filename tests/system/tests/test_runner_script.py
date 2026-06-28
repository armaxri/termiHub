"""Unit tests for the one-command runner ``scripts/test-system-py.sh`` (#898).

These drive the script's ``--dry-run`` mode, which resolves the plan (build
profile, build action, fixtures, forwarded pytest args) and exits *before* any
build / Docker / pytest side effect — so the argument parsing and plan
resolution are covered without launching the app or bringing up containers.

Skipped when no POSIX ``bash`` is available (e.g. native Windows without Git
Bash); the script itself is exercised through its ``.cmd`` delegator there.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "test-system-py.sh"

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None, reason="POSIX bash unavailable"
)


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def _plan(stdout: str) -> dict[str, str]:
    """Parse the ``key: value`` lines emitted by --dry-run into a dict."""
    plan: dict[str, str] = {}
    for line in stdout.splitlines():
        if ": " in line:
            key, _, value = line.partition(": ")
            plan[key.strip()] = value.strip()
    return plan


def test_script_exists_and_is_executable():
    assert SCRIPT.is_file(), f"runner script missing at {SCRIPT}"


def test_help_describes_the_runner():
    result = _run("--help")
    assert result.returncode == 0
    assert "One-command runner" in result.stdout
    assert "--fixtures" in result.stdout


def test_dry_run_resolves_debug_profile_and_forwards_pytest_args():
    result = _run("--dry-run", "--debug", "-k", "sftp_infra", "-x", "-s")
    assert result.returncode == 0, result.stderr
    plan = _plan(result.stdout)
    assert plan["profile"] == "debug"
    assert "target/debug/" in plan["binary"]
    assert plan["fixtures"] == "(none)"
    assert plan["pytest"] == "-k sftp_infra -x -s"


def test_dry_run_defaults_to_release():
    plan = _plan(_run("--dry-run").stdout)
    assert plan["profile"] == "release"
    assert "target/release/" in plan["binary"]


def test_dry_run_lists_fixtures_and_skip_build():
    result = _run(
        "--dry-run",
        "--skip-build",
        "--fixtures",
        "ssh-password ssh-keys",
        "-m",
        "integration",
    )
    assert result.returncode == 0, result.stderr
    plan = _plan(result.stdout)
    assert plan["fixtures"] == "ssh-password ssh-keys"
    assert plan["build"].startswith("skip")
    assert plan["pytest"] == "-m integration"


def test_double_dash_forwards_remaining_args_verbatim():
    result = _run("--dry-run", "--", "--maxfail=2", "--debug")
    plan = _plan(result.stdout)
    # Everything after `--` goes to pytest, even a token that looks like a runner
    # flag (`--debug` here must NOT switch the profile to debug).
    assert plan["profile"] == "release"
    assert plan["pytest"] == "--maxfail=2 --debug"


def test_fixtures_without_value_errors():
    result = _run("--dry-run", "--fixtures")
    assert result.returncode != 0
    assert "requires a value" in result.stderr


def test_empty_args_are_safe_under_set_u():
    # An empty fixtures value and an empty pytest-arg list must not trip
    # `set -u` (bash 3.2 on macOS errors on empty-array expansion).
    result = _run("--dry-run", "--fixtures", "")
    assert result.returncode == 0, result.stderr
    plan = _plan(result.stdout)
    assert plan["fixtures"] == "(none)"
    assert plan["pytest"] == "(none)"

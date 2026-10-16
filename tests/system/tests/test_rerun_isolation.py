"""Rerun isolation for class-scoped suites (#4829).

The nightly lane runs under ``--reruns``, and pytest-rerunfailures re-runs a
failed test against the *same* class-scoped app. These checks run a throwaway
pytest session (in a subprocess, with the real harness conftest) whose suite
drives a fake tab model instead of the app, and prove that:

* a rerun of a test that leaves a tab open and then fails starts with no tabs
  when the suite opts into :meth:`SystemTest.reset_before_rerun`;
* without that reset the rerun really does inherit the tab (so the check above
  is not passing by accident);
* a reset that cannot close the tabs fails with a ``RerunResetError`` naming the
  leftover tab, not a misleading precondition failure;
* every failed attempt's error is kept in the bundle as
  ``attempt-<n>-failure.txt``, so the first attempt's real failure stays visible.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from termihub_harness import artifacts

HARNESS_ROOT = Path(artifacts.__file__).resolve().parents[1]

# A suite that fakes the app's panel tree: tabs live in a plain list, the close
# button removes one (unless the fake is "stuck"), and the class-scoped app
# fixture is replaced so no real app launches.
SUITE = """
import pytest

from termihub_harness import SystemTest, TabsUi


class FakeDriver:
    def __init__(self, stuck):
        self.tabs = []
        self.stuck = stuck

    def get_state(self, path=None, timeout=None):
        tabs = [{{"id": t}} for t in self.tabs]
        return {{"type": "leaf", "id": "p", "tabs": tabs}}

    def click(self, testid):
        tab = testid.removeprefix("tab-close-")
        if not self.stuck and tab in self.tabs:
            self.tabs.remove(tab)

    def exists(self, testid):
        return False

    def read_terminal(self, timeout=None):
        return ""


class TestLeavesTabThenFails(TabsUi, SystemTest):
    @pytest.fixture(scope="class", autouse=True)
    @classmethod
    def _system_test_app(cls, request):
        request.cls.driver = FakeDriver(stuck={stuck})
        yield

{reset}

    def test_starts_empty(self, request):
        assert self.tab_count() == 0, f"rerun inherited tabs {{self.tab_ids()}}"
        self.driver.tabs.append(f"tab-{{request.node.execution_count}}")
        if request.node.execution_count == 1:
            raise AssertionError("first-attempt boom")
"""

RESET = """
    def reset_before_rerun(self):
        self.reset_tabs(timeout=1.0)
"""


def _run_suite(tmp_path: Path, *, reset: bool, stuck: bool = False):
    test_file = tmp_path / "test_rerun_suite.py"
    test_file.write_text(
        textwrap.dedent(SUITE).format(stuck=stuck, reset=RESET if reset else ""),
        encoding="utf-8",
    )
    env = {**os.environ}
    env.pop("PYTEST_XDIST_WORKER", None)
    env.pop("GITHUB_STEP_SUMMARY", None)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-p",
            "no:cacheprovider",
            # The test file lives outside the harness tree, so load the harness
            # conftest explicitly (importable via pythonpath = ".").
            "-p",
            "conftest",
            "--rootdir",
            str(HARNESS_ROOT),
            "-c",
            str(HARNESS_ROOT / "pyproject.toml"),
            "--reruns",
            "1",
            "-r",
            "aR",
            "-s",
            str(test_file),
        ],
        cwd=HARNESS_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    return result, result.stdout + result.stderr


@pytest.fixture
def bundle_dirs():
    """Collect and remove the failure-bundle dirs a subprocess run wrote."""
    dirs: list[Path] = []
    yield dirs
    for d in dirs:
        shutil.rmtree(d, ignore_errors=True)


def _bundle_dir(output: str, dirs: list[Path]) -> Path:
    match = re.search(r"\[rerun-attempt\] attempt 1 \w+ failure saved to (\S+)", output)
    assert match, output
    dest = Path(match.group(1)).parent
    dirs.append(dest)
    return dest


def test_rerun_starts_clean_after_reset(tmp_path, bundle_dirs):
    result, output = _run_suite(tmp_path, reset=True)
    dest = _bundle_dir(output, bundle_dirs)
    assert result.returncode == 0, output
    assert "1 passed, 1 rerun" in output, output
    # The first attempt's real error survives in the bundle.
    first = (dest / "attempt-1-failure.txt").read_text(encoding="utf-8")
    assert "first-attempt boom" in first


def test_rerun_without_reset_inherits_the_tab(tmp_path, bundle_dirs):
    # Control: the fake really does leak state into the rerun, so the passing
    # check above is down to the reset, not to the fake.
    result, output = _run_suite(tmp_path, reset=False)
    dest = _bundle_dir(output, bundle_dirs)
    assert result.returncode != 0, output
    assert "rerun inherited tabs ['tab-1']" in output, output
    assert "first-attempt boom" in (dest / "attempt-1-failure.txt").read_text(
        encoding="utf-8"
    )
    assert "rerun inherited tabs" in (dest / "attempt-2-failure.txt").read_text(
        encoding="utf-8"
    )


def test_failed_reset_is_reported_as_such(tmp_path, bundle_dirs):
    result, output = _run_suite(tmp_path, reset=True, stuck=True)
    dest = _bundle_dir(output, bundle_dirs)
    assert result.returncode != 0, output
    assert "RerunResetError" in output, output
    assert "could not reset the app before rerun attempt 2" in output, output
    assert "tab reset left 1 tab(s) open: ['tab-1']" in output, output
    # The reset failure is a setup-phase error; the first attempt's error is
    # still on disk next to it.
    assert "first-attempt boom" in (dest / "attempt-1-failure.txt").read_text(
        encoding="utf-8"
    )
    assert "setup phase" in (dest / "attempt-2-failure.txt").read_text(encoding="utf-8")


def test_record_failed_attempt_replaces_then_appends(tmp_path):
    target = artifacts.record_failed_attempt(tmp_path, 1, "call", "old run\n")
    assert target == tmp_path / "attempt-1-failure.txt"
    artifacts.record_failed_attempt(tmp_path, 1, "call", "boom")
    artifacts.record_failed_attempt(tmp_path, 1, "teardown", "bang", append=True)
    text = target.read_text(encoding="utf-8")
    assert "old run" not in text
    assert "=== attempt 1, call phase ===\nboom\n" in text
    assert "=== attempt 1, teardown phase ===\nbang\n" in text

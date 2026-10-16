"""Unit tests for the deployed-agent staging CLI (#4479; no app launch).

``python -m termihub_harness.stage_agent`` is what the nightly workflow runs to
stage the musl agent before pre-building the ``agent``-profile images. It must
reuse :func:`~termihub_harness.fixtures.stage_remote_agent_binary` (no copied
recipe) and fail the step, not skip, when it cannot stage.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from termihub_harness import fixtures as fx
from termihub_harness import stage_agent

SYSTEM_DIR = Path(__file__).resolve().parents[1]


def test_stages_through_the_harness_function(monkeypatch, tmp_path, capsys):
    staged = tmp_path / "termihub-agent"
    seen: list[float] = []

    def fake_stage(*, build_timeout: float) -> Path:
        seen.append(build_timeout)
        return staged

    monkeypatch.setattr(fx, "stage_remote_agent_binary", fake_stage)
    assert stage_agent.main([]) == 0
    assert seen == [1500.0], "defaults to the harness' own build ceiling"
    assert capsys.readouterr().out.strip().splitlines()[-1] == str(staged)


def test_build_timeout_is_passed_through(monkeypatch, tmp_path):
    seen: list[float] = []
    monkeypatch.setattr(
        fx,
        "stage_remote_agent_binary",
        lambda *, build_timeout: seen.append(build_timeout) or tmp_path,
    )
    assert stage_agent.main(["--build-timeout", "90"]) == 0
    assert seen == [90.0]


@pytest.mark.parametrize(
    "exc",
    [
        fx.ContainerRuntimeUnavailable("no container runtime"),
        fx.ComposeFixtureFailed("cross-rs not found"),
    ],
    ids=["runtime-unavailable", "build-failed"],
)
def test_not_staged_fails_instead_of_skipping(monkeypatch, capsys, exc):
    def boom(*, build_timeout: float) -> Path:
        raise exc

    monkeypatch.setattr(fx, "stage_remote_agent_binary", boom)
    assert stage_agent.main([]) == 1
    assert str(exc) in capsys.readouterr().err


@pytest.mark.parametrize("argv", [["--build-timeout", "0"], ["--bogus"]])
def test_bad_arguments_exit_2(argv):
    with pytest.raises(SystemExit) as info:
        stage_agent.main(argv)
    assert info.value.code == 2


def test_runs_as_a_module():
    """The workflow invokes it with ``python -m`` from ``tests/system``."""
    result = subprocess.run(
        [sys.executable, "-m", "termihub_harness.stage_agent", "--help"],
        cwd=SYSTEM_DIR,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "--build-timeout" in result.stdout

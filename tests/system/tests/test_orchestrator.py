"""Unit tests for the orchestrator's built-app discovery (no app launch).

Covers the release/debug/override resolution added so the fast local loop can run
against a `pnpm tauri build --debug` artifact instead of only a release build.
These are machinery tests (no `integration` marker) — they monkeypatch the repo
root and platform, so they need no build and run anywhere.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from termihub_harness import orchestrator


@pytest.fixture
def fake_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the orchestrator at an empty temp 'repo' and a Linux layout."""
    monkeypatch.setattr(orchestrator, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(orchestrator.platform, "system", lambda: "Linux")
    monkeypatch.delenv("TERMIHUB_TEST_APP_BINARY", raising=False)
    return tmp_path


def _make_binary(repo: Path, profile: str) -> Path:
    """Create a stub app binary under ``target/<profile>`` for the Linux layout."""
    path = repo / "target" / profile / "termihub"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n")
    return path


def test_prefers_release_over_debug(fake_repo: Path):
    release = _make_binary(fake_repo, "release")
    _make_binary(fake_repo, "debug")
    assert orchestrator.app_binary_path() == release


def test_falls_back_to_debug_build(fake_repo: Path):
    debug = _make_binary(fake_repo, "debug")
    assert orchestrator.app_binary_path() == debug


def test_env_override_wins(fake_repo: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _make_binary(fake_repo, "release")  # would otherwise be chosen
    override = tmp_path / "custom-termihub"
    override.write_text("#!/bin/sh\n")
    monkeypatch.setenv("TERMIHUB_TEST_APP_BINARY", str(override))
    assert orchestrator.app_binary_path() == override


def test_env_override_missing_file_raises(fake_repo: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("TERMIHUB_TEST_APP_BINARY", "/no/such/binary")
    with pytest.raises(FileNotFoundError, match="TERMIHUB_TEST_APP_BINARY"):
        orchestrator.app_binary_path()


def test_no_build_raises_with_both_paths(fake_repo: Path):
    with pytest.raises(FileNotFoundError) as exc:
        orchestrator.app_binary_path()
    # The error names both the release and debug locations it looked in.
    # Path objects render with OS-native separators (backslashes on Windows),
    # so normalize before the substring check to stay separator-agnostic.
    message = str(exc.value).replace("\\", "/")
    assert "target/release" in message
    assert "target/debug" in message


def test_candidates_are_release_then_debug(fake_repo: Path):
    release, debug = orchestrator.app_binary_candidates()
    assert release == fake_repo / "target/release/termihub"
    assert debug == fake_repo / "target/debug/termihub"

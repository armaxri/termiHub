"""Unit tests for the Git Bash detector (#1016).

Machinery group (no app, no Windows): :func:`git_bash_installed_at` is a pure
function of its path list, so both the present and absent cases are asserted on
any host against real temp files. This mirrors the backend's
``GIT_BASH_PATHS.iter().any(...)`` probe in ``core/src/session/shell.rs`` so the
Python gate and the backend agree on what counts as an installed Git Bash.
"""

from __future__ import annotations

from termihub_harness.git_bash import (
    GIT_BASH_PATHS,
    detect_git_bash,
    git_bash_installed_at,
)


def test_reports_installed_when_a_path_exists(tmp_path):
    bash = tmp_path / "bash.exe"
    bash.write_text("")
    missing = tmp_path / "nope.exe"
    assert git_bash_installed_at([str(missing), str(bash)]) is True


def test_reports_absent_when_no_path_exists(tmp_path):
    assert git_bash_installed_at([str(tmp_path / "a.exe"), str(tmp_path / "b.exe")]) is False


def test_empty_path_list_is_absent():
    assert git_bash_installed_at([]) is False


def test_paths_mirror_the_backend_install_locations():
    # The gate probes exactly the two fixed locations the Rust backend checks.
    assert GIT_BASH_PATHS == (
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    )


def test_detect_returns_false_off_windows(monkeypatch):
    # The path gate short-circuits on non-Windows hosts (Git Bash is Windows-only).
    monkeypatch.setattr("termihub_harness.git_bash.sys.platform", "linux")
    assert detect_git_bash() is False

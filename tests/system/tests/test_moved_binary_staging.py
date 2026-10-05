"""Unit tests for the moved-binary shell-integration staging (#3691; no app launch).

Covers :mod:`termihub_harness.moved_binary` and ``AppInstance(sandbox_profile=…)``
plus ``run_cli(binary=…)``: where the moved copy lands, when a real registration
may run, and that the profile redirect reaches both the app and the CLI. These
are machinery tests (no ``integration`` marker), so they run in the normal lane.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from termihub_harness import moved_binary, orchestrator


def _fake_bundle_binary(tmp_path: Path) -> Path:
    macos = tmp_path / "build" / "termiHub.app" / "Contents" / "MacOS"
    macos.mkdir(parents=True)
    binary = macos / "termiHub"
    binary.write_bytes(b"fake mach-o")
    return binary


def _fake_binary(tmp_path: Path) -> Path:
    binary = tmp_path / "build" / "termihub"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"\x7fELF fake")
    return binary


# ── stage_moved_copy ─────────────────────────────────────────────────────────
def test_moved_copy_is_the_bare_executable_in_the_new_dir(tmp_path):
    binary = _fake_bundle_binary(tmp_path)
    moved = moved_binary.stage_moved_copy(binary, tmp_path / "moved")

    assert moved == tmp_path / "moved" / "termiHub"
    assert moved.read_bytes() == b"fake mach-o"
    # Only the executable: no bundle structure is recreated.
    assert sorted(p.name for p in (tmp_path / "moved").iterdir()) == ["termiHub"]
    # Deleting the copy ("moving" the app) leaves the original intact.
    moved.unlink()
    assert binary.is_file()


# ── real_registration_skip_reason ────────────────────────────────────────────
def test_linux_always_runs_because_the_profile_is_sandboxed():
    assert moved_binary.real_registration_skip_reason("Linux", {}) is None


@pytest.mark.parametrize("system", ["Darwin", "Windows"])
def test_macos_and_windows_skip_locally(system):
    reason = moved_binary.real_registration_skip_reason(system, {})
    assert reason is not None
    assert moved_binary.ALLOW_REAL_REGISTRATION_ENV in reason


@pytest.mark.parametrize(
    "env",
    [{"CI": "true"}, {"CI": "1"}, {moved_binary.ALLOW_REAL_REGISTRATION_ENV: "1"}],
)
@pytest.mark.parametrize("system", ["Darwin", "Windows"])
def test_macos_and_windows_run_on_ci_or_with_the_opt_in(system, env):
    assert moved_binary.real_registration_skip_reason(system, env) is None


@pytest.mark.parametrize("value", ["", "0", "false", "No"])
def test_falsy_ci_values_do_not_unlock_a_real_registration(value):
    assert moved_binary.real_registration_skip_reason("Darwin", {"CI": value}) is not None


# ── AppInstance(sandbox_profile=…) / run_cli(binary=…) ───────────────────────
@pytest.fixture
def linux_binary(tmp_path, monkeypatch):
    binary = _fake_binary(tmp_path)
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: binary)
    monkeypatch.setattr(orchestrator.platform, "system", lambda: "Linux")
    monkeypatch.setattr(orchestrator.portable_staging.platform, "system", lambda: "Linux")
    return binary


def test_sandbox_profile_redirects_xdg_for_app_and_cli(tmp_path, linux_binary):
    cfg = tmp_path / "cfg"
    instance = orchestrator.AppInstance(config_dir=cfg, sandbox_profile=True)
    home = cfg / "profile-home"

    for env in (instance.launch_env(), instance.cli_env()):
        assert env["TERMIHUB_CONFIG_DIR"] == str(cfg)
        assert env["XDG_DATA_HOME"] == str(home / ".local" / "share")
        assert env["XDG_CONFIG_HOME"] == str(home / ".config")


def test_without_sandbox_profile_the_env_is_untouched(tmp_path, linux_binary, monkeypatch):
    monkeypatch.setenv("XDG_DATA_HOME", "/real/share")
    instance = orchestrator.AppInstance(config_dir=tmp_path / "cfg")
    assert instance.launch_env()["XDG_DATA_HOME"] == "/real/share"
    assert instance.cli_env()["XDG_DATA_HOME"] == "/real/share"


def test_run_cli_can_run_another_copy_against_the_same_config(
    tmp_path, linux_binary, monkeypatch
):
    captured: dict = {}

    class _Done:
        args = ["x"]
        returncode = 0

        def communicate(self, timeout=None):
            return ("ok", "")

    def _fake_popen(argv, *, env, **_kwargs):
        captured["argv"] = list(argv)
        captured["env"] = env
        return _Done()

    monkeypatch.setattr(orchestrator.subprocess, "Popen", _fake_popen)
    instance = orchestrator.AppInstance(config_dir=tmp_path / "cfg", sandbox_profile=True)
    moved = tmp_path / "moved" / "termihub"

    result = instance.run_cli(["install-shell-integration"], binary=moved)
    assert isinstance(result, subprocess.CompletedProcess)
    assert captured["argv"] == [str(moved), "install-shell-integration"]
    assert captured["env"]["TERMIHUB_CONFIG_DIR"] == str(tmp_path / "cfg")
    assert "XDG_DATA_HOME" in captured["env"]

    instance.run_cli(["uninstall-shell-integration"])
    assert captured["argv"] == [str(linux_binary), "uninstall-shell-integration"]

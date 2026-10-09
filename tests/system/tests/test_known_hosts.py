"""Unit tests for the harness's per-run known_hosts file (#4339, MOCK2-002).

The throwaway sshd endpoints pre-trust their host key so the app's strict
host-key check passes. These tests pin that the trust goes into a per-run temp
file the app is pointed at, and that the user's ``~/.ssh/known_hosts`` is never
read or written, even when a run dies without cleaning up.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from termihub_harness import known_hosts
from termihub_harness import orchestrator

KEY_A = "AAAAC3NzaC1lZDI1NTE5AAAAIKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
KEY_B = "AAAAC3NzaC1lZDI1NTE5AAAAIKeyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"


@pytest.fixture
def run_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "run" / "known_hosts"
    path.parent.mkdir()
    path.write_text("", encoding="utf-8")
    monkeypatch.setattr(known_hosts, "_file", path)
    return path


@pytest.fixture
def fake_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    (home / ".ssh").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setenv("HOME", str(home))
    return home


def test_file_is_a_fresh_temp_file_outside_home(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(known_hosts, "_file", None)
    path = known_hosts.known_hosts_file()
    assert path.is_file()
    assert path.read_text(encoding="utf-8") == ""
    assert path.name == "known_hosts"
    assert path.parent.name.startswith("termihub-known-hosts-")
    assert Path.home() / ".ssh" not in path.parents
    assert known_hosts.known_hosts_file() == path, "one file per process"


def test_host_token_brackets_non_default_ports() -> None:
    assert known_hosts.host_token("127.0.0.1", 22) == "127.0.0.1"
    assert known_hosts.host_token("127.0.0.1", 2222) == "[127.0.0.1]:2222"


def test_trust_replaces_an_earlier_entry_for_the_same_port(run_file: Path) -> None:
    known_hosts.trust("127.0.0.1", 40022, "ssh-ed25519", KEY_A)
    known_hosts.trust("127.0.0.1", 40022, "ssh-ed25519", KEY_B)
    assert run_file.read_text(encoding="utf-8") == f"[127.0.0.1]:40022 ssh-ed25519 {KEY_B}\n"


def test_untrust_matches_the_host_token_exactly(run_file: Path) -> None:
    run_file.write_text(
        f"[127.0.0.1]:2222 ssh-ed25519 {KEY_A}\n"
        f"[127.0.0.1]:22220 ssh-ed25519 {KEY_A}\n"
        f"# [127.0.0.1]:2222 is mentioned in this comment\n"
        f"example.org,[127.0.0.1]:2222 ssh-ed25519 {KEY_A}",
        encoding="utf-8",
    )
    known_hosts.untrust("127.0.0.1", 2222)
    assert run_file.read_text(encoding="utf-8") == (
        f"[127.0.0.1]:22220 ssh-ed25519 {KEY_A}\n"
        f"# [127.0.0.1]:2222 is mentioned in this comment\n"
        f"example.org,[127.0.0.1]:2222 ssh-ed25519 {KEY_A}\n"
    )


def test_untrust_without_an_entry_is_a_no_op(run_file: Path) -> None:
    run_file.write_text(f"[127.0.0.1]:1 ssh-ed25519 {KEY_A}\n", encoding="utf-8")
    known_hosts.untrust("127.0.0.1", 2)
    assert run_file.read_text(encoding="utf-8") == f"[127.0.0.1]:1 ssh-ed25519 {KEY_A}\n"


def test_rewrite_leaves_no_temp_files_behind(run_file: Path) -> None:
    known_hosts.trust("127.0.0.1", 40022, "ssh-ed25519", KEY_A)
    known_hosts.untrust("127.0.0.1", 40022)
    assert sorted(p.name for p in run_file.parent.iterdir()) == ["known_hosts"]


def test_trust_pubkey_file_drops_the_comment(run_file: Path, tmp_path: Path) -> None:
    pub = tmp_path / "host_key.pub"
    pub.write_text(f"ssh-ed25519 {KEY_A} someone@somewhere\n", encoding="utf-8")
    assert known_hosts.trust_pubkey_file("127.0.0.1", 40022, pub) == "[127.0.0.1]:40022"
    assert run_file.read_text(encoding="utf-8") == f"[127.0.0.1]:40022 ssh-ed25519 {KEY_A}\n"


def test_the_users_known_hosts_is_never_touched(run_file: Path, fake_home: Path) -> None:
    real = fake_home / ".ssh" / "known_hosts"
    original = f"[127.0.0.1]:40022 ssh-ed25519 {KEY_B}\nexample.org ssh-ed25519 {KEY_A}\n"
    real.write_text(original, encoding="utf-8")
    before = real.stat().st_mtime_ns

    known_hosts.trust("127.0.0.1", 40022, "ssh-ed25519", KEY_A)
    known_hosts.untrust("127.0.0.1", 40022)

    assert real.read_text(encoding="utf-8") == original
    assert real.stat().st_mtime_ns == before


def test_app_launch_env_points_at_the_run_file(
    run_file: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Every app launch (and CLI call) reads the per-run file, not ~/.ssh."""
    binary = tmp_path / "termihub"
    binary.write_text("", encoding="utf-8")
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: binary)
    app = orchestrator.AppInstance(config_dir=tmp_path / "cfg")
    assert app.launch_env()[known_hosts.KNOWN_HOSTS_ENV] == str(run_file)
    assert app.cli_env()[known_hosts.KNOWN_HOSTS_ENV] == str(run_file)


def test_env_name_matches_the_app() -> None:
    """The harness and the test-bridge build agree on the variable name."""
    source = (
        orchestrator.REPO_ROOT / "src-tauri" / "src" / "utils" / "test_bridge.rs"
    ).read_text(encoding="utf-8")
    assert f'TEST_KNOWN_HOSTS_FILE_ENV: &str = "{known_hosts.KNOWN_HOSTS_ENV}"' in source


def test_a_killed_run_leaves_the_users_file_untouched(fake_home: Path, tmp_path: Path) -> None:
    """A run killed mid-test (no cleanup, no atexit) never edited ~/.ssh/known_hosts."""
    real = fake_home / ".ssh" / "known_hosts"
    original = f"example.org ssh-ed25519 {KEY_A}\n"
    real.write_text(original, encoding="utf-8")
    harness_root = Path(known_hosts.__file__).resolve().parents[1]
    script = textwrap.dedent(
        f"""
        import os, sys
        sys.path.insert(0, {str(harness_root)!r})
        from termihub_harness import known_hosts
        known_hosts.trust("127.0.0.1", 40022, "ssh-ed25519", {KEY_B!r})
        print(known_hosts.known_hosts_file(), flush=True)
        os._exit(9)
        """
    )
    env = dict(os.environ, HOME=str(fake_home), USERPROFILE=str(fake_home))
    result = subprocess.run(
        [sys.executable, "-c", script], env=env, capture_output=True, text=True, timeout=60
    )
    assert result.returncode == 9, result.stderr
    run_path = Path(result.stdout.strip())
    try:
        assert f"[127.0.0.1]:40022 ssh-ed25519 {KEY_B}" in run_path.read_text(encoding="utf-8")
        assert real.read_text(encoding="utf-8") == original
    finally:
        shutil.rmtree(run_path.parent, ignore_errors=True)

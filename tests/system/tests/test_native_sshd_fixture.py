"""Unit tests for the harness side of the native sshd fixture (CI-020, TIN-007).

:class:`NativeSshdFixture` wraps the endpoint that
``scripts/internal/native-sshd-fixture.sh up`` provisions (the only way to get an
sshd on the Windows runner) behind ``LocalAgentSshd``'s interface. These tests
pin its env contract, its ``known_hosts`` bookkeeping and the endpoint choice of
:func:`local_agent_endpoint` without starting any sshd (the fixture script calls
are stubbed); the real round trip runs in the nightly agent reconnect grade.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from termihub_harness import local_agent
from termihub_harness.local_agent import (
    LocalAgentUnavailable,
    NativeSshdFixture,
    local_agent_endpoint,
)

HOST_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTests termihub-native-sshd-host\n"


@pytest.fixture
def native_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A complete TERMIHUB_NATIVE_SSHD_* env and a throwaway home dir."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    pub = tmp_path / "host_ed25519_key.pub"
    pub.write_text(HOST_PUB, encoding="utf-8")
    agent = tmp_path / "termihub-agent"
    agent.write_text("", encoding="utf-8")
    monkeypatch.setenv("TERMIHUB_NATIVE_SSHD", "1")
    monkeypatch.setenv("TERMIHUB_NATIVE_SSHD_PORT", "30400")
    monkeypatch.setenv("TERMIHUB_NATIVE_SSHD_USER", "termihubssh")
    monkeypatch.setenv("TERMIHUB_NATIVE_SSHD_KEY", str(tmp_path / "client_ed25519_key"))
    monkeypatch.setenv("TERMIHUB_NATIVE_SSHD_HOST_PUBKEY", str(pub))
    monkeypatch.setenv("TERMIHUB_NATIVE_SSHD_DIR", str(tmp_path))
    monkeypatch.setenv("TERMIHUB_NATIVE_SSHD_AGENT_BIN", str(agent))
    return home


def _known_hosts(home: Path) -> str:
    path = home / ".ssh" / "known_hosts"
    return path.read_text(encoding="utf-8") if path.exists() else ""


def test_reads_the_fixture_env_and_trusts_its_host_key(native_env: Path) -> None:
    fixture = NativeSshdFixture()
    assert fixture.port == 30400
    assert fixture.username == "termihubssh"
    assert fixture.client_key_path.endswith("client_ed25519_key")
    assert fixture.agent_binary_path.endswith("termihub-agent")
    assert "[127.0.0.1]:30400 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTests" in _known_hosts(
        native_env
    )


def test_cleanup_restarts_a_stopped_fixture_and_drops_only_its_known_host(
    native_env: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ssh_dir = native_env / ".ssh"
    ssh_dir.mkdir()
    (ssh_dir / "known_hosts").write_text("[example.org]:22 ssh-ed25519 AAAAkeep\n", encoding="utf-8")
    calls: list[str] = []
    monkeypatch.setattr(NativeSshdFixture, "_fixture", lambda self, action: calls.append(action))
    monkeypatch.setattr(NativeSshdFixture, "is_listening", lambda self: False)

    fixture = NativeSshdFixture()
    fixture.stop()
    fixture.cleanup()

    assert calls == ["stop", "start"], "cleanup must leave the shared fixture running"
    assert _known_hosts(native_env) == "[example.org]:22 ssh-ed25519 AAAAkeep\n"


def test_incomplete_env_is_unavailable(native_env: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TERMIHUB_NATIVE_SSHD_KEY")
    with pytest.raises(LocalAgentUnavailable, match="TERMIHUB_NATIVE_SSHD_KEY"):
        NativeSshdFixture()


def test_endpoint_prefers_the_native_fixture_when_present(native_env: Path) -> None:
    assert isinstance(local_agent_endpoint(), NativeSshdFixture)


def test_windows_without_the_fixture_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TERMIHUB_NATIVE_SSHD_PORT", raising=False)
    monkeypatch.setattr(local_agent, "_IS_WINDOWS", True)
    with pytest.raises(LocalAgentUnavailable, match="native sshd fixture"):
        local_agent_endpoint()

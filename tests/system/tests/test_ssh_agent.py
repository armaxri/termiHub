"""Unit tests for termihub_harness.ssh_agent (issues #957, #4953).

Machinery group (no app, no live agent): the fingerprint parser is pure, and the
``agent_has_key`` decision logic is exercised with a stubbed subprocess runner,
so these run anywhere — like the other harness-internal tests. One test does hit
real ``ssh-keygen`` against the committed fixture key, guarded on the binary
being present so it stays green where OpenSSH is absent.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from termihub_harness import (
    PrivateSshAgent,
    PrivateSshAgentUnavailable,
    agent_has_key,
    key_fingerprint,
    sha256_fingerprints,
)
from termihub_harness import ssh_agent

#: Committed key the guided-manual agent-auth test asks to be loaded; its
#: fingerprint is stable, so we can assert on it directly.
_FIXTURE_KEY = (
    Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "ssh-keys" / "ed25519"
)
_FIXTURE_FINGERPRINT = "SHA256:5s/eJ8v5pE7dct0Zdom8VAT5eHqlWiYczm6UTU0cQt4"

# A representative two-key ``ssh-add -l`` listing.
_ADD_L_TWO_KEYS = (
    "256 SHA256:5s/eJ8v5pE7dct0Zdom8VAT5eHqlWiYczm6UTU0cQt4 test-ed25519@termihub-test (ED25519)\n"
    "3072 SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/abcd other@host (RSA)\n"
)


# ── sha256_fingerprints (pure parser) ────────────────────────────────────────
def test_sha256_fingerprints_extracts_every_key():
    assert sha256_fingerprints(_ADD_L_TWO_KEYS) == {
        "SHA256:5s/eJ8v5pE7dct0Zdom8VAT5eHqlWiYczm6UTU0cQt4",
        "SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/abcd",
    }


def test_sha256_fingerprints_empty_when_no_identities():
    assert sha256_fingerprints("The agent has no identities.\n") == set()


# ── agent_has_key (decision logic, stubbed subprocess) ───────────────────────
def _stub_run(monkeypatch, *, keygen: str | None, add_l: str | None):
    """Route ssh_agent._run to canned output by the command being invoked."""

    def fake(cmd):
        if cmd[0] == "ssh-keygen":
            return keygen
        if cmd[0] == "ssh-add":
            return add_l
        return None

    monkeypatch.setattr(ssh_agent, "_run", fake)


def test_agent_has_key_true_when_fingerprint_present(monkeypatch):
    _stub_run(
        monkeypatch,
        keygen=f"256 {_FIXTURE_FINGERPRINT} test-ed25519@termihub-test (ED25519)\n",
        add_l=_ADD_L_TWO_KEYS,
    )
    assert agent_has_key(Path("/nonexistent/ed25519")) is True


def test_agent_has_key_false_when_key_absent_from_agent(monkeypatch):
    _stub_run(
        monkeypatch,
        keygen=f"256 {_FIXTURE_FINGERPRINT} test-ed25519@termihub-test (ED25519)\n",
        add_l="3072 SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/abcd other@host (RSA)\n",
    )
    assert agent_has_key(Path("/nonexistent/ed25519")) is False


def test_agent_has_key_false_when_agent_unreachable(monkeypatch):
    # ``ssh-add -l`` returns non-zero (→ None) when no agent is reachable.
    _stub_run(
        monkeypatch,
        keygen=f"256 {_FIXTURE_FINGERPRINT} x (ED25519)\n",
        add_l=None,
    )
    assert agent_has_key(Path("/nonexistent/ed25519")) is False


def test_agent_has_key_false_when_fingerprint_uncomputable(monkeypatch):
    # ssh-keygen could not read the key (→ None): nothing to match against.
    _stub_run(monkeypatch, keygen=None, add_l=_ADD_L_TWO_KEYS)
    assert agent_has_key(Path("/nonexistent/ed25519")) is False


# ── key_fingerprint (real ssh-keygen against the committed fixture) ───────────
@pytest.mark.skipif(
    shutil.which("ssh-keygen") is None, reason="ssh-keygen not on PATH"
)
def test_key_fingerprint_matches_committed_fixture():
    assert key_fingerprint(_FIXTURE_KEY) == _FIXTURE_FINGERPRINT


# ── PrivateSshAgent (real ssh-agent on a private socket, #4953) ──────────────
_NO_PRIVATE_AGENT = os.name == "nt" or not (shutil.which("ssh-agent") and shutil.which("ssh-add"))


@pytest.mark.skipif(_NO_PRIVATE_AGENT, reason="needs POSIX ssh-agent and ssh-add")
def test_private_agent_holds_only_the_added_key_and_leaves_the_caller_alone():
    caller_sock = os.environ.get("SSH_AUTH_SOCK")
    with PrivateSshAgent() as agent:
        sock = agent.socket_path
        assert agent.app_env() == {"SSH_AUTH_SOCK": str(sock)}
        assert sock.exists()
        assert not agent.has_key(_FIXTURE_KEY), "a fresh private agent must be empty"
        agent.add_key(_FIXTURE_KEY)
        assert agent.has_key(_FIXTURE_KEY)
        # The key copy the agent loaded is private to the agent's temp dir.
        copies = list(sock.parent.glob("key-*"))
        assert [oct(c.stat().st_mode & 0o777) for c in copies] == ["0o600"]
    assert not sock.parent.exists(), "close() must remove the socket and key copy"
    assert os.environ.get("SSH_AUTH_SOCK") == caller_sock


@pytest.mark.skipif(_NO_PRIVATE_AGENT, reason="needs POSIX ssh-agent and ssh-add")
def test_private_agent_close_kills_the_agent_process():
    agent = PrivateSshAgent()
    process = agent._process
    assert process is not None and process.poll() is None
    agent.close()
    assert process.poll() is not None
    agent.close()  # idempotent


def test_private_agent_is_unavailable_on_windows(monkeypatch):
    monkeypatch.setattr(ssh_agent.os, "name", "nt")
    with pytest.raises(PrivateSshAgentUnavailable, match="system OpenSSH agent pipe"):
        PrivateSshAgent()

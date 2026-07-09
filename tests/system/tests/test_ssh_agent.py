"""Unit tests for termihub_harness.ssh_agent (issue #957).

Machinery group (no app, no live agent): the fingerprint parser is pure, and the
``agent_has_key`` decision logic is exercised with a stubbed subprocess runner,
so these run anywhere — like the other harness-internal tests. One test does hit
real ``ssh-keygen`` against the committed fixture key, guarded on the binary
being present so it stays green where OpenSSH is absent.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from termihub_harness import agent_has_key, key_fingerprint, sha256_fingerprints
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

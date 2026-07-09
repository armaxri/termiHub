"""Query the local ssh-agent — for guided-manual agent-auth tests (#957).

Loading a key into the operator's ssh-agent is an environmental precondition the
harness cannot perform portably. But whether a given key *is* loaded is
machine-checkable via the SHA256 fingerprints that both ``ssh-add -l`` and
``ssh-keygen -lf`` print. These helpers let a test verify that precondition
programmatically — proceeding unattended when the key is present and skipping
with an actionable message when it is not — instead of gating an operator on a
manual prompt.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Optional

#: OpenSSH renders key fingerprints as ``SHA256:<base64>`` in both ``ssh-add -l``
#: and ``ssh-keygen -lf`` output; this captures that token wherever it appears.
_FINGERPRINT_RE = re.compile(r"SHA256:[A-Za-z0-9+/=]+")


def sha256_fingerprints(text: str) -> set[str]:
    """Every ``SHA256:…`` key fingerprint appearing in ``text`` (order-free)."""
    return set(_FINGERPRINT_RE.findall(text))


def _run(cmd: list[str]) -> Optional[str]:
    """Stdout of ``cmd``, or ``None`` if it cannot run or returns non-zero.

    ``ssh-add -l`` exits non-zero both when the agent is empty and when no agent
    is reachable; either way there is no loaded key to match, so a ``None``
    result funnels the caller to the same "not loaded" outcome.
    """
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout if result.returncode == 0 else None


def key_fingerprint(key_path: Path) -> Optional[str]:
    """SHA256 fingerprint of the key at ``key_path`` (``None`` if uncomputable).

    Prefers the sibling ``.pub`` file when present: ``ssh-keygen -lf`` never
    needs a passphrase for a public key, so this can never block on a prompt.
    """
    pub = key_path.with_name(key_path.name + ".pub")
    target = pub if pub.exists() else key_path
    out = _run(["ssh-keygen", "-lf", str(target)])
    if out is None:
        return None
    return next(iter(sha256_fingerprints(out)), None)


def agent_has_key(key_path: Path) -> bool:
    """Whether the running ssh-agent holds the key at ``key_path``.

    Compares SHA256 fingerprints, so it detects the *specific* key rather than
    merely "some identity is loaded". Returns ``False`` when the key is absent,
    the agent is empty or unreachable, or the fingerprint cannot be computed.
    """
    fingerprint = key_fingerprint(key_path)
    if fingerprint is None:
        return False
    listing = _run(["ssh-add", "-l"])
    if listing is None:
        return False
    return fingerprint in sha256_fingerprints(listing)

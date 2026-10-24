"""Query an ssh-agent, or run a private one for agent-auth tests (#957, #4953).

Loading a key into the operator's ssh-agent is an environmental precondition the
harness cannot perform portably. But whether a given key *is* loaded is
machine-checkable via the SHA256 fingerprints that both ``ssh-add -l`` and
``ssh-keygen -lf`` print. These helpers let a test verify that precondition
programmatically — proceeding unattended when the key is present and skipping
with an actionable message when it is not — instead of gating an operator on a
manual prompt.

:class:`PrivateSshAgent` goes further for the automated agent-auth test
(MT-SSH-07, #4953): it starts a throwaway ``ssh-agent -D -a <tmp sock>`` that
holds only a 0600 copy of the key the test hands it. The suite's app gets that
socket as ``SSH_AUTH_SOCK``, so the developer's own agent and keys are never read,
changed or offered to the test server.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import time
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


class PrivateSshAgentUnavailable(Exception):
    """A private ssh-agent cannot be run on this host (the reason says why)."""


class PrivateSshAgent:
    """A throwaway ``ssh-agent`` on a private socket, killed by :meth:`close`.

    Usage::

        agent = PrivateSshAgent()       # raises PrivateSshAgentUnavailable
        agent.add_key(key_path)         # ssh-adds a 0600 copy of the key
        env = agent.app_env()           # {"SSH_AUTH_SOCK": <private socket>}
        ...
        agent.close()                   # kills the agent, removes the temp dir

    The agent runs in the foreground (``-D``) as a child process the harness
    owns, so :meth:`close` reaps exactly that process and nothing else. Every
    ``ssh-add`` call carries the private socket explicitly; the caller's own
    ``SSH_AUTH_SOCK`` is never used.

    Not available on Windows: the app's Windows agent client connects only to
    the system OpenSSH agent pipe (``openssh-ssh-agent``), which is the
    developer's own agent and so off limits to a test.
    """

    def __init__(self, ready_timeout: float = 10.0) -> None:
        if os.name == "nt":
            raise PrivateSshAgentUnavailable(
                "the app's Windows agent client only uses the system OpenSSH agent pipe"
            )
        agent_bin = shutil.which("ssh-agent")
        self._ssh_add = shutil.which("ssh-add")
        if not agent_bin or not self._ssh_add:
            raise PrivateSshAgentUnavailable("ssh-agent / ssh-add not found on PATH")
        # A short prefix keeps the socket path under the 104-byte sun_path limit
        # on macOS, whose $TMPDIR is already long.
        self._dir = Path(tempfile.mkdtemp(prefix="th-agent-"))
        os.chmod(self._dir, 0o700)
        self._sock = self._dir / "agent.sock"
        self._process: Optional[subprocess.Popen] = subprocess.Popen(
            [agent_bin, "-D", "-a", str(self._sock)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            self._wait_for_socket(ready_timeout)
        except BaseException:
            self.close()
            raise

    @property
    def socket_path(self) -> Path:
        return self._sock

    def app_env(self) -> dict[str, str]:
        """Environment that points a child process at this agent only."""
        return {"SSH_AUTH_SOCK": str(self._sock)}

    def add_key(self, key_path: Path) -> None:
        """Load a 0600 copy of the unencrypted key at ``key_path`` into the agent.

        ``ssh-add`` refuses a key file readable by others, and a git checkout
        does not keep the fixture key's mode, so the agent gets a private copy.
        """
        copy = self._dir / f"key-{len(list(self._dir.glob('key-*')))}"
        shutil.copyfile(key_path, copy)
        os.chmod(copy, 0o600)
        result = self._ssh_add_cmd([str(copy)])
        if result.returncode != 0:
            raise PrivateSshAgentUnavailable(
                f"ssh-add {key_path.name} failed (code {result.returncode}): "
                f"{result.stderr.strip()}"
            )

    def has_key(self, key_path: Path) -> bool:
        """Whether this agent holds the key at ``key_path`` (by fingerprint)."""
        fingerprint = key_fingerprint(key_path)
        if fingerprint is None:
            return False
        result = self._ssh_add_cmd(["-l"])
        return result.returncode == 0 and fingerprint in sha256_fingerprints(result.stdout)

    def close(self) -> None:
        """Kill the agent and remove its socket and key copies. Idempotent."""
        process, self._process = self._process, None
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        shutil.rmtree(self._dir, ignore_errors=True)

    def __enter__(self) -> "PrivateSshAgent":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _ssh_add_cmd(self, args: list[str]) -> subprocess.CompletedProcess:
        env = {k: v for k, v in os.environ.items() if not k.startswith("SSH_ASKPASS")}
        env["SSH_AUTH_SOCK"] = str(self._sock)
        return subprocess.run(
            [str(self._ssh_add), *args],
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=10,
        )

    def _wait_for_socket(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._process is not None and self._process.poll() is not None:
                err = self._process.stderr.read() if self._process.stderr else ""
                raise PrivateSshAgentUnavailable(
                    f"ssh-agent exited early (code {self._process.returncode}): {err.strip()}"
                )
            if self._sock.exists():
                return
            time.sleep(0.05)
        raise PrivateSshAgentUnavailable(f"ssh-agent socket did not appear within {timeout}s")

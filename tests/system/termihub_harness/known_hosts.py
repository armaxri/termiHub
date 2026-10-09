"""A per-run ``known_hosts`` file for the app under test (#4339, MOCK2-002).

The app's SSH host-key check trusts a key recorded in ``known_hosts`` without a
prompt (#1969). The harness's throwaway sshd endpoints (:mod:`.local_agent`)
pre-trust their host key so an agent connect is not blocked on a trust prompt.

They used to append that entry to the runner's real ``~/.ssh/known_hosts`` and
rewrite the whole file on cleanup, with no lock and no atomic replace. A killed
run left stale entries behind, and two runs could clobber each other's edits.

Now every harness process owns one temporary file instead. Each
:class:`~termihub_harness.orchestrator.AppInstance` launches the app with
:data:`KNOWN_HOSTS_ENV` pointing at it, and a test-bridge build reads that file
instead of ``~/.ssh/known_hosts``. Nothing here reads or writes the user's file.
xdist workers are separate processes, so each worker has its own file.
"""

from __future__ import annotations

import atexit
import os
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Optional

#: The env var a test-bridge app build reads its known_hosts path from (mirrors
#: ``TEST_KNOWN_HOSTS_FILE_ENV`` in ``src-tauri/src/utils/test_bridge.rs``).
KNOWN_HOSTS_ENV = "TERMIHUB_TEST_KNOWN_HOSTS_FILE"

_lock = threading.Lock()
_file: Optional[Path] = None


def _remove_dir(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


def known_hosts_file() -> Path:
    """This process's known_hosts file, created empty on first use.

    The file lives in its own temp directory, which is removed when the
    process exits.
    """
    global _file
    with _lock:
        if _file is None:
            directory = Path(tempfile.mkdtemp(prefix="termihub-known-hosts-"))
            atexit.register(_remove_dir, directory)
            path = directory / "known_hosts"
            path.write_text("", encoding="utf-8")
            _file = path
        return _file


def app_env() -> dict[str, str]:
    """The env entry that points a launched app at :func:`known_hosts_file`."""
    return {KNOWN_HOSTS_ENV: str(known_hosts_file())}


def host_token(host: str, port: int) -> str:
    """The OpenSSH host token for ``host:port``: bare for 22, else ``[host]:port``."""
    return host if port == 22 else f"[{host}]:{port}"


def _rewrite(token: str, new_line: Optional[str]) -> None:
    """Drop every line keyed on ``token`` and append ``new_line`` if given.

    A line matches only when its first field equals ``token`` exactly, so
    ``[127.0.0.1]:2222`` never removes ``[127.0.0.1]:22220``. The new content is
    written to a sibling temp file and moved into place with :func:`os.replace`.
    """
    path = known_hosts_file()
    with _lock:
        lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
        kept = [ln for ln in lines if (ln.split(maxsplit=1) or [""])[0] != token]
        if kept and not kept[-1].endswith("\n"):
            kept[-1] += "\n"
        if new_line is not None:
            kept.append(new_line if new_line.endswith("\n") else new_line + "\n")
        fd, tmp = tempfile.mkstemp(prefix=".known_hosts-", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write("".join(kept))
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise


def trust(host: str, port: int, algorithm: str, key: str) -> str:
    """Record ``algorithm key`` as the trusted key for ``host:port``.

    Replaces any earlier entry for the same host and port, so a reused port never
    leaves two conflicting keys behind. Returns the host token it wrote.
    """
    token = host_token(host, port)
    _rewrite(token, f"{token} {algorithm} {key}")
    return token


def untrust(host: str, port: int) -> None:
    """Remove every entry for ``host:port`` (a no-op when there is none)."""
    _rewrite(host_token(host, port), None)


def trust_pubkey_file(host: str, port: int, pubkey: Path) -> str:
    """:func:`trust` the key in an OpenSSH ``.pub`` file (``algo base64 [comment]``)."""
    algorithm, key = pubkey.read_text(encoding="utf-8").split()[:2]
    return trust(host, port, algorithm, key)

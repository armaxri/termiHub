"""Current on-disk schema versions of the app's versioned config stores.

System tests that assert what the app *writes* (e.g. a fresh-start
``connections.json``) must not hard-code a store's schema version: every
migration bump would silently break them (#5048 — ``connections.json`` went
v5 → v6 under the config-recovery grade). The single source of truth is the
``VersionedStore`` impl in ``src-tauri/src``; this module reads
``CURRENT_VERSION`` from there, so the harness follows each bump automatically.

Plain source parsing — no app, no polling — so it stays unit-testable in
``test_store_versions.py``.
"""

from __future__ import annotations

import re
from pathlib import Path

from .dev_local import REPO_ROOT

#: Where the desktop app's ``VersionedStore`` impls live.
TAURI_SRC = REPO_ROOT / "src-tauri" / "src"

_IMPL_RE = re.compile(r"\bimpl\b[^{;]*\bVersionedStore\s+for\s+\w+\s*\{")
_STORE_NAME_RE = re.compile(r'const\s+STORE_NAME\s*:\s*&\'static\s+str\s*=\s*"([^"]+)"\s*;')
_VERSION_RE = re.compile(r"const\s+CURRENT_VERSION\s*:\s*u32\s*=\s*([^;]+);")
_LINE_COMMENT_RE = re.compile(r"//[^\n]*")


def store_versions_in(source: str) -> dict[str, int]:
    """Map ``STORE_NAME`` → literal ``CURRENT_VERSION`` for each impl in ``source``.

    An impl whose version is not an integer literal (e.g. it forwards another
    type's constant) is skipped; :func:`current_store_version` reports it as
    not found rather than guessing.
    """
    found: dict[str, int] = {}
    # Drop line/doc comments so prose quoting a constant cannot shadow the code.
    source = _LINE_COMMENT_RE.sub("", source)
    starts = [m.end() for m in _IMPL_RE.finditer(source)]
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(source)
        body = source[start:end]
        name = _STORE_NAME_RE.search(body)
        version = _VERSION_RE.search(body)
        if not name or not version:
            continue
        literal = version.group(1).strip().replace("_", "")
        if literal.isdigit():
            found[name.group(1)] = int(literal)
    return found


def current_store_version(store_name: str, src_root: Path = TAURI_SRC) -> int:
    """The schema version the app currently writes for ``store_name``.

    ``store_name`` is the file name the store persists to (its ``STORE_NAME``,
    e.g. ``"connections.json"``). Raises ``LookupError`` when no impl with a
    literal ``CURRENT_VERSION`` declares it — a test should fail loudly then,
    not fall back to a stale number.
    """
    for path in sorted(src_root.rglob("*.rs")):
        text = path.read_text(encoding="utf-8")
        if "VersionedStore" not in text:
            continue
        version = store_versions_in(text).get(store_name)
        if version is not None:
            return version
    raise LookupError(f"no VersionedStore with a literal CURRENT_VERSION for {store_name!r}")

"""Guard the triaged legacy manual-test corpus (``tests/manual/*.yaml``, #3681).

After the TIN-015 triage every remaining YAML item must be exactly one of:

- **release-gating manual** — ``release_gate: true`` plus a ``manual_reason``
  saying why it cannot be automated; or
- **pending automation** — ``automation_issue: <N>`` naming the tracked
  follow-up issue that will automate (and then delete) it.

Anything already automated is deleted from the YAML rather than kept, so a new
item added without one of these markers fails here instead of silently growing
the manual gate. Ids must also be unique (the corpus once carried two
``MT-SER-06`` items).

Pure file parsing — no app, bridge, Docker or PyYAML needed — so this runs in
the normal (non-integration) lane. The YAML files use a fixed, flat item layout
(``  - id:`` then 4-space-indented keys), which the line scan below relies on.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
MANUAL_DIR = REPO_ROOT / "tests" / "manual"

_ID = re.compile(r"^  - id: *\"?([A-Z0-9-]+)\"?\s*$")
_KEY = re.compile(r"^    ([a-z_]+): *(.*)$")


def _items() -> list[tuple[str, str, dict[str, str]]]:
    """Return ``(file, id, top-level keys)`` for every item in the corpus."""
    items: list[tuple[str, str, dict[str, str]]] = []
    for path in sorted(MANUAL_DIR.glob("*.yaml")):
        current: dict[str, str] | None = None
        for line in path.read_text(encoding="utf-8").splitlines():
            m = _ID.match(line)
            if m:
                current = {}
                items.append((path.name, m.group(1), current))
                continue
            k = _KEY.match(line)
            if k and current is not None:
                current[k.group(1)] = k.group(2).strip()
    return items


def test_corpus_is_not_empty():
    assert _items(), f"no manual items found under {MANUAL_DIR}"


def test_manual_ids_are_unique():
    seen: dict[str, str] = {}
    dupes = []
    for fname, item_id, _ in _items():
        if item_id in seen:
            dupes.append(f"{item_id} ({seen[item_id]} and {fname})")
        seen[item_id] = fname
    assert not dupes, f"duplicate manual test ids: {dupes}"


def test_every_item_is_release_gating_or_tracked():
    bad = []
    for fname, item_id, keys in _items():
        gated = keys.get("release_gate") == "true" and bool(keys.get("manual_reason", "").strip('"'))
        tracked = keys.get("automation_issue", "").isdigit()
        if gated == tracked:
            bad.append(f"{fname}:{item_id}")
    assert not bad, (
        "each manual item needs exactly one of `release_gate: true` + `manual_reason`, "
        f"or `automation_issue: <N>` (see docs/testing.md → Manual Testing): {bad}"
    )

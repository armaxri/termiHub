#!/usr/bin/env python3
"""Print the manual-test inventory; no counts are committed to the docs (#4070).

The per-category counts of the legacy manual corpus (``tests/manual/*.yaml``)
used to live in ``docs/testing.md`` and ``docs/release-plan-0.1.0.md`` -- first
hand-maintained, then (#3721) as a generated block. Either way every PR that
automated (and so deleted) a manual item rewrote the same Total row, so any two
such PRs conflicted textually even when they touched different YAML files. Now
no counts are committed anywhere: the YAMLs are the only source of truth, and
this script renders the inventory on demand.

Modes:

- (no flag)  print the inventory as a Markdown table to stdout
- ``--check``  CI: fail if the corpus is empty/unparseable or if a doc
  reintroduces a committed inventory block; on success print the table and,
  under GitHub Actions, append it to the job summary (``$GITHUB_STEP_SUMMARY``)
- ``--write``  retired (#4070); kept only to tell stale instructions what to do

Stdlib-only (no PyYAML): it reads the corpus with the same fixed line layout
that ``tests/system/tests/test_manual_corpus.py`` relies on (``  - id:`` items
with 4-space-indented keys, top-level ``category:`` / ``display_name:``), so it
runs in any CI job without a Python venv.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import NamedTuple

REPO_ROOT = Path(__file__).resolve().parents[1]
MANUAL_DIR = REPO_ROOT / "tests" / "manual"
DOCS_DIR = REPO_ROOT / "docs"

# The retired #3721 marker. A doc that carries it again would bring back the
# committed counts that made every test-automation PR conflict (#4070).
LEGACY_MARKER = "<!-- manual-inventory:start -->"
SHOW_CMD = "python3 scripts/manual-inventory.py"

_ID = re.compile(r"^  - id: *\"?([A-Za-z0-9-]+)\"?\s*$")
_KEY = re.compile(r"^    ([a-z_]+): *(.*)$")
_TOP = re.compile(r"^(category|display_name): *(.*)$")


class Item(NamedTuple):
    file: str
    id: str
    category: str
    display_name: str
    keys: dict


class Row(NamedTuple):
    category: str
    display_name: str
    platforms: str
    release_gate: int
    pending: int

    @property
    def total(self) -> int:
        return self.release_gate + self.pending


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def load_items(manual_dir: Path | None = None) -> list[Item]:
    """Return every item in the corpus with its category and top-level keys."""
    manual_dir = MANUAL_DIR if manual_dir is None else manual_dir
    items: list[Item] = []
    for path in sorted(manual_dir.glob("*.yaml")):
        top: dict[str, str] = {"category": path.stem, "display_name": ""}
        found: list[tuple[str, dict]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            t = _TOP.match(line)
            if t:
                top[t.group(1)] = _unquote(t.group(2))
                continue
            m = _ID.match(line)
            if m:
                found.append((m.group(1), {}))
                continue
            k = _KEY.match(line)
            if k and found:
                found[-1][1][k.group(1)] = k.group(2).strip()
        display = top["display_name"] or top["category"]
        items.extend(Item(path.name, i, top["category"], display, keys) for i, keys in found)
    return items


def is_release_gate(item: Item) -> bool:
    return item.keys.get("release_gate") == "true"


def _platforms(items: list[Item]) -> str:
    seen: set[str] = set()
    for it in items:
        raw = it.keys.get("platforms", "[all]").strip("[]")
        seen.update(p.strip() for p in raw.split(",") if p.strip())
    if not seen or "all" in seen or seen >= {"linux", "macos", "windows"}:
        return "all"
    return ", ".join(sorted(seen))


def inventory(items: list[Item]) -> list[Row]:
    """Aggregate items into per-category rows, sorted by category name."""
    by_cat: dict[str, list[Item]] = {}
    for it in items:
        by_cat.setdefault(it.category, []).append(it)
    rows = []
    for cat in sorted(by_cat):
        its = by_cat[cat]
        gate = sum(1 for it in its if is_release_gate(it))
        rows.append(Row(cat, its[0].display_name, _platforms(its), gate, len(its) - gate))
    return rows


def _table(header: list[str], align: list[str], body: list[list[str]]) -> list[str]:
    """Render a Markdown table exactly as Prettier formats it."""
    widths = [max(3, len(h), *(len(r[i]) for r in body)) for i, h in enumerate(header)]

    def cell(text: str, i: int) -> str:
        return text.rjust(widths[i]) if align[i] == "r" else text.ljust(widths[i])

    def line(cells: list[str]) -> str:
        return "| " + " | ".join(cells) + " |"

    rule = [
        "-" * (widths[i] - 1) + ":" if align[i] == "r" else "-" * widths[i]
        for i in range(len(header))
    ]
    return [line([cell(h, i) for i, h in enumerate(header)]), line(rule)] + [
        line([cell(c, i) for i, c in enumerate(r)]) for r in body
    ]


def render(rows: list[Row]) -> str:
    """Render the inventory as a Prettier-formatted Markdown table."""
    body = [
        [f"`{r.category}`", r.display_name, r.platforms, str(r.release_gate), str(r.pending), str(r.total)]
        for r in rows
    ]
    gate = sum(r.release_gate for r in rows)
    pending = sum(r.pending for r in rows)
    body.append(
        [
            f"**Total ({len(rows)} categories)**",
            "",
            "",
            f"**{gate}**",
            f"**{pending}**",
            f"**{gate + pending}**",
        ]
    )
    table = _table(
        ["Category (`--category`)", "Display name", "Platforms", "Release-gating", "Pending automation", "Total"],
        ["l", "l", "l", "r", "r", "r"],
        body,
    )
    return "\n".join(table)


def docs_with_committed_block(docs_dir: Path | None = None) -> list[Path]:
    """Return every Markdown doc that carries the retired inventory marker."""
    docs_dir = DOCS_DIR if docs_dir is None else docs_dir
    return [
        doc
        for doc in sorted(docs_dir.rglob("*.md"))
        if LEGACY_MARKER in doc.read_text(encoding="utf-8")
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        epilog=(
            "The inventory is deliberately not committed to the docs (#4070): run this "
            "script, or read the 'Manual-test inventory' job summary of the "
            "Frontend Code Quality CI job."
        ),
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--check",
        action="store_true",
        help="CI: validate the corpus and the docs, print the table, append it to the job summary",
    )
    mode.add_argument("--write", action="store_true", help="retired (#4070): no doc carries counts any more")
    args = parser.parse_args(argv)

    if args.write:
        print(
            "manual-inventory.py --write is retired (#4070): the docs no longer carry a "
            "generated count block, so there is nothing to regenerate. Just edit "
            f"tests/manual/*.yaml; view the counts with: {SHOW_CMD}",
            file=sys.stderr,
        )
        return 0

    items = load_items()
    if not items:
        print(f"error: no manual items found under {MANUAL_DIR}", file=sys.stderr)
        return 1
    table = render(inventory(items))

    if not args.check:
        print(table)
        return 0

    reintroduced = docs_with_committed_block()
    if reintroduced:
        names = ", ".join(d.relative_to(REPO_ROOT).as_posix() for d in reintroduced)
        print(
            f"error: {names} carries a committed manual-inventory block ({LEGACY_MARKER}).\n"
            "Committed counts make every test-automation PR conflict (#4070); remove the "
            f"block and point readers at: {SHOW_CMD}",
            file=sys.stderr,
        )
        return 1

    print(table)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(f"### Manual-test inventory\n\nGenerated from `tests/manual/*.yaml` by `{SHOW_CMD}`.\n\n")
            fh.write(table + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

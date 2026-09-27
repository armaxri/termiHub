#!/usr/bin/env python3
"""Generate the manual-test inventory blocks in the docs (#3721).

The per-category counts of the legacy manual corpus (``tests/manual/*.yaml``)
used to be hand-maintained in ``docs/testing.md`` and
``docs/release-plan-0.1.0.md``. Every PR that automated (and so deleted) a
manual item edited the same totals, so any two such PRs conflicted. Now each
doc carries one generated block between these markers::

    <!-- manual-inventory:start -->
    ...generated table...
    <!-- manual-inventory:end -->

and this script is the only thing that writes it. The block is a pure,
deterministic function of the corpus (categories sorted by name, fixed column
layout already in Prettier's table format), so when two PRs conflict on it the
resolution is always the same: take either side and re-run::

    python3 scripts/manual-inventory.py --write

Modes:

- (no flag)  print the block to stdout
- ``--write``  rewrite the block in every target doc in place
- ``--check``  exit 1 if any target doc's block is missing or stale (CI)

Stdlib-only (no PyYAML): it reads the corpus with the same fixed line layout
that ``tests/system/tests/test_manual_corpus.py`` relies on (``  - id:`` items
with 4-space-indented keys, top-level ``category:`` / ``display_name:``), so it
runs in any CI job without a Python venv.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import NamedTuple

REPO_ROOT = Path(__file__).resolve().parents[1]
MANUAL_DIR = REPO_ROOT / "tests" / "manual"
DOCS = (
    REPO_ROOT / "docs" / "testing.md",
    REPO_ROOT / "docs" / "release-plan-0.1.0.md",
)

START = "<!-- manual-inventory:start -->"
END = "<!-- manual-inventory:end -->"
REGEN_CMD = "python3 scripts/manual-inventory.py --write"

_ID = re.compile(r"^  - id: *\"?([A-Za-z0-9-]+)\"?\s*$")
_KEY = re.compile(r"^    ([a-z_]+): *(.*)$")
_TOP = re.compile(r"^(category|display_name): *(.*)$")
_BLOCK = re.compile(re.escape(START) + r".*?" + re.escape(END), re.DOTALL)


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
    """Render the full marker-delimited block (no trailing newline)."""
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
    lines = [
        START,
        "",
        "<!-- Generated from tests/manual/*.yaml by scripts/manual-inventory.py; do not edit by hand.",
        f"     On a merge conflict here, take either side and run: {REGEN_CMD} -->",
        "",
        *table,
        "",
        END,
    ]
    return "\n".join(lines)


def apply(text: str, block: str) -> str | None:
    """Return ``text`` with its block replaced, or None if it has no markers."""
    if not _BLOCK.search(text):
        return None
    return _BLOCK.sub(lambda _m: block, text, count=1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="rewrite the block in every target doc")
    mode.add_argument("--check", action="store_true", help="fail if any target doc's block is stale")
    args = parser.parse_args(argv)

    items = load_items()
    if not items:
        print(f"error: no manual items found under {MANUAL_DIR}", file=sys.stderr)
        return 1
    block = render(inventory(items))

    if not (args.write or args.check):
        print(block)
        return 0

    stale = []
    for doc in DOCS:
        rel = doc.relative_to(REPO_ROOT).as_posix()
        text = doc.read_text(encoding="utf-8")
        updated = apply(text, block)
        if updated is None:
            print(f"error: {rel} has no {START} ... {END} block", file=sys.stderr)
            return 1
        if updated != text:
            if args.write:
                doc.write_text(updated, encoding="utf-8")
                print(f"updated {rel}")
            else:
                stale.append(rel)
    if stale:
        print(
            f"error: manual-inventory block is stale in {', '.join(stale)}.\n"
            f"Regenerate it (never hand-edit it) with: {REGEN_CMD}",
            file=sys.stderr,
        )
        return 1
    if args.check:
        print("manual-inventory blocks are up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())

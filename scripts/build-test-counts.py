#!/usr/bin/env python3
"""Keep the test-count columns in ``docs/testing.md`` derived from source.

The hand-maintained "Tests" numbers in the **Test Suites** and **Manual Test
Categories** tables drifted and began to contradict themselves (the manual total
disagreed with the sum of its own rows, and several per-row counts were stale).
This script makes those numbers a generated, CI-checked artifact instead —
mirroring ``build-testid-catalog.py``:

* **Manual Test Categories** — each row's count and the **Total** are the number
  of ``id: MT-…`` entries in that ``tests/manual/*.yaml`` file (the YAML is the
  declared source of truth for guided testing).
* **Test Suites** — each row backed by a dedicated test file
  (``core/tests/*.rs`` or ``tests/system/tests/*.py``) shows the number of test
  functions in it (Rust ``#[test]`` / ``#[tokio::test]``; pytest ``def test_``).
  Rows backed by a shared, mixed module (e.g. the single agent-deploy test inside
  ``src-tauri/src/utils/remote_exec.rs``) are left untouched — they are not a
  whole suite, so counting the file would be wrong.

Edits are line-targeted (a row is found by the unique file token it already
contains and only its count cell is rewritten), so the wide Description cells are
never reparsed.

Usage::

    python scripts/build-test-counts.py            # rewrite docs/testing.md
    python scripts/build-test-counts.py --check     # verify; exit 1 if stale (CI)
    python scripts/build-test-counts.py --stdout     # print the result, don't write
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DOC_PATH = REPO_ROOT / "docs" / "testing.md"
MANUAL_DIR = REPO_ROOT / "tests" / "manual"

# One id: MT-… entry per manual test.
_MANUAL_ID = re.compile(r"^\s*(?:-\s*)?id:\s*MT-", re.MULTILINE)
# A Rust test fn: #[test] / #[tokio::test] / #[tokio::test(flavor = …)].
_RUST_TEST = re.compile(r"#\[(?:tokio::)?test(?:\]|\()")
# A pytest test fn (sync or async).
_PY_TEST = re.compile(r"^\s*(?:async\s+)?def test_\w*", re.MULTILINE)


def _count_in_file(rel_path: str) -> int:
    """Number of test functions in a dedicated test file (``0`` if missing)."""
    path = REPO_ROOT / rel_path
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return 0
    if rel_path.endswith(".rs"):
        return len(_RUST_TEST.findall(text))
    if rel_path.endswith(".py"):
        return len(_PY_TEST.findall(text))
    return 0


def _count_manual(yaml_name: str) -> int:
    """Number of ``id: MT-…`` entries in ``tests/manual/<yaml_name>``."""
    path = MANUAL_DIR / yaml_name
    try:
        return len(_MANUAL_ID.findall(path.read_text(encoding="utf-8")))
    except OSError:
        return 0


def _render(doc: str) -> str:
    """Return ``doc`` with every generated count cell refreshed from source."""
    lines = doc.splitlines(keepends=True)
    manual_total = 0

    for i, line in enumerate(lines):
        if not line.lstrip().startswith("|"):
            continue

        # Test Suites row: `| … | `<test file>` | <count> | … |` — rewrite the
        # count cell that immediately follows a dedicated-test-file code span.
        suite = re.search(r"`(core/tests/\w+\.rs|tests/system/tests/\w+\.py)`", line)
        if suite:
            count = _count_in_file(suite.group(1))
            lines[i] = re.sub(
                r"(`" + re.escape(suite.group(1)) + r"`\s*\|\s*)\d+(\s*\|)",
                lambda m: f"{m.group(1)}{count}{m.group(2)}",
                line,
                count=1,
            )
            continue

        # Manual Test Categories row: `… | `MT-…` | <count> |` — rewrite the
        # trailing count cell and accumulate the total.
        manual = re.search(r"tests/manual/([\w-]+\.yaml)", line)
        if manual:
            count = _count_manual(manual.group(1))
            manual_total += count
            lines[i] = re.sub(
                r"(\|\s*)\d+(\s*\|\s*)$",
                lambda m: f"{m.group(1)}{count}{m.group(2)}",
                line.rstrip("\n"),
            ) + ("\n" if line.endswith("\n") else "")
            continue

    # Manual **Total** row (rendered after all category rows are summed).
    if manual_total:
        for i, line in enumerate(lines):
            if line.lstrip().startswith("|") and "**Total**" in line:
                lines[i] = re.sub(r"\*\*\d+\*\*", f"**{manual_total}**", line)
                break

    return "".join(lines)


def main(argv: "list[str] | None" = None) -> int:
    parser = argparse.ArgumentParser(
        description="Refresh the generated test-count cells in docs/testing.md."
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--check",
        action="store_true",
        help="verify the committed counts are up to date; exit 1 if stale (CI).",
    )
    group.add_argument(
        "--stdout",
        action="store_true",
        help="print the refreshed document to stdout instead of writing it.",
    )
    args = parser.parse_args(argv)

    current = DOC_PATH.read_text(encoding="utf-8")
    rendered = _render(current)

    if args.stdout:
        sys.stdout.write(rendered)
        return 0

    rel = DOC_PATH.relative_to(REPO_ROOT).as_posix()
    if args.check:
        if current != rendered:
            print(
                f"ERROR: test counts in {rel} are out of date.\n"
                "Regenerate with: python scripts/build-test-counts.py",
                file=sys.stderr,
            )
            return 1
        print(f"{rel} test counts are up to date.")
        return 0

    DOC_PATH.write_text(rendered, encoding="utf-8")
    print(f"Updated test counts in {rel}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

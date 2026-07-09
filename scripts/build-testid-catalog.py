#!/usr/bin/env python3
"""Generate a queryable ``data-testid`` catalog for system-test authors (#899).

Stale or dynamic ``data-testid`` selectors are the single most common authoring
error when porting tests to the Python bridge harness: the old WebdriverIO specs
predate UI refactors, and many ids are dynamic (``file-row-${name}``,
``${testIdPrefix}-download``) so a literal grep misses them. This script scans
``src/**`` for every ``data-testid`` and writes a checked-in catalog so an author
can confirm an id exists without spelunking component source.

Each id is classified as:

* **literal**  — a fixed string (``connection-editor-save``).
* **dynamic**  — a template with interpolation; rendered as a ``*`` glob pattern
  (``file-row-*``, ``*-download``) plus the raw template for context.
* **indirect** — supplied by a prop/variable at the call site
  (``data-testid={option.testId}``); the expression is recorded so the author
  knows the real id is defined elsewhere.

Usage::

    python scripts/build-testid-catalog.py            # (re)write the catalog
    python scripts/build-testid-catalog.py --check     # verify it is up to date (CI)
    python scripts/build-testid-catalog.py --stdout    # print, don't write

The catalog lives at ``tests/system/testid-catalog.md``. Run ``--check`` in CI so
the catalog never silently drifts from the source.

Requires: Python 3.8+ (standard library only).
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(
    subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], text=True
    ).strip()
)
SRC_DIR = REPO_ROOT / "src"
CATALOG_PATH = REPO_ROOT / "tests" / "system" / "testid-catalog.md"

# Files whose ``data-testid`` references are assertions/fixtures/plumbing, not
# app UI. ``testbridge`` builds ``[data-testid="…"]`` selectors at runtime rather
# than defining ids, so its matches are false positives.
_SKIP_SUFFIXES = (".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".d.ts")
_SKIP_DIR_PARTS = {"__tests__", "test", "__mocks__", "testbridge"}

_INTERP = re.compile(r"\$\{[^}]*\}")  # a ${...} interpolation
_COLLAPSE = re.compile(r"\*+")  # runs of glob stars
_EQ = re.compile(r"\s*=\s*")  # the `=` between attribute name and value


# ---------------------------------------------------------------------------
# Scanning
# ---------------------------------------------------------------------------


def iter_source_files(src_dir: Path = SRC_DIR):
    """Yield app ``.ts`` / ``.tsx`` files, skipping tests, mocks, and decls."""
    for path in sorted(src_dir.rglob("*")):
        if path.suffix not in (".ts", ".tsx"):
            continue
        if path.name.endswith(_SKIP_SUFFIXES):
            continue
        if _SKIP_DIR_PARTS & set(path.relative_to(src_dir).parts[:-1]):
            continue
        yield path


def _read_quoted(text: str, start: int) -> "tuple[str, int]":
    """Read a quoted string starting at ``text[start]`` (the quote char).

    Returns ``(inner_without_quotes, index_past_closing_quote)``.
    """
    quote = text[start]
    i = start + 1
    out = []
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            out.append(text[i + 1])
            i += 2
            continue
        if ch == quote:
            return "".join(out), i + 1
        out.append(ch)
        i += 1
    return "".join(out), i


def _read_braced(text: str, start: int) -> "tuple[str, int]":
    """Read a balanced ``{...}`` JSX expression starting at ``text[start]`` (``{``).

    Returns ``(inner_without_outer_braces, index_past_closing_brace)``. Brace
    counting is sufficient for testid expressions: every ``${`` in a template
    literal has a matching ``}``, and these expressions contain no brace-bearing
    object/regex literals in practice.
    """
    depth = 0
    i = start
    while i < len(text):
        ch = text[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1 : i], i + 1
        i += 1
    return text[start + 1 :], i


def scan_testids(text: str) -> "list[tuple[str, str]]":
    """Return ``(origin, value)`` for every ``data-testid=`` in ``text``.

    ``origin`` is ``"quoted"`` (value is the literal attribute string content) or
    ``"expr"`` (value is the inner JSX ``{...}`` expression). Keeping the origin
    lets classification tell a literal string from a bare expression — the quotes
    are gone by then.
    """
    needle = "data-testid"
    out: "list[tuple[str, str]]" = []
    i = 0
    while True:
        j = text.find(needle, i)
        if j < 0:
            break
        k = j + len(needle)
        m = _EQ.match(text, k)
        if not m:
            i = k
            continue
        p = m.end()
        if p >= len(text):
            break
        ch = text[p]
        if ch in "\"'":
            val, end = _read_quoted(text, p)
            out.append(("quoted", val))
            i = end
        elif ch == "{":
            inner, end = _read_braced(text, p)
            out.append(("expr", inner.strip()))
            i = end
        else:
            i = p
    return out


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


def to_pattern(template: str) -> str:
    """Render a template string into a ``*``-glob pattern (``file-row-*``)."""
    return _COLLAPSE.sub("*", _INTERP.sub("*", template))


def _classify_string(value: str) -> "tuple[str, str, str]":
    """Classify a known string value (literal text, possibly with ``${...}``)."""
    if "${" in value:
        pattern = to_pattern(value)
        # A pattern with no static text (just "*") is effectively indirect.
        if pattern.strip("*") == "":
            return "indirect", value, value
        return "dynamic", pattern, value
    return "literal", value, value


def classify_testid(origin: str, value: str) -> "tuple[str, str, str]":
    """Classify a scanned testid into ``(kind, key, raw_template)``.

    ``kind`` is ``"literal"``, ``"dynamic"``, or ``"indirect"``; ``key`` is the
    catalog entry (exact id, ``*`` pattern, or call-site expression).
    """
    token = value.strip()

    if origin == "quoted":
        return _classify_string(token)

    # origin == "expr": the inner of a JSX {...}.
    if token and token[0] == "`":
        inner = token[1:-1] if token.endswith("`") else token[1:]
        return _classify_string(inner)
    if token and token[0] in "\"'":
        inner, _ = _read_quoted(token, 0)
        return _classify_string(inner)

    # A bare JSX expression: data-testid={dataTestId} / {option.testId}.
    return "indirect", token, token


# ---------------------------------------------------------------------------
# Catalog assembly + rendering
# ---------------------------------------------------------------------------


def collect(src_dir: Path = SRC_DIR) -> "dict[str, dict]":
    """Walk the source tree and bucket testids by kind.

    Each bucket maps ``key -> {"files": set[str], "raw": set[str]}``.
    """
    buckets: "dict[str, dict]" = {
        "literal": {},
        "dynamic": {},
        "indirect": {},
    }
    for path in iter_source_files(src_dir):
        rel = path.relative_to(REPO_ROOT).as_posix()
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for origin, value in scan_testids(text):
            if not value:
                continue
            kind, key, template = classify_testid(origin, value)
            entry = buckets[kind].setdefault(key, {"files": set(), "raw": set()})
            entry["files"].add(rel)
            entry["raw"].add(template)
    return buckets


def _files(entry: dict) -> str:
    return ", ".join(f"`{f}`" for f in sorted(entry["files"]))


def _section(title: str, description: "list[str]", headers: "list[str]") -> "list[str]":
    """Scaffold for a catalog section: heading, prose, and the table header row."""
    return [
        "",
        f"## {title}",
        "",
        *description,
        "",
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("-" * len(h) for h in headers) + " |",
    ]


def render(buckets: "dict[str, dict]") -> str:
    """Render the buckets into the deterministic catalog markdown."""
    literal = buckets["literal"]
    dynamic = buckets["dynamic"]
    indirect = buckets["indirect"]

    lines = [
        "# `data-testid` catalog",
        "",
        "<!-- GENERATED by scripts/build-testid-catalog.py — DO NOT EDIT BY HAND. -->",
        "",
        "Every `data-testid` rendered by the app, scanned from `src/**`. Use it to",
        "confirm a selector exists (and its exact form) without reading component",
        "source — the #1 authoring error when porting system tests (#899).",
        "",
        "- **Regenerate:** `python scripts/build-testid-catalog.py`",
        "- **Verify freshness (CI):** `python scripts/build-testid-catalog.py --check`",
    ]

    lines += _section(
        "Literal test IDs", ["Fixed strings — match exactly."], ["testid", "source"]
    )
    for key in sorted(literal):
        lines.append(f"| `{key}` | {_files(literal[key])} |")

    lines += _section(
        "Dynamic test IDs",
        [
            "Built from a template; `*` marks an interpolated segment. Match on the",
            "static prefix/suffix (e.g. a row keyed by name renders `file-row-<name>`).",
        ],
        ["pattern", "example template", "source"],
    )
    for key in sorted(dynamic):
        example = sorted(dynamic[key]["raw"])[0]
        lines.append(f"| `{key}` | `{example}` | {_files(dynamic[key])} |")

    lines += _section(
        "Indirect test IDs",
        [
            "Supplied by a prop/variable at the call site — the real id is defined",
            "where the component is used, not at the `data-testid` site.",
        ],
        ["expression", "source"],
    )
    for key in sorted(indirect):
        lines.append(f"| `{{{key}}}` | {_files(indirect[key])} |")

    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: "list[str] | None" = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate the data-testid catalog for system-test authors."
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--check",
        action="store_true",
        help="verify the committed catalog is up to date; exit 1 if stale (CI).",
    )
    group.add_argument(
        "--stdout",
        action="store_true",
        help="print the catalog to stdout instead of writing the file.",
    )
    args = parser.parse_args(argv)

    content = render(collect())

    if args.stdout:
        sys.stdout.write(content)
        return 0

    if args.check:
        current = CATALOG_PATH.read_text(encoding="utf-8") if CATALOG_PATH.exists() else ""
        if current != content:
            rel = CATALOG_PATH.relative_to(REPO_ROOT).as_posix()
            print(
                f"ERROR: {rel} is out of date.\n"
                "Regenerate it with: python scripts/build-testid-catalog.py",
                file=sys.stderr,
            )
            return 1
        print(f"{CATALOG_PATH.relative_to(REPO_ROOT).as_posix()} is up to date.")
        return 0

    # Force LF newlines so regenerating on Windows (e.g. from the autoformat
    # hook, #1084) does not rewrite the file with CRLF and create a spurious
    # diff — the repo normalizes the catalog to LF via .gitattributes anyway.
    with open(CATALOG_PATH, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
    print(f"Wrote {CATALOG_PATH.relative_to(REPO_ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

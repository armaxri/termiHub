#!/usr/bin/env python3
"""Static ``data-testid`` drift guard for the Python system-test harness (TIN-012).

The Python bridge harness (``tests/system/``) drives the app by ``data-testid``
selectors. When a component's testid is renamed or removed in ``src/**`` but the
harness still references the old id, the harness breaks — historically caught
only by a coverage check and the slow nightly integration lane, i.e. late.

This guard closes that gap with a **purely static** per-PR check (no app build,
no Docker, stdlib only):

1. **Source side** — reuse ``scripts/build-testid-catalog.py`` to scan ``src/**``
   for every rendered ``data-testid`` (literals, ``*``-glob dynamic patterns, and
   indirect call-site expressions). This is the exact same scan that produces the
   testid catalog, so the guard and the catalog can never disagree.
2. **Harness side** — AST-walk the harness Python and collect every testid the
   harness *references*: string literals passed to a bridge ``Driver`` selector
   method (``click``/``type``/``exists``/``context_menu``/…), resolving simple
   module-/class-level string constants (e.g. ``SAVE = "file-editor-save"``); plus
   the static prefixes of ``f"..."`` testid builders (``f"file-row-{name}"`` →
   ``file-row-``).
3. **Drift** — a referenced literal that is neither an exact source literal nor a
   match for any source ``*``-glob is drift; a referenced builder-prefix that no
   source testid begins with is drift. Either fails the guard.

Only selector-call arguments are treated as references, so a fabricated testid in
a harness *unit* test (e.g. a ``scan_testids`` snippet in
``test_testid_catalog.py``, or a ``StubDriver`` fixture) is never mistaken for a
real reference — those strings are never passed to a live selector method.

Usage::

    python scripts/check-testid-drift.py          # exit 1 on drift, print a report
    python scripts/check-testid-drift.py --list    # also list the resolved refs

Requires: Python 3.8+ (standard library only).
"""

from __future__ import annotations

import argparse
import ast
import fnmatch
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(
    subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], text=True
    ).strip()
)
HARNESS_DIR = REPO_ROOT / "tests" / "system"
CATALOG_SCRIPT = REPO_ROOT / "scripts" / "build-testid-catalog.py"

# ``Driver`` methods (tests/system/termihub_harness/bridge.py) whose FIRST
# positional argument is a ``data-testid`` selector. ``drag_to`` takes two
# selectors (from + to); both positions are checked.
_SELECTOR_METHODS_ARG0 = {
    "click",
    "double_click",
    "type",
    "select",
    "context_menu",
    "exists",
    "get_text",
    "get_value",
    "get_attribute",
    "is_disabled",
    "drag",
    "wait_for",
    "wait_for_gone",
}
_SELECTOR_METHODS_TWO = {"drag_to"}
_SELECTOR_METHODS = _SELECTOR_METHODS_ARG0 | _SELECTOR_METHODS_TWO

# Harness files that are unit tests of the harness itself: they fabricate testids
# (scanner snippets, StubDriver fixtures) that intentionally need not exist in
# ``src/**``. They contain no live selector calls, but skip them explicitly so a
# future stub selector cannot leak a false reference into the guard.
_SKIP_FILES = {
    "tests/test_testid_catalog.py",
    "tests/test_test_inventory.py",
    "tests/test_ui_helpers.py",
    "tests/test_testid_drift.py",
    "tests/fake_app.py",
}
_SKIP_DIR_PARTS = {".venv", "__pycache__", "artifacts", ".pytest_cache"}

# A referenced string is only considered a candidate testid if it is "testid
# shaped": lowercase kebab with at least one hyphen. This keeps non-selector
# noise (state paths like ``editorStatus``, enum args like ``"menu"``) from ever
# being treated as a testid, independent of the selector-call gate.
_TESTID_SHAPE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)+$")
# A builder prefix must retain real static text (a trailing hyphen + >=3 chars).
_MIN_PREFIX = 3


# ---------------------------------------------------------------------------
# Source side — reuse the catalog generator's scan
# ---------------------------------------------------------------------------


def _load_catalog_module():
    spec = importlib.util.spec_from_file_location(
        "build_testid_catalog", CATALOG_SCRIPT
    )
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


# The catalog generator scans only the JSX ``data-testid=`` attribute plus three
# fixed sidebar forwarding props (``testId`` / ``nameTestId`` / ``badgeTestId``).
# The app forwards testids through many more differently-named ``*TestId`` props
# (``toggleTestId``, ``footerTestId``, ``headerTestId``, ``modalTestId`` …), and
# through object-property (``testId: "…"`` / ``"data-testid": "…"``) and imperative
# (``setAttribute("data-testid", …)``) forms. Those ids ARE in the DOM and ARE
# referenced by the harness, so the guard must see them or it false-flags drift.
# Recognise them generically here without touching the catalog generator (a
# follow-up tracks widening the catalog itself).
_VALUE = r"""(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)"""
# A prop/object-key that is a testid sink: any identifier ending in ``TestId`` or
# the literal ``data-testid`` (optionally quoted), then ``=`` / ``:`` and a
# quoted-or-template value (optionally wrapped in a JSX ``{ … }``).
_PROP_TESTID = re.compile(
    r"""(?<![A-Za-z0-9_$])"""
    r"""(?:[A-Za-z0-9_$]*[Tt]est[Ii]d|["']?data-testid["']?)"""
    r"""\s*[=:]\s*\{?\s*(""" + _VALUE + r""")"""
)
_SETATTR_TESTID = re.compile(
    r"""setAttribute\(\s*["']data-testid["']\s*,\s*(""" + _VALUE + r""")"""
)
# A ``*TestIdPrefix`` prop supplies the static stem of per-row ids the component
# renders as ```${prefix}-${index}``` (e.g. ``rowTestIdPrefix="dns-result"`` →
# rows ``dns-result-0``…). The rendered id itself collapses to the over-broad
# ``*-*`` glob, so recover the concrete family from the caller's literal prefix.
_PREFIX_PROP = re.compile(
    r"""(?<![A-Za-z0-9_$])[A-Za-z0-9_$]*[Tt]est[Ii]d[Pp]refix"""
    r"""\s*[=:]\s*\{?\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)"""
)
# A ```...`` template literal (its inner text) — used to recover the static shape
# of a testid built inside a larger expression, e.g. a ``foo ?? `${b}-suffix```
# fallback the catalog classifies as fully "indirect".
_TEMPLATE = re.compile(r"`([^`]*)`")
# Names of JSX props / object keys that sink into a rendered testid, so an
# expression value can be mined for embedded templates.
_TESTID_SINK_NAME = re.compile(
    r"""(?<![A-Za-z0-9_$])([A-Za-z0-9_$]*[Tt]est[Ii]d|data-testid)(?![A-Za-z0-9_$])"""
)
# A key/pattern is a plausible testid only if it is lowercase kebab (``*`` glob
# segments allowed). Filters template noise like ``Refresh interval set to *``.
_TESTID_KEY_SHAPE = re.compile(r"^[a-z0-9*]+(?:-[a-z0-9*]+)+$")


def _classify_value(mod, raw: str):
    """Classify a captured quoted/template value via the catalog module."""
    if raw[:1] == "`":
        return mod.classify_testid("expr", raw)
    inner, _ = mod._read_quoted(raw, 0)
    return mod.classify_testid("quoted", inner)


def _add(result, literals: "set[str]", globs: "set[str]") -> None:
    kind, key = result[0], result[1]
    if kind == "literal" and _TESTID_KEY_SHAPE.match(key):
        literals.add(key)
    elif kind == "dynamic" and _TESTID_KEY_SHAPE.match(key):
        globs.add(key)


def _extra_source_scan(mod) -> "tuple[set[str], set[str]]":
    """Scan src/** for testid forms the catalog generator does not recognise.

    Returns ``(literals, dynamic_globs)`` classified with the catalog module's own
    classifier so the two scans agree on literal-vs-glob shape. Covers:

    * every ``*TestId`` prop / ``"data-testid":`` object key / ``setAttribute``
      call with a quoted-or-template value (the catalog only scans four fixed
      JSX attributes);
    * ``*TestIdPrefix`` props → the ``prefix-*`` row family;
    * templates embedded inside a testid-sink ``{...}`` expression (the
      ``x ?? `${base}-suffix``` fallback the catalog records as indirect).
    """
    literals: "set[str]" = set()
    globs: "set[str]" = set()
    for path in mod.iter_source_files():
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        # Direct quoted/template values on any testid sink + setAttribute.
        for pattern in (_PROP_TESTID, _SETATTR_TESTID):
            for raw in pattern.findall(text):
                _add(_classify_value(mod, raw), literals, globs)
        # `*TestIdPrefix="dns-result"` → dynamic row family `dns-result-*`.
        for raw in _PREFIX_PROP.findall(text):
            inner = raw[1:-1] if raw[:1] in "\"'`" else raw
            stem = inner.rstrip("-")
            if stem and _TESTID_KEY_SHAPE.match(stem):
                globs.add(stem + "-*")
        # Templates embedded in a testid-sink `{...}` expression.
        for name_match in _TESTID_SINK_NAME.finditer(text):
            eq = mod._EQ.match(text, name_match.end())
            if not eq or eq.end() >= len(text) or text[eq.end()] != "{":
                continue
            inner, _ = mod._read_braced(text, eq.end())
            for tmpl in _TEMPLATE.findall(inner):
                if "${" not in tmpl:
                    continue
                _add(
                    mod.classify_testid("expr", "`" + tmpl + "`"),
                    literals,
                    globs,
                )
    return literals, globs


def source_testids() -> "tuple[set[str], list[str], list[str]]":
    """Return ``(literals, dynamic_globs, static_prefixes)`` scanned from src/**.

    ``literals`` are exact ids; ``dynamic_globs`` are ``*``-glob patterns
    (``file-row-*``); ``static_prefixes`` are the leading static segment of every
    literal and dynamic pattern (used to validate harness builder prefixes).
    """
    mod = _load_catalog_module()
    buckets = mod.collect()
    extra_literals, extra_globs = _extra_source_scan(mod)
    literals = set(buckets["literal"].keys()) | extra_literals
    dynamic_globs = sorted(set(buckets["dynamic"].keys()) | extra_globs)
    static_prefixes = set()
    for key in literals:
        static_prefixes.add(key)
    for glob in dynamic_globs:
        head = glob.split("*", 1)[0]
        if head:
            static_prefixes.add(head)
    return literals, dynamic_globs, sorted(static_prefixes)


# ---------------------------------------------------------------------------
# Harness side — AST extraction of referenced testids
# ---------------------------------------------------------------------------


def iter_harness_files():
    """Yield harness ``.py`` files that may reference *real-app* testids.

    Skips harness self-tests (explicit list) and any file that drives the
    ``FakeApp`` plumbing double — those fabricate testids (``theme-select``,
    ``connection-item-abc``) that intentionally need not exist in ``src/**``.
    ``FakeApp`` importers are detected statically so the skip stays accurate as
    plumbing suites are added.
    """
    for path in sorted(HARNESS_DIR.rglob("*.py")):
        rel = path.relative_to(HARNESS_DIR).as_posix()
        if _SKIP_DIR_PARTS & set(path.relative_to(HARNESS_DIR).parts):
            continue
        if rel in _SKIP_FILES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if "fake_app" in text or "FakeApp" in text:
            continue
        yield path


def _const_map(tree: ast.AST) -> "dict[str, str]":
    """Map simple ``NAME = "literal"`` / class ``ATTR = "literal"`` to their value.

    Keyed by the bare name so both ``NAME`` and ``self.NAME`` / ``Cls.NAME``
    references resolve. Covers the dominant harness pattern of declaring testids
    as module- or class-level string constants (``SAVE = "file-editor-save"``).
    """
    const: "dict[str, str]" = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            if isinstance(node.value, ast.Constant) and isinstance(
                node.value.value, str
            ):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        const[target.id] = node.value.value
        elif isinstance(node, ast.AnnAssign):
            if (
                isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str)
                and isinstance(node.target, ast.Name)
            ):
                const[node.target.id] = node.value.value
    return const


def _joinedstr_prefix(node: ast.JoinedStr) -> str:
    """The leading static text of an f-string, up to the first interpolation."""
    if not node.values:
        return ""
    first = node.values[0]
    if isinstance(first, ast.Constant) and isinstance(first.value, str):
        return first.value
    return ""


def _resolve_arg(node: ast.AST, const: "dict[str, str]"):
    """Resolve a selector argument to ``("literal", value)`` / ``("prefix", value)``.

    Returns ``None`` when the argument is not statically a testid (a bare
    variable, a builder call, an attribute miss, etc.).
    """
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return ("literal", node.value)
    if isinstance(node, ast.Name) and node.id in const:
        return ("literal", const[node.id])
    if isinstance(node, ast.Attribute) and node.attr in const:
        return ("literal", const[node.attr])
    if isinstance(node, ast.JoinedStr):
        prefix = _joinedstr_prefix(node)
        if prefix:
            return ("prefix", prefix)
    return None


def extract_references(path: Path):
    """Return ``(literals, prefixes)`` referenced as selectors in one harness file."""
    literals: "set[str]" = set()
    prefixes: "set[str]" = set()
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    const = _const_map(tree)

    # ``assert not driver.exists("x")`` deliberately references an id expected to
    # be ABSENT (a removed feature). Collect those negated-``exists`` calls so
    # their argument is not counted as a "must exist" reference. A positively
    # used id (waited-for elsewhere) still records normally from its other call.
    negated_calls: "set[int]" = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            op = node.operand
            if (
                isinstance(op, ast.Call)
                and isinstance(op.func, ast.Attribute)
                and op.func.attr in ("exists", "wait_for_gone")
            ):
                negated_calls.add(id(op))

    def _record(node: ast.AST) -> None:
        resolved = _resolve_arg(node, const)
        if resolved is None:
            return
        kind, value = resolved
        if kind == "literal" and _TESTID_SHAPE.match(value):
            literals.add(value)
        elif kind == "prefix" and value.endswith("-") and len(value) >= _MIN_PREFIX:
            prefixes.add(value)

    for node in ast.walk(tree):
        # Selector-method calls: ``<x>.click("...")`` / ``<x>.drag_to(a, b)``.
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            method = node.func.attr
            if id(node) in negated_calls:
                continue
            if method in _SELECTOR_METHODS_ARG0 and node.args:
                _record(node.args[0])
            elif method in _SELECTOR_METHODS_TWO:
                for arg in node.args[:2]:
                    _record(arg)
        # Testid *builder* functions (``def *testid*(...) -> str: return f"...-{x}"``)
        # contribute their static prefix even when only ever called with a
        # variable argument, so a builder-prefix rename is still caught.
        if isinstance(node, ast.FunctionDef) and "testid" in node.name.lower():
            for sub in ast.walk(node):
                if isinstance(sub, ast.Return) and isinstance(
                    sub.value, ast.JoinedStr
                ):
                    prefix = _joinedstr_prefix(sub.value)
                    if prefix.endswith("-") and len(prefix) >= _MIN_PREFIX:
                        prefixes.add(prefix)
    return literals, prefixes


def harness_references():
    """Aggregate ``(literal_refs, prefix_refs)`` across all harness files.

    Each maps ``value -> sorted list of referencing files`` for reporting.
    """
    literal_refs: "dict[str, set[str]]" = {}
    prefix_refs: "dict[str, set[str]]" = {}
    for path in iter_harness_files():
        rel = path.relative_to(REPO_ROOT).as_posix()
        lits, prefs = extract_references(path)
        for lit in lits:
            literal_refs.setdefault(lit, set()).add(rel)
        for pref in prefs:
            prefix_refs.setdefault(pref, set()).add(rel)
    return literal_refs, prefix_refs


# ---------------------------------------------------------------------------
# Drift computation
# ---------------------------------------------------------------------------


def _specific_glob(glob: str) -> bool:
    """Whether a ``*``-glob has a real static anchor, not just wildcards/separators.

    Fully-interpolated source ids (``data-testid={`${a}-${b}`}``) collapse to
    globs like ``*-*`` / ``*-*-*`` that ``fnmatch``-match *any* hyphenated string,
    which would mask every literal rename. Treat a glob as coverage only when
    something alphanumeric survives removing the ``*``s and separators.
    """
    static = glob.replace("*", "")
    return any(ch.isalnum() for ch in static)


def _literal_covered(
    testid: str, literals: "set[str]", specific_globs: "list[str]"
) -> bool:
    if testid in literals:
        return True
    return any(fnmatch.fnmatchcase(testid, glob) for glob in specific_globs)


def _prefix_covered(prefix: str, static_prefixes: "list[str]") -> bool:
    # Covered when some source id begins with this builder prefix, or the prefix
    # extends a shorter static source prefix (a builder for a longer id). Both
    # directions keep the check lenient on legitimately-nested ids while still
    # failing when the whole prefix is renamed away.
    for src in static_prefixes:
        if len(src) < _MIN_PREFIX:
            continue
        if src.startswith(prefix) or prefix.startswith(src):
            return True
    return False


def find_drift():
    """Return ``(literal_drift, prefix_drift)`` — the uncovered harness references.

    Each is a sorted list of ``(value, [files])`` tuples. Empty lists mean no
    drift. This is the importable core the pytest guard and the CLI both use.
    """
    literals, dynamic_globs, static_prefixes = source_testids()
    literal_refs, prefix_refs = harness_references()

    specific_globs = [g for g in dynamic_globs if _specific_glob(g)]
    literal_drift = sorted(
        (tid, sorted(files))
        for tid, files in literal_refs.items()
        if not _literal_covered(tid, literals, specific_globs)
    )
    prefix_drift = sorted(
        (pref, sorted(files))
        for pref, files in prefix_refs.items()
        if not _prefix_covered(pref, static_prefixes)
    )
    return literal_drift, prefix_drift


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _print_drift(literal_drift, prefix_drift) -> None:
    print("testid drift detected — the harness references ids absent from src/**:")
    if literal_drift:
        print("\n  Missing literal test IDs:")
        for tid, files in literal_drift:
            print(f"    - {tid}")
            for f in files:
                print(f"        referenced in {f}")
    if prefix_drift:
        print("\n  Missing dynamic builder prefixes:")
        for pref, files in prefix_drift:
            print(f"    - {pref}*")
            for f in files:
                print(f"        referenced in {f}")
    print(
        "\nRename or restore the id in src/**, or update the harness reference. "
        "Regenerate the catalog with `python scripts/build-testid-catalog.py`."
    )


def main(argv: "list[str] | None" = None) -> int:
    parser = argparse.ArgumentParser(
        description="Static data-testid drift guard for the system-test harness."
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="print all resolved harness testid references, then the verdict.",
    )
    args = parser.parse_args(argv)

    if args.list:
        literal_refs, prefix_refs = harness_references()
        print(f"Resolved {len(literal_refs)} literal + {len(prefix_refs)} prefix refs:")
        for tid in sorted(literal_refs):
            print(f"  literal  {tid}")
        for pref in sorted(prefix_refs):
            print(f"  prefix   {pref}*")
        print()

    literal_drift, prefix_drift = find_drift()
    if literal_drift or prefix_drift:
        _print_drift(literal_drift, prefix_drift)
        return 1

    literal_refs, prefix_refs = harness_references()
    print(
        f"OK — {len(literal_refs)} literal + {len(prefix_refs)} builder-prefix "
        "harness testid references all present in src/**."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

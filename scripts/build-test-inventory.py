#!/usr/bin/env python3
"""Generate a test-inventory + coverage-gap report for the Python harness (#1950).

The `data-testid` catalog (``scripts/build-testid-catalog.py``) answers *"does
this selector exist?"* — a **selector** index. It does not answer the question a
reviewer or release manager actually asks: *"what do we verify for feature X
(automated **and** manual), and which features have* **zero** *coverage?"* Tests
are discoverable only by the ``test_<feature>.py`` filename convention plus
``pytest --collect-only``; the markers are just ``integration`` / ``manual``.
There is no single **test -> feature** inventory. This script builds one.

It **statically introspects** the harness test modules with the stdlib ``ast``
module — the same stdlib-only approach as ``build-testid-catalog.py`` — rather
than importing them or running ``pytest --collect-only``. That is deliberate: the
report then generates on any machine, with no harness ``.venv``, no installed
dependencies, and no app build (``pytest --collect-only`` needs all three because
it imports every test module). The trade-off is that parametrized cases are
counted once, at the base test function.

For each collected test it records:

* **test id** — the pytest node id relative to ``tests/system``
  (``tests/test_ssh.py::TestSsh::test_connect``).
* **feature** (category) — an explicit ``@pytest.mark.category("ssh")`` marker
  when present (on the item, its class, or the module ``pytestmark``), else the
  ``test_<feature>.py`` filename stem with the ``test_`` prefix stripped.
* **lane** — ``manual`` when the ``manual`` marker applies, else ``automated``.
* **platforms** — ``linux`` / ``macos`` / ``windows``. The harness runs on all
  three by default; a recognized ``skipif`` marker (e.g. ``skip_on_non_windows``,
  ``sys.platform == 'darwin'``) narrows the set. Best-effort and documented as
  such: an unrecognized ``skipif`` leaves the default untouched.

It then emits a Markdown **and** JSON report grouped by feature, and a
**"features with no coverage"** section: entries in the curated ``FEATURE_AREAS``
map that have no automated **and** no manual test. That curated list is the
source of truth for *"what features do we track"* — a feature only shows up as a
gap once it is listed there, so maintainers add an entry when they add a feature
(mirroring how the testid catalog is only as complete as its scan). Categories
that match no known feature are surfaced too, so the map cannot silently drift.

Usage::

    python scripts/build-test-inventory.py             # (re)write .md + .json
    python scripts/build-test-inventory.py --stdout     # print markdown, no write
    python scripts/build-test-inventory.py --json       # print json, no write

The reports live at ``tests/system/test-inventory.{md,json}`` and are **local,
regenerated artifacts** — git-ignored, not committed, for the same reason as the
testid catalog (#1528): a single committed file goes stale on every branch the
moment any test changes on ``develop``. CI regenerates them in a non-blocking
step and the grouping/gap logic is verified in
``tests/system/tests/test_test_inventory.py``.

Requires: Python 3.9+ (standard library only).
"""

from __future__ import annotations

import argparse
import ast
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(
    subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], text=True
    ).strip()
)
SYSTEM_DIR = REPO_ROOT / "tests" / "system"
TESTS_DIR = SYSTEM_DIR / "tests"
MD_PATH = SYSTEM_DIR / "test-inventory.md"
JSON_PATH = SYSTEM_DIR / "test-inventory.json"

ALL_PLATFORMS = ("linux", "macos", "windows")

# Curated map of feature area -> category substrings that count as covering it.
# This is the source of truth for "what features do we track": a feature only
# appears in the coverage-gap section once it is listed here, so a maintainer
# adding a genuinely new feature adds a row (mirroring the app's subsystems in
# .claude/CLAUDE.md and the harness `*Ui` mixins). A category "covers" a feature
# when the category name contains any of the feature's substrings.
FEATURE_AREAS: "dict[str, tuple[str, ...]]" = {
    "local shell": ("local_shell", "shell_commands", "enter_submits"),
    "ssh": ("ssh",),
    "serial": ("serial",),
    "telnet": ("telnet",),
    "sftp": ("sftp",),
    "file browser": ("file_browser", "files_ui", "external_files"),
    "tunnels": ("tunnel",),
    "monitoring": ("monitoring",),
    "credential store": ("credential",),
    "embedded servers": ("embedded_services", "transfer", "ftp_insecure"),
    "network tools": ("network_tools",),
    "workspace / automation": ("workflow", "workspace"),
    "remote agent": ("remote_agent", "agent_update"),
    "connection editor": (
        "connection_editor",
        "connection_crud",
        "connection_forms",
    ),
    "tabs": ("tab_management", "tab_horizontal"),
    "split views": ("split_views",),
    "settings": ("settings",),
    "clipboard": ("clipboard",),
    "editor": ("editor",),
    "export / import": ("export_import",),
    "themes / rendering": ("theme", "display", "visual_rendering"),
    "password prompt": ("password_prompt",),
    "config recovery": ("config_recovery",),
    "terminal": ("terminal",),
    "sidebar": ("sidebar",),
    "shells (windows/wsl/git bash)": ("windows_shells", "wsl", "git_bash"),
    "input routing": ("input_routing",),
    "native dialogs": ("native_dialogs",),
    "external app": ("external_app",),
}

# Categories that are harness self-tests / plumbing, not app feature areas.
# Excluded from the "unmapped categories" drift guard so that list surfaces only
# genuine feature categories missing a FEATURE_AREAS mapping.
MACHINERY_CATEGORIES = frozenset(
    {
        "app_lifecycle",
        "artifacts",
        "cross_platform",
        "dev_local",
        "fixtures",
        "manual_examples",
        "manual_mode",
        "mixins",
        "orchestrator",
        "performance",
        "protocol",
        "roundtrip",
        "runner_script",
        "screenshot",
        "test_inventory",
        "test_script",
        "testid_catalog",
        "ui_helpers",
        "ui_state",
    }
)

# Test files that are harness plumbing / stand-ins, not feature suites. They
# contain no `test_<feature>` behavior to inventory.
_SKIP_FILES = {"fake_app.py", "conftest.py"}


# ---------------------------------------------------------------------------
# AST helpers — resolve pytest marks without importing the modules
# ---------------------------------------------------------------------------


def _attr_chain(node: ast.AST) -> "list[str]":
    """Return the dotted-name parts of an attribute/name chain, outer-last.

    ``pytest.mark.skipif`` -> ``["pytest", "mark", "skipif"]``; a bare
    ``ast.Name`` -> ``[name]``; anything else -> ``[]``.
    """
    parts: "list[str]" = []
    cur = node
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        parts.append(cur.id)
    else:
        return []
    parts.reverse()
    return parts


def _literal(node: ast.AST):
    """Best-effort literal value of ``node``; ``None`` if not a constant."""
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError):
        return None


class Mark:
    """A resolved pytest mark: its ``name`` plus decision-relevant fields."""

    __slots__ = ("name", "category", "skip_text")

    def __init__(self, name: str, category: "str | None", skip_text: str):
        self.name = name
        self.category = category  # arg of @pytest.mark.category("x"), if any
        self.skip_text = skip_text  # condition+reason source of a skipif, else ""


def parse_mark(node: ast.AST, symbols: "dict[str, Mark]") -> "Mark | None":
    """Resolve a decorator/pytestmark element into a :class:`Mark`.

    Handles ``pytest.mark.<name>`` (attribute or call), ``pytest.mark.category``
    with its string arg, ``pytest.mark.skipif`` with its condition/reason text,
    and a bare ``ast.Name`` referencing a module-level mark (``skip_on_non_windows
    = pytest.mark.skipif(...)``) via ``symbols``.
    """
    # A bare name: look it up in the module symbol table.
    if isinstance(node, ast.Name):
        return symbols.get(node.id)

    call_args: "list[ast.AST]" = []
    call_keywords: "list[ast.keyword]" = []
    func = node
    if isinstance(node, ast.Call):
        func = node.func
        call_args = list(node.args)
        call_keywords = list(node.keywords)

    parts = _attr_chain(func)
    # Expect the chain to end in `pytest.mark.<name>` (be lenient about aliases:
    # accept any `*.mark.<name>` shape).
    if len(parts) < 2 or "mark" not in parts:
        return None
    name = parts[-1]

    category = None
    if name == "category" and call_args:
        category = _literal(call_args[0])
        if category is not None:
            category = str(category)

    skip_text = ""
    if name == "skipif":
        chunks: "list[str]" = []
        if call_args:
            chunks.append(_unparse(call_args[0]))
        for kw in call_keywords:
            if kw.arg == "reason":
                chunks.append(_unparse(kw.value))
        skip_text = " ".join(chunks)

    return Mark(name, category, skip_text)


def _unparse(node: ast.AST) -> str:
    try:
        return ast.unparse(node)
    except Exception:  # pragma: no cover - unparse is available on 3.9+
        return ""


def _marks_from(nodes, symbols: "dict[str, Mark]") -> "list[Mark]":
    out: "list[Mark]" = []
    for n in nodes or []:
        mark = parse_mark(n, symbols)
        if mark is not None:
            out.append(mark)
    return out


def _pytestmark_value(node: ast.AST) -> "list[ast.AST]":
    """The mark expressions from a ``pytestmark = ...`` assignment value."""
    if isinstance(node, (ast.List, ast.Tuple)):
        return list(node.elts)
    return [node]


def _build_symbols(tree: ast.Module) -> "dict[str, Mark]":
    """Module-level ``NAME = pytest.mark.<...>`` assignments, resolvable by name.

    Lets a decorator like ``@skip_on_non_windows`` be understood as the skipif
    mark it aliases.
    """
    symbols: "dict[str, Mark]" = {}
    for stmt in tree.body:
        if not isinstance(stmt, ast.Assign):
            continue
        mark = parse_mark(stmt.value, symbols)
        if mark is None:
            continue
        for target in stmt.targets:
            if isinstance(target, ast.Name):
                symbols[target.id] = mark
    return symbols


# ---------------------------------------------------------------------------
# Classification of a single test into lane / platforms / category
# ---------------------------------------------------------------------------


def _restriction_for(mark: Mark) -> "set[str] | None":
    """Platforms a ``skipif`` mark leaves the test running on (``None`` = unknown).

    Best-effort recognition of the concrete platform gates used in the harness,
    handling both polarities:

    * "skip unless <platform>" — ``not _IS_WINDOWS``, ``sys.platform != 'win32'``,
      a ``…-only`` reason — restricts the test **to** that platform.
    * "skip on <platform>" — ``sys.platform == 'darwin'`` — **drops** that
      platform.

    An unrecognized condition returns ``None`` so the default (all platforms) is
    kept rather than guessed wrong.
    """
    if mark.name != "skipif":
        return None
    text = mark.skip_text.lower()

    # 1) An "<platform>-only" reason is the strongest, least ambiguous signal.
    for platform, tokens in (
        ("windows", ("windows-only", "windows only")),
        ("linux", ("linux-only", "linux only")),
        ("macos", ("macos-only", "macos only", "mac-only", "mac only", "darwin only")),
    ):
        if any(tok in text for tok in tokens):
            return {platform}

    # 2) "skip unless <platform>" conditions -> restrict to that platform.
    if (
        "non_windows" in text
        or "non-windows" in text
        or "not _is_windows" in text
        or "not is_windows" in text
        or "!= 'win32'" in text
        or '!= "win32"' in text
    ):
        return {"windows"}
    if (
        "not _is_macos" in text
        or "not is_macos" in text
        or "not _is_mac" in text
        or "!= 'darwin'" in text
        or '!= "darwin"' in text
    ):
        return {"macos"}
    if (
        "not _is_linux" in text
        or "not is_linux" in text
        or "!= 'linux'" in text
        or '!= "linux"' in text
    ):
        return {"linux"}
    # WSL / Git Bash gates only ever apply to Windows-only shell suites.
    if "wsl" in text or "git_bash" in text or "git bash" in text:
        return {"windows"}

    # 3) "skip ON <platform>" equality conditions -> drop that platform.
    dropped: "set[str]" = set()
    if "== 'darwin'" in text or '== "darwin"' in text or "'darwin'" in text:
        dropped.add("macos")
    if "== 'win32'" in text or '== "win32"' in text:
        dropped.add("windows")
    if "== 'linux'" in text or '== "linux"' in text:
        dropped.add("linux")
    if dropped:
        return set(ALL_PLATFORMS) - dropped
    return None


def lane_for(marks: "list[Mark]") -> str:
    """``"manual"`` if any applicable mark is ``manual``, else ``"automated"``."""
    return "manual" if any(m.name == "manual" for m in marks) else "automated"


def platforms_for(marks: "list[Mark]") -> "list[str]":
    """Platform set for a test, narrowed by recognized ``skipif`` marks."""
    platforms = set(ALL_PLATFORMS)
    for mark in marks:
        restriction = _restriction_for(mark)
        if restriction is not None:
            platforms &= restriction
    return [p for p in ALL_PLATFORMS if p in platforms]


def category_for(marks: "list[Mark]", filename: str) -> str:
    """Explicit ``category`` mark, else the ``test_<feature>.py`` filename stem."""
    for mark in marks:
        if mark.name == "category" and mark.category:
            return mark.category
    stem = Path(filename).stem
    if stem.startswith("test_"):
        stem = stem[len("test_") :]
    return stem


# ---------------------------------------------------------------------------
# Collection
# ---------------------------------------------------------------------------


def _iter_test_functions(tree: ast.Module):
    """Yield ``(node_id_suffix, decorator_nodes, class_decorator_nodes)`` items.

    Follows pytest's default collection: module-level ``def test_*`` functions and
    ``def test_*`` methods inside ``class Test*``.
    """
    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if stmt.name.startswith("test"):
                yield (stmt.name, stmt.decorator_list, [])
        elif isinstance(stmt, ast.ClassDef) and stmt.name.startswith("Test"):
            for sub in stmt.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    if sub.name.startswith("test"):
                        node_id = f"{stmt.name}::{sub.name}"
                        yield (node_id, sub.decorator_list, stmt.decorator_list)


def collect_file(path: Path) -> "list[dict]":
    """Collect the test records from one test module.

    Each record is ``{"id", "feature", "lane", "platforms", "file"}``. Module-,
    class-, and function-level marks all apply to a method (as pytest merges
    them), so they are combined before classification.
    """
    try:
        text = path.read_text(encoding="utf-8")
        tree = ast.parse(text, filename=str(path))
    except (OSError, UnicodeDecodeError, SyntaxError):
        return []

    symbols = _build_symbols(tree)

    module_marks: "list[Mark]" = []
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "pytestmark" for t in stmt.targets
        ):
            module_marks = _marks_from(_pytestmark_value(stmt.value), symbols)

    rel = path.relative_to(SYSTEM_DIR).as_posix()
    records: "list[dict]" = []
    for node_suffix, deco, class_deco in _iter_test_functions(tree):
        marks = (
            module_marks
            + _marks_from(class_deco, symbols)
            + _marks_from(deco, symbols)
        )
        records.append(
            {
                "id": f"{rel}::{node_suffix}",
                "feature": category_for(marks, path.name),
                "lane": lane_for(marks),
                "platforms": platforms_for(marks),
                "file": rel,
            }
        )
    return records


def collect(tests_dir: Path = TESTS_DIR) -> "list[dict]":
    """Collect every harness test record, sorted by node id."""
    records: "list[dict]" = []
    for path in sorted(tests_dir.glob("test_*.py")):
        if path.name in _SKIP_FILES:
            continue
        records.extend(collect_file(path))
    records.sort(key=lambda r: r["id"])
    return records


# ---------------------------------------------------------------------------
# Grouping + gap logic (unit-tested in test_test_inventory.py)
# ---------------------------------------------------------------------------


def group_by_feature(records: "list[dict]") -> "dict[str, dict]":
    """Group records by feature into per-feature automated/manual buckets.

    Returns ``feature -> {"automated": int, "manual": int, "platforms": set,
    "tests": [record, ...]}``.
    """
    groups: "dict[str, dict]" = {}
    for rec in records:
        group = groups.setdefault(
            rec["feature"],
            {"automated": 0, "manual": 0, "platforms": set(), "tests": []},
        )
        group[rec["lane"]] += 1
        group["platforms"].update(rec["platforms"])
        group["tests"].append(rec)
    return groups


def coverage(records: "list[dict]", feature_areas=FEATURE_AREAS) -> "dict[str, dict]":
    """Automated/manual test counts per curated feature area.

    A category covers an area when the category name contains one of the area's
    substrings. Returns ``area -> {"automated": int, "manual": int,
    "categories": [str, ...]}``.
    """
    result = {
        area: {"automated": 0, "manual": 0, "categories": set()}
        for area in feature_areas
    }
    for rec in records:
        feature = rec["feature"]
        for area, needles in feature_areas.items():
            if any(needle in feature for needle in needles):
                result[area][rec["lane"]] += 1
                result[area]["categories"].add(feature)
    return result


def coverage_gaps(records: "list[dict]", feature_areas=FEATURE_AREAS) -> "list[str]":
    """Curated feature areas with no automated **and** no manual test."""
    cov = coverage(records, feature_areas)
    return [
        area
        for area in feature_areas
        if cov[area]["automated"] == 0 and cov[area]["manual"] == 0
    ]


def unmapped_categories(records: "list[dict]", feature_areas=FEATURE_AREAS) -> "list[str]":
    """Feature categories that match no curated feature area (map drift guard).

    Harness self-test / plumbing categories (``MACHINERY_CATEGORIES``) are
    excluded, so the result surfaces only genuine feature categories that lack a
    ``FEATURE_AREAS`` mapping.
    """
    unmapped: "set[str]" = set()
    for rec in records:
        feature = rec["feature"]
        if feature in MACHINERY_CATEGORIES:
            continue
        if not any(
            needle in feature
            for needles in feature_areas.values()
            for needle in needles
        ):
            unmapped.add(feature)
    return sorted(unmapped)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _fmt_platforms(platforms) -> str:
    ordered = [p for p in ALL_PLATFORMS if p in set(platforms)]
    if len(ordered) == len(ALL_PLATFORMS):
        return "all"
    return ", ".join(ordered) if ordered else "none"


def build_report(records: "list[dict]") -> dict:
    """Assemble the JSON-serializable report structure."""
    groups = group_by_feature(records)
    cov = coverage(records)
    features = []
    for feature in sorted(groups):
        group = groups[feature]
        features.append(
            {
                "feature": feature,
                "automated": group["automated"],
                "manual": group["manual"],
                "platforms": _fmt_platforms(group["platforms"]),
                "tests": group["tests"],
            }
        )
    return {
        "total_tests": len(records),
        "total_features": len(groups),
        "features": features,
        "coverage_gaps": coverage_gaps(records),
        "unmapped_categories": unmapped_categories(records),
        "feature_areas": {
            area: {
                "automated": cov[area]["automated"],
                "manual": cov[area]["manual"],
                "categories": sorted(cov[area]["categories"]),
            }
            for area in sorted(FEATURE_AREAS)
        },
    }


def render_markdown(records: "list[dict]") -> str:
    report = build_report(records)
    lines = [
        "# Test inventory & coverage-gap report",
        "",
        "<!-- GENERATED by scripts/build-test-inventory.py — DO NOT EDIT BY HAND. -->",
        "",
        "Every collected system-harness test mapped to its **feature**, **lane** "
        "(automated / manual), and **platforms** — plus the feature areas with "
        "**no** coverage (#1950).",
        "",
        "- **Regenerate:** `python scripts/build-test-inventory.py`",
        "- **Not committed:** a local, git-ignored artifact; CI regenerates it "
        "(non-blocking) instead of diffing a file that goes stale per-branch (#1528).",
        "",
        f"- **Tests:** {report['total_tests']}  ·  "
        f"**Features:** {report['total_features']}  ·  "
        f"**Coverage gaps:** {len(report['coverage_gaps'])}",
        "",
        "## Features with no coverage",
        "",
    ]
    if report["coverage_gaps"]:
        lines += [
            "Curated feature areas (`FEATURE_AREAS` in the generator) with **no "
            "automated and no manual** test:",
            "",
        ]
        lines += [f"- **{area}**" for area in report["coverage_gaps"]]
    else:
        lines.append("None — every curated feature area has at least one test. 🎉")
    lines.append("")

    if report["unmapped_categories"]:
        lines += [
            "## Categories not mapped to a feature area",
            "",
            "These test categories match no `FEATURE_AREAS` entry — add a mapping "
            "so their feature is tracked for coverage:",
            "",
        ]
        lines += [f"- `{cat}`" for cat in report["unmapped_categories"]]
        lines.append("")

    lines += [
        "## Inventory by feature",
        "",
        "| test id | feature | lane | platforms |",
        "| --- | --- | --- | --- |",
    ]
    for feature in report["features"]:
        for test in feature["tests"]:
            lines.append(
                f"| `{test['id']}` | {feature['feature']} | {test['lane']} | "
                f"{_fmt_platforms(test['platforms'])} |"
            )
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: "list[str] | None" = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate the harness test-inventory + coverage-gap report."
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--stdout",
        action="store_true",
        help="print the markdown report to stdout instead of writing files.",
    )
    group.add_argument(
        "--json",
        action="store_true",
        help="print the JSON report to stdout instead of writing files.",
    )
    args = parser.parse_args(argv)

    records = collect()

    if args.json:
        json.dump(build_report(records), sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 0
    if args.stdout:
        sys.stdout.write(render_markdown(records))
        return 0

    # Force LF newlines so regenerating on Windows does not rewrite the files
    # with CRLF and create a spurious diff (matches build-testid-catalog.py).
    with open(MD_PATH, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(render_markdown(records))
    with open(JSON_PATH, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(build_report(records), handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"Wrote {MD_PATH.relative_to(REPO_ROOT).as_posix()}")
    print(f"Wrote {JSON_PATH.relative_to(REPO_ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

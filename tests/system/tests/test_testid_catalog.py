"""Unit tests for the data-testid catalog generator (#899).

Loads ``scripts/build-testid-catalog.py`` directly (it is a script, not a
package) and exercises its pure classification/scanning helpers, plus an
end-to-end ``--check`` that guards the committed catalog against drift. No app
build or Docker is involved.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "build-testid-catalog.py"
CATALOG = REPO_ROOT / "tests" / "system" / "testid-catalog.md"


def _load_module():
    spec = importlib.util.spec_from_file_location("build_testid_catalog", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


mod = _load_module()


# ── classification ──────────────────────────────────────────────────────────


def test_literal_quoted_attribute():
    assert mod.classify_testid("quoted", "connection-editor-save") == (
        "literal",
        "connection-editor-save",
        "connection-editor-save",
    )


def test_literal_string_inside_jsx_expression():
    # data-testid={"foo"} and data-testid={`foo`} are still literal.
    assert mod.classify_testid("expr", '"foo"')[0] == "literal"
    assert mod.classify_testid("expr", "`foo`") == ("literal", "foo", "foo")


def test_dynamic_static_prefix():
    kind, key, raw = mod.classify_testid("expr", "`file-row-${entry.name}`")
    assert (kind, key) == ("dynamic", "file-row-*")
    assert raw == "file-row-${entry.name}"


def test_dynamic_static_suffix_and_multi_interpolation():
    assert mod.classify_testid("expr", "`${testIdPrefix}-download`")[:2] == (
        "dynamic",
        "*-download",
    )
    assert mod.classify_testid("expr", "`field-${a}-${b}-${c}`")[1] == "field-*-*-*"


def test_indirect_bare_expression():
    assert mod.classify_testid("expr", "option.testId") == (
        "indirect",
        "option.testId",
        "option.testId",
    )


def test_fully_dynamic_string_is_indirect_not_dynamic():
    # No static text survives — a bare "*" pattern is useless, so it's indirect.
    assert mod.classify_testid("quoted", "${command.testId}")[0] == "indirect"


def test_to_pattern_collapses_adjacent_globs():
    assert mod.to_pattern("${a}${b}-x") == "*-x"


def test_scan_mixed_jsx():
    snippet = """
      <div data-testid="literal-one" />
      <Row data-testid={`file-row-${name}`} />
      <X data-testid={option.testId} />
    """
    found = mod.scan_testids(snippet)
    assert ("quoted", "literal-one") in found
    assert ("expr", "`file-row-${name}`") in found
    assert ("expr", "option.testId") in found


# ── forwarded SidebarListItem/SidebarStatusDot props (#1431) ─────────────────


def test_scan_forwarded_props_quoted_and_template():
    # Consumers pass row/name/badge/status ids through the shared shell's props
    # instead of a raw data-testid, so the scanner must recognise them too.
    snippet = """
      <SidebarListItem
        testId="server-item-one"
        nameTestId={`server-name-${id}`}
        badgeTestId="server-type-one"
        status={<SidebarStatusDot tone="neutral" testId={`server-status-${id}`} />}
      />
    """
    found = mod.scan_testids(snippet)
    assert ("quoted", "server-item-one") in found
    assert ("expr", "`server-name-${id}`") in found
    assert ("quoted", "server-type-one") in found
    assert ("expr", "`server-status-${id}`") in found


def test_forwarding_prop_boundary_no_false_substring():
    # `nameTestId` / `badgeTestId` embed the substring `testId`; the boundary
    # check must not register a phantom bare `testId` match for either.
    found = mod.scan_testids('<X nameTestId="n" badgeTestId="b" />')
    assert ("quoted", "n") in found
    assert ("quoted", "b") in found
    assert len(found) == 2


def test_collect_attributes_forwarded_prop_to_consumer_file(tmp_path, monkeypatch):
    src = tmp_path / "src" / "components" / "Foo"
    src.mkdir(parents=True)
    consumer = src / "FooItem.tsx"
    consumer.write_text(
        "<SidebarListItem\n"
        '  testId="foo-item"\n'
        '  nameTestId="foo-name"\n'
        '  badgeTestId="foo-type"\n'
        '  status={<SidebarStatusDot tone="neutral" testId="foo-status" />}\n'
        "/>\n",
        encoding="utf-8",
    )
    # collect() renders source paths relative to REPO_ROOT; point it at tmp_path.
    monkeypatch.setattr(mod, "REPO_ROOT", tmp_path)
    literal = mod.collect(tmp_path / "src")["literal"]
    rel = "src/components/Foo/FooItem.tsx"
    for tid in ("foo-item", "foo-name", "foo-type", "foo-status"):
        assert tid in literal, f"{tid} not cataloged"
        assert rel in literal[tid]["files"]


# ── committed catalog stays in sync ─────────────────────────────────────────


def test_committed_catalog_is_up_to_date():
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--check"],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert result.returncode == 0, (
        f"{CATALOG.name} is stale — run `python scripts/build-testid-catalog.py`.\n"
        f"{result.stderr}"
    )


def test_catalog_contains_a_known_literal_id():
    text = CATALOG.read_text(encoding="utf-8")
    assert "`connection-editor-save`" in text
    assert "`file-row-*`" in text


def test_catalog_contains_forwarded_sidebar_prop_ids():
    # Ids forwarded through SidebarListItem/SidebarStatusDot props must appear in
    # the catalog even though they are never written as a literal data-testid.
    text = CATALOG.read_text(encoding="utf-8")
    for pattern in (
        "`server-item-*`",
        "`server-name-*`",
        "`server-status-*`",
        "`server-type-*`",
        "`workspace-item-*`",
        "`workspace-name-*`",
        "`tunnel-item-*`",
        "`tunnel-name-*`",
        "`tunnel-status-*`",
        "`tunnel-type-*`",
    ):
        assert pattern in text, f"{pattern} missing from catalog"

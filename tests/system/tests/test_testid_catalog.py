"""Unit tests for the data-testid catalog generator (#899).

Loads ``scripts/build-testid-catalog.py`` directly (it is a script, not a
package) and exercises its pure classification/scanning helpers, plus a
generate-and-verify pass that renders the catalog from the live ``src/`` tree
and asserts known ids are covered. The catalog is no longer committed, so there
is nothing to diff against and nothing to go stale (#1528); consistency is
verified by regenerating in-memory here instead. No app build or Docker is
involved.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "build-testid-catalog.py"


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


# ── generate-and-verify against the live source tree (#1528) ─────────────────


@pytest.fixture(scope="module")
def generated_catalog() -> str:
    """The catalog rendered from the live ``src/`` tree.

    The catalog is not committed, so freshness is meaningless — instead we scan
    the real source and assert the generator still covers the ids system-test
    authors rely on. A regression in the scanner (e.g. dropping forwarded props)
    fails here without any dependence on a checked-in file that could go stale.
    """
    return mod.render(mod.collect())


def test_catalog_contains_a_known_literal_id(generated_catalog: str):
    assert "`connection-editor-save`" in generated_catalog
    assert "`file-row-*`" in generated_catalog


def test_catalog_contains_forwarded_sidebar_prop_ids(generated_catalog: str):
    # Ids forwarded through SidebarListItem/SidebarStatusDot props must appear in
    # the catalog even though they are never written as a literal data-testid.
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
        assert pattern in generated_catalog, f"{pattern} missing from catalog"

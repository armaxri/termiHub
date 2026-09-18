"""Unit + integration tests for the static testid-drift guard (TIN-012).

Loads ``scripts/check-testid-drift.py`` directly (it is a script, not a package)
and exercises its pure extraction/classification helpers with synthetic inputs,
then runs the live guard against the real ``src/`` + ``tests/system/`` trees and
asserts there is no drift. No app build and no Docker are involved — the guard is
a static source scan, so this runs in the fast per-PR machinery lane alongside
``test_testid_catalog.py`` (the guard has its own blocking CI job too).
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "check-testid-drift.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("check_testid_drift", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


mod = _load_module()


# ── harness reference extraction ─────────────────────────────────────────────


def _write(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "ui_module.py"
    path.write_text(body, encoding="utf-8")
    return path


def test_selector_literal_is_referenced(tmp_path):
    lits, _ = mod.extract_references(
        _write(tmp_path, 'driver.click("connection-editor-save")\n')
    )
    assert "connection-editor-save" in lits


def test_class_constant_resolves_through_self(tmp_path):
    # The dominant harness pattern: a class constant clicked via ``self.SAVE``.
    body = (
        "class EditorUi:\n"
        '    SAVE = "file-editor-save"\n'
        "    def save(self):\n"
        "        self.driver.click(self.SAVE)\n"
    )
    lits, _ = mod.extract_references(_write(tmp_path, body))
    assert "file-editor-save" in lits


def test_fstring_builder_contributes_prefix(tmp_path):
    body = (
        "def file_row_testid(name):\n"
        '    return f"file-row-{name}"\n'
    )
    _, prefixes = mod.extract_references(_write(tmp_path, body))
    assert "file-row-" in prefixes


def test_non_testid_string_is_ignored(tmp_path):
    # A selector arg that is not testid-shaped (an enum/keyword) is not a ref.
    lits, _ = mod.extract_references(_write(tmp_path, 'driver.press_key("Escape")\n'))
    assert lits == set()


def test_negated_exists_is_not_a_reference(tmp_path):
    # ``assert not exists("x")`` deliberately references a REMOVED id — it must
    # not be counted as a must-exist reference, while a real click still is.
    body = (
        'assert not self.driver.exists("connection-editor-folder-select")\n'
        'self.driver.click("connection-editor-save")\n'
    )
    lits, _ = mod.extract_references(_write(tmp_path, body))
    assert "connection-editor-save" in lits
    assert "connection-editor-folder-select" not in lits


def test_positive_exists_still_counts_when_id_also_negated_elsewhere(tmp_path):
    # If the same id is waited-for positively too, it is a real reference.
    body = (
        'assert not self.driver.exists("thing-one")\n'
        'self.wait(lambda: self.driver.exists("thing-one"))\n'
    )
    lits, _ = mod.extract_references(_write(tmp_path, body))
    assert "thing-one" in lits


# ── source-side classification helpers ───────────────────────────────────────


def test_prop_testid_matches_forwarding_props_and_object_keys():
    # Custom ``*TestId`` props and object-property forms the catalog misses.
    for text, expected in (
        ('toggleTestId="connection-list-group-toggle"', "connection-list-group-toggle"),
        ('testId: "storage-mode-none"', "storage-mode-none"),
        ('"data-testid": `server-dialog-proto-${type}`', None),
    ):
        matches = mod._PROP_TESTID.findall(text)
        assert matches, text
        if expected is not None:
            kind, key, _ = mod._classify_value(mod._load_catalog_module(), matches[0])
            assert (kind, key) == ("literal", expected)


def test_prefix_prop_regex_captures_row_family():
    assert mod._PREFIX_PROP.findall('rowTestIdPrefix="dns-result"') == ['"dns-result"']


def test_specific_glob_excludes_pure_wildcards():
    assert mod._specific_glob("file-row-*") is True
    assert mod._specific_glob("*-download") is True
    assert mod._specific_glob("*-*") is False
    assert mod._specific_glob("*-*-*") is False


def test_literal_covered_by_specific_glob_not_by_wildcard():
    literals = {"file-editor-save"}
    specific = ["file-row-*"]
    assert mod._literal_covered("file-editor-save", literals, specific)
    assert mod._literal_covered("file-row-notes.txt", literals, specific)
    # A pure-wildcard glob is filtered out before this point, so a random id is
    # NOT considered covered — that is what lets literal renames be caught.
    assert not mod._literal_covered("something-else", literals, specific)


# ── live guard against the real trees (the actual gate) ──────────────────────


def test_no_testid_drift_on_current_tree():
    literal_drift, prefix_drift = mod.find_drift()
    assert literal_drift == [], (
        "harness references literal testids absent from src/**: "
        + ", ".join(t for t, _ in literal_drift)
    )
    assert prefix_drift == [], (
        "harness references builder-prefixes no src testid begins with: "
        + ", ".join(p for p, _ in prefix_drift)
    )

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


def test_source_side_covers_widened_forms_via_catalog_alone():
    # The guard no longer runs its own supplementary scan (#3044): the catalog's
    # scan must cover custom ``*TestId`` props, object-property keys,
    # ``setAttribute``, ``*TestIdPrefix`` row families and embedded templates.
    literals, globs, _ = mod.source_testids()
    assert "connection-list-group-toggle" in literals
    assert "storage-mode-none" in literals
    for glob in (
        "server-dialog-proto-*",
        "terminal-renderer-*",
        "dns-result-*",
        "*-dont-ask-again",
    ):
        assert glob in globs, glob


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


# ── registry-backed templates (#5341) ────────────────────────────────────────

tpl = mod.templates

_REGISTRY_TS = """
export const CATEGORIES: CategoryDefinition[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" }, // trailing comment
];
"""

_SETTINGS_CONFIG = {
    "registry": [
        {
            "globs": ["settings-nav-*"],
            "source": "registry.ts",
            "extract": {"kind": "object-field", "const": "CATEGORIES", "field": "id"},
        }
    ],
    "dynamic": {"file-row-*": "file name"},
}


def _classify(tmp_path, ts_text, config=_SETTINGS_CONFIG, globs=None):
    (tmp_path / "registry.ts").write_text(ts_text, encoding="utf-8")
    return tpl.classify(globs or ["settings-nav-*", "file-row-*"], config, tmp_path)


def _covered(cls, testid):
    globs = ["settings-nav-*", "file-row-*"]
    return mod._literal_covered(testid, set(), globs, tpl.expansions(cls["members"]))


def test_registry_member_passes(tmp_path):
    cls = _classify(tmp_path, _REGISTRY_TS)
    assert cls["problems"] == []
    assert cls["members"]["settings-nav-*"] == ["appearance", "general"]
    assert _covered(cls, "settings-nav-appearance")


def test_registry_typo_suffix_fails(tmp_path):
    cls = _classify(tmp_path, _REGISTRY_TS)
    assert not _covered(cls, "settings-nav-apperance")


def test_registry_removed_member_fails(tmp_path):
    removed = _REGISTRY_TS.replace('  { id: "appearance", label: "Appearance" },', "")
    cls = _classify(tmp_path, removed)
    assert cls["members"]["settings-nav-*"] == ["general"]
    assert not _covered(cls, "settings-nav-appearance")


def test_dynamic_template_passes_any_suffix(tmp_path):
    cls = _classify(tmp_path, _REGISTRY_TS)
    assert cls["kind"]["file-row-*"] == tpl.DYNAMIC
    assert _covered(cls, "file-row-anything-at-all")


def test_unresolvable_registry_falls_back_and_is_reported(tmp_path):
    # A member that is not a literal must not yield a partial (wrong) expansion.
    cls = _classify(tmp_path, "const CATEGORIES = [{ id: SOME_CONST }];\n")
    assert "settings-nav-*" not in cls["members"]
    assert cls["kind"]["settings-nav-*"] == tpl.REGISTRY
    assert any("non-literal" in p for p in cls["problems"])
    assert _covered(cls, "settings-nav-apperance")  # plain-glob fallback


def test_missing_registry_source_is_reported(tmp_path):
    cls = tpl.classify(["settings-nav-*"], _SETTINGS_CONFIG, tmp_path)
    assert any("not found" in p for p in cls["problems"])


def test_stale_config_glob_is_reported(tmp_path):
    cls = _classify(tmp_path, _REGISTRY_TS, globs=["settings-nav-*"])
    assert any("'file-row-*'" in p and "stale" in p for p in cls["problems"])


def test_star_leading_glob_is_a_caller_stem(tmp_path):
    cls = _classify(tmp_path, _REGISTRY_TS, globs=["settings-nav-*", "file-row-*", "*-confirm"])
    assert cls["kind"]["*-confirm"] == tpl.STEM


def test_extractors_cover_unions_arrays_and_transforms():
    union = 'export type Side =\n  | "local"\n  | "remote";\n'
    assert tpl.extract_members(union, {"kind": "union", "type": "Side"}) == ["local", "remote"]
    prop = 'export type Info = { /** doc */ level: "a" | "b", other: string, };'
    spec = {"kind": "property-union", "type": "Info", "property": "level"}
    assert tpl.extract_members(prop, spec) == ["a", "b"]
    arr = 'const SIZES = [1, 2, 4] as const;\nconst COLORS = ["#ef4444", "#22c55e"];'
    assert tpl.extract_members(arr, {"kind": "array", "const": "SIZES"}) == ["1", "2", "4"]
    colors = tpl.extract_members(arr, {"kind": "array", "const": "COLORS"}, "strip-hash")
    assert colors == ["22c55e", "ef4444"]
    items = 'const A = [{ label: "File Browser" }];\nconst B = [{ label: "Macros" }];'
    spec = {"kind": "object-field", "const": ["A", "B"], "field": "label"}
    assert tpl.extract_members(items, spec, "kebab-lower") == ["file-browser", "macros"]


def test_helper_call_resolves_to_concrete_id(tmp_path):
    # The harness wraps templated ids in helpers; a literal argument at the call
    # site must become a concrete reference so a typo there is caught.
    body = (
        "class SettingsUi:\n"
        "    def open_settings_category(self, category):\n"
        '        nav = f"settings-nav-{category}"\n'
        "        self.driver.click(nav)\n"
        "    def run(self):\n"
        '        self.open_settings_category("apperance")\n'
        '        self.open_settings_category(category="general")\n'
    )
    import ast

    tree = ast.parse(body)
    helpers = mod.builder_calls.merge(
        [
            mod.builder_calls.function_templates(
                tree, mod._SELECTOR_METHODS_ARG0, mod._SELECTOR_METHODS_TWO
            )
        ]
    )
    found = mod.builder_calls.call_literals(tree, helpers, {})
    assert found == {"settings-nav-apperance", "settings-nav-general"}


def test_conflicting_helper_definitions_are_skipped():
    a = {"open_thing": {("name", 0, 1, "a-", "")}}
    b = {"open_thing": {("name", 0, 1, "b-", "")}}
    assert mod.builder_calls.merge([a, b]) == {}


def test_live_typo_in_registry_backed_id_is_drift(monkeypatch):
    # End to end on the real src/**: a typo'd settings category is drift, a real
    # one is not.
    refs = {"settings-nav-apperance": {"x.py"}, "settings-nav-appearance": {"x.py"}}
    monkeypatch.setattr(mod, "harness_references", lambda: (refs, {}))
    result = mod.analyze()
    assert [t for t, _ in result["literal_drift"]] == ["settings-nav-apperance"]
    assert result["registry_misses"]["settings-nav-apperance"] == ["settings-nav-*"]


def test_live_template_config_resolves_cleanly():
    # Every registry entry in tests/system/testid-templates.json resolves and
    # every listed glob is still rendered — otherwise the guard would be
    # quietly falling back to plain globs.
    _, globs, _ = mod.source_testids()
    cls = mod.classify_globs(globs)
    assert cls["problems"] == []
    assert "appearance" in cls["members"]["settings-nav-*"]


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

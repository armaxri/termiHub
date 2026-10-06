"""Unit tests for ``scripts/manual-inventory.py`` (#3721, #4070).

Loads the script directly (it is a script, not a package) and checks its
parser, aggregation and Markdown rendering on synthetic corpora, plus that no
doc carries a committed count block (committed counts made every pair of
test-automation PRs conflict, #4070). Pure file parsing — no app, bridge,
Docker or PyYAML — so it runs in the normal (non-integration) lane.
"""

from __future__ import annotations

import importlib.util
import textwrap
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "manual-inventory.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("manual_inventory", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


mod = _load_module()

ALPHA = """\
    category: alpha
    display_name: "Alpha Things"

    tests:
      - id: MT-A-01
        release_gate: true
        manual_reason: "real OS store"
        name: "first"
        platforms: [macos]
        instructions: [do it]
        expected: [it works]

      - id: MT-A-02
        automation_issue: 1234
        name: "second"
        platforms: [linux]
        instructions: [do it]
        expected: [it works]
    """

BETA = """\
    category: beta

    tests:
      - id: MT-B-01
        automation_issue: 99
        name: "third"
        platforms: [all]
        instructions: [do it]
        expected: [it works]
    """


def _corpus(tmp_path: Path, **files: str) -> Path:
    for name, body in files.items():
        (tmp_path / f"{name}.yaml").write_text(textwrap.dedent(body), encoding="utf-8")
    return tmp_path


def test_load_items_reads_category_display_name_and_keys(tmp_path):
    items = mod.load_items(_corpus(tmp_path, alpha=ALPHA, beta=BETA))
    assert [(i.id, i.category, i.display_name) for i in items] == [
        ("MT-A-01", "alpha", "Alpha Things"),
        ("MT-A-02", "alpha", "Alpha Things"),
        # No display_name → falls back to the category, like test-manual.py.
        ("MT-B-01", "beta", "beta"),
    ]
    assert items[0].keys["release_gate"] == "true"
    assert items[1].keys["automation_issue"] == "1234"


def test_inventory_splits_release_gate_from_pending_and_sorts(tmp_path):
    # Written in reverse order to prove rows are sorted, not file-ordered.
    rows = mod.inventory(mod.load_items(_corpus(tmp_path, zeta=BETA, alpha=ALPHA)))
    assert rows == [
        mod.Row("alpha", "Alpha Things", "linux, macos", 1, 1),
        mod.Row("beta", "beta", "all", 0, 1),
    ]
    assert rows[0].total == 2


def test_render_is_deterministic_and_carries_totals(tmp_path):
    corpus = _corpus(tmp_path, alpha=ALPHA, beta=BETA)
    table = mod.render(mod.inventory(mod.load_items(corpus)))
    assert table == mod.render(mod.inventory(mod.load_items(corpus)))
    lines = table.splitlines()
    assert all(ln.startswith("|") for ln in lines)
    total = [c.strip() for c in lines[-1].strip("|").split("|")]
    assert total == ["**Total (2 categories)**", "", "", "**1**", "**2**", "**3**"]
    # Every table row has the same width (Prettier's aligned table layout).
    assert len({len(ln) for ln in lines}) == 1


def _isolate(monkeypatch, tmp_path, corpus, docs_dir):
    monkeypatch.setattr(mod, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(mod, "MANUAL_DIR", corpus)
    monkeypatch.setattr(mod, "DOCS_DIR", docs_dir)


def test_check_prints_table_and_appends_job_summary(tmp_path, monkeypatch, capsys):
    corpus = _corpus(tmp_path, alpha=ALPHA)
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "clean.md").write_text("# Doc\n\nRun the script for counts.\n", encoding="utf-8")
    summary = tmp_path / "summary.md"
    summary.write_text("earlier step\n", encoding="utf-8")
    _isolate(monkeypatch, tmp_path, corpus, docs)
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))

    assert mod.main(["--check"]) == 0
    table = mod.render(mod.inventory(mod.load_items(corpus)))
    assert table in capsys.readouterr().out
    written = summary.read_text(encoding="utf-8")
    assert written.startswith("earlier step\n")  # appended, not overwritten
    assert "### Manual-test inventory" in written and table in written


def test_check_without_summary_env_still_passes(tmp_path, monkeypatch):
    corpus = _corpus(tmp_path, alpha=ALPHA)
    docs = tmp_path / "docs"
    docs.mkdir()
    _isolate(monkeypatch, tmp_path, corpus, docs)
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    assert mod.main(["--check"]) == 0


def test_check_fails_when_a_doc_reintroduces_a_committed_block(tmp_path, monkeypatch, capsys):
    corpus = _corpus(tmp_path, alpha=ALPHA)
    docs = tmp_path / "docs" / "nested"
    docs.mkdir(parents=True)
    (docs / "bad.md").write_text(f"{mod.LEGACY_MARKER}\n| x |\n", encoding="utf-8")
    _isolate(monkeypatch, tmp_path, corpus, tmp_path / "docs")
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    assert mod.main(["--check"]) == 1
    assert "docs/nested/bad.md" in capsys.readouterr().err


def test_check_fails_on_empty_corpus(tmp_path, monkeypatch):
    empty = tmp_path / "manual"
    empty.mkdir()
    _isolate(monkeypatch, tmp_path, empty, tmp_path)
    assert mod.main(["--check"]) == 1


def test_retired_write_is_a_noop_that_explains(tmp_path, monkeypatch, capsys):
    _isolate(monkeypatch, tmp_path, tmp_path, tmp_path)
    assert mod.main(["--write"]) == 0
    assert "retired" in capsys.readouterr().err


def test_live_docs_carry_no_committed_inventory_block():
    """What CI's ``--check`` enforces on the real tree (#4070)."""
    assert mod.docs_with_committed_block() == []
    assert mod.inventory(mod.load_items()), "live corpus must not be empty"


# ---------------------------------------------------------------------------
# Required-key schema check (#4131)
# ---------------------------------------------------------------------------

COMPLETE = """\
    category: gamma

    tests:
      - id: MT-G-01
        release_gate: true
        manual_reason: "visual"
        name: "complete"
        instructions:
          - do it
        expected:
          - it works
    """

# MT-NET-16/21 shipped with ``title``/``steps`` instead of ``name``/
# ``instructions`` and crashed ``test-manual.py --list`` (#4131).
MISSPELLED = """\
    category: delta

    tests:
      - id: MT-D-01
        release_gate: true
        manual_reason: "visual"
        title: "wrong key"
        steps:
          - do it
        expected:
          - it works
    """


def test_schema_errors_accepts_a_complete_item(tmp_path):
    assert mod.schema_errors(mod.load_items(_corpus(tmp_path, gamma=COMPLETE))) == []


def test_schema_errors_names_the_item_and_suggests_the_real_key(tmp_path):
    errors = mod.schema_errors(mod.load_items(_corpus(tmp_path, delta=MISSPELLED)))
    assert errors == [
        "delta.yaml: MT-D-01: missing required key 'name' (found 'title' -- rename it to 'name')",
        "delta.yaml: MT-D-01: missing required key 'instructions'"
        " (found 'steps' -- rename it to 'instructions')",
    ]


def test_check_fails_on_a_missing_required_key(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(mod, "MANUAL_DIR", _corpus(tmp_path, gamma=COMPLETE, delta=MISSPELLED))
    assert mod.main(["--check"]) == 1
    err = capsys.readouterr().err
    assert "MT-D-01: missing required key 'name'" in err
    assert "MT-G-01" not in err


def test_real_corpus_has_every_required_key():
    assert mod.schema_errors(mod.load_items()) == []

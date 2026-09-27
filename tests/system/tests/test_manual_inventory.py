"""Unit tests for the generated manual-inventory doc blocks (#3721).

Loads ``scripts/manual-inventory.py`` directly (it is a script, not a package)
and checks its parser, aggregation and Markdown rendering on synthetic corpora,
plus that the blocks committed in ``docs/testing.md`` and
``docs/release-plan-0.1.0.md`` match a fresh render of the live corpus. Pure
file parsing — no app, bridge, Docker or PyYAML — so it runs in the normal
(non-integration) lane.
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

      - id: MT-A-02
        automation_issue: 1234
        name: "second"
        platforms: [linux]
    """

BETA = """\
    category: beta

    tests:
      - id: MT-B-01
        automation_issue: 99
        platforms: [all]
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
    block = mod.render(mod.inventory(mod.load_items(corpus)))
    assert block == mod.render(mod.inventory(mod.load_items(corpus)))
    lines = block.splitlines()
    assert lines[0] == mod.START and lines[-1] == mod.END
    assert mod.REGEN_CMD in block
    table = [ln for ln in lines if ln.startswith("|")]
    total = [c.strip() for c in table[-1].strip("|").split("|")]
    assert total == ["**Total (2 categories)**", "", "", "**1**", "**2**", "**3**"]
    # Every table row has the same width (Prettier's aligned table layout).
    assert len({len(ln) for ln in table}) == 1


def test_apply_replaces_only_the_marked_block():
    doc = f"intro\n\n{mod.START}\nstale\n{mod.END}\n\noutro\n"
    new = f"{mod.START}\nfresh\n{mod.END}"
    assert mod.apply(doc, new) == f"intro\n\n{new}\n\noutro\n"
    assert mod.apply("no markers here", new) is None


@pytest.mark.parametrize("stale", [False, True])
def test_check_and_write_modes(tmp_path, monkeypatch, capsys, stale):
    corpus = _corpus(tmp_path, alpha=ALPHA)
    doc = tmp_path / "doc.md"
    fresh = mod.render(mod.inventory(mod.load_items(corpus)))
    body = f"{mod.START}\nold\n{mod.END}" if stale else fresh
    doc.write_text(f"# Doc\n\n{body}\n", encoding="utf-8")
    monkeypatch.setattr(mod, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(mod, "MANUAL_DIR", corpus)
    monkeypatch.setattr(mod, "DOCS", (doc,))

    assert mod.main(["--check"]) == (1 if stale else 0)
    if stale:
        assert mod.REGEN_CMD in capsys.readouterr().err
    assert mod.main(["--write"]) == 0
    assert mod.main(["--check"]) == 0
    assert doc.read_text(encoding="utf-8") == f"# Doc\n\n{fresh}\n"


def test_check_fails_when_doc_has_no_block(tmp_path, monkeypatch):
    doc = tmp_path / "doc.md"
    doc.write_text("# Doc without markers\n", encoding="utf-8")
    monkeypatch.setattr(mod, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(mod, "DOCS", (doc,))
    assert mod.main(["--check"]) == 1


def test_committed_doc_blocks_match_the_live_corpus():
    """The real docs must carry a fresh block (what CI's ``--check`` enforces)."""
    block = mod.render(mod.inventory(mod.load_items()))
    for doc in mod.DOCS:
        text = doc.read_text(encoding="utf-8")
        assert mod.apply(text, block) == text, (
            f"{doc.relative_to(REPO_ROOT)}: manual-inventory block is stale; "
            f"run `{mod.REGEN_CMD}`"
        )

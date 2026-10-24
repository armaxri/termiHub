"""Guard the retirement of the legacy YAML manual corpus (#913, #919).

Until #919 the irreducibly-manual checks lived in ``tests/manual/*.yaml`` and
were walked by ``scripts/test-manual.py``. Every remaining item was ported to a
guided-manual pytest (``@pytest.mark.manual``) and the YAML runner was deleted,
so the harness is the single source of truth for manual tests.

This guard keeps it that way:

- the legacy runner and corpus do not come back;
- every retired item id is named in the docstring of a test function in a
  ``manual``-marked suite, so a later refactor cannot silently drop an item
  from the release gate;
- or, once an item is automated (the #4927 campaign), it is listed in
  ``AUTOMATED_IDS`` with the automated test whose docstring names it, and no
  guided test still claims it.

Pure ``ast`` parsing of the test modules — no app, bridge or Docker — so it runs
in the normal (non-integration) lane.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
TESTS_DIR = Path(__file__).resolve().parent

#: The 95 items the YAML corpus still held when it was retired (#919).
RETIRED_YAML_IDS = frozenset(
    """
    MT-APP-02 MT-APP-03 MT-APP-04 MT-APP-05
    MT-AGENT-28
    MT-CRED-01 MT-CRED-02 MT-CRED-03 MT-CRED-11 MT-CRED-12 MT-CRED-13 MT-CRED-14
    MT-CRED-15 MT-CRED-16 MT-CRED-17 MT-CRED-18
    MT-FB-30 MT-FB-31 MT-FB-32
    MT-LOCAL-03 MT-LOCAL-08 MT-LOCAL-30 MT-LOCAL-31 MT-LOCAL-32 MT-LOCAL-33
    MT-NET-16 MT-NET-21
    MT-NIN-01 MT-NIN-02 MT-NIN-03 MT-NIN-04 MT-NIN-05 MT-NIN-06 MT-NIN-07
    MT-NIN-10 MT-NIN-11 MT-NIN-12 MT-NIN-13 MT-NIN-14 MT-NIN-15 MT-NIN-16
    MT-NIN-20 MT-NIN-21 MT-NIN-22 MT-NIN-23 MT-NIN-24 MT-NIN-30 MT-NIN-31
    MT-RD-01 MT-RD-02 MT-RD-03 MT-RD-04 MT-RD-05 MT-RD-06 MT-RD-07 MT-RD-08
    MT-RD-09 MT-RD-10 MT-RD-11 MT-RD-12 MT-RD-13
    MT-SER-02
    MT-SHI-01 MT-SHI-02 MT-SHI-03 MT-SHI-04 MT-SHI-05 MT-SHI-06
    MT-SSH-01 MT-SSH-50 MT-SSH-51 MT-SSH-52
    MT-UI-05 MT-UI-13 MT-UI-40 MT-UI-41 MT-UI-42 MT-UI-43 MT-UI-44 MT-UI-45
    MT-UI-46 MT-UI-47 MT-UI-48 MT-UI-49 MT-UI-50 MT-UI-51 MT-UI-52 MT-UI-53
    MT-UI-54 MT-UI-55 MT-UI-56
    MT-WIN-01 MT-WIN-02 MT-WIN-03 MT-WIN-04
    """.split()
)

_THEME = "test_theme_grades.py"
_LAYOUT = "test_layout_grades.py"

#: Manual items retired into automated (non-``manual``) tests, mapped to the
#: ``<module>::<test function>`` whose docstring names the id (#4927). Covers
#: retired YAML items and later guided-only ones (MT-UI-16/35/36).
AUTOMATED_IDS: dict[str, str] = {
    # #4930: theme, layout and scrollbar grades from computed styles + measure_terminal.
    "MT-UI-05": f"{_THEME}::test_os_theme_toggle_switches_app_live",
    "MT-UI-13": f"{_THEME}::test_single_panel_border_blends_with_sidebar",
    "MT-UI-16": f"{_LAYOUT}::test_no_black_bar_at_terminal_bottom",
    "MT-UI-35": f"{_LAYOUT}::test_vertical_scrollbar_only_with_scrollback_and_same_in_both_modes",
    "MT-UI-36": f"{_LAYOUT}::test_vertical_scrollbar_only_with_scrollback_and_same_in_both_modes",
    "MT-UI-41": f"{_THEME}::test_scrollbar_thumb_visible_at_rest_in_every_theme",
    "MT-UI-43": "test_terminal_command_marks.py::test_gutter_bars_and_jump_highlight",
    "MT-UI-45": f"{_LAYOUT}::test_sidebar_paints_fully_on_cold_launch",
    "MT-UI-47": f"{_LAYOUT}::test_zoom_overlay_leaves_escape_to_terminal",
    "MT-UI-48": f"{_LAYOUT}::test_context_menu_in_zoomed_terminal_above_overlay",
    "MT-UI-49": f"{_THEME}::test_every_light_theme_gets_a_light_editor",
    "MT-UI-50": f"{_THEME}::test_charts_and_primary_buttons_follow_live_theme",
    "MT-UI-51": f"{_LAYOUT}::test_terminal_and_breadcrumb_scrollbars_follow_global_style",
    "MT-UI-52": f"{_THEME}::test_editor_background_matches_panes_in_every_theme",
}

_ID = re.compile(r"\bMT-[A-Z]+-\d+\b")


def _is_manual_module(tree: ast.Module) -> bool:
    """Whether the module carries ``pytest.mark.manual`` anywhere (module or test)."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr == "manual":
            value = node.value
            if isinstance(value, ast.Attribute) and value.attr == "mark":
                return True
    return False


def manual_test_ids(tests_dir: Path = TESTS_DIR) -> dict[str, list[str]]:
    """Map each ``MT-…`` id to the manual test functions whose docstring names it."""
    found: dict[str, list[str]] = {}
    for path in sorted(tests_dir.glob("test_*.py")):
        if path.name == Path(__file__).name:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        if not _is_manual_module(tree):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name.startswith("test_"):
                for item_id in _ID.findall(ast.get_docstring(node) or ""):
                    found.setdefault(item_id, []).append(f"{path.name}::{node.name}")
    return found


def test_legacy_runner_and_corpus_stay_deleted():
    assert not (REPO_ROOT / "scripts" / "test-manual.py").exists()
    assert not (REPO_ROOT / "scripts" / "manual-inventory.py").exists()
    assert not list((REPO_ROOT / "tests" / "manual").glob("*.yaml"))


def test_every_retired_yaml_item_has_a_guided_or_automated_test():
    found = manual_test_ids()
    missing = sorted(RETIRED_YAML_IDS - found.keys() - AUTOMATED_IDS.keys())
    assert not missing, (
        "retired YAML items named in no manual test docstring and not in AUTOMATED_IDS: "
        f"{', '.join(missing)}"
    )


def _test_docstring(module: str, function: str, tests_dir: Path = TESTS_DIR) -> str | None:
    """The docstring of test ``function`` in ``module`` (``None`` if it is missing)."""
    path = tests_dir / module
    if not path.exists():
        return None
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.FunctionDef) and node.name == function:
            return ast.get_docstring(node) or ""
    return None


def test_every_automated_item_names_its_test():
    wrong = []
    for item_id, target in sorted(AUTOMATED_IDS.items()):
        module, function = target.split("::")
        doc = _test_docstring(module, function)
        if doc is None or item_id not in _ID.findall(doc):
            wrong.append(f"{item_id} -> {target}")
    assert not wrong, f"automated items whose test is missing or does not name them: {wrong}"


def test_automated_items_live_in_automated_suites():
    manual_modules = {
        path.name
        for path in TESTS_DIR.glob("test_*.py")
        if _is_manual_module(ast.parse(path.read_text(encoding="utf-8")))
    }
    in_manual = {i: t for i, t in AUTOMATED_IDS.items() if t.split("::")[0] in manual_modules}
    assert not in_manual, f"automated items mapped into a manual suite: {in_manual}"


def test_automated_items_are_no_longer_guided():
    still_guided = {i: t for i, t in manual_test_ids().items() if i in AUTOMATED_IDS}
    assert not still_guided, f"automated items still claimed by a guided test: {still_guided}"


def test_retired_id_list_has_no_duplicates_and_expected_size():
    # 95 items when the corpus was retired; the frozenset would hide a duplicate.
    assert len(RETIRED_YAML_IDS) == 95

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
  :data:`AUTOMATED_IDS` and named in the docstring of that automated test,
  which runs in the integration lane instead of waiting for an operator — or,
  when a release install smoke grades it on the shipped artifacts (#4933), a
  frontend unit test (vitest) pins it per PR or the rendered visual checks
  (#4712) audit it, named in the text of that file — and no guided test still
  claims it.

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
_CAPTURE = "test_native_capture_grades.py"
_PAINT = "test_native_paint_grades.py"

#: Manual items retired into automated (not ``manual``-marked) tests (#4927),
#: mapped to the ``"<module>::<test function>"`` whose docstring names the id,
#: or to a repo-relative file whose text names it (one of :data:`_FILE_PREFIXES`):
#: a release install smoke script (``scripts/...``, run by
#: ``.github/workflows/release-*-smoke.yml``, #4933), a frontend unit test
#: (``src/...``), or the rendered visual checks (``tests/visual/...``, #4712).
#: The guided-manual test is deleted when the item moves here. Covers retired
#: YAML items and later guided-only ones (see :data:`LATER_GUIDED_IDS`).
AUTOMATED_IDS: dict[str, str] = {
    # #4929: the harness reads the OS credential store itself.
    "MT-CRED-01": "test_os_credential_store.py::test_saved_password_lands_in_the_os_credential_store",
    "MT-CRED-02": "test_os_credential_store.py::test_saved_password_lands_in_the_os_credential_store",
    "MT-CRED-03": "test_os_credential_store.py::test_saved_password_lands_in_the_os_credential_store",
    "MT-CRED-18": "test_os_credential_store.py::test_backup_restore_imports_credentials_into_the_os_store",
    # #4931: flash, ordering, flood and hidden-tab memory checks.
    "MT-LOCAL-05": "test_output_flash_and_flood.py::test_ssh_connect_paints_no_setup_flash",
    "MT-LOCAL-30": "test_windows_shells.py::test_cmd_output_paints_in_order",
    "MT-LOCAL-32": (
        "test_output_flash_and_flood.py::test_output_flood_stays_bounded_and_ctrl_c_stops_it"
    ),
    "MT-LOCAL-33": (
        "test_performance.py::test_perf_03b_every_tab_renders_and_hidden_tabs_release_webgl"
    ),
    # #4933: graded on the shipped artifacts by the release install smokes.
    "MT-APP-02": "scripts/internal/release-smoke-app-lifecycle.sh",
    "MT-APP-04": "scripts/internal/release-smoke-app-lifecycle.sh",
    "MT-UI-19": "scripts/internal/release-smoke-bundle-icon.sh",
    # #4928: guided checks that duplicated existing automation.
    # Shell chords reach the PTY: no default binding claims them, they are
    # shell-reserved, and the terminal router passes them through.
    "MT-KB-09": "src/services/keybindings.test.ts",
    "MT-KB-10": "src/services/keybindings.test.ts",
    "MT-KB-11": "src/services/keybindings.test.ts",
    "MT-KB-12": "src/components/Terminal/terminalInputRouting.test.ts",
    "MT-KB-13": "src/hooks/useKeyboardShortcuts.test.ts",
    "MT-KB-14": "src/hooks/useKeyboardShortcuts.test.ts",
    # Real drag gestures over the bridge onto the dnd-kit drop zones (#2583).
    "MT-TAB-06": "test_layout_scrollback_ui.py::test_drag_to_edge_preserves_scrollback",
    "MT-TAB-07": "test_layout_scrollback_ui.py::test_drag_to_center_preserves_scrollback",
    "MT-FB-16": "test_file_browser_local.py::test_vscode_menu_item_matches_availability",
    "MT-FB-23": (
        "test_file_browser_local.py::test_open_folder_vscode_toolbar_matches_availability"
    ),
    # Rendered visual checks (#4712) at 1280x800, 1024x700 and 800x600.
    "MT-CRED-17": "tests/visual/surfaces.spec.ts",
    "MT-UI-54": "tests/visual/surfaces.spec.ts",
    "MT-UI-55": "tests/visual/surfaces.spec.ts",
    # The revoke flow is unit-tested; its look is a rendered visual surface.
    "MT-UI-56": "src/components/Settings/ImportedWorkspaceConfirmations.test.tsx",
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
    # #4937: graded on a native capture of the test app's window (by its PID).
    "MT-SSH-01": f"{_CAPTURE}::test_agnoster_prompt_has_no_black_rectangle",
    "MT-SSH-02": f"{_CAPTURE}::test_ansi_16_colours_paint_their_palette_colour",
    "MT-UI-31": f"{_CAPTURE}::test_box_drawing_strokes_are_continuous",
    "MT-SER-01": f"{_CAPTURE}::test_nerd_font_glyphs_render_from_the_bundled_font",
    "MT-SER-02": f"{_CAPTURE}::test_nerd_font_glyphs_render_from_the_bundled_font",
    "MT-UI-01": f"{_PAINT}::test_cold_launch_paints_no_white_frame",
    "MT-UI-42": f"{_PAINT}::test_zoom_unzoom_and_split_repaint_without_scrolling",
    "MT-UI-44": f"{_PAINT}::test_inline_images_paint_scroll_and_repaint_on_both_renderers",
}

#: Automated items that were never in the retired YAML corpus — they lived only
#: as guided-manual tests before being automated.
LATER_GUIDED_IDS = frozenset(
    {
        "MT-LOCAL-05",
        "MT-UI-16",
        "MT-UI-19",
        "MT-UI-35",
        "MT-UI-36",
        "MT-KB-09",
        "MT-KB-10",
        "MT-KB-11",
        "MT-KB-12",
        "MT-KB-13",
        "MT-KB-14",
        "MT-TAB-06",
        "MT-TAB-07",
        "MT-FB-16",
        "MT-FB-23",
        "MT-SSH-02",
        "MT-UI-31",
        "MT-SER-01",
        "MT-UI-01",
    }
)

#: Repo-relative locations an :data:`AUTOMATED_IDS` value may name as a file
#: (rather than a ``module::test`` in this directory).
_FILE_PREFIXES = ("scripts/", "src/", "tests/visual/")

_ID = re.compile(r"\bMT-[A-Z]+-\d+\b")


def _is_manual_module(tree: ast.Module) -> bool:
    """Whether the module carries ``pytest.mark.manual`` anywhere (module or test)."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr == "manual":
            value = node.value
            if isinstance(value, ast.Attribute) and value.attr == "mark":
                return True
    return False


def manual_test_ids(
    tests_dir: Path = TESTS_DIR, *, manual: bool = True
) -> dict[str, list[str]]:
    """Map each ``MT-…`` id to the test functions whose docstring names it.

    ``manual=True`` reads only ``manual``-marked modules, ``False`` only the
    others (the automated suites).
    """
    found: dict[str, list[str]] = {}
    for path in sorted(tests_dir.glob("test_*.py")):
        if path.name == Path(__file__).name:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        if _is_manual_module(tree) != manual:
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
        "retired YAML items no longer named in any manual test docstring "
        f"(nor listed in AUTOMATED_IDS): {', '.join(missing)}"
    )


def _names_item(item_id: str, test: str, automated: dict[str, list[str]]) -> bool:
    if test.startswith(_FILE_PREFIXES):
        path = REPO_ROOT / test
        return path.is_file() and item_id in _ID.findall(path.read_text(encoding="utf-8"))
    return test in automated.get(item_id, [])


def test_automated_items_name_their_automated_test():
    automated = manual_test_ids(manual=False)
    wrong = {
        item_id: (test, automated.get(item_id, []))
        for item_id, test in AUTOMATED_IDS.items()
        if not _names_item(item_id, test, automated)
    }
    assert not wrong, (
        "AUTOMATED_IDS entries whose automated test (or named file) does not exist "
        f"or does not name the item: {wrong}"
    )


def test_automated_items_have_no_guided_test_left():
    manual = manual_test_ids()
    both = sorted(AUTOMATED_IDS.keys() & manual.keys())
    assert not both, f"automated items still walked by a guided test: {both}"


def test_automated_ids_are_retired_or_later_guided_items():
    unknown = sorted(AUTOMATED_IDS.keys() - RETIRED_YAML_IDS - LATER_GUIDED_IDS)
    assert not unknown, (
        f"AUTOMATED_IDS entries that are neither retired nor later-guided: {unknown}"
    )


def test_later_guided_ids_are_automated_and_not_retired_yaml():
    assert LATER_GUIDED_IDS <= AUTOMATED_IDS.keys()
    assert not (LATER_GUIDED_IDS & RETIRED_YAML_IDS)


def test_retired_id_list_has_no_duplicates_and_expected_size():
    # 95 items when the corpus was retired; the frozenset would hide a duplicate.
    assert len(RETIRED_YAML_IDS) == 95

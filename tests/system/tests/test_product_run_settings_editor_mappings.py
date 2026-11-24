"""The product run's Settings ▸ Editor file type mappings grade (#5841), without an app.

The user's mappings and the add form come first; the built-in mappings fold
behind "Show built-in mappings (N)" with a filter; the language comes from a
searchable list of known languages, and the page says "language", not "Monaco
language ID". The live measurement runs in the desktop phase's editor mappings
step; this file runs in the normal (per-PR) lane.
"""

from __future__ import annotations

from termihub_harness.product_run.editor_mappings import (
    EXPECTED_LANGUAGES,
    FILTER_QUERY,
    MAX_COLLAPSED_SECTION_HEIGHT,
    editor_mappings_problems,
)


def _box(y, height, x=0.0, width=600.0):
    return {"x": x, "y": y, "width": width, "height": height}


def _good():
    return {
        "editor_text": "Editor Custom file type mappings Choose the language a file opens in.",
        "legacy_language_input": False,
        "language_select": True,
        "disclosure": {"text": "Show built-in mappings (92)", "expanded": "false"},
        "collapsed_table": False,
        "section": _box(400.0, 64.0),
        "add_form": _box(180.0, 28.0),
        "expanded": {
            "expanded": "true",
            "table": True,
            "filter": True,
            "rows": 92,
            "filtered": [
                {"pattern": "Dockerfile", "language": "dockerfile"},
                {"pattern": ".dockerignore", "language": "plaintext"},
            ],
        },
        "picker": {"search": True, "offered": list(EXPECTED_LANGUAGES), "query_hit": True},
    }


def test_a_good_page_passes():
    assert editor_mappings_problems(_good()) == []


def test_nothing_measured_passes():
    assert editor_mappings_problems({}) == []


def test_the_grade_filters_on_a_real_built_in_term():
    # Dockerfile / .dockerignore are built-ins in languageMapping.ts.
    assert FILTER_QUERY == "docker"


def test_an_unfolded_table_fails():
    # R-029: the ~2600 px built-in table dominating the page.
    m = _good()
    m["disclosure"]["expanded"] = "true"
    m["collapsed_table"] = True
    m["section"] = _box(400.0, 2600.0)
    problems = editor_mappings_problems(m)
    assert "the built-in mappings are not folded by default" in problems
    assert "the built-in table shows while folded" in problems
    assert any(f"> {MAX_COLLAPSED_SECTION_HEIGHT:.0f}px" in p for p in problems)


def test_no_disclosure_fails():
    m = _good()
    m["disclosure"] = None
    assert editor_mappings_problems(m) == ["no 'Show built-in mappings' disclosure"]


def test_an_uncounted_disclosure_fails():
    m = _good()
    m["disclosure"]["text"] = "Built-in defaults"
    assert any("want 'Show built-in mappings (N)'" in p for p in editor_mappings_problems(m))


def test_a_zero_count_fails():
    m = _good()
    m["disclosure"]["text"] = "Show built-in mappings (0)"
    assert "the disclosure counts 0 built-in mappings" in editor_mappings_problems(m)


def test_built_ins_above_the_add_form_fail():
    m = _good()
    m["add_form"] = _box(900.0, 28.0)
    assert "the add-mapping form is not above the built-in mappings" in (
        editor_mappings_problems(m)
    )


def test_unfolding_without_a_table_or_filter_fails():
    m = _good()
    m["expanded"] = {"expanded": "false", "table": False, "filter": False, "rows": 0}
    problems = editor_mappings_problems(m)
    assert "the disclosure does not report aria-expanded=true when open" in problems
    assert "unfolding shows no built-in table" in problems
    assert "the unfolded built-in mappings have no filter" in problems


def test_a_filter_that_does_not_narrow_fails():
    m = _good()
    m["expanded"]["rows"] = 2
    assert "filter 'docker' does not narrow the table" in editor_mappings_problems(m)


def test_a_filter_keeping_unrelated_rows_fails():
    m = _good()
    m["expanded"]["filtered"].append({"pattern": "Makefile", "language": "makefile"})
    assert any("kept unrelated row" in p for p in editor_mappings_problems(m))


def test_a_filter_with_no_rows_fails():
    m = _good()
    m["expanded"]["filtered"] = []
    assert "filter 'docker' leaves no rows" in editor_mappings_problems(m)


def test_a_free_text_language_fails():
    # R-102: a typo silently saves an unknown language.
    m = _good()
    m["legacy_language_input"] = True
    m["language_select"] = False
    assert "the language is a free-text field, not a list of known languages" in (
        editor_mappings_problems(m)
    )


def test_monaco_jargon_fails():
    m = _good()
    m["editor_text"] += " Values must be valid Monaco language IDs."
    assert "the page still says 'Monaco' / 'language ID'" in editor_mappings_problems(m)


def test_a_language_list_without_search_fails():
    m = _good()
    m["picker"] = {"search": False, "offered": list(EXPECTED_LANGUAGES)}
    assert "the language list has no search box" in editor_mappings_problems(m)


def test_a_stub_language_list_fails():
    m = _good()
    m["picker"]["offered"] = ["javascript"]
    assert any("does not offer json" in p for p in editor_mappings_problems(m))


def test_a_search_that_misses_fails():
    m = _good()
    m["picker"]["query_hit"] = False
    assert "searching 'hcl' does not offer hcl" in editor_mappings_problems(m)

"""Settings ▸ Editor file type mappings (#5841): measure live, grade without an app.

The user's own mappings and the add form come first; the ~100 built-in
mappings are folded behind a "Show built-in mappings (N)" disclosure with a
filter, so the built-in section is a single line until asked for. The language
is chosen from a searchable list of known languages instead of typed free
text, and the page says "language", not "Monaco language ID".
:func:`measure_editor_mappings` reads the open Editor category (and drives the
disclosure, its filter and the language list); :func:`editor_mappings_problems`
grades the result and runs in the normal lane.
"""

from __future__ import annotations

import re
from typing import Any, Optional

#: The collapsed built-in section (heading + disclosure button) stays this short.
#: The unfolded table was ~2600 px (R-029).
MAX_COLLAPSED_SECTION_HEIGHT = 120.0
#: The built-in filter the live step types, and what each row must then mention.
FILTER_QUERY = "docker"
#: The language search the live step types, and the option it must offer.
LANGUAGE_QUERY = "hcl"
LANGUAGE_OPTION = "file-type-language-option-hcl"
#: Common languages the unfiltered list must offer (a real list, not a stub).
EXPECTED_LANGUAGES = ("javascript", "json", "shell", "yaml")

SECTION = "file-type-builtin-section"
DISCLOSURE = "file-type-builtin-disclosure"
TABLE = "file-type-builtin-table"
FILTER = "file-type-builtin-filter"
ADD_FORM_PATTERN = "file-type-pattern-input"
LANGUAGE_SELECT = "file-type-language-select"
LANGUAGE_SEARCH = "file-type-language-search"
LEGACY_LANGUAGE_INPUT = "file-type-language-input"
EDITOR = "settings-editor"

_SHOW_RE = re.compile(r"^Show built-in mappings \((\d+)\)$")
_JARGON_RE = re.compile(r"monaco|language id", re.IGNORECASE)


def _rows(driver: Any) -> list[dict[str, str]]:
    """Pattern / language text of each visible built-in table row."""
    table = driver.measure_element(TABLE, "text")
    rows: dict[str, dict[str, str]] = {}
    for item in table.get("items") or []:
        test_id = item.get("testId") or ""
        for column in ("pattern", "language"):
            prefix = f"file-type-builtin-{column}-"
            if test_id.startswith(prefix):
                key = test_id[len(prefix):]
                rows.setdefault(key, {})[column] = (item.get("text") or "").strip()
    return [{"pattern": k, **v} for k, v in rows.items()]


def measure_editor_mappings(driver: Any) -> dict[str, Any]:
    """Read the open Settings ▸ Editor category, then unfold and probe it.

    Leaves the page as it found it: the disclosure folded again and the
    language list closed.
    """
    m: dict[str, Any] = {
        "editor_text": driver.get_text(EDITOR),
        "legacy_language_input": driver.exists(LEGACY_LANGUAGE_INPUT),
        "language_select": driver.exists(LANGUAGE_SELECT),
    }
    if not driver.exists(DISCLOSURE):
        m["disclosure"] = None
        return m
    m["disclosure"] = {
        "text": driver.get_text(DISCLOSURE).strip(),
        "expanded": driver.get_attribute(DISCLOSURE, "aria-expanded"),
    }
    m["collapsed_table"] = driver.exists(TABLE)
    m["section"] = driver.measure_element(SECTION)["rect"]
    m["add_form"] = driver.measure_element(ADD_FORM_PATTERN)["rect"]

    driver.click(DISCLOSURE)
    try:
        m["expanded"] = {
            "expanded": driver.get_attribute(DISCLOSURE, "aria-expanded"),
            "table": driver.exists(TABLE),
            "filter": driver.exists(FILTER),
            "rows": len(_rows(driver)) if driver.exists(TABLE) else 0,
        }
        if driver.exists(FILTER):
            driver.type(FILTER, FILTER_QUERY)
            m["expanded"]["filtered"] = _rows(driver) if driver.exists(TABLE) else []
    finally:
        driver.click(DISCLOSURE)

    if driver.exists(LANGUAGE_SELECT):
        driver.click(LANGUAGE_SELECT)
        try:
            m["picker"] = {"search": driver.exists(LANGUAGE_SEARCH)}
            m["picker"]["offered"] = [
                lang for lang in EXPECTED_LANGUAGES
                if driver.exists(f"file-type-language-option-{lang}")
            ]
            if m["picker"]["search"]:
                driver.type(LANGUAGE_SEARCH, LANGUAGE_QUERY)
                m["picker"]["query_hit"] = driver.exists(LANGUAGE_OPTION)
        finally:
            driver.press_key("Escape")
    return m


def _disclosure_problems(m: dict[str, Any]) -> list[str]:
    disclosure: Optional[dict[str, Any]] = m.get("disclosure")
    if disclosure is None:
        return ["no 'Show built-in mappings' disclosure"]
    problems = []
    match = _SHOW_RE.match(disclosure.get("text") or "")
    if not match:
        problems.append(
            f"disclosure reads {disclosure.get('text')!r}, want 'Show built-in mappings (N)'"
        )
    elif int(match.group(1)) == 0:
        problems.append("the disclosure counts 0 built-in mappings")
    if disclosure.get("expanded") != "false":
        problems.append("the built-in mappings are not folded by default")
    if m.get("collapsed_table"):
        problems.append("the built-in table shows while folded")
    section = m.get("section")
    if section and section["height"] > MAX_COLLAPSED_SECTION_HEIGHT:
        problems.append(
            f"the folded built-in section is {section['height']:.0f}px tall "
            f"(> {MAX_COLLAPSED_SECTION_HEIGHT:.0f}px)"
        )
    add_form = m.get("add_form")
    if section and add_form and add_form["y"] >= section["y"]:
        problems.append("the add-mapping form is not above the built-in mappings")
    return problems


def _expanded_problems(m: dict[str, Any]) -> list[str]:
    expanded = m.get("expanded")
    if expanded is None:
        return []
    problems = []
    if expanded.get("expanded") != "true":
        problems.append("the disclosure does not report aria-expanded=true when open")
    if not expanded.get("table"):
        problems.append("unfolding shows no built-in table")
    if not expanded.get("filter"):
        problems.append("the unfolded built-in mappings have no filter")
    filtered = expanded.get("filtered")
    if filtered is not None:
        if not filtered:
            problems.append(f"filter {FILTER_QUERY!r} leaves no rows")
        elif len(filtered) >= expanded.get("rows", 0):
            problems.append(f"filter {FILTER_QUERY!r} does not narrow the table")
        for row in filtered:
            text = f"{row.get('pattern', '')} {row.get('language', '')}".lower()
            if FILTER_QUERY not in text:
                problems.append(f"filter {FILTER_QUERY!r} kept unrelated row {row}")
    return problems


def _language_problems(m: dict[str, Any]) -> list[str]:
    problems = []
    if m.get("legacy_language_input") or not m.get("language_select"):
        problems.append("the language is a free-text field, not a list of known languages")
    if _JARGON_RE.search(m.get("editor_text") or ""):
        problems.append("the page still says 'Monaco' / 'language ID'")
    picker = m.get("picker")
    if picker is not None:
        if not picker.get("search"):
            problems.append("the language list has no search box")
        missing = [lang for lang in EXPECTED_LANGUAGES if lang not in picker.get("offered", [])]
        if missing:
            problems.append(f"the language list does not offer {', '.join(missing)}")
        if picker.get("search") and not picker.get("query_hit"):
            problems.append(f"searching {LANGUAGE_QUERY!r} does not offer {LANGUAGE_QUERY}")
    return problems


def editor_mappings_problems(m: dict[str, Any]) -> list[str]:
    """Every way the measured Editor mappings page misses #5841; ``[]`` passes."""
    if not m:
        return []
    return _disclosure_problems(m) + _expanded_problems(m) + _language_problems(m)

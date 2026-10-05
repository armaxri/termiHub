"""Unit tests for the required-key check in ``scripts/test-manual.py`` (#4131).

MT-NET-16/21 used ``title:`` instead of ``name:`` and ``test-manual.py --list``
crashed with a bare ``KeyError: 'name'``. The runner now validates every item
on load and reports the file and id of each malformed one.

The runner imports PyYAML at module load, which the harness venv does not
carry; ``validate_test`` itself is pure, so a stub ``yaml`` module is injected
when the real one is absent. The end-to-end ``load_tests`` case needs real
PyYAML and is skipped without it. Runs in the normal (non-integration) lane.
"""

from __future__ import annotations

import importlib.util
import sys
import textwrap
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "test-manual.py"

try:
    import yaml  # noqa: F401

    HAVE_YAML = True
except ImportError:
    HAVE_YAML = False


def _load_module():
    if not HAVE_YAML:
        sys.modules.setdefault("yaml", types.ModuleType("yaml"))
    spec = importlib.util.spec_from_file_location("test_manual_runner", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    try:
        spec.loader.exec_module(module)
    finally:
        if not HAVE_YAML:
            sys.modules.pop("yaml", None)
    return module


mod = _load_module()

COMPLETE = {
    "id": "MT-X-01",
    "name": "complete",
    "instructions": ["do it"],
    "expected": ["it works"],
}


def test_complete_item_has_no_errors():
    assert mod.validate_test(dict(COMPLETE), "x.yaml") == []


def test_title_instead_of_name_is_reported_with_file_and_id():
    item = {k: v for k, v in COMPLETE.items() if k != "name"}
    item["title"] = "wrong key"
    assert mod.validate_test(item, "network-tools.yaml") == [
        "network-tools.yaml: MT-X-01: missing required key 'name'"
    ]


def test_item_without_id_or_not_a_mapping_is_reported():
    assert mod.validate_test({"name": "n", "instructions": [], "expected": []}, "a.yaml") == [
        "a.yaml: <no id>: missing required key 'id'"
    ]
    assert mod.validate_test("just a string", "a.yaml") == [
        "a.yaml: item is not a mapping: 'just a string'"
    ]


@pytest.mark.skipif(not HAVE_YAML, reason="PyYAML not installed")
def test_load_tests_raises_a_clear_error_instead_of_keyerror(tmp_path):
    (tmp_path / "net.yaml").write_text(
        textwrap.dedent(
            """\
            category: net
            tests:
              - id: MT-NET-99
                title: Traceroute
                instructions: [run it]
                expected: [hops]
            """
        ),
        encoding="utf-8",
    )
    with pytest.raises(mod.ManualSchemaError) as exc:
        mod.load_tests(tmp_path)
    assert "net.yaml: MT-NET-99: missing required key 'name'" in str(exc.value)


@pytest.mark.skipif(not HAVE_YAML, reason="PyYAML not installed")
def test_real_corpus_loads():
    assert mod.load_tests(REPO_ROOT / "tests" / "manual")

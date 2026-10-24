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
- or, once a release install smoke grades it on the shipped artifacts (#4933),
  it is listed in :data:`RELEASE_SMOKE_IDS` with the smoke script that names it,
  and no guided test still claims it.

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

#: Manual items the release install smokes (``.github/workflows/release-*-smoke.yml``)
#: now grade on the shipped artifacts (#4933), mapped to the smoke script
#: (repo-relative) whose text names the id. The guided test is deleted.
RELEASE_SMOKE_IDS: dict[str, str] = {
    "MT-APP-02": "scripts/internal/release-smoke-app-lifecycle.sh",
    "MT-APP-04": "scripts/internal/release-smoke-app-lifecycle.sh",
    "MT-UI-19": "scripts/internal/release-smoke-bundle-icon.sh",
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


def test_every_retired_yaml_item_has_a_guided_test():
    found = manual_test_ids()
    missing = sorted(RETIRED_YAML_IDS - found.keys() - RELEASE_SMOKE_IDS.keys())
    assert not missing, (
        "retired YAML items no longer named in any manual test docstring: "
        f"{', '.join(missing)}"
    )


def test_release_smoke_items_name_their_script_and_are_no_longer_guided():
    for item_id, script in RELEASE_SMOKE_IDS.items():
        path = REPO_ROOT / script
        assert path.is_file(), f"{item_id}: {script} does not exist"
        assert item_id in _ID.findall(path.read_text(encoding="utf-8")), (
            f"{item_id}: {script} does not name the item"
        )
    still_guided = sorted(RELEASE_SMOKE_IDS.keys() & manual_test_ids().keys())
    assert not still_guided, f"release-smoke items still walked by a guided test: {still_guided}"


def test_retired_id_list_has_no_duplicates_and_expected_size():
    # 95 items when the corpus was retired; the frozenset would hide a duplicate.
    assert len(RETIRED_YAML_IDS) == 95

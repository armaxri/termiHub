"""Unit tests for the test-inventory + coverage-gap generator (#1950).

Loads ``scripts/build-test-inventory.py`` directly (it is a script, not a
package) and exercises its pure introspection/grouping/gap helpers, plus a
generate-and-verify pass over the live ``tests/system/tests`` tree. Like the
testid catalog (#1528) the report is not committed, so there is nothing to diff
and nothing to go stale — coverage is verified by regenerating in-memory here.
No app build, no Docker, and no harness ``.venv`` beyond pytest is involved (the
generator is stdlib-only and parses the test modules with ``ast``).
"""

from __future__ import annotations

import importlib.util
import textwrap
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "build-test-inventory.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("build_test_inventory", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


mod = _load_module()


def _write(tmp_path: Path, name: str, body: str) -> Path:
    path = tmp_path / name
    path.write_text(textwrap.dedent(body), encoding="utf-8")
    return path


def _collect_body(tmp_path: Path, name: str, body: str, monkeypatch) -> "list[dict]":
    """Parse one synthetic module, with SYSTEM_DIR pointed at ``tmp_path``."""
    monkeypatch.setattr(mod, "SYSTEM_DIR", tmp_path)
    return mod.collect_file(_write(tmp_path, name, body))


# ── category derivation ─────────────────────────────────────────────────────


def test_category_defaults_to_filename_stem():
    assert mod.category_for([], "test_ssh_agent.py") == "ssh_agent"
    assert mod.category_for([], "test_local_shell.py") == "local_shell"


def test_category_marker_overrides_filename(tmp_path, monkeypatch):
    records = _collect_body(
        tmp_path,
        "test_ssh_agent.py",
        """
        import pytest

        @pytest.mark.category("ssh")
        class TestAgent:
            def test_one(self): ...
        """,
        monkeypatch,
    )
    assert records[0]["feature"] == "ssh"


def test_module_level_category_marker(tmp_path, monkeypatch):
    records = _collect_body(
        tmp_path,
        "test_ssh_keys.py",
        """
        import pytest

        pytestmark = pytest.mark.category("ssh")

        def test_keys(): ...
        """,
        monkeypatch,
    )
    assert records[0]["feature"] == "ssh"


# ── lane classification ─────────────────────────────────────────────────────


def test_lane_is_automated_without_any_lane_mark():
    assert mod.lane_for([mod.Mark("slow", None, "")]) == "automated"
    assert mod.lane_for([]) == "automated"


def test_integration_mark_is_its_own_lane():
    # #2050: integration tests do NOT run on the per-PR gate, so they must not be
    # counted as "automated" merge-gate coverage.
    assert mod.lane_for([mod.Mark("integration", None, "")]) == "integration"


def test_lane_is_manual_with_manual_mark():
    assert mod.lane_for([mod.Mark("manual", None, "")]) == "manual"


def test_manual_wins_over_integration():
    lane = mod.lane_for(
        [mod.Mark("integration", None, ""), mod.Mark("manual", None, "")]
    )
    assert lane == "manual"


def test_module_manual_mark_applies_to_methods(tmp_path, monkeypatch):
    records = _collect_body(
        tmp_path,
        "test_native_dialogs.py",
        """
        import pytest

        pytestmark = [pytest.mark.integration, pytest.mark.manual]

        class TestDialogs:
            def test_export(self): ...
        """,
        monkeypatch,
    )
    assert records[0]["lane"] == "manual"


# ── platform narrowing ──────────────────────────────────────────────────────


def test_platforms_default_to_all():
    assert mod.platforms_for([]) == ["linux", "macos", "windows"]


def test_skip_on_non_windows_narrows_to_windows(tmp_path, monkeypatch):
    records = _collect_body(
        tmp_path,
        "test_windows_shells.py",
        """
        import pytest

        skip_on_non_windows = pytest.mark.skipif(
            "sys.platform != 'win32'", reason="Windows only"
        )

        @skip_on_non_windows
        class TestShells:
            def test_cmd(self): ...
        """,
        monkeypatch,
    )
    assert records[0]["platforms"] == ["windows"]


def test_skipif_darwin_drops_macos(tmp_path, monkeypatch):
    records = _collect_body(
        tmp_path,
        "test_ssh_tunnels.py",
        """
        import pytest

        skip_on_macos = pytest.mark.skipif(
            "sys.platform == 'darwin'", reason="loopback tunnel flakes on macOS"
        )

        class TestTunnels:
            @skip_on_macos
            def test_start(self): ...
        """,
        monkeypatch,
    )
    assert records[0]["platforms"] == ["linux", "windows"]


def test_unrecognized_skipif_keeps_all_platforms():
    mark = mod.Mark("skipif", None, "shutil.which('ssh') is None reason=no ssh")
    assert mod.platforms_for([mark]) == ["linux", "macos", "windows"]


# ── collection follows pytest conventions ───────────────────────────────────


def test_collects_functions_and_class_methods(tmp_path, monkeypatch):
    records = _collect_body(
        tmp_path,
        "test_thing.py",
        """
        def test_free_function(): ...

        def not_a_test(): ...

        class TestThing:
            def test_method(self): ...
            def helper(self): ...

        class NotACollectedClass:
            def test_ignored(self): ...
        """,
        monkeypatch,
    )
    ids = {r["id"] for r in records}
    assert ids == {
        "test_thing.py::test_free_function",
        "test_thing.py::TestThing::test_method",
    }


# ── grouping + gap logic ────────────────────────────────────────────────────


_FEATURE_AREAS = {"ssh": ("ssh",), "serial": ("serial",), "telnet": ("telnet",)}


def _rec(feature, lane="automated", platforms=("linux", "macos", "windows")):
    return {
        "id": f"tests/test_{feature}.py::test_x",
        "feature": feature,
        "lane": lane,
        "platforms": list(platforms),
        "file": f"tests/test_{feature}.py",
    }


def test_group_by_feature_counts_lanes():
    groups = mod.group_by_feature(
        [_rec("ssh"), _rec("ssh", "manual"), _rec("serial")]
    )
    assert groups["ssh"]["automated"] == 1
    assert groups["ssh"]["manual"] == 1
    assert groups["serial"]["automated"] == 1


def test_coverage_gap_flags_feature_with_no_tests():
    # serial + telnet have no records -> both are gaps; ssh is covered.
    gaps = mod.coverage_gaps([_rec("ssh")], _FEATURE_AREAS)
    assert set(gaps) == {"serial", "telnet"}


def test_coverage_gap_requires_no_test_in_any_lane():
    # A feature with only a manual test is NOT a total gap.
    gaps = mod.coverage_gaps([_rec("serial", "manual")], _FEATURE_AREAS)
    assert "serial" not in gaps
    # Nor is one covered only by an integration test.
    gaps = mod.coverage_gaps([_rec("telnet", "integration")], _FEATURE_AREAS)
    assert "telnet" not in gaps


def test_per_pr_gap_flags_integration_only_feature():
    # #2050: ssh covered ONLY by an integration test -> unexercised on the merge
    # gate, so it is a per-PR gap even though it is not a total coverage gap.
    records = [_rec("ssh", "integration")]
    # ssh has an integration test (not a total gap) but no per-PR automated one.
    assert "ssh" in mod.per_pr_gaps(records, _FEATURE_AREAS)
    assert "ssh" not in mod.coverage_gaps(records, _FEATURE_AREAS)


def test_per_pr_gap_flags_manual_only_feature():
    records = [_rec("ssh", "manual")]
    assert "ssh" in mod.per_pr_gaps(records, _FEATURE_AREAS)


def test_per_pr_gap_cleared_by_an_automated_test():
    # A single automated (per-PR) test removes the merge-gate gap.
    records = [_rec("ssh", "automated"), _rec("ssh", "integration")]
    assert "ssh" not in mod.per_pr_gaps(records, _FEATURE_AREAS)


def test_coverage_counts_integration_lane():
    cov = mod.coverage(
        [_rec("ssh", "integration"), _rec("ssh", "automated")], _FEATURE_AREAS
    )
    assert cov["ssh"]["integration"] == 1
    assert cov["ssh"]["automated"] == 1


def test_coverage_counts_split_by_lane():
    cov = mod.coverage(
        [_rec("ssh"), _rec("ssh", "manual"), _rec("ssh")], _FEATURE_AREAS
    )
    assert cov["ssh"]["automated"] == 2
    assert cov["ssh"]["manual"] == 1


def test_unmapped_category_excludes_machinery(monkeypatch):
    monkeypatch.setattr(mod, "MACHINERY_CATEGORIES", frozenset({"protocol"}))
    records = [_rec("protocol"), _rec("brand_new_feature")]
    unmapped = mod.unmapped_categories(records, _FEATURE_AREAS)
    assert unmapped == ["brand_new_feature"]  # machinery "protocol" excluded


# ── generate-and-verify against the live test tree ──────────────────────────


def test_live_report_is_wellformed():
    records = mod.collect()
    assert len(records) > 100  # the harness has hundreds of tests
    report = mod.build_report(records)
    assert report["total_tests"] == len(records)
    assert report["total_features"] == len(report["features"])
    # Known feature areas have at least one test in some lane (no total gap).
    for area in ("ssh", "sftp", "serial", "telnet"):
        assert area not in report["coverage_gaps"]
    # A per-PR gap is always a subset of "has some test" — it can never exceed
    # the total set of tracked areas, and every per-PR gap is a real area.
    assert set(report["per_pr_gaps"]) <= set(mod.FEATURE_AREAS)


def test_live_markdown_has_required_sections():
    markdown = mod.render_markdown(mod.collect())
    assert "# Test inventory & coverage-gap report" in markdown
    assert "## Feature areas the per-PR merge gate does not exercise" in markdown
    assert "## Feature areas with no test at all" in markdown
    assert "## Inventory by feature" in markdown
    assert "| test id | feature | lane | platforms |" in markdown

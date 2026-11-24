"""Graded UI review and the review loop across linked runs (#5817) — normal lane.

Pure file I/O over synthetic run directories built with the real
:class:`~termihub_harness.product_run.Recorder`, plus a throwaway git repo for
the "PRs that touched a surface" lookup; no app, no display.
"""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from termihub_harness.product_run import Recorder
from termihub_harness.product_run import review_loop as loop
from termihub_harness.product_run.review import prepare_review
from termihub_harness.product_run.review_merge import merge_grades, merge_review
from termihub_harness.product_run.review_schema import (
    FINDING_JSON_SCHEMA,
    validate_finding,
    validate_findings_file,
)
from termihub_harness.window_capture import Frame, encode_png

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "scripts" / "internal" / "product-run-review.py"
NODE_CHOOSER = "tests/test_product_run.py::TestChecklist::test_02_chooser_states"
NODE_SETTINGS = "tests/test_product_run.py::TestChecklist::test_04_settings_wording"
SHOT = "shots/checklist.chooser.recommended.png"


def _clock() -> str:
    return "2026-11-24T00:00:00Z"


def _no_git(*_args, **_kwargs):
    return None


def _run(base: Path, name: str, steps=None, *, commit: str | None = None) -> Path:
    """A finished run with one screenshot per step; ``steps`` = (id, node or None)."""
    run = base / name
    rec = Recorder(run, clock=_clock)
    rec.start(run_id=name, inputs={}, profile={})
    for step, node in steps or (
        ("checklist.chooser.recommended", NODE_CHOOSER),
        ("checklist.chooser.master-password", NODE_CHOOSER),
        ("checklist.settings.keyboard", NODE_SETTINGS),
    ):
        rec.begin(step, step.split(".")[-1], phase="checklist", expect="the screen", node=node)
        path = rec.shot_path(step)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(encode_png(Frame.filled(8, 8, (10, 120, 200))))
        rec.add_screenshot(step, path, {"label": None, "theme": "dark", "source": "window"})
        rec.end(step, "pass")
    rec.finish()
    if commit:
        (run / "run-info.json").write_text(json.dumps({"commit": commit}))
    return run


def _finding(**over) -> dict:
    base = {
        "id": "chooser-1",
        "surface": "chooser",
        "screenshot": SHOT,
        "severity": "P2",
        "kind": "usefulness",
        "task": "pick where credentials are stored",
        "finding": "The change-later hint wraps to three lines under the radio cards",
        "recommendation": "Shorten the hint to one line",
    }
    return {**base, **over}


def _legacy(**over) -> dict:
    item = {**_finding(**over), "suggestion": "Shorten the hint to one line"}
    del item["task"], item["recommendation"]
    return item


def _write_findings(run: Path, surface: str, doc: dict) -> None:
    out = run / "review" / "findings" / f"{surface}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc))


def _graded(run: Path, grades: dict[str, int], findings: dict[str, list] | None = None) -> None:
    """Prepare + write one graded findings file per surface + merge."""
    prepare_review(run, contact_sheets=False, clock=_clock, git=_no_git)
    for surface, grade in grades.items():
        _write_findings(run, surface, {"surface": surface, "grade": grade,
                                       "grade_reason": f"{surface} reason",
                                       "findings": (findings or {}).get(surface, [])})
    merge_review(run, clock=_clock)


# ── schema: old + new findings ────────────────────────────────────────────────
def test_legacy_ungraded_files_stay_valid():
    valid, errors = validate_findings_file({"surface": "chooser", "findings": [_legacy()]})
    assert errors == []
    assert valid[0]["recommendation"] == valid[0]["suggestion"] == "Shorten the hint to one line"
    assert valid[0]["task"] == ""
    assert validate_findings_file([_legacy()])[1] == []


def test_graded_files_need_task_and_recommendation():
    doc = {"surface": "chooser", "grade": 3, "findings": [_finding(), _legacy(id="old")]}
    valid, errors = validate_findings_file(doc)
    assert [f["id"] for f in valid] == ["chooser-1"]
    assert any("(old): task: required" in e for e in errors), errors
    assert any("(old): recommendation: required" in e for e in errors), errors


@pytest.mark.parametrize("grade", [0, 6, "3", True, 2.5])
def test_grade_must_be_an_integer_one_to_five(grade):
    _valid, errors = validate_findings_file({"surface": "chooser", "grade": grade, "findings": []})
    assert any(e.startswith("grade:") for e in errors), errors


def test_previous_verdicts_are_validated():
    doc = {"surface": "chooser", "grade": 4, "findings": [],
           "previous": [{"id": "R-001", "verdict": "fixed"}, {"id": "R-002", "verdict": "gone"},
                        {"id": "R-003", "verdict": "fixed", "extra": "x"}]}
    errors = validate_findings_file(doc)[1]
    assert any("previous[1]: verdict" in e for e in errors), errors
    assert any("previous[2]: extra: unknown field" in e for e in errors), errors
    assert not any("previous[0]" in e for e in errors)


def test_unknown_fields_are_still_rejected_and_schema_lists_the_new_fields():
    assert "zzz: unknown field" in validate_finding(_finding(zzz="x"))
    item = FINDING_JSON_SCHEMA["properties"]["findings"]["items"]
    assert {"task", "recommendation"} <= set(item["required"])
    assert "suggestion" in item["properties"] and "suggestion" not in item["required"]
    assert FINDING_JSON_SCHEMA["properties"]["grade"]["maximum"] == 5
    assert "grade" in FINDING_JSON_SCHEMA["required"]


# ── grade merge ───────────────────────────────────────────────────────────────
def test_merge_grades_keeps_the_lowest_grade_lists_ungraded_and_the_change():
    reviews = [
        {"surface": "chooser", "grade": 4, "grade_reason": "ok", "file": "a.json",
         "reviewer": "r1", "previous": [{"id": "R-001", "verdict": "fixed"}]},
        {"surface": "chooser", "grade": 2, "grade_reason": "misread", "file": "b.json",
         "reviewer": "r2", "previous": [{"id": "R-002", "verdict": "regressed"}]},
        {"surface": "ghost", "grade": 1, "file": "c.json"},
    ]
    findings = [{"surface": "chooser", "severity": "P1"}, {"surface": "chooser", "severity": "P3"}]
    out = merge_grades(reviews, findings, surfaces=["chooser", "settings"],
                       previous={"chooser": 3})
    assert set(out) == {"chooser", "settings"}
    chooser = out["chooser"]
    assert chooser["grade"] == 2 and chooser["previous_grade"] == 3 and chooser["change"] == -1
    assert chooser["reasons"] == ["ok", "misread"] and chooser["files"] == ["a.json", "b.json"]
    assert chooser["counts"] == {"P1": 1, "P2": 0, "P3": 1}
    assert chooser["verdicts"]["fixed"] == 1 and chooser["verdicts"]["regressed"] == 1
    assert out["settings"]["grade"] is None and out["settings"]["change"] is None


def test_merge_review_writes_grades_history_and_a_grade_table(tmp_path):
    run = _run(tmp_path, "20261124T000000Z")
    prepare_review(run, contact_sheets=False, clock=_clock, git=_no_git)
    _write_findings(run, "chooser", {"surface": "chooser", "grade": 2,
                                     "grade_reason": "the hint misleads", "findings": [_finding()]})
    _write_findings(run, "settings", {"surface": "settings", "findings": [
        _legacy(id="s-1", surface="settings", screenshot="shots/checklist.settings.keyboard.png")]})
    doc = merge_review(run, clock=_clock)
    assert doc["rejected"] == []
    grades = json.loads((run / "review" / "grades.json").read_text())
    assert grades["round"] == 0
    assert grades["surfaces"]["chooser"]["grade"] == 2
    assert grades["surfaces"]["settings"]["grade"] is None  # legacy file: no grade
    history = json.loads((run / "review" / "history.json").read_text())
    assert history["surfaces"]["chooser"] == [{"round": 0, "run_id": run.name, "grade": 2}]
    assert "loop" not in history and doc["loop"] is None
    md = (run / "review" / "findings.md").read_text()
    assert "| Surface | Grade |" in md and "| chooser | 2 | - | 2 |" in md
    assert "Task: pick where credentials are stored" in md and "Recommendation:" in md
    legacy = next(f for f in doc["findings"] if f["surface"] == "settings")
    assert legacy["recommendation"] == "Shorten the hint to one line"
    js = (run / "review" / "findings.js").read_text()
    assert '"grades"' in js and '"history"' in js


# ── loop-stop rule ────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    ("grades", "rounds_done", "action", "below"),
    [
        ({"a": 4, "b": 5}, 0, loop.DONE, []),
        ({"a": 3, "b": 5}, 0, loop.CONTINUE, ["a"]),
        ({"a": 3, "b": 2}, 2, loop.CONTINUE, ["a", "b"]),
        ({"a": 3, "b": 5}, 3, loop.ESCALATE, ["a"]),
        ({"a": 5, "b": 5}, 3, loop.DONE, []),
        ({"a": None, "b": 2}, 0, loop.NEEDS_GRADES, ["b"]),
        ({"b": 2}, 0, loop.NEEDS_GRADES, ["b"]),
    ],
)
def test_loop_decision(grades, rounds_done, action, below):
    decision = loop.loop_decision(grades, ["a", "b"], target_grade=4, rounds_done=rounds_done,
                                  max_rounds=3)
    assert decision["action"] == action, decision["reason"]
    assert decision["below"] == below


# ── surface -> steps -> nodes ─────────────────────────────────────────────────
def _fake_tests(system: Path) -> Path:
    (system / "tests").mkdir(parents=True, exist_ok=True)
    (system / "tests" / "test_product_run_fake.py").write_text(textwrap.dedent('''
        class TestFake:
            def test_00_setup(self):
                with self.step("fake.base", "Base"):
                    pass

            def test_01_menu(self):
                self.not_tested("fake.menu.skipped", "Skipped", "no input")
                with self.step("fake.menu.open", "Open"):
                    self.require("fake.base")

            def helper(self):
                with self.step("fake.menu.helper", "Not a test"):
                    pass
    '''))
    return system


def test_surface_steps_and_node_selection_with_recorded_nodes(tmp_path):
    run = _run(tmp_path, "r0")
    steps = loop.surface_steps(run, ["chooser", "settings", "nope"])
    assert steps["chooser"] == ["checklist.chooser.recommended", "checklist.chooser.master-password"]
    assert steps["settings"] == ["checklist.settings.keyboard"] and steps["nope"] == []
    nodes, unresolved = loop.select_nodes(run, steps["chooser"], tmp_path / "empty")
    assert nodes == [NODE_CHOOSER] and unresolved == []


def test_node_selection_falls_back_to_the_sources_and_follows_require(tmp_path):
    system = _fake_tests(tmp_path / "system")
    step_node, requires = loop.scan_test_steps(system)
    menu = "tests/test_product_run_fake.py::TestFake::test_01_menu"
    setup = "tests/test_product_run_fake.py::TestFake::test_00_setup"
    assert step_node["fake.menu.open"] == menu and step_node["fake.menu.skipped"] == menu
    assert "fake.menu.helper" not in step_node and requires[menu] == ["fake.base"]
    run = _run(tmp_path, "old", [("fake.base", None), ("fake.menu.open", None),
                                 ("fake.menu.lost", None)])
    nodes, unresolved = loop.select_nodes(run, ["fake.menu.open", "fake.menu.lost"], system)
    assert nodes == [setup, menu]  # the required step's test runs first
    assert unresolved == ["fake.menu.lost"]


# ── history + plan + context across linked rounds ─────────────────────────────
def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True,
                          text=True).stdout.strip()


def _repo_with_pr(tmp_path: Path) -> tuple[Path, str, str]:
    repo = tmp_path / "repo"
    (repo / "src" / "components").mkdir(parents=True)
    _git(repo.parent, "init", "-q", "-b", "develop", str(repo))
    _git(repo, "config", "user.email", "t@example.invalid")
    _git(repo, "config", "user.name", "t")
    chooser = repo / "src" / "components" / "CredentialChooser.tsx"
    chooser.write_text("v1\n")
    (repo / "src" / "Other.tsx").write_text("v1\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "chore: base")
    base = _git(repo, "rev-parse", "HEAD")
    _git(repo, "checkout", "-qb", "dev1/fix/1-chooser")
    chooser.write_text("v2\n")
    _git(repo, "commit", "-qam", "fix(ui): shorten the chooser hint")
    _git(repo, "checkout", "-q", "develop")
    (repo / "src" / "Other.tsx").write_text("v2\n")
    _git(repo, "commit", "-qam", "fix(ui): unrelated (#7)")
    _git(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #42 from x/dev1/fix/1-chooser",
         "dev1/fix/1-chooser")
    return repo, base, _git(repo, "rev-parse", "HEAD")


def test_touched_prs_between_two_commits(tmp_path):
    repo, base, head = _repo_with_pr(tmp_path)
    files = loop.surface_files(repo, "chooser", [NODE_CHOOSER])
    assert files == ["tests/system/tests/test_product_run.py",
                     "src/components/CredentialChooser.tsx"]
    prs = loop.touched_prs(repo, base, head, files)
    assert [p["pr"] for p in prs] == [42]
    other = loop.touched_prs(repo, base, head, ["src/Other.tsx"])
    assert [p["pr"] for p in other] == [7]  # first parent: the merge did not touch it
    assert loop.touched_prs(repo, None, head, files) == []
    assert loop.touched_prs(repo, "not-a-commit", head, files) == []


def test_plan_init_context_and_history_across_rounds(tmp_path):
    repo, base, head = _repo_with_pr(tmp_path)
    r0 = _run(tmp_path, "r0", commit=base)
    _graded(r0, {"chooser": 2, "settings": 5}, {"chooser": [_finding()]})

    with pytest.raises(loop.LoopError, match="no step for surface"):
        loop.plan_loop(r0, ["ghost"], system_dir=tmp_path)
    plan = loop.plan_loop(r0, ["chooser", "settings"], system_dir=tmp_path, max_rounds=2)
    assert plan["decision"]["action"] == loop.CONTINUE and plan["round"] == 1
    assert plan["surfaces"] == ["chooser"] and plan["nodes"] == [NODE_CHOOSER]

    r1 = _run(tmp_path, "r1", [("checklist.chooser.recommended", NODE_CHOOSER),
                               ("checklist.settings.keyboard", NODE_SETTINGS)], commit=head)
    loop.init_loop_run(r1, plan)
    assert loop.previous_run(r1) == r0.resolve() and loop.loop_round(r1) == 1

    ctx = loop.loop_context(r1, repo=repo)
    chooser = ctx["per_surface"]["chooser"]
    assert chooser["previous_grade"] == 2 and chooser["trend"] == [2]
    assert [p["pr"] for p in chooser["touched_prs"]] == [42]
    assert chooser["previous_findings"][0]["id"] == "R-001"

    request = prepare_review(r1, contact_sheets=False, clock=_clock, repo=repo)
    assert [r["surface"] for r in request["reviewers"]] == ["chooser"]
    assert request["loop"]["not_reviewed"] == ["settings"]
    prompt = request["reviewers"][0]["prompt"]
    for needle in ("must not have built", "graded 2 in the previous round", "R-001",
                   "#42: Merge pull request #42", '"previous": [ ... ]', "grade 5:"):
        assert needle in prompt, needle
    brief = (r1 / "review" / "review-brief.md").read_text()
    assert "## Reviewer independence" in brief and "#42" in brief

    _write_findings(r1, "chooser", {"surface": "chooser", "grade": 3, "findings": [],
                                    "previous": [{"id": "R-001", "verdict": "fixed"}]})
    doc = merge_review(r1, clock=_clock)
    assert doc["grades"]["chooser"]["change"] == 1
    assert doc["loop"]["action"] == loop.CONTINUE  # 3 < 4, round 1 of 2
    history = json.loads((r1 / "review" / "history.json").read_text())
    assert [r["run_id"] for r in history["rounds"]] == ["r0", "r1"]
    assert loop.trend(history, "chooser") == [2, 3] and loop.trend(history, "settings") == [5]

    plan2 = loop.plan_loop(r1, ["chooser"], system_dir=tmp_path, max_rounds=2)
    assert plan2["round"] == 2 and plan2["nodes"] == [NODE_CHOOSER]
    r2 = _run(tmp_path, "r2", [("checklist.chooser.recommended", NODE_CHOOSER)], commit=head)
    loop.init_loop_run(r2, plan2)
    prepare_review(r2, contact_sheets=False, clock=_clock, repo=repo)
    _write_findings(r2, "chooser", {"surface": "chooser", "grade": 3, "findings": []})
    assert merge_review(r2, clock=_clock)["loop"]["action"] == loop.ESCALATE
    assert loop.trend(loop.build_history(r2), "chooser") == [2, 3, 3]
    assert loop.plan_loop(r2, ["chooser"], system_dir=tmp_path, max_rounds=2)["decision"][
        "action"] == loop.ESCALATE


def test_chain_stops_on_a_cycle(tmp_path):
    a, b = _run(tmp_path, "a"), _run(tmp_path, "b")
    for run in (a, b):
        (run / "review").mkdir(exist_ok=True)
    (a / "review" / "previous-run").write_text(str(b))
    (b / "review" / "previous-run").write_text(str(a))
    assert loop.chain(a) == [b.resolve(), a.resolve()]


# ── the CLI, executed for real ────────────────────────────────────────────────
def _cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True,
                          timeout=120)


def test_loop_plan_cli_exit_codes_and_init(tmp_path):
    run = _run(tmp_path, "r0")
    ungraded = _cli("loop-plan", "--previous", str(run), "--surfaces", "chooser")
    assert ungraded.returncode == 2, ungraded.stderr
    _graded(run, {"chooser": 3, "settings": 4})

    new = tmp_path / "r1"
    new.mkdir()
    nodes = tmp_path / "nodes.txt"
    go = _cli("loop-plan", "--previous", str(run), "--surfaces", "chooser,settings",
              "--init", str(new), "--nodes-out", str(nodes))
    assert go.returncode == 0, go.stderr
    assert f"re-run {NODE_CHOOSER}" in go.stdout
    assert nodes.read_text().splitlines() == [NODE_CHOOSER]
    assert json.loads((new / "loop.json").read_text())["surfaces"] == ["chooser"]

    done = _cli("loop-plan", "--previous", str(run), "--surfaces", "settings")
    assert done.returncode == 10 and "done" in done.stdout
    out = _cli("loop-plan", "--previous", str(run), "--surfaces", "chooser", "--max-rounds", "1",
               "--json")
    assert out.returncode == 0 and json.loads(out.stdout)["nodes"] == [NODE_CHOOSER]
    bad = _cli("loop-plan", "--previous", str(run), "--surfaces", "ghost")
    assert bad.returncode == 2 and "no step for surface" in bad.stderr

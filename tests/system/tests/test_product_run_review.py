"""Product-run UI-review hand-off, merge and hover fallback (#5538) — normal lane.

Pure file I/O over a synthetic run directory built with the real
:class:`~termihub_harness.product_run.Recorder`; no app, no display.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from termihub_harness.product_run import Recorder
from termihub_harness.product_run import hover as hover_mod
from termihub_harness.product_run.review import group_shots, prepare_review, surface_of
from termihub_harness.product_run.review_images import decode_png, downscale, grid
from termihub_harness.product_run.review_merge import dedupe, merge_review, similarity
from termihub_harness.product_run.review_schema import (
    FINDING_FIELDS,
    FINDING_JSON_SCHEMA,
    validate_finding,
    validate_findings_file,
)
from termihub_harness.window_capture import Frame, encode_png

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "scripts" / "internal" / "product-run-review.py"


def _clock() -> str:
    return "2026-11-13T00:00:00Z"


def _png(path: Path, rgb=(200, 10, 10), size=(40, 20)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encode_png(Frame.filled(size[0], size[1], rgb)))


def _run(tmp_path: Path) -> Path:
    run = tmp_path / "20261113T000000Z"
    rec = Recorder(run, clock=_clock)
    rec.start(run_id=run.name, inputs={}, profile={})
    for step, status, expect in (
        ("checklist.chooser.recommended", "pass", "the chooser with OS Keychain preselected"),
        ("checklist.chooser.master-password", "fail", "Cancel, Back, Create vault"),
        ("checklist.settings.keyboard", "pass", "Settings > Keyboard"),
    ):
        rec.begin(step, step.split(".")[-1], phase="checklist", expect=expect)
        rec.evidence(step, f"measured {step}")
        path = rec.shot_path(step)
        _png(path)
        meta = {"label": None, "theme": "dark", "source": "window", "width": 40, "height": 20,
                "window_css": {"width": "1280px", "height": "800px"}}
        rec.add_screenshot(step, path, meta)
        rec.end(step, status, reason="it broke" if status == "fail" else None)
    rec.not_tested("inputs.serial", "Serial", phase="checklist", reason="no input")
    rec.finish()
    return run


def _finding(**over) -> dict:
    base = {
        "id": "chooser-1",
        "surface": "chooser",
        "screenshot": "shots/checklist.chooser.recommended.png",
        "severity": "P2",
        "kind": "looks",
        "finding": "The change-later hint wraps to three lines under the radio cards",
        "suggestion": "Shorten the hint to one line",
    }
    return {**base, **over}


# ── grouping + hand-off ───────────────────────────────────────────────────────
def test_surface_comes_from_the_step_id_or_the_manifest():
    assert surface_of({"step": "checklist.chooser.back"}) == "chooser"
    assert surface_of({"step": "ssh.jump"}) == "ssh"
    assert surface_of({"step": "x.y.z", "surface": "file-browser"}) == "file-browser"
    assert surface_of({}) == "misc"


def test_group_shots_carries_the_grade_and_skips_missing_files(tmp_path):
    run = _run(tmp_path)
    (run / "shots" / "checklist.settings.keyboard.png").unlink()
    groups = group_shots(run)
    assert list(groups) == ["chooser"]
    failed = groups["chooser"][1]
    assert failed["status"] == "fail" and failed["reason"] == "it broke"
    assert failed["evidence"][0] == "measured checklist.chooser.master-password"
    assert failed["theme"] == "dark" and "1280px" in failed["window"]


def test_prepare_review_writes_brief_request_and_contact_sheets(tmp_path):
    run = _run(tmp_path)
    request = prepare_review(run, clock=_clock)
    review = run / "review"
    assert (review / "findings").is_dir()
    on_disk = json.loads((review / "review-request.json").read_text())
    assert on_disk == request
    assert request["run_id"] == run.name and request["finding_schema"] == FINDING_JSON_SCHEMA
    by_surface = {r["surface"]: r for r in request["reviewers"]}
    assert set(by_surface) == {"chooser", "settings"}
    chooser = by_surface["chooser"]
    assert len(chooser["shots"]) == 2 and chooser["themes"] == ["dark"]
    assert chooser["output"] == "review/findings/chooser.json"
    sheet = decode_png((run / chooser["contact_sheet"]).read_bytes())
    assert sheet.width > 2 * 40 and sheet.pixel(12, 12) == (200, 10, 10)
    prompt = chooser["prompt"]
    for needle in (str(run / "shots" / "checklist.chooser.recommended.png"),
                   str(run / "review" / "findings" / "chooser.json"),
                   "looks AND usefulness", "machine grade: fail (it broke)", '"surface": "chooser"'):
        assert needle in prompt, needle
    assert "settings" not in prompt.split("Screens")[1].split("Rules")[0]
    brief = (review / "review-brief.md").read_text()
    assert "### Chooser (checklist)" in brief and "product-run-review.py merge" in brief
    assert "inputs.serial" not in brief  # no screenshot, nothing to review


def test_prepare_review_without_a_run_fails(tmp_path):
    with pytest.raises(FileNotFoundError):
        prepare_review(tmp_path)


# ── schema ────────────────────────────────────────────────────────────────────
def test_json_schema_and_validator_share_one_field_list():
    item_schema = FINDING_JSON_SCHEMA["properties"]["findings"]["items"]
    assert item_schema["required"] == list(FINDING_FIELDS)
    assert item_schema["properties"]["severity"]["enum"] == ["P1", "P2", "P3"]
    assert item_schema["properties"]["kind"]["enum"] == ["looks", "usefulness", "bug"]
    assert validate_finding(_finding()) == []


@pytest.mark.parametrize(
    ("change", "error"),
    [
        ({"severity": "P0"}, "severity"),
        ({"kind": "style"}, "kind"),
        ({"finding": "  "}, "finding"),
        ({"extra": "x"}, "extra: unknown field"),
        ({"surface": "nope"}, "was not reviewed"),
        ({"screenshot": "shots/other.png"}, "not a screenshot of this run"),
    ],
)
def test_validator_rejects_bad_findings(change, error):
    errors = validate_finding(
        _finding(**change),
        surfaces=["chooser"],
        screenshots=["shots/checklist.chooser.recommended.png"],
    )
    assert any(error in e for e in errors), errors


def test_one_bad_finding_never_hides_the_good_ones():
    doc = {"surface": "chooser", "findings": [_finding(), _finding(id="b", kind="x"), _finding()]}
    valid, errors = validate_findings_file(doc)
    assert [f["id"] for f in valid] == ["chooser-1"]
    assert any("findings[1] (b): kind" in e for e in errors)
    assert any("used twice" in e for e in errors)
    assert validate_findings_file({"surface": "x"})[1] == ["findings: required array"]
    assert validate_findings_file([_finding()])[0]


# ── merge + dedupe ────────────────────────────────────────────────────────────
def test_similarity_and_dedupe_fold_near_duplicates():
    a = "The change-later hint wraps to three lines under the radio cards"
    assert similarity(a, a.upper()) == 1.0
    assert similarity(a, "Primary button text is too light") < 0.2
    items = [
        {**_finding(), "source": "a.json#1"},
        {**_finding(id="2", severity="P1", screenshot="shots/b.png",
                    finding="The change later hint wraps onto three lines under the radio cards",
                    suggestion="Move the hint"), "source": "b.json#2"},
        {**_finding(id="3", kind="usefulness"), "source": "c.json#3"},
        {**_finding(id="4", surface="settings"), "source": "d.json#4"},
    ]
    merged = dedupe(items)
    assert len(merged) == 3
    first = merged[0]
    assert first["id"] == "R-001" and first["severity"] == "P1"
    assert first["screenshots"] == ["shots/checklist.chooser.recommended.png", "shots/b.png"]
    assert first["sources"] == ["a.json#1", "b.json#2"]
    assert first["also_suggested"] == ["Move the hint"]


def test_merge_review_writes_md_json_js_and_reports_rejects(tmp_path):
    run = _run(tmp_path)
    prepare_review(run, clock=_clock)
    out = run / "review" / "findings"
    (out / "chooser.json").write_text(json.dumps({
        "surface": "chooser",
        "findings": [_finding(severity="P1"), _finding(id="x", surface="ssh")],
    }))
    (out / "settings.json").write_text("{not json")
    doc = merge_review(run, clock=_clock)
    assert doc["raw_count"] == 1 and doc["counts"] == {"P1": 1, "P2": 0, "P3": 0}
    assert {r["file"] for r in doc["rejected"]} == {"chooser.json", "settings.json"}
    review = run / "review"
    assert json.loads((review / "findings.json").read_text()) == doc
    js = (review / "findings.js").read_text()
    assert js.startswith("window.__productRunReview(") and js.rstrip().endswith(");")
    md = (review / "findings.md").read_text()
    assert "Most important:" in md and "R-001 P1 looks" in md and "Rejected" in md


def test_the_page_renders_the_review_section():
    page = (REPO / "tests/system/termihub_harness/product_run/page.html").read_text()
    assert "window.__productRunReview" in page and 'load("review/findings.js")' in page


def test_cli_prepare_and_merge(tmp_path):
    run = _run(tmp_path)
    prep = subprocess.run([sys.executable, str(SCRIPT), "prepare", str(run)],
                          capture_output=True, text=True, check=False)
    assert prep.returncode == 0, prep.stderr
    assert "2 surfaces, 3 screenshots" in prep.stdout
    findings = tmp_path / "mine.json"
    findings.write_text(json.dumps([_finding()]))
    merged = subprocess.run([sys.executable, str(SCRIPT), "merge", str(run), str(findings)],
                            capture_output=True, text=True, check=False)
    assert merged.returncode == 0, merged.stderr
    assert "into 1 (0 P1, 1 P2, 0 P3)" in merged.stdout


# ── images ────────────────────────────────────────────────────────────────────
def test_png_roundtrip_downscale_and_grid():
    frame = Frame.filled(10, 4, (1, 2, 3))
    assert decode_png(encode_png(frame)).data == frame.data
    small = downscale(Frame.filled(100, 50, (9, 9, 9)), 30)
    assert (small.width, small.height) == (25, 13)
    sheet = grid([Frame.filled(4, 4, (255, 0, 0))] * 3, columns=2, gap=2)
    assert (sheet.width, sheet.height) == (14, 14)
    assert sheet.pixel(2, 8) == (255, 0, 0) and sheet.pixel(8, 8) == (128, 128, 128)


def test_decode_png_handles_filtered_rows():
    import struct
    import zlib

    # Two RGB rows of 2 px: row 0 Sub-filtered, row 1 Paeth-filtered.
    raw = bytes([1, 10, 20, 30, 5, 5, 5, 4, 1, 1, 1, 0, 0, 0])
    header = struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + b"\0\0\0\0"

    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw))
    frame = decode_png(data + chunk(b"IEND", b""))
    assert frame.pixel(0, 0) == (10, 20, 30) and frame.pixel(1, 0) == (15, 25, 35)
    assert frame.pixel(0, 1) == (11, 21, 31) and frame.pixel(1, 1) == (15, 25, 35)


# ── hover fallback ────────────────────────────────────────────────────────────
class _Driver:
    def __init__(self) -> None:
        self.calls: list = []

    def force_hover(self, test_id):
        self.calls.append(test_id)
        return 0 if test_id is None else 7


def test_hover_falls_back_to_the_bridge_when_the_pointer_is_not_allowed(monkeypatch):
    monkeypatch.setattr(hover_mod, "_pointer_blocker", lambda: "global input refused\nmore")
    driver = _Driver()
    with hover_mod.hovered(driver, 4242, "row") as how:
        assert how.mode == "forced"
        assert "7 :hover rules" in how.note and "global input refused" in how.note
        assert "more" not in how.note
    assert driver.calls == ["row", None]


def test_hover_uses_the_real_pointer_when_allowed(monkeypatch):
    monkeypatch.setattr(hover_mod, "_pointer_blocker", lambda: None)
    monkeypatch.setattr(hover_mod, "_pointer_hover", lambda d, pid, t: f"pointer {pid} {t}")
    driver = _Driver()
    with hover_mod.hovered(driver, 4242, "row") as how:
        assert how == hover_mod.Hover("pointer", "pointer 4242 row")
    assert driver.calls == []


def test_a_refused_pointer_falls_back(monkeypatch):
    from termihub_harness.os_input import ForeignAppAlive

    def refuse(*_a):
        raise ForeignAppAlive("another termiHub process is alive")

    monkeypatch.setattr(hover_mod, "_pointer_blocker", lambda: None)
    monkeypatch.setattr(hover_mod, "_pointer_hover", refuse)
    how = hover_mod.hover(_Driver(), 4242, "row")
    assert how.mode == "forced" and "another termiHub" in how.note

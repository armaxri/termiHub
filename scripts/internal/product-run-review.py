#!/usr/bin/env python3
"""UI-expert review hand-off of a product run (#5538).

Usage:
  scripts/internal/product-run-review.py prepare [RUN_DIR]
      Write RUN_DIR/review/: review-brief.md, review-request.json (one reviewer
      entry per surface, each with a self-contained prompt) and per-surface
      contact sheets. scripts/internal/product-run.sh runs this after every run.
  scripts/internal/product-run-review.py merge [RUN_DIR] [FINDINGS.json ...]
      Validate the reviewers' JSON (default: RUN_DIR/review/findings/*.json)
      against the finding schema, dedupe, and write review/findings.{md,json,js};
      the run's progress page shows them as "UI review". It also writes
      review/grades.json (grade 1-5 per surface) and review/history.json (grades
      per round across linked loop rounds, plus a loop round's stop decision).
      Exit 1 when any reviewer output was rejected (the merged file still holds
      every valid finding).
  scripts/internal/product-run-review.py loop-plan --surfaces S[,S...]
          [--previous RUN_DIR] [--target-grade 4] [--max-rounds 3]
          [--init NEW_RUN_DIR] [--nodes-out FILE] [--json]
      Decide the next review-loop round (#5817) after the merged run
      --previous (default: the newest run with review/grades.json) and select
      the pytest nodes behind the surfaces still below the target grade.
      --init links NEW_RUN_DIR to the previous run (loop.json,
      review/previous-run); --nodes-out writes one node id per line.
      Exit 0 = run the round, 10 = target reached (done), 11 = rounds used up
      (escalate), 2 = cannot plan (unknown surface, no grades merged yet).
      scripts/internal/product-run.sh --loop runs this first.

RUN_DIR defaults to the newest tests/system/artifacts/product-run/<run id>/.

Coordinator loop: prepare -> spawn one read-only reviewer agent per
review-request.json `reviewers[]` entry (prompt = its `prompt`; the reviewer
must not have built or fixed the surface) -> merge -> file the deduped findings
as issues -> fix -> product-run.sh --loop <surfaces below the target> -> repeat
until loop-plan says done or escalate.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SYSTEM = REPO / "tests" / "system"
RUNS = SYSTEM / "artifacts" / "product-run"
_REEXEC_ENV = "TERMIHUB_PRODUCT_RUN_REVIEW_REEXEC"


def _import_harness():
    sys.path.insert(0, str(SYSTEM))
    try:
        from termihub_harness.product_run import review, review_loop, review_merge  # noqa: PLC0415
    except ImportError:
        uv = shutil.which("uv")
        if uv is None or os.environ.get(_REEXEC_ENV):
            raise
        # The harness needs its own venv (pytest, websockets): re-run inside it.
        os.environ[_REEXEC_ENV] = "1"
        argv = [uv, "run", "--frozen", "--project", str(SYSTEM), "python", __file__, *sys.argv[1:]]
        os.execv(uv, argv)
    return review, review_merge, review_loop


def _run_dir(arg: str | None) -> Path:
    if arg:
        return Path(arg).resolve()
    runs = sorted(p for p in RUNS.glob("*") if (p / "status.json").is_file())
    if not runs:
        sys.exit(f"no product run under {RUNS}")
    return runs[-1]


EXIT_DONE, EXIT_ESCALATE = 10, 11


def _newest_graded() -> Path:
    runs = sorted(p for p in RUNS.glob("*") if (p / "review" / "grades.json").is_file())
    if not runs:
        sys.exit(f"no product run with merged grades under {RUNS} (run merge first)")
    return runs[-1]


def loop_plan(review_loop, argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="product-run-review.py loop-plan")
    parser.add_argument("--surfaces", required=True, help="comma-separated surface ids")
    parser.add_argument("--previous", help="the merged run to loop from")
    parser.add_argument("--target-grade", type=int, default=review_loop.DEFAULT_TARGET_GRADE)
    parser.add_argument("--max-rounds", type=int, default=review_loop.DEFAULT_MAX_ROUNDS)
    parser.add_argument("--init", help="new run dir to link to the previous run")
    parser.add_argument("--nodes-out", help="write the selected pytest node ids here")
    parser.add_argument("--json", action="store_true", help="print the plan as JSON")
    args = parser.parse_args(argv)
    previous = Path(args.previous).resolve() if args.previous else _newest_graded()
    try:
        plan = review_loop.plan_loop(
            previous,
            args.surfaces.split(","),
            system_dir=SYSTEM,
            target_grade=args.target_grade,
            max_rounds=args.max_rounds,
        )
    except review_loop.LoopError as exc:
        print(f"review loop: {exc}", file=sys.stderr)
        return 2
    decision = plan["decision"]
    if args.json:
        print(json.dumps(plan, indent=2))
    else:
        print(f"review loop after {previous.name}: {decision['action']} ({decision['reason']})")
        for surface, grade in decision["grades"].items():
            print(f"  {surface}: grade {grade if grade is not None else '-'}")
    action = decision["action"]
    if action == review_loop.DONE:
        return EXIT_DONE
    if action == review_loop.ESCALATE:
        return EXIT_ESCALATE
    if action != review_loop.CONTINUE:
        return 2
    if not args.json:
        print(f"round {plan['round']} of {plan['max_rounds']}: {', '.join(plan['surfaces'])}")
        for node in plan["nodes"]:
            print(f"  re-run {node}")
        for step in plan["unresolved_steps"]:
            print(f"  no test found for step {step}", file=sys.stderr)
    if args.nodes_out:
        Path(args.nodes_out).write_text("".join(f"{n}\n" for n in plan["nodes"]), encoding="utf-8")
    if args.init:
        review_loop.init_loop_run(Path(args.init).resolve(), plan)
    return 0


def main(argv: list[str]) -> int:
    commands = ("prepare", "merge", "loop-plan")
    if not argv or argv[0] in ("-h", "--help") or argv[0] not in commands:
        print(__doc__.strip())
        return 0 if argv and argv[0] in ("-h", "--help") else 2
    review, review_merge, review_loop = _import_harness()
    command, rest = argv[0], argv[1:]
    if command == "loop-plan":
        return loop_plan(review_loop, rest)
    run_arg = rest[0] if rest and not rest[0].endswith(".json") else None
    run_dir = _run_dir(run_arg)
    if command == "prepare":
        request = review.prepare_review(run_dir)
        shots = sum(len(r["shots"]) for r in request["reviewers"])
        print(f"review hand-off: {run_dir / 'review'}")
        print(f"  {len(request['reviewers'])} surfaces, {shots} screenshots")
        for r in request["reviewers"]:
            prs = ", ".join(f"#{p['pr']}" for p in r.get("touched_prs") or [] if p.get("pr"))
            print(f"  - {r['surface']}: {len(r['shots'])} shots -> {r['output']}"
                  + (f" (touched by {prs})" if prs else ""))
        if request.get("loop"):
            print(f"  loop round {request['loop']['round']} after "
                  f"{request['loop']['previous_run_id']}")
        return 0
    files = [Path(f).resolve() for f in rest[1 if run_arg else 0 :]] or None
    doc = review_merge.merge_review(run_dir, files)
    counts = ", ".join(f"{n} {sev}" for sev, n in doc["counts"].items())
    print(f"merged {doc['raw_count']} findings from {len(doc['files'])} files into "
          f"{len(doc['findings'])} ({counts}): {run_dir / 'review' / 'findings.md'}")
    for surface, grade in (doc.get("grades") or {}).items():
        before = grade.get("previous_grade")
        print(f"  grade {surface}: {grade['grade'] if grade['grade'] is not None else '-'}"
              + (f" (previous {before})" if before is not None else ""))
    if doc.get("loop"):
        print(f"  loop: {doc['loop']['action']} ({doc['loop']['reason']})")
    for bad in doc["rejected"]:
        for error in bad["errors"]:
            print(f"  rejected {bad['file']}: {error}", file=sys.stderr)
    return 1 if doc["rejected"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

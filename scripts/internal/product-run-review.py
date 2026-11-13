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
      the run's progress page shows them as "UI review". Exit 1 when any reviewer
      output was rejected (the merged file still holds every valid finding).

RUN_DIR defaults to the newest tests/system/artifacts/product-run/<run id>/.

Coordinator loop: prepare -> spawn one read-only reviewer agent per
review-request.json `reviewers[]` entry (prompt = its `prompt`) -> merge ->
file the deduped findings as issues.
"""

from __future__ import annotations

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
        from termihub_harness.product_run import review, review_merge  # noqa: PLC0415
    except ImportError:
        uv = shutil.which("uv")
        if uv is None or os.environ.get(_REEXEC_ENV):
            raise
        # The harness needs its own venv (pytest, websockets): re-run inside it.
        os.environ[_REEXEC_ENV] = "1"
        argv = [uv, "run", "--frozen", "--project", str(SYSTEM), "python", __file__, *sys.argv[1:]]
        os.execv(uv, argv)
    return review, review_merge


def _run_dir(arg: str | None) -> Path:
    if arg:
        return Path(arg).resolve()
    runs = sorted(p for p in RUNS.glob("*") if (p / "status.json").is_file())
    if not runs:
        sys.exit(f"no product run under {RUNS}")
    return runs[-1]


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help") or argv[0] not in ("prepare", "merge"):
        print(__doc__.strip())
        return 0 if argv and argv[0] in ("-h", "--help") else 2
    review, review_merge = _import_harness()
    command, rest = argv[0], argv[1:]
    run_arg = rest[0] if rest and not rest[0].endswith(".json") else None
    run_dir = _run_dir(run_arg)
    if command == "prepare":
        request = review.prepare_review(run_dir)
        shots = sum(len(r["shots"]) for r in request["reviewers"])
        print(f"review hand-off: {run_dir / 'review'}")
        print(f"  {len(request['reviewers'])} surfaces, {shots} screenshots")
        for r in request["reviewers"]:
            print(f"  - {r['surface']}: {len(r['shots'])} shots -> {r['output']}")
        return 0
    files = [Path(f).resolve() for f in rest[1 if run_arg else 0 :]] or None
    doc = review_merge.merge_review(run_dir, files)
    counts = ", ".join(f"{n} {sev}" for sev, n in doc["counts"].items())
    print(f"merged {doc['raw_count']} findings from {len(doc['files'])} files into "
          f"{len(doc['findings'])} ({counts}): {run_dir / 'review' / 'findings.md'}")
    for bad in doc["rejected"]:
        for error in bad["errors"]:
            print(f"  rejected {bad['file']}: {error}", file=sys.stderr)
    return 1 if doc["rejected"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

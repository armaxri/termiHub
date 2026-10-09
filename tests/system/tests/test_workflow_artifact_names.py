"""Artifact names in the nightly workflow are unique per matrix leg (#4339, TIN2-006).

A manual dispatch defaults to ``branch=both``, so each OS runs a develop leg AND a
main leg. ``actions/upload-artifact`` v4 artifacts are immutable per run, so when
two legs upload under the same name the second upload fails with a 409. Every
upload in a job whose matrix has a ``branch`` axis must therefore name the
branch. (The ``os`` axis is not checked: the Linux-only coverage upload runs on
one OS per branch, and the per-OS uploads already name it.)
"""

from __future__ import annotations

import re

from termihub_harness.orchestrator import REPO_ROOT

WORKFLOW = REPO_ROOT / ".github" / "workflows" / "system-integration.yml"

_JOB_RE = re.compile(r"^  ([A-Za-z0-9_-]+):\s*$", re.M)
_MATRIX_AXIS_RE = re.compile(r"^        ([a-z_]+):", re.M)


def _jobs(text: str) -> dict[str, str]:
    """``{job id: job body}`` for the top-level ``jobs:`` mapping."""
    body = text[text.index("\njobs:\n") :]
    starts = list(_JOB_RE.finditer(body))
    return {
        match.group(1): body[match.end() : starts[i + 1].start() if i + 1 < len(starts) else None]
        for i, match in enumerate(starts)
    }


def _matrix_axes(job: str) -> set[str]:
    match = re.search(r"^      matrix:\n((?:        .*\n|\s*#.*\n)+)", job, re.M)
    return set(_MATRIX_AXIS_RE.findall(match.group(1))) if match else set()


def _upload_names(job: str) -> list[str]:
    """The ``name:`` of every ``actions/upload-artifact`` step in ``job``."""
    names = []
    for step in re.split(r"^      - ", job, flags=re.M):
        if "actions/upload-artifact@" in step:
            match = re.search(r"^          name: (.+)$", step, re.M)
            assert match, f"upload step without a name:\n{step}"
            names.append(match.group(1).strip())
    return names


def test_workflow_parses_into_jobs_with_uploads() -> None:
    """Guard the parser: the jobs the rule is about are found."""
    jobs = _jobs(WORKFLOW.read_text(encoding="utf-8"))
    uploads = {job: _upload_names(body) for job, body in jobs.items()}
    assert sum(len(names) for names in uploads.values()) >= 3
    assert any("branch" in _matrix_axes(body) for body in jobs.values())


def test_every_upload_in_a_branch_matrix_names_the_branch() -> None:
    for job, body in _jobs(WORKFLOW.read_text(encoding="utf-8")).items():
        if "branch" not in _matrix_axes(body):
            continue
        for name in _upload_names(body):
            assert "matrix.branch" in name, (
                f"job {job!r}: artifact {name!r} does not name matrix.branch; the develop "
                "and main legs of a 'both' dispatch would upload the same name (409)"
            )


def test_upload_names_are_unique_across_jobs() -> None:
    names = [
        name
        for body in _jobs(WORKFLOW.read_text(encoding="utf-8")).values()
        for name in _upload_names(body)
    ]
    assert len(names) == len(set(names)), f"duplicate artifact name templates: {names}"

---
id: TIN-016
title: The parallel-isolation scheme collides silently on a missing/misconfigured dev.local.json
angle: test-integration
severity: low
category: tooling
is_workaround: false
subsystem: tests/system/termihub_harness/dev_local.py, dev.local.json
evidence:
  - tests/system/termihub_harness/dev_local.py
  - docs/testing.md:718
  - docs/testing.md:802
status: open
---

## What

Ten checkouts share one machine using per-checkout `dev.local.json` (gitignored)
that assigns a distinct `dev_port`, `dev_agent_port`, `compose_project`, and
`test_port_offset`. The resolver falls back to offset `0` / project `termihub`
when the file is missing, so a checkout with **no** `dev.local.json` does not
fail — it **silently collides** with checkout 0's ports and containers, producing
flaky cross-checkout failures that look like real bugs. The docs call this out
(`docs/testing.md:718-807`), and note two sharp edges:

- The collision-free property is subtle: it holds "**not** because `1000`
  exceeds the base-port span … but because no two base ports differ by an exact
  multiple of `1000`" — an invariant a new base port can break.
- `git clean -xfd` deletes the gitignored `dev.local.json`; `pnpm tauri dev` used
  to bind checkout 0's port in every checkout until #1588.

## Why it matters

- A missing/mis-copied file (e.g. `cp default.dev.local.json` into another slot)
  points a checkout at another's containers, corrupting both runs' results — the
  failures masquerade as product bugs and cost debugging time (documented failure
  mode in the coordinator's operating notes).
- This is an infrastructure fragility that makes the whole integration suite less
  trustworthy on the shared dev machine, even though it is not a product defect.

## Evidence

- `docs/testing.md:718-908` (Parallel Test Isolation) — fallback-to-0 behavior,
  the multiple-of-1000 invariant, `git clean` and `pnpm tauri dev` hazards.
- `tests/system/termihub_harness/dev_local.py` — resolver precedence (env >
  file > default).

## Recommendation

- Make a missing or offset-0-colliding `dev.local.json` **fail fast** in the
  harness when more than one checkout is detected (or when `TERMIHUB_DEV_NAME`
  is unset in a multi-checkout layout), rather than silently defaulting — turn a
  silent collision into a clear error.
- Add a self-check (a machinery test) that asserts the resolved ports/project for
  the current checkout are internally consistent with its `dev_name`, so a
  clobbered file is caught before a suite runs.

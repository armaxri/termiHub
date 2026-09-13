---
id: TOOL-012
title: Display/host-gated scripts never run headless in CI; no .sh/.cmd parity check
angle: tooling-coverage
severity: medium
category: tooling
is_workaround: false
subsystem: scripts / ci
evidence:
  - scripts/smoke-test.sh:1
  - scripts/run-guided-manual.sh:1
  - scripts/test-system-linux.sh:1
status: open
---

## What

Several shipped scripts are executed by **no CI lane** and depend on a display, real
hardware, or a full host setup: `smoke-test.sh` (launches the built app / uses
`tauri-driver` or `osascript`), `run-guided-manual.sh`, and the `test-system-*.sh`
per-machine orchestrators (Docker + virtual serial ports). Because CI never runs
them, a shell bug in the setup/pre-launch portion sits undetected until someone runs
it by hand. Separately, the whole `scripts/` kit ships **`.sh` + `.cmd` pairs** with
no automated check that the two stay behavior-equivalent.

## Why it matters

This is exactly the class the coordinator's SC2257 lesson describes: a manual,
display-gated harness that CI never runs shipped a `set -u` "unbound variable" bug
that aborted on its first real run — static checks (`bash -n`, shellcheck) and green
CI were the only gates and both missed it. Every not-CI-run script is a latent
instance. The `.sh`/`.cmd` parity gap is the same risk across platforms: a fix landed
in `check.sh` but not `check.cmd` silently diverges Windows dev/CI behavior, and
nothing catches it.

## Evidence

- `scripts/smoke-test.sh`, `scripts/run-guided-manual.sh`, `scripts/test-system-*.sh`
  are referenced by docs and manual workflows but are not invoked in
  `.github/workflows/**` (the smoke test is wired into `release-*-smoke.yml` on Linux
  only; macOS/Windows paths of `smoke-test.sh` never run in CI).
- No parity/drift check exists between any `*.sh` and its `*.cmd` sibling.

## Recommendation

- **Run every script to the furthest point the environment allows in CI**, even the
  display-gated ones: a headless invocation still executes the pre-launch setup,
  argument parsing, and prints — which is where the `set -u`/expansion class of bug
  lives and is caught in one second. Add a CI job that runs `smoke-test.sh --help`
  and the setup portion of the system-test scripts under `set -u` on all three OSes.
- Run **shellcheck** on all `scripts/**.sh` in CI (it is not currently a lane) and
  treat any `# shellcheck disable=` on a not-CI-run script as requiring justification.
- Add a **`.sh`/`.cmd` parity guard**: at minimum a doc/test that enumerates the pairs
  and a checklist step; better, a smoke job that runs the `.cmd` variants of `check`/
  `test` on the Windows runner so both variants are actually exercised.

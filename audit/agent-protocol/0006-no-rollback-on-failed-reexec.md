---
id: AGT-006
title: No rollback if re-exec fails — a bad-but-valid binary can leave the host with a non-starting agent
angle: agent-protocol
severity: medium
category: reliability
is_workaround: false
subsystem: agent/src/update/apply.rs, agent/src/session/manager.rs
evidence:
  - agent/src/update/apply.rs:186
  - agent/src/update/apply.rs:233
  - agent/src/update/apply.rs:213
status: open
---

## What
`apply_update_binary` replaces the on-disk binary and *then* re-execs
(`agent/src/update/apply.rs:186`). The swap itself is atomic (copy to sibling temp → chmod →
`rename`, `apply.rs:207-228` — good), but there is **no backup of the replaced binary and no
revert on re-exec failure**. If `reexec` fails (`apply.rs:233`) the new binary is already in
place while the old process keeps running the old image; a later restart then runs the new
code, which may be incompatible with the still-running old process's detached daemons. If
the new binary passes the (absent, per AGT-004) integrity check but crashes on exec, the
host is left with a non-starting agent and no rollback path — the "brick itself" scenario.

Additionally, `replace_binary` uses a **fixed** temp filename `.termihub-agent.update.tmp`
in the target dir (`apply.rs:213`), so two concurrent applies (self-update timer racing a
pushed update) could clobber each other's temp.

## Why it matters
On a safety-critical host, an update that cannot roll back is an availability hazard: one
bad release (or a corrupted staged file) permanently disables the remote agent with no
automated recovery.

## Recommendation
Keep the old binary as a backup, exec-test the new binary (or verify it starts) before
committing the swap, and revert to the backup if re-exec fails. Use a unique temp filename
per apply. Consider an A/B binary scheme with a boot-success watchdog.

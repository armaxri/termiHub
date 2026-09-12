---
id: AGT-004
title: Update apply path performs no integrity verification — checksum lives only in the self-update download
angle: agent-protocol
severity: critical
category: security
is_workaround: false
subsystem: agent/src/session/manager.rs, agent/src/update/apply.rs
evidence:
  - agent/src/session/manager.rs:1048
  - agent/src/update/apply.rs:207
  - agent/src/update/download.rs:47
status: deferred
resolution: "maintainer-decision — signed-update design"
---

## What
Integrity verification (SHA-256 against a `.sha256` sidecar) exists **only** in the
self-update *download* path (`agent/src/update/download.rs:47`). The *apply* path —
`SessionManager::apply_pending_update` → `SystemUpdateApplier::apply` → `replace_binary` —
performs **no** digest check of its own. Every non-self-download route to apply therefore
swaps and execs bytes that were never verified at apply time:
- The desktop-pushed coordinated path SFTP-uploads a binary and calls
  `agent.request_update{binaryPath}`; the agent applies it with zero agent-side integrity
  check (trust rests entirely on the desktop having verified before upload + SSH).
- A binary staged earlier (coordinated/deferred strategy) is applied later on idle with no
  re-verification — a TOCTOU window where a local user with write access to the staging or
  `/tmp` upload path can swap the file between stage and apply.

## Why it matters
Verification decoupled from application means the guarantee "we only run bytes we checked"
does not actually hold on the paths that ship. Combined with AGT-003 (arbitrary path) this
is a direct code-execution route. Verification must be immediately-before-swap, on every
route.

## Evidence
- `agent/src/session/manager.rs:1048` — `apply_pending_update` calls `update_applier.apply`
  with no digest check.
- `agent/src/update/apply.rs:207` — `replace_binary` copies + renames + chmods + re-execs,
  no verification.
- `agent/src/update/download.rs:47` — the only SHA-256 check in the subsystem, in the
  download path only.

## Recommendation
Move integrity verification into the apply path so that pushed, coordinated, "Apply Now",
and retried-from-state routes all verify the bytes immediately before the swap. Re-verify a
staged binary at apply time (close the TOCTOU). Ideally verify a signature (AGT-005), not
just a self-consistent digest.

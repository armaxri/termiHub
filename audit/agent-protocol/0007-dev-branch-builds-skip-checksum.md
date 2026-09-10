---
id: AGT-007
title: Dev/branch agent builds are downloaded and installed with checksum enforcement disabled
angle: agent-protocol
severity: medium
category: security
is_workaround: true
subsystem: src-tauri/src/terminal/agent_binary.rs
evidence:
  - src-tauri/src/terminal/agent_binary.rs:320
  - src-tauri/src/terminal/agent_binary.rs:357
  - src-tauri/src/terminal/agent_binary.rs:283
status: open
---

## What
The desktop's agent-binary resolver treats dev and branch builds as exempt from checksum
enforcement. `is_dev_build` includes `cfg!(debug_assertions)`
(`agent_binary.rs:357`); dev/branch downloads pass `require_checksum = false`
(`agent_binary.rs:320`, branch builds `:328`), and a missing sidecar is tolerated with only
a warning (`agent_binary.rs:283`). A whole class of deploys therefore ships an agent binary
whose integrity is never checked before it is uploaded and executed on the remote host.

## Why it matters
This is a stopgap (`require_checksum = false`) that disables an integrity control on a real
path. Even if release builds enforce the checksum, the exemption is a latent hole for any
non-release channel and interacts with AGT-004/AGT-005 (the apply side checks nothing
either). Marked `is_workaround: true` — the disabled check should be removed/justified
before release.

## Evidence
- `src-tauri/src/terminal/agent_binary.rs:320` — `require_checksum = false` for dev.
- `:357` — `is_dev_build` keyed on `debug_assertions`.
- `:283` — missing sidecar → warning, not failure.

## Recommendation
Require a checksum (and eventually a signature) on all channels, or explicitly document and
gate the dev exemption so it cannot be reached in a release build. Fail closed on a missing
sidecar.

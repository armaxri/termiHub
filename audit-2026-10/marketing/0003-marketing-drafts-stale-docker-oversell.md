---
id: MKT2-003
title: "docs/marketing launch drafts (the staged fixes for MKT-004/006/007/011) have gone stale and would reintroduce the Docker oversell"
angle: marketing / product positioning
severity: medium
category: docs-accuracy
is_workaround: false
subsystem: "docs/marketing"
evidence:
  - "docs/marketing/README.md:4-11"
  - "docs/marketing/feature-matrix.md:13"
  - "docs/marketing/feature-matrix.md:16"
  - "docs/marketing/value-proposition.md:42"
  - "docs/marketing/value-proposition.md:79-80"
  - "docs/marketing/release-notes-0.1.0-draft.md:21-23"
  - "docs/marketing/release-notes-0.1.0-draft.md:65-66"
  - "docs/marketing/release-notes-0.1.0-draft.md:5"
  - "README.md:101"
  - "core/src/backends/docker/mod.rs:724-732"
  - "core/src/backends/ssh/mod.rs:362-381"
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The drafts are meant to be folded into README.md and CHANGELOG.md at release, and docs/marketing/README.md:8-9 says every claim is 'grounded in shipped code'. They now contradict the product in several places. (1) Docker is called 'run-new only; attaching to an already-running container is not yet supported' in five places (feature-matrix.md:16, value-proposition.md:42 and :79-80, release-notes draft :21 and :65-66). The product supports existing containers and Compose services (README.md:101, docker/mod.rs:724-732). (2) Feature-matrix tunnels, network tools and embedded servers are 'Stable' although they are experimental-gated. (3) SSH is described as 'Key & password auth' only (feature-matrix.md:13, release-notes :22), but SSH Agent and Keyboard-Interactive (OTP/2FA) also ship. (4) The release-notes draft cites '590+ per-branch fragments'; there are now about 904 files under docs/changes. It also omits capabilities shipped since it was drafted: plugin OS sandbox, VNC file transfer, telnet auto-login, Docker existing/Compose, 2FA SSH, backup & restore, biometric unlock, inline images, custom themes.

## Why it matters

These files are the ready-to-paste fixes for four open marketing findings. Pasted at release, the Docker text would undo MKT-005 (a known first-use trust break) and would undersell features that have been added since. The 'grounded in shipped code' header makes a reviewer less likely to re-verify them.

## Evidence

- `docs/marketing/README.md:4-11`
- `docs/marketing/feature-matrix.md:13`
- `docs/marketing/feature-matrix.md:16`
- `docs/marketing/value-proposition.md:42`
- `docs/marketing/value-proposition.md:79-80`
- `docs/marketing/release-notes-0.1.0-draft.md:21-23`
- `docs/marketing/release-notes-0.1.0-draft.md:65-66`
- `docs/marketing/release-notes-0.1.0-draft.md:5`
- `README.md:101`
- `core/src/backends/docker/mod.rs:724-732`
- `core/src/backends/ssh/mod.rs:362-381`

## Recommendation

Re-sync the three drafts against the current README.md and code. Replace every 'run-new only' Docker line with new / existing / Compose-service. List all four SSH auth methods. Mark gated features Experimental. Refresh the fragment count and add the capabilities shipped since then. Add a 'last verified against <commit>' line to each draft header. Add a release-checklist item (docs/release-plan-0.1.0.md or scripts/release-check.sh) that re-verifies docs/marketing/\* before folding.

## Verification

Confirmed. feature-matrix.md:16, value-proposition.md:42/79-80 and release-notes draft :21/:65 still say Docker is run-new only, while README:101 lists existing-container and Compose support. SSH is described as key/password only, and tunnels/network tools/servers are marked Stable. The '590+' fragment count is stale: find docs/changes counts 904 files. These are drafts, so medium rather than higher.

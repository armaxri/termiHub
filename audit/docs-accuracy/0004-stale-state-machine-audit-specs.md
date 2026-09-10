---
id: DOC-004
title: docs/audits/*state-machine*.md are stale point-in-time snapshots contradicted by current code, not marked historical
angle: docs-accuracy
severity: medium
category: docs
is_workaround: false
subsystem: docs/audits
evidence:
  - docs/audits/credential-store-state-machine.md:1
  - docs/audits/remote-agent-lifecycle-state-machine.md:1
  - docs/audits/embedded-servers-state-machine.md:1
  - docs/audits/remote-system-monitoring-state-machine.md:1
status: open
---

## What

The eight `docs/audits/*-state-machine.md` documents are audit findings frozen against a specific
past state of the code (each is stamped "Deliverable: Audit findings only … No production code
changes" and tied to issues #1131–#1137). They are packed with precise `file:line` citations and
descriptions of the state model — e.g. the credential/agent/monitoring docs describe frontend
"optimistic writer" reducers in `appStore.ts` at specific line numbers, and the reducer-inversion
migration since then deleted those reducers and moved authority into backend projections. The
line numbers and the "who is authoritative" descriptions no longer match. Nothing in these files
marks them as historical/superseded, so a reader treats them as current specifications.

## Why it matters

These are the most detailed written description of several state machines (credential store,
SFTP, embedded servers, HTTP monitor, remote-agent lifecycle, remote monitoring, SSH tunnel,
workspace). A contributor debugging one of these subsystems will follow the cited `file:line`
into the wrong place and reason from a superseded architecture (appStore-authoritative rather
than region-authoritative). Stale specs with authoritative-looking citations are worse than no
spec.

## Evidence

- Every file carries the frozen banner, e.g. `docs/audits/credential-store-state-machine.md:5`
  "Deliverable: Audit findings only … No production code changes."
- They cite exact appStore lines that have since shifted: e.g. the credential doc points at
  `src/store/appStore.ts:691, 4087` and the remote-agent doc at `appStore.ts:3002/3018/3032/3054`;
  `appStore.ts` is now 8156 lines and the reducers/optimistic-writers these docs describe were
  removed by the completed reducer-inversion migration (see DOC-001 and the project memory:
  "reducer inversion done … reconnect engine deleted").
- The docs describe the frontend as authoritative with backend "shadow" regions — the current
  code inverts this (regions authoritative), so both the narrative and the line refs are stale.

## Recommendation

Either (a) move these under a clearly-labelled `docs/audits/archive/` (or add a prominent
"Historical — captured at #113x; superseded by the stateless-UI migration, see …" banner at the
top of each) so they read as snapshots, or (b) refresh the ones still used as living specs against
current code. Do not leave them presenting stale `file:line` references as current fact.

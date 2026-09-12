---
id: PROD-013
title: Cross-remote transfer is client-mediated (local temp round-trip), no direct remote↔remote
angle: product-completeness
severity: low
category: missing-feature
is_workaround: true
subsystem: src/hooks/useSessionFileSystem
evidence:
  - src/hooks/useSessionFileSystem.ts:318
  - src/hooks/useSessionFileSystem.ts:355
status: open
---

## What
SFTP→SFTP transfer streams through a local temp file (download then upload); byte backends
round-trip bytes through the client. There is no server-to-server transfer, and
sftp→session cross-source copy is explicitly unsupported.

## Why it matters
Moving files between two remote hosts pulls all bytes through the local machine — slow over
asymmetric links and impossible when the client lacks disk/bandwidth. Power users expect
agent-relayed or direct transfer.

## Evidence
- `src/hooks/useSessionFileSystem.ts:318-331` — SFTP→SFTP via local temp file.
- `src/hooks/useSessionFileSystem.ts:336-337, 355` — byte round-trip; cross-source unsupported.

## Recommendation
Offer agent-relayed copy between two hosts sharing an agent, or stream directly between the
two SFTP channels without a temp file; support the sftp↔session cross-source case.

---
id: SM-023
title: Corrupt last-session.json is swallowed as "no session" with no .bak and no recovery warning
angle: state-machine-ux
severity: low
category: reliability
is_workaround: false
subsystem: src-tauri/src/workspace/last_session.rs
evidence:
  - src-tauri/src/workspace/last_session.rs:79
status: open
---

## What
A parse-corrupt `last-session.json` is mapped to `Ok(None)` (`last_session.rs:79-82`), unlike
workspaces/session-history which back the corrupt file up to `*.json.bak` and surface a
`RecoveryWarning`. The frontend now toasts on the *load-error* path (`appStore.ts:7875`), but
a *parse-corrupt* file returns `Ok(None)`, which is indistinguishable from "no session to
restore".

## Why it matters
On a corrupt last-session, the user gets a blank window (looks like a fresh start), the
corrupt file is silently discarded rather than preserved for diagnosis, and no recovery
warning is shown — an asymmetry with the other two stores that both `.bak` and warn.

## Evidence
- `last_session.rs:79-82` — corrupt parse → `Ok(None)`, no `.bak`, no warning.

## Recommendation
On a parse failure, `.bak` the corrupt file and surface the same `RecoveryWarning` channel the
workspaces/session-history stores use, so a corrupt session is distinguishable from an empty
one and is recoverable.

---
id: SM-010
title: Credential store auto-locks under a long interactive session (activity not tracked on terminal I/O)
angle: state-machine-ux
severity: low
category: ux
is_workaround: false
subsystem: src-tauri credential manager
evidence:
  - src-tauri/src/security/credential/manager.rs:187
  - src-tauri/src/security/credential/auto_lock.rs:186
status: open
---

## What
Auto-lock activity is recorded only on credential-store access (`record_activity` fires on
store I/O, `manager.rs:187-235`), not on terminal I/O. A long interactive SSH session that
read a stored credential once at connect time will still auto-lock underneath the user after
the idle timeout (`auto_lock.rs:186`). The lock is now at least announced via a toast
(`LockedEventPayload{auto:true}` → `useCredentialStoreEvents.ts:37`).

## Why it matters
The Locked state is correct, but the *timing* is surprising: a user actively typing in a
terminal for an hour is "idle" from the credential store's point of view, so the store
locks. The next reconnect / new tab / anything needing a stored secret re-prompts for the
master password mid-work. Not a stuck/data-loss defect, but an ambiguous "why am I being
asked again?" moment.

## Evidence
- `manager.rs:187-235` — `record_activity` called only on credential access.
- `auto_lock.rs:186` — idle timer drives the lock.

## Recommendation
Decide the intended policy with the maintainer: either treat any live session/terminal
activity as store activity (defer auto-lock while sessions are active), or keep the current
behavior but make the toast explain it ("credential store locked after N min idle — sessions
unaffected; unlock needed for new connections"). The current toast already helps; this is a
policy/legibility call.

---
id: AGT-021
title: Session connection settings (possibly including secrets) are persisted to state.json in plaintext with no file-permission hardening
angle: agent-protocol
severity: medium
category: security
is_workaround: false
subsystem: agent/src/state/persistence.rs, agent/src/session/manager.rs
evidence:
  - agent/src/state/persistence.rs:66
  - agent/src/session/manager.rs:519
  - agent/src/session/manager.rs:244
status: open
---

## What
`PersistedSession.settings` stores the **full connection settings JSON**
(`agent/src/state/persistence.rs:66`, written at `agent/src/session/manager.rs:519`) so the
session can be re-spawned on recovery. Depending on how the desktop populates them, those
settings can include SSH passwords, key passphrases, or other secret material. The file sits
at `~/.config` / `%APPDATA%` and this code applies **no explicit `0o600` chmod** on it. The
same settings are also passed transiently to the daemon via the `TERMIHUB_SETTINGS` env var
(`agent/src/session/manager.rs:244`) — process env is same-user-readable (and on some systems
root/tooling-readable).

## Why it matters
Plaintext secret-at-rest with default file perms is a credential-exposure risk on a
shared/backed-up host, and it is invisible to the user. For a safety-critical release,
secret handling over the wire and at rest should be explicit.

## Evidence
- `agent/src/state/persistence.rs:66-68` — `settings` holds the full config JSON.
- `agent/src/session/manager.rs:519` — persisted on create.
- `agent/src/session/manager.rs:244` — settings passed via `TERMIHUB_SETTINGS` env.

## Recommendation
Confirm whether secrets can reach `settings`. If so: strip them before persisting and
re-resolve from the credential store on recovery, and/or write `state.json` with `0o600`
and document the exposure. Avoid passing secrets through the environment where a file
descriptor or socket handshake would keep them out of `ps`/`/proc`.

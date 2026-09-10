---
id: PER-008
title: Credential envelope version check has no up/down migration — a rollback locks out all credentials
angle: persistence-migration
severity: medium
category: reliability
is_workaround: false
subsystem: src-tauri/src/credential
evidence:
  - src-tauri/src/credential/crypto.rs:23
  - src-tauri/src/credential/crypto.rs:217
  - src-tauri/src/credential/master_password.rs:143
status: open
---

## What

The encrypted credential store is the **only** persisted store that versions its format and actually
checks it: `ENVELOPE_VERSION: u32 = 1` (`crypto.rs:23`), enforced on decrypt
(`crypto.rs:217-222`) and on unlock (`master_password.rs:143-149`):

```rust
if envelope.version != ENVELOPE_VERSION {
    return Err(... "unsupported file version: {}" ...);
}
```

This is good hygiene — but the check is a hard **equality** with **no migration in either
direction**. There is no path that reads a `version: 0`/legacy envelope and upgrades it, and no path
that lets an older binary read a newer envelope. Any bump of `ENVELOPE_VERSION` is a one-way door.

## Why it matters

Losing the credential store means losing **all** saved credentials. On an auto-updating app:

- **Rollback / staged-update revert:** if vN+1 ever writes a `version: 2` envelope (e.g. a KDF or
  AEAD upgrade — a plausible pre-release hardening), a downgrade to vN sees `2 != 1` and **cannot
  unlock the store at all**. Every saved credential becomes inaccessible until the user re-upgrades;
  if they had also changed the master password under vN+1, recovery is worse.
- **Forward:** because the check is strict equality, even a benign additive envelope change forces a
  version bump that instantly breaks older installs, with no graceful "read old, write new" step.

The behaviour fails *closed* (no plaintext leak, no silent wipe), so this is not data-*loss* in the
corruption sense — but it is data-*inaccessibility*, which for credentials is nearly as bad, and it
is the concrete instance of the PER-001 migration gap in the most sensitive store.

## Evidence

- `crypto.rs:23` — `pub const ENVELOPE_VERSION: u32 = 1;`
- `crypto.rs:217-222` — `decrypt_with_password` bails on any non-matching version.
- `master_password.rs:143-149` — unlock returns `Corrupted("unsupported file version")` on mismatch.
- No code path migrates an envelope between versions (grep for envelope-version handling shows only
  the two rejection sites).

## Recommendation

Before the format is ever bumped, add a real envelope-migration path: accept a *range* of supported
versions on read, re-encrypt to the current version on next unlock/save (transparent forward
migration), and define an explicit policy for a *newer* envelope than the binary supports — surface a
clear "credentials were written by a newer version, please update" message rather than a generic
"corrupted/unsupported" error, so a rollback is diagnosable and never mistaken for corruption.
</content>

---
id: PROD-065
title: Credentials cannot be shared/reused across connections
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src-tauri/src/credential
evidence:
  - src-tauri/src/credential/os_keychain.rs:20
  - src-tauri/src/credential/types.rs:58
status: open
---

## What
Each credential is bound to one connection id (keychain account = `<connection-id>:<type>`).
There is no connection-independent credential entity referenced by multiple connections.

## Why it matters
A shared vault entry (one password/key used by many hosts, changed once) is a core secrets-
manager expectation. Users must duplicate a secret per connection and update each on rotation —
error-prone and tedious for a fleet with a shared bastion/key.

## Evidence
- `src-tauri/src/credential/os_keychain.rs:20-21` — account names are `<connection-id>:<type>`.
- `src-tauri/src/credential/types.rs:58` — parsing keyed by connection id.

## Recommendation
Introduce standalone named credential entries that connections reference by id, so one secret
serves many connections and rotates in one place.

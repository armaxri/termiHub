---
id: PROD-064
title: No biometric unlock (Touch ID / Windows Hello) for the credential store
angle: product-completeness
severity: medium
category: missing-feature
is_workaround: false
subsystem: src-tauri/src/credential
evidence:
  - src-tauri/src/credential/auto_lock.rs:1
status: open
---

## What
Unlock is master-password only. There is no biometric gate (Touch ID / Face ID / Windows
Hello); OS-keychain mode may prompt the OS but there is no explicit biometric unlock.

## Why it matters
Biometric unlock is increasingly expected for a secrets store; typing a master password every
auto-lock is friction that pushes users toward weaker passwords or the "none" storage mode.

## Evidence
- No `biometric/touch id/windows hello/face id/LAContext/LocalAuthentication` in credential code.

## Recommendation
Integrate platform biometric auth (LocalAuthentication on macOS, Windows Hello) as an unlock
method gating the master key.

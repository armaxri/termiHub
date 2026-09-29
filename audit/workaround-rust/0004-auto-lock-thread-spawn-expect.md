---
id: WA-RS-004
title: Credential auto-lock timer thread spawn panics on failure
angle: workaround-rust
severity: low
category: reliability
is_workaround: true
subsystem: src-tauri/credential
evidence:
  - src-tauri/src/credential/auto_lock.rs:109
status: fixed
resolution: "#2852 — AutoLockTimer::new returns io::Result (no .expect panic); fail-safe: unlock/setup gated on has_auto_lock_timer() so a failed spawn keeps store LOCKED (never unlocked-without-timer); startup force-locks on Err"
---

## What
The credential auto-lock timer spawns its background thread with
`.expect("Failed to spawn auto-lock timer thread")`.

## Why it matters
Thread-spawn failure (resource exhaustion) panics rather than degrading. Because
auto-lock is a security feature, a silent-crash vs. graceful-degrade choice
should be deliberate. Violates "No `.unwrap()` in production code".

## Recommendation
Return/log an error on spawn failure and either retry or leave the store locked
(fail-safe) rather than panicking the caller.

---
id: DEAD-003
title: Runtime feature-flag injection mechanism (#2476) is orphaned — no frontend consumer
angle: deadcode-flags
severity: medium
category: workaround
is_workaround: true
subsystem: src-tauri/src/utils/test_bridge.rs
evidence:
  - src-tauri/src/utils/test_bridge.rs:32
  - src-tauri/src/utils/test_bridge.rs:36
  - src-tauri/src/utils/test_bridge.rs:54
  - src-tauri/src/utils/test_bridge.rs:99
status: open
---

## What
The `TERMIHUB_TEST_FLAG_<NAME>` → `window.__TERMIHUB_<NAME>__` injection mechanism
(added by #2476 to let the harness flip the `sessionBackendReattach` reconnect flag
for a live grade) is now **dead**: no frontend code reads any `window.__TERMIHUB_*__`
feature-flag global. The reconnect flag and the client reconnect engine it gated were
deleted when the projection/reducer inversion completed (#2205/#2283), leaving the
injection half with nothing to inject to.

## Why it matters
`TEST_FLAG_ENV_PREFIX`, `flag_is_truthy`, `is_safe_flag_name`, and
`feature_flag_init_script()` (plus their unit tests) are scaffolding for a flag that
no longer exists. It survives only because it is bundled inside the always-compiled
test-bridge module (see DEAD-002). Leaving it invites a future author to "wire up" a
mechanism that has no live purpose.

## Evidence
- `grep -rn "__TERMIHUB_" src/ | grep -v .test.` → only `__TERMIHUB_TEST_BRIDGE__`
  and `__TERMIHUB_TEST_BRIDGE_PORT__` (the bridge itself), **never** a `__TERMIHUB_<flag>__`.
- `src-tauri/src/utils/test_bridge.rs:54` `feature_flag_init_script()` scans
  `TERMIHUB_TEST_FLAG_*` env vars; its output is appended to the boot script at line 99.
- No script under `scripts/` or test under `tests/system/` sets any `TERMIHUB_TEST_FLAG_*`.

## Recommendation
Delete `TEST_FLAG_ENV_PREFIX`, `flag_is_truthy`, `is_safe_flag_name`,
`feature_flag_init_script()`, their concatenation into the init script, and the
associated unit tests. Order: land after or alongside DEAD-002's gating so the
removal is a clean subtraction. If the maintainer wants to retain a generic
flag-flip harness capability for future flags, keep it but add a smoke consumer so it
is not silently dead again.

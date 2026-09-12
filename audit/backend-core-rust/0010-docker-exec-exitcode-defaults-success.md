---
id: CORE-010
title: Docker exec treats a failed/absent exit-code inspect as success (silent file-op corruption)
angle: backend-core-rust
severity: medium
category: bug
is_workaround: false
subsystem: core/backends/docker
evidence:
  - core/src/backends/docker/file_browser.rs:83
status: fixed
resolution: "#2756 — exec exit code honored"
---

## What
The exec exit-code check discards an `inspect_exec` failure and defaults an
unknown exit code to `0`:

```rust
let inspect = client.inspect_exec(&exec.id).await.ok();
let exit_code = inspect.and_then(|i| i.exit_code).unwrap_or(0);
if exit_code != 0 {
```

## Why it matters
`.ok()` throws away an inspect error and `unwrap_or(0)` then treats an unknown
exit code as success. A container command that actually failed — but whose
`inspect_exec` errored, or that returned no `exit_code` — is reported as OK with
possibly empty or partial stdout. For file operations (read/list/delete) that is
silent data corruption: an empty read looks like an empty file, a failed delete
looks done. The same pattern appears again around lines 160-166.

## Evidence
`core/src/backends/docker/file_browser.rs:83-89` and `:160-166`.

## Recommendation
Treat a missing/failed inspect result as an error (propagate a
`FileError::OperationFailed`) rather than assuming exit code 0.

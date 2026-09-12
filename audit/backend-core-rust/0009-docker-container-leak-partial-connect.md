---
id: CORE-009
title: Docker container leaked when exec setup fails after the container starts
angle: backend-core-rust
severity: medium
category: reliability
is_workaround: false
subsystem: core/backends/docker
evidence:
  - core/src/backends/docker/mod.rs:705
  - core/src/backends/docker/mod.rs:726
status: fixed
resolution: "#2756 — container cleanup on failed connect"
---

## What
`connect` starts the container, then creates and starts an exec instance. Each
step propagates its error with `?`, but nothing undoes the started container:

```rust
client.start_container::<String>(&container_id, None).await
    .map_err(|e| SessionError::SpawnFailed(format!("Failed to start container: {e}")))?;
...
let exec_response = client.create_exec(&container_id, exec_config).await
    .map_err(|e| SessionError::SpawnFailed(format!("Failed to create exec: {e}")))?;
```

## Why it matters
If `create_exec` or `start_exec` fails after `start_container` succeeds, `connect`
returns early before storing `ConnectedState`, so `disconnect` never runs and the
started container is never stopped or removed. Repeated failed connects leak
running containers on the host indefinitely.

## Evidence
`core/src/backends/docker/mod.rs:705-743`. Cleanup only happens via
`disconnect`, which requires a stored `ConnectedState` that is only set on full
success.

## Recommendation
On any error after `start_container`, best-effort `stop_container` +
`remove_container` before returning the error (a scope guard / helper that runs
teardown on the error path).

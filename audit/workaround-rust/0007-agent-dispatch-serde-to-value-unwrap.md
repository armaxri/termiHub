---
id: WA-RS-007
title: Agent JSON-RPC dispatch unwraps serde_json::to_value across ~30 handlers
angle: workaround-rust
severity: low
category: reliability
is_workaround: true
subsystem: agent/handler/dispatch
evidence:
  - agent/src/handler/dispatch.rs:693
  - agent/src/handler/dispatch.rs:874
  - agent/src/handler/dispatch.rs:936
  - agent/src/handler/dispatch.rs:2003
status: open
---

## What
Nearly every agent JSON-RPC handler serializes its result with
`serde_json::to_value(result).unwrap()` (~30 call sites). Serialization of a
well-formed result struct is effectively infallible, so this rarely fails — but
it is an unwrap on the response hot path of the remote agent.

## Why it matters
A serialize error (e.g. a future result type gaining a non-string-keyed map, or
a `serde` impl that can error) would panic the agent worker instead of returning
a JSON-RPC error. It is the highest-count `unwrap` cluster in the agent and
violates "No `.unwrap()` in production code".

## Recommendation
Introduce one helper (e.g. `fn ok_value<T: Serialize>(v: T) -> RpcResult`) that
maps a serialize error to an internal JSON-RPC error object, and use it in place
of `serde_json::to_value(...).unwrap()` everywhere. One change removes the entire
cluster and keeps the rule enforceable.

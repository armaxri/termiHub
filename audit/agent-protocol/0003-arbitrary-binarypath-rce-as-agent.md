---
id: AGT-003
title: Any initialized client can push an arbitrary binaryPath the agent copies over itself and execs (RCE-as-agent)
angle: agent-protocol
severity: critical
category: security
is_workaround: false
subsystem: agent/src/handler/dispatch.rs, agent/src/session/manager.rs
evidence:
  - agent/src/handler/dispatch.rs:1816
  - agent/src/session/manager.rs:975
  - agent/src/update/apply.rs:207
status: open
---

## What
`agent.request_update` and `agent.request_deferred_update` are gated **only** by the
`initialized` flag — there is no per-method authorization, capability check, or path
confinement. The `binaryPath` parameter is an attacker-controlled **absolute path** that
flows, validated only by `Path::new(&path).is_file()` (`agent/src/session/manager.rs:975`),
into the apply path, which copies it over the agent's own executable (`current_exe()`) and
re-execs it (`agent/src/update/apply.rs:207`). Any file readable by the agent user, at any
path — not confined to the staging/upload directory — becomes the new agent binary and runs
as the agent user. Every other client on that host then runs it on next start/attach.

## Why it matters
The effective authorization boundary is "can complete `initialize` over the transport" —
i.e. any principal with SSH access to the host (or, in `--listen` mode, any local process
that can reach the loopback port; see AGT-002). This turns ordinary agent access into
arbitrary-code-execution-as-the-agent-user plus host-wide persistence, with no signature
and no path restriction. On a safety-critical release this is the single highest-risk
finding in the protocol surface.

## Evidence
- `agent/src/handler/dispatch.rs:1816` — `agent.request_update` handler; only `initialized`
  is checked, then `binaryPath` is passed straight through.
- `agent/src/session/manager.rs:975` — the sole validation is `is_file()`; no confinement to
  an agent-owned directory.
- `agent/src/update/apply.rs:207` — `replace_binary` copies the given path over the target
  and (`:233`) `reexec`s it.
- The desktop-side "connected-host guard" (`src-tauri/src/terminal/agent_deploy.rs:231`) is
  UI-only and bypassable with `force`; the agent enforces no guard of its own.

## Recommendation
Constrain `binaryPath` to the agent-owned staging directory (reject any path outside it),
require a cryptographic signature the agent verifies before swap (see AGT-005), and add an
authorization step beyond `initialized`. Fail closed on any path outside the trusted dir.

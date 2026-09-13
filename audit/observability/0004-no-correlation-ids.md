---
id: OBS-004
title: No correlation id or spans to trace one session across frontend↔backend↔agent
angle: observability
severity: medium
category: reliability
is_workaround: false
subsystem: core, src-tauri, agent (tracing usage)
evidence:
  - src-tauri/src/terminal/agent_manager.rs:2248
  - src-tauri/src/session/manager.rs:1136
  - src-tauri/src/files/transfer/mod.rs:420
status: open
---

## What
Logging is unstructured-leaning and uncorrelated. Backend `tracing` calls mostly
interpolate identifiers into the message string (`"Agent {}: connection lost…"`,
`"Closed session"` with a `session_id` field, `transfer_id` on transfers) rather than
carrying a consistent set of structured fields, and there is **no single correlation id
that threads one logical session across the three processes**. The desktop knows a session
by one id, the agent by another, and the frontend by tab/panel identity; nothing ties them
together in the logs. No `tracing` **spans** are used to scope a connect/session lifecycle,
so related events aren't grouped.

## Why it matters
The whole point of field logs is to answer "what happened to *this* session." With ten
sessions active, a supporter reading `termihub.log` cannot reliably follow one session from
the UI action, through the desktop backend, to the agent and back — the ids don't line up
and events from different sessions interleave with no grouping. This turns every non-trivial
diagnosis into correlation-by-timestamp guesswork.

## Evidence
- `agent_manager.rs:2248` — `info!("Agent {}: connection lost, attempting reconnect", agent_id)`
  uses an agent-scoped id interpolated into the message, not a session-spanning field.
- `session/manager.rs:1136` — `info!(session_id, "Closed session")` uses a desktop
  session id with no link to the agent's id for the same session.
- `files/transfer/mod.rs:420` — `warn!(transfer_id = %ctx.transfer_id, …)` uses yet another
  id space. Each subsystem invents its own; none is shared end-to-end.

## Recommendation
Mint one correlation id at session/connection creation (desktop side), thread it into the
agent protocol handshake, and attach it as a structured `tracing` field (and ideally a
`span`) on every log line in all three tiers — including the re-emitted frontend logs from
OBS-001 and the agent logs from OBS-003. Standardize on structured fields
(`session_id`, `connection_id`, `agent_id`, `host`) over string interpolation so logs are
grep/filter-friendly and the LogViewer can filter by session.

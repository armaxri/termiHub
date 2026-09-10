---
id: DEAD-007
title: events.ts remote-state / agent-state subscriber machinery has no consumers
angle: deadcode-flags
severity: medium
category: arch
is_workaround: false
subsystem: src/services/events.ts
evidence:
  - src/services/events.ts:179
  - src/services/events.ts:273
  - src/services/events.ts:384
  - src/services/events.ts:392
status: open
---

## What
`TerminalOutputDispatcher` maintains `remoteStateCallbacks` and `agentStateCallbacks`
maps, registers Tauri `listen("remote-state-change", …)` and
`listen("agent-state-change", …)` handlers that dispatch into them, and exposes
`subscribeRemoteState()` / `subscribeAgentState()` to register callbacks. **Nothing
in `src/` calls either subscribe method**, so the callback maps are always empty and
the two event listeners fire into a no-op — dead subscriber infrastructure.

## Why it matters
Two always-registered global Tauri event listeners plus their dispatch bookkeeping
run for events that reach no consumer. Remote/agent state now flows through the
projection regions (e.g. `agents_projection`), not this dispatcher, so this is
pre-inversion residue.

## Evidence
- Maps: `events.ts:179-180` `remoteStateCallbacks` / `agentStateCallbacks`.
- Listeners: `events.ts:273` `"remote-state-change"`, `:292` `"agent-state-change"`.
- Public setters: `events.ts:384` `subscribeRemoteState`, `:392` `subscribeAgentState`.
- Callers: `grep -rn "subscribeRemoteState\|subscribeAgentState" src/ | grep -v events.ts | grep -v .test.`
  → none. (The backend still *emits* `agent-state-change` at
  `agent_manager.rs:1878`, but that feeds the agents projection, not this listener.)

## Recommendation
Remove `remoteStateCallbacks`, `agentStateCallbacks`, the two `listen(...)`
registrations, `subscribeRemoteState`, `subscribeAgentState`, and their teardown in
`destroy()`. Confirm no test relies on the dispatcher forwarding these events; remove
those cases if so. Bundle with DEAD-006 (both are remote-state residue).

---
id: FEC-015
title: useTauriEvents is a dead "Phase 2" stub hook that does nothing
angle: frontend-components
severity: low
category: workaround
is_workaround: true
subsystem: src/hooks
evidence:
  - src/hooks/useTauriEvents.ts:5
status: fixed
resolution: "#2730"
---

## What
`src/hooks/useTauriEvents.ts` is an exported hook whose entire body is comments:
```ts
export function useTauriEvents() {
  // Phase 2: Will use @tauri-apps/api/event to listen for:
  // - "terminal-output" -> write to xterm ...
}
```
It has no callers anywhere in `src/` (grep confirms zero usages). The real event
wiring lives in `services/events.ts` (`TerminalOutputDispatcher`), which
superseded this stub.

## Why it matters
Dead scaffolding shipped in the tree. Low impact, but it is misleading (implies a
"Phase 2" migration is pending when the functionality already exists elsewhere)
and is exactly the kind of stub a pre-release workaround sweep should remove.

## Evidence
`src/hooks/useTauriEvents.ts:1-11`; no importers.

## Recommendation
Delete the file.

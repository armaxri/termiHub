---
id: DEAD-008
title: useTauriEvents() is an empty Phase-1 stub hook, never imported
angle: deadcode-flags
severity: low
category: arch
is_workaround: false
subsystem: src/hooks/useTauriEvents.ts
evidence:
  - src/hooks/useTauriEvents.ts:5
status: open
---

## What
`src/hooks/useTauriEvents.ts` exports `useTauriEvents()`, whose body is empty except
for a "Phase 2 will…" comment. It is **never imported** anywhere in `src/`. The event
wiring it was a placeholder for shipped elsewhere (`services/events.ts`).

## Why it matters
Dead file that advertises unfinished "Phase 2" work that was actually completed by a
different module — misleading residue from an early scaffolding phase.

## Evidence
- `useTauriEvents.ts:5-11`: empty function body, "Phase 2: Will use
  @tauri-apps/api/event to listen for … terminal-output …".
- `grep -rn "useTauriEvents" src/` → only the definition file; no import.

## Recommendation
Delete `src/hooks/useTauriEvents.ts`.

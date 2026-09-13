---
id: TFE-011
title: Coverage thresholds are a loose global ratchet; no per-file floor lets a 0% critical module hide
angle: test-frontend
severity: info
category: tooling
is_workaround: false
subsystem: vitest.config.ts
evidence:
  - vitest.config.ts:31
status: open
---

## What

The coverage gate sets **global** floors only:

```ts
thresholds: { lines: 75, statements: 74, functions: 70, branches: 67 }
```

Each floor sits a few points below the measured value (a deliberate "ratchet, not
target" per the config comment). Two structural weaknesses:

1. **Global-only.** A single well-covered utility can offset a completely untested
   critical module — the aggregate stays above the floor while `Terminal.tsx` (46%B),
   `useSessionFileSystem.ts` (8%B), or a new 0% component contributes nothing. There
   is no `perFile` threshold and no directory-scoped floor.
2. **The branch floor (67%) is low for a safety-critical app.** Branches are where
   error/reconnect paths live (TFE-002/005/008); a 67% gate permits the dangerous
   third to stay dark indefinitely.

Combined with TFE-001 (`.tsx` excluded from `all`-mode zero-fill), the gate is both
loose and blind to its worst case.

## Why it matters

This is not a defect today — coverage is healthy in aggregate — but the gate does not
actually protect the modules that most need protecting, so it gives release
confidence it hasn't earned. A ratchet that can't see per-module regressions won't
catch the next `Terminal.tsx`-class hole.

## Evidence

- `vitest.config.ts:31` — global-only thresholds, no `perFile: true`, no per-path
  overrides.

## Recommendation

- Enable `thresholds.perFile: true` (or add per-directory overrides via multiple
  glob-keyed threshold blocks) so a single untested critical file trips the gate.
- Set higher **per-file branch floors** for the hot-path modules once TFE-002/005 land
  (`store/appStore.ts`, `Terminal/*`, `services/api.ts`, `hooks/use*FileSystem`).
- Keep the global ratchet, but raise the branch floor as the failure-path coverage
  improves. Do this together with TFE-001 so the numbers reflect components too.

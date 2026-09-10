---
id: LIBFE-001
title: Consolidate hand-rolled ID generation on the already-installed ulid
angle: lib-usage-frontend
severity: medium
category: arch
is_workaround: false
subsystem: src (cross-cutting)
evidence:
  - src/components/Sidebar/ConnectionList.tsx:967
  - src/components/ConnectionEditor/ConnectionEditor.tsx:750
  - src/components/ConnectionEditor/ConnectionEditor.tsx:786
  - src/hooks/useConnections.ts:20
  - src/hooks/useConnections.ts:28
  - src/components/Settings/shellIntegrationEntries.ts:37
  - src/components/RecentSessionsSidebar/SaveAsConnectionDialog.tsx:25
  - src/components/WorkflowSidebar/WorkflowEditorDialog.tsx:67
  - src/components/WorkflowSidebar/WorkflowSidebar.tsx:22
  - src/components/MacroSidebar/MacroSidebar.tsx:18
  - src/store/slices/macrosSlice.ts:60
  - src/store/appStore.ts:1709
  - src/services/macroIo.ts:137
  - src/services/workflowIo.ts:293
  - src/services/customHighlightRules.ts:28
  - src/themes/customThemes.ts:55
  - src/services/transport/ids.ts:9
status: open
---

## What

Client-side ID generation is hand-rolled and duplicated across the frontend in
two flavours, even though a proper, maintained ID library (`ulid`) is **already a
dependency** and already has a canonical wrapper at `src/services/transport/ids.ts`.

1. **Duplicated `crypto.randomUUID()`-with-fallback helpers.** At least 11 files
   define their own near-identical helper of the shape:

   ```ts
   const c = globalThis.crypto as Crypto | undefined;
   if (c && typeof c.randomUUID === "function") return c.randomUUID();
   return `macro-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
   ```

   (macros, workflows, themes, highlight rules, shell-integration entries, saved
   connections, …). Each is separately maintained and separately tested.

2. **Collision-prone `Date.now()`-only IDs.** Several creation paths use *only* a
   millisecond timestamp with no random/counter suffix:

   - `src/components/Sidebar/ConnectionList.tsx:967` — `id: \`folder-${Date.now()}\``
   - `src/hooks/useConnections.ts:20,28` — `conn-${Date.now()}` / `folder-${Date.now()}`
   - `src/components/ConnectionEditor/ConnectionEditor.tsx:750,786` — `agent-${Date.now()}` / `conn-${Date.now()}`

   Two entities created within the same millisecond (rapid clicks, programmatic
   creation, restore/import flows, or a fast machine) get the **same ID**. Notably
   the bulk SSH-import path already sidesteps this (`conn-${now}-${i}` in
   `sshConfigImport.ts`), which shows the inconsistency: some authors knew the bare
   timestamp was unsafe and worked around it locally.

## Why it matters

- **Correctness / data integrity (the safety-relevant part):** the `Date.now()`-only
  IDs are a latent duplicate-key bug for connections, folders, and agents — the exact
  identifiers used as React keys and as store/persistence keys. A collision silently
  merges or overwrites a user's saved connection/folder. On a "ventilator-grade"
  release this is the kind of quiet data-loss the audit is meant to eliminate.
- **Maintenance:** the same `randomUUID`-fallback snippet living in 11+ files means
  11 places to fix if the policy changes, 11 places to test, and 11 chances to drift.
- **The library is already paid for.** `ulid` (line 63 of `package.json`) is
  installed and battle-tested; `services/transport/ids.ts` already wraps it with a
  clear doc comment. There is no new dependency, no bundle-size argument — this is
  purely "use what we already have."
- The `crypto.randomUUID` fallback branch is effectively **dead code** in this
  environment: termiHub runs in a modern Tauri WebView where `crypto.randomUUID` is
  always present, so the `Math.random().toString(36)` branch never executes yet must
  still be read and maintained.

## Evidence

- Canonical, correct approach already exists: `src/services/transport/ids.ts:9`
  imports `ulid` and exposes `newIntentId()` / `newClientId()`.
- 11+ duplicated fallback helpers (see the frontmatter list; grep
  `randomUUID === "function"`).
- 5 collision-prone bare-timestamp IDs (grep `` `[a-z]*-${Date.now()}` ``).

## Recommendation

Adopt the installed library through one shared helper rather than adding anything new:

1. Add a general `newId(prefix?: string)` (and/or unprefixed `newId()`) alongside the
   existing `services/transport/ids.ts`, backed by `ulid()`. ULIDs are
   time-ordered, lexicographically sortable, and collision-resistant — strictly
   better than both `randomUUID` (unordered) and the timestamp hack.
2. Replace every local `crypto.randomUUID()`-fallback helper and every
   `Date.now()`-only ID with a call to it. Delete the duplicated helpers.
3. This is safe to do incrementally per subsystem; each site is a one-line swap and
   the existing per-feature tests will guard behaviour.

**Priority:** fix the five `Date.now()`-only sites first (real collision risk),
then fold the duplicated helpers in as cleanup.

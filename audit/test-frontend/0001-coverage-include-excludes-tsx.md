---
id: TFE-001
title: Coverage include glob excludes .tsx, hiding untested components from the gate
angle: test-frontend
severity: high
category: tooling
is_workaround: false
subsystem: vitest.config.ts / coverage
evidence:
  - vitest.config.ts:23
  - coverage/clover.xml
status: open
---

## What

The coverage config includes only `.ts`:

```ts
coverage: {
  provider: "v8",
  include: ["src/**/*.ts"],   // <- does NOT match *.tsx
  ...
}
```

`src/**/*.ts` does not match `.tsx` (picomatch treats `.tsx` as a different
extension). v8 coverage runs in `all` mode by default, which zero-fills files that
match `include` but were never imported by a test. Because component files are
`.tsx`, **a component that no test ever imports is never zero-filled — it simply
disappears from the coverage denominator instead of counting as 0%.**

Measured against the committed report: of 197 non-test `.tsx` source files, **23 do
not appear in the coverage report at all** because no test imports them. They incur
no 0% penalty, so the headline "79.7% statements" is a `.ts`-weighted figure, not a
whole-app one. (Imported-but-partially-tested `.tsx` files *do* appear — 174 of them
— so the effect is specifically to erase the fully-untested components.)

The 23 invisible components include core surfaces: `SplitView.tsx`,
`PanelDropZone.tsx`, the entire `RemoteDesktop/{Canvas,Tab,Toolbar,Overlay}.tsx`
render surface, `LogViewer.tsx`, `TerminalReconnectPrompt.tsx`, `TabGroupChips.tsx`,
`WorkspaceEditor.tsx`, `Sidebar.tsx`, `App.tsx` (see TFE-007 for the full list).

## Why it matters

The coverage gate is the release signal for "how much is tested", and it is
structurally blind to the highest-cost gap — a component with **no test at all**.
Adding a brand-new untested component does not lower the coverage %, so the ratchet
in the config comment ("Raise these as coverage improves") cannot catch the one thing
it most needs to catch. On a safety-critical release this is false confidence baked
into the tooling.

## Evidence

- `vitest.config.ts:23` — `include: ["src/**/*.ts"]`.
- `find src -name '*.tsx' ! -name '*.test.tsx' | wc -l` → 197 source components.
- Cross-referencing the 174 `.tsx` paths present in `coverage/clover.xml` leaves **23
  source components with no coverage entry** (they are never imported by a test).

## Recommendation

Change the include to cover both extensions:

```ts
include: ["src/**/*.{ts,tsx}"],
```

Then regenerate coverage and re-baseline the thresholds (they will drop as the 23
zero-fill in — that drop is the point). Consider also `all: true` explicitly for
clarity. After this, add per-file or per-directory floors (see TFE-011) so a single
0% component can't be masked by well-covered utils.

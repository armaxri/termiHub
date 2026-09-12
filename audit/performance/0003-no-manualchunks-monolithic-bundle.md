---
id: PERF-003
title: No code-splitting strategy — single monolithic entry bundle, all dialogs/tools eagerly imported
angle: performance
severity: medium
category: perf
is_workaround: false
subsystem: vite.config.ts, src/App.tsx
evidence:
  - vite.config.ts:18
  - src/App.tsx:1
status: open
---

## What
`vite.config.ts` configures no `build.rollupOptions.output.manualChunks` and the app makes
almost no use of `React.lazy` / dynamic `import()` for its heavy feature surfaces. `App.tsx`
statically imports ~50 modules including many dialogs and panels (CustomizeLayoutDialog,
RecoveryDialog, OverlayViewPanel, Settings surfaces, NetworkTools, etc.). Everything —
editor, terminal, all dialogs, network tools, workspace/embedded-server editors — lands in
one entry chunk that is downloaded, parsed and evaluated before first paint.

## Why it matters
A single large entry chunk is the classic Tauri/Electron cold-start tax: the whole feature
set is compiled at launch even though a session opens with an empty terminal and a sidebar.
Rarely-used, self-contained surfaces (network tools, workspace editor, tunnel editor,
recovery dialog, color picker, macro dialogs) are all resident from launch. It also hurts
cache efficiency: any app-code change invalidates the one big chunk, so returning users
re-download vendored libraries that never changed.

This compounds PERF-001 (Monaco/shiki) — those are the biggest offenders, but the absence of
any chunking strategy is the systemic issue.

## Evidence
- `vite.config.ts:18-19` — config object exposes only `plugins: [react()]`; no `build` key,
  no `manualChunks`.
- `src/App.tsx` — 50 static `import` statements including modal/panel components used only
  on demand (e.g. `CustomizeLayoutDialog`, `RecoveryDialog`, `OverlayViewPanel`).
- The only dynamic imports in `src/` are utility-level (`html-to-image`, `panelTree`, Tauri
  plugins) — no feature-level splitting.

## Recommendation
- Add `manualChunks` to split stable vendor libraries into their own long-lived chunks:
  `monaco-editor` + `@monaco-editor/react` + shiki; `@xterm/*`; the Radix/dnd-kit UI stack.
- Lazy-load on-demand surfaces with `React.lazy` behind their open triggers: NetworkTools,
  WorkspaceEditor, TunnelEditor, EmbeddedServer editors, the recovery/customize/macro
  dialogs. Each becomes a small chunk fetched on first use.
- Measure with a bundle visualizer before/after; the target is a small terminal-first entry
  chunk with heavy features split out.
</content>
</invoke>

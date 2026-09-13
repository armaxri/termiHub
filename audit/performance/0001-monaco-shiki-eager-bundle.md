---
id: PERF-001
title: Monaco + shiki are eagerly bundled into the main chunk via always-mounted SplitView
angle: performance
severity: high
category: perf
is_workaround: false
subsystem: src/components/FileEditor, vite.config.ts
evidence:
  - src/components/SplitView/SplitView.tsx:62
  - src/components/FileEditor/FileEditor.tsx:2
  - src/components/FileEditor/FileEditor.tsx:3
  - src/utils/monacoCustomLanguages.ts:27
  - src/utils/monacoCustomLanguages.ts:28
  - vite.config.ts:19
status: fixed
resolution: "#2812 — Monaco+shiki code-split out of entry via React.lazy/dynamic import; entry -48% raw/-50% gzip; FileEditor behavior preserved (removed harmful manualChunks)"
---

## What
The Monaco editor (`monaco-editor` meta package + `@monaco-editor/react`) and shiki
(`shiki`, `@shikijs/monaco`) are imported **statically** by `FileEditor.tsx`, which is
imported **statically** by `SplitView.tsx` — a core component mounted for the whole app
lifetime (it renders every terminal/editor panel). There is no `React.lazy`, no dynamic
`import()`, and `vite.config.ts` declares no `manualChunks`. As a result the entire Monaco
editor and shiki grammar/highlighter machinery are pulled into the app's main JS chunk and
parsed/executed at cold start, even for the overwhelmingly common case where the user only
ever opens terminals and never opens the file editor.

## Why it matters
`monaco-editor` imported as `import * as monaco from "monaco-editor"` brings the full
editor: all ~90 `basic-languages`, all editor features, and the worker glue. It is one of
the largest editor libraries in the ecosystem (multiple MB minified). shiki additionally
pulls its WASM oniguruma engine and grammar loading. Bundling both into the eagerly-loaded
main chunk directly inflates:

- **Cold start / time-to-interactive** — more JS to download, parse, compile, and evaluate
  before the first terminal is usable. This is the app's most common launch path and it
  pays the editor's full cost up front.
- **Memory** — the editor's module graph is resident from launch whether or not a file is
  ever opened.

The app already demonstrates the right pattern elsewhere (`html-to-image`, `panelTree`,
Tauri plugins are all dynamically imported), so this is an inconsistency, not a constraint.

## Evidence
- `src/components/SplitView/SplitView.tsx:62` — `import { FileEditor } from "@/components/FileEditor";` (static, in an always-mounted component).
- `src/components/FileEditor/FileEditor.tsx:2-3` — `import Editor, { loader } from "@monaco-editor/react";` and `import * as monaco from "monaco-editor";` (full editor).
- `src/utils/monacoCustomLanguages.ts:27-28,35` — static `import * as monaco`, `import { createHighlighter, bundledLanguages, bundledLanguagesInfo } from "shiki"`, `import { shikiToMonaco } from "@shikijs/monaco"`.
- `vite.config.ts:18-19` — only `plugins: [react()]`; no `build.rollupOptions.output.manualChunks`.

## Recommendation
- Lazy-load the editor: make `FileEditor` a `React.lazy(() => import("@/components/FileEditor"))`
  boundary in `SplitView`, so Monaco/shiki are code-split into their own chunk fetched only
  when the user first opens an editor/file tab. Wrap with `<Suspense>` and a lightweight
  loading state (the component already renders a loading view).
- Push the shiki highlighter setup (`monacoCustomLanguages.ts`) behind the same lazy
  boundary so its grammar/WASM load is deferred with the editor.
- Add explicit `manualChunks` in `vite.config.ts` to at least split `monaco-editor`,
  `shiki`, and `@xterm/*` into separate vendor chunks so a change to app code does not
  invalidate the (large, stable) editor chunk in cache, and so the terminal path never
  downloads the editor chunk.
- Verify the win by inspecting the production bundle (`pnpm build` + a bundle visualizer);
  target: the editor no longer appears in the entry chunk.
</content>
</invoke>

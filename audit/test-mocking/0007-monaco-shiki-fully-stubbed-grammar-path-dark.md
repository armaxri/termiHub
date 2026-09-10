---
id: MOCK-007
title: monaco-editor and shiki are fully stubbed in global setup; language registration + custom grammars are never exercised
angle: test-mocking
severity: low
category: test-gap
is_workaround: false
subsystem: src/test/setup.ts, editor/highlighting
evidence:
  - src/test/setup.ts:153
  - src/test/setup.ts:190
  - src/utils/monacoCustomLanguages.ts
status: open
---

## What
`src/test/setup.ts` globally replaces `monaco-editor` (`:153`), `shiki` (`:190`), and
`@shikijs/monaco` (`:211`) with `vi.fn()` stubs. The monaco stub returns a **hard-coded list
of language ids** and no-op `register`/`setMonarchTokensProvider`/`setLanguageConfiguration`;
the shiki stub returns a fixed `bundledLanguagesInfo` array and a highlighter whose
`loadLanguage` resolves to `undefined`.

Because the token providers and language registration are no-ops, the app's custom grammar /
Monarch-token code (`src/utils/monacoCustomLanguages.ts`, reported at ~2% branch in TFE-009)
is never actually run against a real monaco `languages` API in any test. The stub also
hard-codes the language list, so it drifts from whatever monaco/shiki actually bundle.

## Why it matters
- The editor's syntax-highlighting registration is exercised only against a fake that accepts
  any call and asserts nothing about the grammar. A malformed Monarch rule, a bad language
  configuration, or a shiki-id that no longer exists would pass CI and only fail in the real
  WebView.
- The hard-coded `getLanguages()` / `bundledLanguagesInfo` lists are hand-maintained mirrors of
  the real bundle; they will silently diverge on a monaco/shiki upgrade, so tests that filter
  or map over "available languages" test the fixture, not the library.

## Evidence
- monaco stub with fixed language list: `src/test/setup.ts:153-187`.
- shiki / @shikijs/monaco stubs: `src/test/setup.ts:190-213`.
- Custom-language code that the stub renders untestable: `src/utils/monacoCustomLanguages.ts`
  (2% branch per the frontend coverage audit).

## Recommendation
For the grammar-registration logic specifically, add a focused test that imports the **real**
monaco `languages` namespace (it works headless — it is a pure JS registry, no DOM/WASM) and
asserts each custom language registers without throwing and produces a tokenizer. Keep the
heavyweight editor/WASM stubbed for component tests, but do not let the *registration contract*
live entirely behind a no-op mock. Where the stubbed language list is used for assertions,
derive expectations from the same source the app reads rather than a duplicated literal.

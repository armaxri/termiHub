---
id: WA-FE-007
title: Diagnostic Shiki tokenization block (with `as any`) runs in production on every grammar load
angle: workaround-frontend
severity: low
category: workaround
is_workaround: true
subsystem: utils/monacoCustomLanguages
evidence:
  - src/utils/monacoCustomLanguages.ts:205
  - src/utils/monacoCustomLanguages.ts:208
  - src/utils/monacoCustomLanguages.ts:209
status: open
---

## What
After loading each custom grammar, the code runs a "Diagnostic" tokenization of the literal
string `"test"` purely to emit a `frontendLog` line, reaching the API through an `as any` cast
with a suppressed `no-explicit-any` lint:

```ts
// Diagnostic: tokenize a trivial test line to confirm Shiki can tokenize this language.
// Cast lang: custom IDs are not BundledLanguage but work at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const diag = (await (shikiHighlighter as any).codeToTokens("test", { lang: id, theme: MONACO_DARK_THEME })) ...
```

## Why it matters
- CLAUDE.md: "Remove debug logging before the final PR." This is debug/diagnostic instrumentation
  left in the shipping path — it runs an extra tokenization pass on every custom-grammar load.
- It carries an `as any` + lint suppression, coupling to Shiki's untyped custom-language behavior.

## Evidence
`src/utils/monacoCustomLanguages.ts:205-224` — the `try { codeToTokens("test", …) } catch` block
whose only effect is a `frontendLog` describing the produced tokens.

## Recommendation
Remove the diagnostic block for release (or gate it behind a debug-only flag). If a load-health
check is genuinely wanted, keep it but drop the `as any` by typing the custom-language id path
properly (Shiki's `codeToTokens` accepts a registered language string). Removing the block or the
`as any`+suppression is the signal.

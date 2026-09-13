---
id: ERR-008
title: Error surfaces are inconsistent and ephemeral — no single legible place a user finds "what went wrong"
angle: error-handling
severity: medium
category: ux
is_workaround: false
subsystem: src (error UX across toast / dialog / banner / console / LogViewer)
evidence:
  - src/components/ui/ErrorBoundary.tsx:44
  - src/components/FileEditor/FileEditor.tsx:1020
  - src/utils/classifyAgentError.ts:79
  - src/utils/frontendLog.ts:31
status: open
---

## What
A failure can surface in at least five different, uncoordinated ways depending on which code path hit it:

1. **`toast.error`** — 364 toast calls; the dominant path, but ephemeral (auto-dismisses, not recorded anywhere).
2. **Inline dialog / banner** — connection-failure classification renders a titled card (`classifyAgentError`), FileEditor renders a `saveError` banner, `AgentUpdateBanner` renders its own.
3. **`console.error`** — 5 sites (`ErrorBoundary.tsx:44`, `FileEditor.tsx:1020`, `ActivityBar.tsx:116`), invisible to users per repo policy.
4. **The LogViewer** — shows backend logs + frontend **DEBUG** breadcrumbs, but (per ERR-002) **never a frontend error**.
5. **Nothing** — the ~44 swallowed catches (ERR-002).

There is no through-line: the same failure class lands in different surfaces in different components, none of them durable, and the one surface the user can open and scroll back through (the LogViewer) is the one that never receives errors.

## Why it matters
- **No authoritative "error history."** A user (or a support session) cannot answer "what failed and why" after a toast has vanished. On a safety-critical product, transient toasts are not an adequate record of failure.
- **Inconsistent quality and actionability.** `classifyAgentError` produces genuinely good actionable copy for 6 known cases and dumps a raw string for everything else (`:79`, the `"unknown"` fallback). FileEditor shows a formatted banner. A swallowed catch shows nothing. Same product, wildly different error UX per surface.
- **Raw-string leakage risk.** The `"unknown"` fallback and the many `map_err(|e| e.to_string())` boundaries pass backend error strings straight to the UI; those strings interpolate paths and OS errors (e.g. `credential/os_keychain.rs:74` "Failed to read OS keychain entry for {key}", `ssh/auth.rs:251` "Failed to load key: {original_error}"). Not secrets today, but path/username disclosure in a toast is uncontrolled and unreviewed.

## Evidence
- 364 `toast.(error|success|...)` calls vs 5 `console.error` vs DEBUG-only `frontendLog` — three disjoint channels, no error log.
- `src/utils/classifyAgentError.ts:79` — raw backend string shown as the message on the `"unknown"` path.
- `src-tauri/src/credential/os_keychain.rs:74`, `core/src/backends/ssh/auth.rs:251` — error strings interpolate key names / paths that flow to the UI.

## Recommendation
Define one error-surface contract: (a) every user-facing failure emits **both** a toast/inline message *and* a durable `frontendError` LogViewer line (ERR-002); (b) route classification through the typed error envelope (ERR-003) so the *category* drives the surface (transient → toast, blocking → dialog, background → log-only) consistently; (c) sanitize/curate the display message so raw backend strings with paths are only in the log detail, never the headline. Make the LogViewer the single durable record of what went wrong.
</content>

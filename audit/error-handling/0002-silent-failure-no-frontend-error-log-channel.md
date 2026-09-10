---
id: ERR-002
title: Frontend has no ERROR-level log channel, so swallowed and console-logged failures are invisible to users
angle: error-handling
severity: high
category: reliability
is_workaround: false
subsystem: src/utils/frontendLog.ts, src (swallowed catches)
evidence:
  - src/utils/frontendLog.ts:31
  - src/components/ui/ErrorBoundary.tsx:44
  - src/components/FileEditor/FileEditor.tsx:1020
  - src/components/ActivityBar/ActivityBar.tsx:116
status: fixed
resolution: "#2727"
---

## What
Two independently-flagged frontend problems compound into one systemic gap:

1. **~44 async calls swallow their error** with `.catch(() => {})` / `.catch(() => null|[]|false)` (44 non-test sites; prior `workaround-frontend` WA-FE-005 and `ux-flows` 0033 counted ~40–45).
2. **`frontendLog` — the *only* sanctioned path into the user-visible LogViewer — hard-codes `level: "DEBUG"`** (`frontendLog.ts:31`). There is no `frontendWarn`/`frontendError`, and no component emits anything but DEBUG.

The consequence the prior threads did not draw: **there is no ERROR channel on the frontend at all.** When an error is *not* swallowed, it goes to `console.error` (5 sites: `ErrorBoundary.tsx:44`, `FileEditor.tsx:1020`, `ActivityBar.tsx:116`, plus two comments) — i.e. to the browser DevTools console, which the repo's own CLAUDE.md says **"is not accessible to the user."** So a frontend failure has exactly three fates, all invisible in-app: swallowed to nothing, logged to a console the user cannot open, or (best case) a one-shot `toast.error` that scrolls away and is never recorded. Nothing lands in the LogViewer the user *can* open.

There is also **no `window.onunhandledrejection` / `window.onerror` handler** (grep finds none), so any un-awaited `invoke` that rejects — and there are many fire-and-forget calls — disappears entirely.

## Why it matters
- **Diagnosis is impossible after the fact.** On a ventilator-grade product, "the reconnect silently didn't happen" or "the credential store call failed" must be reconstructable from an in-app log. Today it cannot be — the LogViewer only ever shows backend logs + frontend DEBUG breadcrumbs, never a frontend error.
- Several swallowed sites are **user-initiated destructive actions**, not best-effort teardown — see ERR-004-adjacent examples in ux-flows 0016/0017 (lying transfer controls, silent downloads) and OpenConnections "disconnect/close/cancel" (`OpenConnectionsModal.tsx:295,330,362,454,498`) where a failed kill leaves the connection alive with zero signal.
- The `frontendLog` startup-buffer design (buffers up to 500 pre-mount entries so DEBUG logs aren't lost) shows the authors *care* about not dropping diagnostics — yet the far more important error path drops everything.

## Evidence
- `src/utils/frontendLog.ts:31` — `level: "DEBUG"` is the only level emitted; no error/warn variant exists.
- `src/components/ui/ErrorBoundary.tsx:44` — a caught React render crash goes to `console.error` only, never to the LogViewer.
- 44 `.catch(() => {})`-style swallows (e.g. `OpenConnectionsModal.tsx:295/330/362/454/498`, `Terminal.tsx:1051/1505`, `hooks/useRemoteDesktopSession.ts:153`).
- No `unhandledrejection`/`window.onerror` listener anywhere in `src`.

## Recommendation
1. Add `frontendWarn` / `frontendError` to `frontendLog.ts` (level param), and route `ErrorBoundary`, `FileEditor` save-fail, `ActivityBar` import-fail, and every currently-swallowed *action* failure through it — keep the toast for user feedback, add a log line for the record.
2. Install a global `unhandledrejection` + `error` handler that logs to the same channel (and optionally shows a throttled toast). This is the single highest-leverage change: it catches the whole swallowed-catch class at once.
3. Audit the 44 swallows: keep truly best-effort teardown as `.catch(() => {})` but annotate why; convert action failures to logged + toasted. (References WA-FE-005, WA-FE-006, ux-flows 0033/0016/0017 — this finding is the unifying "no error channel exists" root cause.)
</content>

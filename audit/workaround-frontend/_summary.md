# Workaround audit — TypeScript/React frontend

Angle: **workaround-frontend** · Scope: `src/**` (TS/TSX/CSS), `index.html`, `vite.config.ts`,
`tsconfig*`, `eslint.config.js` · Method: static analysis + reading only (no builds, no git).

## Headline

The frontend is **notably clean of the loud markers** an auditor first hunts for: there are
**zero** production `TODO`/`FIXME`/`HACK`/`XXX`/`WORKAROUND` comments (all such hits are test
fixtures or the syntax-highlighter's `"e.g. TODO markers"` placeholder), **zero** `it.skip` /
`it.only` / `it.todo` / disabled tests, **zero** `@ts-ignore` / `@ts-expect-error`, **zero**
`eslint-disable` on whole files, and **no** commented-out code blocks or `if (false)` dead code.
The reducer-inversion cleanup (per project memory) landed thoroughly — the old client reconnect
engine and per-domain "instant-revert" fallbacks are gone for 10 of 11 domains.

The workarounds that remain are **semantic**, not marker-flagged: private-API reaching, a
non-functional shipped setting, systemic type-erasure casts, one domain's un-finished reducer
inversion, and a broad habit of swallowing async errors. None is a crash-on-common-path, but two
are release-relevant on the "ventilator-grade / no-workarounds" bar.

## Counts by severity

| Severity | Count |
| --- | --- |
| critical | 0 |
| high | 2 |
| medium | 3 |
| low | 7 |
| **total** | **12** |

All 12 are `is_workaround: true`.

## Findings index

| ID | Sev | Title |
| --- | --- | --- |
| WA-FE-001 | high | xterm.js private internals (`_core._renderService`) reached via `as any` for cell width |
| WA-FE-002 | high | Agent "Allow self-update" toggle + "Deferred" strategy shipped for an unimplemented feature (SI-8) |
| WA-FE-003 | medium | Systemic `config.config as unknown as Record<string, unknown>` type-erasure (~11 prod sites) |
| WA-FE-004 | medium | Layout domain still runs local reducers + optimistic overlay (reducer removal deferred, #2562) |
| WA-FE-005 | medium | ~40 async calls swallow errors with `.catch(() => {})` |
| WA-FE-006 | low | Production `console.error` instead of the mandated LogViewer/`frontendLog` |
| WA-FE-007 | low | Diagnostic Shiki tokenization block (`as any`) runs in prod on every grammar load |
| WA-FE-008 | low | Raw `z-index` magic numbers across ~20 CSS files instead of tokens |
| WA-FE-009 | low | 50ms `setTimeout` defers session teardown to survive React StrictMode double-mount |
| WA-FE-010 | low | `initialCommand` sent via arbitrary 200ms `setTimeout` after connect (shell-readiness race) |
| WA-FE-011 | low | `react-hooks/exhaustive-deps` suppressed at ~9 production sites |
| WA-FE-012 | low | `setInterval(100)` cancellation-polling instead of an abort signal in session waits |

## Highest-priority (most release-relevant)

1. **WA-FE-002 — non-functional self-update setting.** A user can toggle "Allow agent self-update"
   and pick a "Deferred" update strategy; both persist a preference the code admits "is not yet
   implemented." A control that silently does nothing is a trust defect on a safety-critical tool.
   Cheapest fix: hide the controls until SI-8 lands.
2. **WA-FE-001 — xterm private-API reach.** Terminal horizontal-scroll width depends on
   `(xterm as any)._core._renderService.dimensions.css.cell.width`. An xterm upgrade can break this
   silently (no compile error, unit tests mock xterm). Fragile coupling on a core render path.
3. **WA-FE-005 — swallowed `.catch(() => {})`.** ~40 sites, several on close/disconnect/
   remove-credential paths, hide failures with no log/toast — directly at odds with the "every
   action gives feedback" rule and the LogViewer debugging story, and it blinds leak investigations.
4. **WA-FE-003 — config type-erasure casts.** The schema-driven `config.config` is untyped, so
   ~11 sites double-cast through `unknown` (the banned-`any` escape hatch) to read `host`/flags —
   typos and schema drift are invisible to the compiler.
5. **WA-FE-004 — layout reducers not fully inverted.** The one domain still carrying dual paths
   (local reducer + optimistic overlay + region mirror), gated on #2562 — the last migration
   scaffolding, maintainer-gated but not something to ship permanently.

## Cross-cutting patterns

- **Silent-failure culture on async edges.** `.catch(() => {})` (WA-FE-005) + production
  `console.error` (WA-FE-006) + diagnostic logging left in (WA-FE-007) together mean several
  frontend failure modes never reach the user-visible LogViewer. This is the single most
  repeated theme and the one most worth a sweep.
- **Escape-hatch casts substituting for real types.** `as any` (WA-FE-001, 007) and
  `as unknown as` (WA-FE-003) appear wherever a third-party or schema-driven type is missing.
  Only ~2 bare `as any` and ~14 `as unknown as` in production — small enough to eliminate.
- **Timing guesses instead of signals.** 50ms StrictMode defer (WA-FE-009), 200ms initial-command
  (WA-FE-010), 100ms cancellation polls (WA-FE-012), the rAF `waitForUsableDimensions` loop — a
  cluster of wall-clock stopgaps around terminal lifecycle/sizing that would be better driven by
  events/abort signals.
- **Design-system token drift.** Raw `z-index` numerics (WA-FE-008) are the clearest violation of
  the "tokens only" rule that reached CSS; worth checking other token categories in the UI-audit
  angle.

## Notes / non-findings (verified clean)

- No skipped/only/todo tests; no `@ts-ignore`/`@ts-expect-error`; no whole-file eslint-disable;
  no `if (false)` / commented-out code; no hardcoded dev ports/URLs leaking into production
  (`127.0.0.1`/`ws://` hits are all in `src/testbridge/**`, which is test infrastructure).
- `src/utils/featureFlags.ts` and `src/utils/reconnectBackoff.ts` were read in full and are clean,
  well-designed code — not workarounds despite the "flag"/"backoff" names.

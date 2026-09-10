# Frontend "buy-vs-build" / library-usage audit — summary

**Angle:** is the frontend maintaining its own code for problems a mature, installed
(or well-established) library already solves? Focus on **under-used existing
dependencies** (highest payoff — no new dep, just use what is installed), genuine
reinvented wheels, and risky hand-rolled parsers on the safety path.

**Scope:** `src/**` (utils, hooks, services, parsing/formatting/validation),
cross-checked against `package.json` / installed deps. Read-only.

**Bottom line:** the frontend is, on the whole, **disciplined** about libraries — it
already pulls in `ulid`, `fast-json-patch`, `match-sorter`, `scslre`,
`react-colorful`, `@tanstack/react-virtual`, `@dnd-kit`, `shiki`, etc. rather than
hand-rolling those. The findings are mostly about **applying installed libraries /
shared helpers consistently** rather than adding anything new. Only one finding has
real correctness impact (collision-prone IDs).

## Findings index

| id | severity | title |
| --- | --- | --- |
| LIBFE-001 | medium | Consolidate hand-rolled ID generation on the already-installed `ulid` |
| LIBFE-002 | low | Duplicated byte / relative-time / duration formatters; consolidate (no new dep) |
| LIBFE-003 | low | Repeated hand-rolled `setTimeout` debounce; extract one shared hook |
| LIBFE-004 | info | Sidebar tree search uses substring match while `match-sorter` is installed |
| LIBFE-005 | info | Hand-rolled regex-source parser in `regexSafety` largely subsumed by `scslre` |
| LIBFE-006 | info | Roundup — hand-rolled code that should stay hand-rolled (no library warranted) |

## Hand-rolled area → candidate library → recommendation

| Hand-rolled area | Candidate library | Already a dep? | Recommendation |
| --- | --- | --- | --- |
| ID generation: 11+ `crypto.randomUUID`-fallback helpers + 5 `Date.now()`-only IDs | `ulid` (via existing `services/transport/ids.ts`) | **yes** | **adopt-installed** — one shared `newId()`; fix `Date.now()`-only IDs first (collision bug) |
| Byte-size formatting (`formatBytes` copied 3×) | `pretty-bytes` / `filesize` | no | **keep-as-is** — consolidate to the one shared helper; too small to warrant a dep |
| Relative-time / elapsed formatting (3 variants) | `Intl.RelativeTimeFormat` (built-in) / `date-fns` | built-in | **keep-as-is** — consolidate; optionally back with built-in `Intl` (zero dep) |
| Debounce via raw `setTimeout` (~10 sites; leaked-timer bug seen in tests) | `lodash.debounce` / `use-debounce` | no | **keep-as-is** — extract one internal `useDebouncedCallback` hook, no dep |
| Sidebar tree leaf-match (substring `.includes`) | `match-sorter` | **yes** | **adopt-installed** (low prio) — reuse for ranked/fuzzy leaf match; keep the tree-walk |
| ReDoS nested-quantifier structural check (`hasNestedQuantifier`) | `scslre` (analyzer) | **yes** | **keep for release**; candidate to simplify once a test proves scslre coverage is a superset |
| Reconnect exponential backoff + jitter state machine | `p-retry` / `exponential-backoff` | no | **keep-as-is** — pure, injectable, domain-specific, well-tested |
| `host:port` / IPv6-bracket parsing | WHATWG `URL` / parser lib | n/a | **keep-as-is** — `URL` can't parse bare host:port; small + correct |
| Filename → Monaco language id | `linguist-languages` | no | **keep-as-is** — Monaco-specific glue; different problem domain |
| Projection JSON patching | `fast-json-patch` | **yes** | already used correctly — emulate elsewhere |

## Top opportunities, ranked by payoff

1. **LIBFE-001 — Consolidate IDs on `ulid` (use a dep we already have).** Highest
   payoff. Removes 11+ duplicated `randomUUID`-fallback helpers and, more
   importantly, kills a **real duplicate-key data-integrity risk**: five creation
   paths (`folder-${Date.now()}`, `conn-${Date.now()}`, `agent-${Date.now()}`) use a
   bare millisecond timestamp with no random suffix, so two entities created in the
   same millisecond collide. `ulid` is installed and already wrapped in
   `services/transport/ids.ts`. Fix the bare-timestamp sites first.
2. **LIBFE-004 — Route sidebar tree search through `match-sorter` (already installed).**
   No new dep; brings the connection/agent sidebar search up to the same ranked,
   forgiving matching the Command Palette already ships, for UX consistency.
3. **LIBFE-002 / LIBFE-003 — Consolidate formatters and debounce into shared
   in-house helpers.** No new dependency justified; the value is removing duplication
   and the leaked-timer failure mode (which the test harness already has to defuse).

## Release-relevance / risk notes

- **Only LIBFE-001 has correctness (data-loss) impact** and is release-relevant: the
  `Date.now()`-only IDs can silently overwrite a saved connection/folder/agent.
- **LIBFE-005 is on a security path** (ReDoS validation of user regex) but the code
  is *safe today* — it uses `scslre` correctly and the hand-rolled layer is
  defense-in-depth. Flagged only as a post-release simplification candidate; do not
  remove a protection layer under release pressure.
- Nothing here is a `is_workaround: true` stopgap — these are design/consistency
  choices, not disabled checks or hidden hacks.

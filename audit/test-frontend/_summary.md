# Frontend test coverage & testability — audit summary

**Angle:** test-frontend · **Id prefix:** TFE · **Date:** 2026-09-10

## Overall posture

The frontend has a **large, disciplined test suite**: 568 test files, a shared
`src/test/` harness kit (region harnesses, `flushAsync`), sensible global jsdom
shims, and a coverage gate wired into `vitest.config.ts`. Zero tests are
`.skip`/`.only`/`todo`, fake timers are consistently restored, and the highest-risk
*pure* modules are genuinely well-covered (see "What's good"). This is well above
the bar for most apps.

But for a **safety-critical** release the picture has real holes, and — more
importantly — **the coverage number overstates how much is actually tested.** The
committed coverage report (`coverage/clover.xml`, dated **2026-07-30**, ~6 weeks
stale) shows **statements 79.7% / branches 71.5% / functions 74.6%**. Two structural
issues make that headline optimistic:

1. **The coverage `include` glob is `src/**/*.ts` — it does not match `.tsx`.** With
   v8 `all`-mode, `.tsx` files **that no test ever imports** are never zero-filled,
   so they vanish from the denominator instead of counting as 0%. **23 component
   `.tsx` files have zero tests and are entirely invisible to the gate** — including
   `SplitView.tsx`, `PanelDropZone.tsx`, the whole `RemoteDesktop/` render surface,
   `LogViewer.tsx`, `TerminalReconnectPrompt.tsx`, `WorkspaceEditor.tsx`,
   `Sidebar.tsx`. (TFE-001, TFE-007)
2. **Branch coverage on the two most dangerous modules is ~half.** `Terminal.tsx`
   (1733 LOC, the connect/reconnect state machine) is **46% branch / 62% line**;
   `appStore.ts` (the god store, 2271 stmts) is **66% branch**; `services/api.ts`
   (the 2472-LOC IPC layer) is **48% branch / 46% line**. The untested branches are
   overwhelmingly the **error/rejection/edge paths** that matter most on a
   ventilator-grade release.

**Release-adequate?** **Not yet, as measured.** The breadth is good but the gate is
fooling itself on components, and the three modules carrying the most
reconnect/connection risk are the least-covered by branch. None of this is a
blocker to *ship a beta*, but the coverage tooling should be fixed (TFE-001) before
anyone trusts the % as a release signal, and the Terminal state machine (TFE-002)
should be made unit-testable before the reconnect inversion is declared done.

## Coverage-by-risk map (as of the committed 2026-07-30 report)

| Critical area | Module(s) | Line / Branch | Test state |
|---|---|---|---|
| Terminal connect/reconnect state machine | `Terminal/Terminal.tsx` (1733 LOC) | 62% / **46%** | Component-level only, via effects; xterm fully mocked | 
| God store — actions & error paths | `store/appStore.ts` (2271 stmts) | 82% / **66%** | Broad but error branches thin |
| IPC command layer | `services/api.ts` (2472 LOC) | **46% / 48%** | ~46/73 wrappers tested, assert-on-mock only |
| Tauri event fan-out | `services/events.ts` | 64% / 77% | Partial |
| Projection mirror / optimistic fold | `useProjected*`, `*MutationCut`, `*RenderCut` | good | 13 dedicated suites — solid |
| ReDoS / regex safety | `services/regexSafety.ts` | 96% / 87% | **Strong** (structural + scslre) |
| DynamicForm + validation | `DynamicForm/*`, `settingsSchemaToZod.ts` | 95–100% | Good |
| Credential UI / unlock | `ensureCredentialStoreUnlocked`, `resolveConnectionCredential` | 100% | Good |
| SSH key path input | `Settings/KeyPathInput.tsx` | 40% / **21%** | Weak (security-adjacent) |
| File-system hooks | `useSessionFileSystem` 8%B, `useLocalFileSystem` 37%B, `useFileSystem` 37%B | low | **Under-tested** |
| Store slices | `embedded-serversSlice` 10%B, `tunnelSlice` 26%B, `pluginsSlice` 67%B | low | Under-tested |
| Layout / split view | `SplitView.tsx`, `PanelDropZone.tsx` | **untested tsx** | 0 tests (panelTree.ts logic is 90% though) |
| Remote desktop surface | `RemoteDesktop{Canvas,Tab,Toolbar,Overlay}.tsx` | **untested tsx** | Only `CertPrompt` tested |
| Editor grammar | `utils/monacoCustomLanguages.ts` | 8% / **2%** | Near-zero |
| Accessibility regression | — | — | **No axe/automated a11y net** |

## Systemic test-quality issues

- **Coverage measurement lies on components** (TFE-001) — the single most important
  finding: the gate cannot see 23 untested components, so "79.7%" is a `.ts`-weighted
  number, not a whole-app one.
- **Logic entangled with rendering blocks unit testing** (TFE-002) — `Terminal.tsx`
  puts a ~450-line connect/reconnect state machine inside `useEffect`s. Every
  transition can only be reached by mounting the component and elaborately mocking
  the store/api/sessionBridge. There is no pure state-machine module to unit-test, so
  branch coverage is stuck at 46% and the reconnect edge cases (the app's headline
  reliability feature) are the least-tested part of the tree.
- **xterm is fully faked, hiding real integration breaks** (TFE-003) — the mock
  `MockXTerm` has no `_core`, yet `Terminal.tsx:169` reaches into
  `(xterm as any)._core?._renderService?.dimensions?.css?.cell?.width`. No test ever
  exercises that path, so an xterm upgrade that renames the private field degrades
  silently to `undefined` with green CI.
- **Assert-on-mock for the IPC layer** (TFE-004) — `api.test.ts` verifies `invoke`
  was called with the right args but never that the response is decoded/validated;
  half the command surface has no test at all.
- **No automated accessibility net** (TFE-012) — no `jest-axe`/`vitest-axe`; roles are
  only queried incidentally. Nothing fails when a label/role regresses.
- **Committed coverage artifact is stale** (TFE-010) — `coverage/` is 6 weeks old and
  used as a source of truth; it should be regenerated in CI, not committed.

## What's good (keep, don't regress)

- `regexSafety.ts` — deterministic ReDoS defence with dedicated tests (safety-relevant, done right).
- `appStore.storeErrorSurfacing.test.ts` — locks in that catch-blocks log + toast instead of swallowing (directly addresses the swallowed-error class).
- 13 projection-mirror / mutation-cut / render-cut suites — the inversion architecture is genuinely tested.
- Region harnesses in `src/test/` — reusable, reduce per-test mocking boilerplate.
- Zero skipped/only tests; fake timers restored everywhere; documented jsdom shims.

## Findings index (ranked by release risk)

| Id | Sev | Title |
|---|---|---|
| TFE-001 | high | Coverage `include` glob excludes `.tsx`, hiding 23 untested components from the gate |
| TFE-002 | high | Terminal connect/reconnect state machine is untestable (46% branch, logic inside effects) |
| TFE-005 | high | God store `appStore.ts` error/rejection branches ~1/3 untested (66% branch) |
| TFE-003 | medium | xterm fully mocked; private `_core` render path never exercised (silent-break risk) |
| TFE-004 | medium | IPC layer `api.ts` half-untested and assert-on-mock only (no response validation) |
| TFE-006 | medium | Store slices under-tested: embedded-servers 10%B, tunnel 26%B, plugins 67%B |
| TFE-007 | medium | 23 component `.tsx` files have zero tests (SplitView, RemoteDesktop surface, LogViewer, …) |
| TFE-008 | medium | File-system hooks nearly untested (useSessionFileSystem 8%B, useLocalFileSystem/useFileSystem 37%B) |
| TFE-012 | medium | No automated accessibility regression net (no axe) |
| TFE-009 | low | Isolated near-zero modules: monacoCustomLanguages 2%B, KeyPathInput 21%B |
| TFE-010 | low | Committed `coverage/` report is 6 weeks stale and used as source of truth |
| TFE-011 | info | Coverage thresholds are a loose ratchet; no per-file floor lets a 0% critical module hide |

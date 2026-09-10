# Frontend — components / services / transport (angle: frontend-components)

Expert: senior frontend engineer (React/TypeScript). Scope: `src/components/**`
(logic), `src/services/**` (esp. `transport/`), `src/hooks/**`, `src/utils/**`,
`src/types/**`, `src/plugins/**` (sandbox host), `src/testbridge`. Focus:
component/service **code correctness** — effects/lifecycle, leaks, hook
correctness, TypeScript rigor, transport correctness — at a safety-critical bar.
Store/state, UX, visual, and a11y are covered by other experts and not re-filed
here.

## Overall assessment

The component/service layer is, on the whole, **carefully written**: async
effects almost universally use `canceled`/`disposed` guards, refs are used
deliberately to dodge stale closures, event-listener cleanup is symmetric in the
resize/keyboard hooks, and the projection transport (`ProjectionClient`) and the
`TerminalOutputDispatcher` are genuinely well-engineered (ordered optimistic
folds, generation-guarded init, bounded pre-subscribe buffers). There is no
scattered `any`, and most `exhaustive-deps` suppressions are justified and
commented.

The problems are concentrated, not diffuse, and fall into a few systemic
patterns:

- **Silent failure on user actions.** The strongest defects are places where a
  mutating action can fail with no feedback and, worse, discard data:
  FileEditor "Save & Close" closing a tab after a save that didn't happen
  (FEC-010), TransferQueue pause/cancel/retry showing success even on IPC
  rejection (FEC-004), and a load effect that can clobber unsaved edits
  (FEC-011). ~37 `.catch(() => {})` sites on close/cancel/disconnect paths hide
  real session-release failures (FEC-009).
- **Coupling to third-party internals + magic timing.** The Terminal reaches
  into xterm privates via `as any` (FEC-001) and leans on polled-boolean
  cancellation (FEC-002), fixed `setTimeout` for command timing (FEC-003) and
  StrictMode-defer close (FEC-014). These are all downstream of one root cause:
  the connection state machine is a ~700-line async function inside a component
  effect that can't be unit-tested (FEC-016).
- **Per-component global event listeners on hot paths.** RemoteDesktop re-does
  the exact O(N) fan-out the terminal path was refactored away from — every tab
  listens to every framebuffer event (FEC-005) — and the dispatcher carries dead
  remote/agent-state listeners nobody consumes (FEC-006).
- **Type escape hatches at the IPC boundary.** `ConnectionConfig.config` is
  untyped, forcing ~25 `as unknown as Record<string,unknown>` double-casts and
  an unvalidated `as unknown as RemoteAgentConfig` (FEC-008).
- **Async-registration and watch teardown races** (FEC-013, FEC-017) leak OS
  watchers / listeners on fast unmount, and the second `Transport` impl diverges
  from the first (FEC-007).

Nothing here is a crash-on-common-path, but the data-loss and silent-failure
items (FEC-010, FEC-004, FEC-011, FEC-009) are the ones that matter for a
ventilator-grade release, and the Terminal monolith (FEC-016) is the structural
reason its correctness is hard to verify.

## Findings (ranked)

| id | sev | title |
|----|-----|-------|
| FEC-010 | high | FileEditor "Save & Close" discards unsaved edits when the save didn't succeed |
| FEC-001 | high | Terminal reaches into xterm.js private internals for cell width (`as any`) |
| FEC-004 | high | TransferQueue pause/resume/cancel/retry show success even when the IPC call fails |
| FEC-016 | medium | Terminal connection state machine is a ~700-line async function inside an effect |
| FEC-011 | medium | FileEditor load effect can re-fire and overwrite unsaved edits (no dirty guard) |
| FEC-005 | medium | RemoteDesktop registers per-component global Tauri listeners on the frame hot path |
| FEC-002 | medium | Terminal connect/retry polls a boolean every 100 ms instead of an abort signal |
| FEC-003 | medium | Initial command sent on a fixed 200 ms setTimeout after connect |
| FEC-008 | medium | `ConnectionConfig.config` untyped → ~25 `as unknown as` casts across the frontend |
| FEC-009 | medium | ~37 `.catch(() => {})` swallow IPC failures on disconnect/close/cancel paths |
| FEC-012 | medium | TerminalSlot RAF-path adoption never parks the xterm element back |
| FEC-013 | medium | `watchLocalFile` start races its unwatch teardown, leaking an OS watch |
| FEC-006 | low | Dispatcher remote/agent-state listeners are dead; single-callback maps last-writer-wins |
| FEC-007 | low | WebSocketTransport allows one subscriber per region; notification listener never torn down |
| FEC-014 | low | Session teardown deferred by fixed `setTimeout(50)` for StrictMode |
| FEC-015 | low | `useTauriEvents` is a dead "Phase 2" stub hook |
| FEC-017 | low | `useTransferEvents` async listener setup has no disposed-guard; module timer not cleared |
| FEC-018 | low | SplitView: fire-and-forget clipboard write, zoom double-mounts one Monaco model, unchecked dnd casts |
| FEC-019 | low | ConnectionSettingsForm `isResetting` flag can swallow a genuine first edit |
| FEC-020 | low | Plugin sandbox watchdog spreads all keys into `Math.min`; worker has no error handler |

## Workarounds flagged (`is_workaround: true`)

FEC-001, FEC-002, FEC-003, FEC-009, FEC-014, FEC-015, FEC-019 — plus the
in-code workarounds noted within them (RHF value-cache clearing in FEC-019, the
degenerate-fit guards and parking dance in Terminal referenced by FEC-016).

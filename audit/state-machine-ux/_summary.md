# State-machine + UX-state correctness audit

**Angle:** state-machine-ux · **ID prefix:** `SM` · **Scope:** the stateful subsystems whose
correctness is user-visible — connection/session lifecycle, remote-agent lifecycle, credential
store, SSH tunnels, SFTP/file-transfer queue, remote system monitoring, HTTP monitor, embedded
servers, and workspace/layout save-restore. Compared the hand-written reference specs in
`docs/audits/*state-machine*.md` (July snapshots) and real-world needs against the **current**
implementation in `src/store`, `src/hooks`, `src/components`, `src-tauri/src` projections, and
`core/src`.

**Findings:** 29 (1 critical · 8 high · 9 medium · 10 low · 1 info)

## Method note — the specs are stale (SM-029)

The eight `docs/audits` state-machine docs are historical audit snapshots of a *pre-refactor*
codebase. Since they were written, every subsystem was rebuilt onto a shared `core/` `Service`
trait + server-authoritative **projection regions**, and the large majority of the documented
gaps are already **fixed or removed** — several spec "facts" are now inverted. So this audit
reconstructs the *actual* state graph per subsystem from code and reports only the **residual
live defects**, plus the cross-cutting structural issues the specs never covered. Do not action
the old spec gap lists.

## Per-subsystem state-correctness scorecard

| Subsystem | Modeled well | Residual gaps / stuck-state risk | Findings |
|---|---|---|---|
| **Connection/session lifecycle** | 6-state region machine, cancellable reconnect, backoff engine, cold-start on restart | **Highest risk area.** Overloaded `Reconnecting` has an Idle regime with **no timer and no timeout** → genuine no-exit stuck state; cancel-vs-recover unguarded on the agent path; no auth-failed/host-key states; phantom-session resurrection; client deadline fights backend reconnect | SM-001, SM-002, SM-004, SM-005, SM-006, SM-011 |
| **Remote-agent lifecycle** | Cancel, self-reap of zombies, Open-Connections visibility, single-writer, deploy/setup cancel — old G1–G10 all fixed | `degraded`/`reaped` not modeled (behavior only); tab-dot blind to session-lost (shared with session) | (covered by SM-011, SM-020) |
| **Credential store** | Locked/Unlocked/Unavailable + typed WrongPassword/Corrupt + reset; idempotent unlock; toasts — old G1–G8 fixed | Auto-lock ignores terminal activity → locks under a long interactive session | SM-010 |
| **SSH tunnels** | 5 states all reachable; supervisor detects silent death; Error is a resting state; double-fire guards — old GAP1–9 fixed | Dead event-wrapper residue from the migration | SM-009 |
| **SFTP / transfer queue** | First-class 6-state transfer machine (cancel/pause/progress); session-scoped browser; atomic teardown — old L/S/D fixed | Navigation applies **stale list responses** (no request-seq guard); failed-listing has no Retry control | SM-007, SM-008 |
| **Remote system monitoring** | Live/Stale/Reconnecting/Offline/Paused; keyed by session; retry control — old G1–G10 mostly fixed | **Agent-mediated path has none of it** — stale data shows as live forever; Pause is a silent no-op; `Reconnecting` un-dims data (no UI mapping) | SM-012, SM-013, SM-014 |
| **HTTP monitor** | Persisted across restart; up/down toasts; pause/resume; stop≠delete; Open-Connections group — old #1–#11 mostly fixed | No failure backoff + drifting poll period; no server-side URL dedupe | SM-015, SM-019 |
| **Embedded servers** | Confirmed-bind Running; Error recoverable; stats polled — old G1–G9 fixed | `Stopping` never emitted → Stop-then-Start port TOCTOU; **absent from Open Connections**; manual Start lacks the port-fallback quick-share has | SM-016, SM-017, SM-018 |
| **Workspace save/restore** | Teardown-before-restore, in-flight guards, restore-cohort region + one summary toast, atomic writes — old G1–G7 fixed | Session-history write non-atomic; version field never read / no migration; corrupt last-session swallowed; two instances clobber shared files | SM-021, SM-022, SM-023, SM-025 |
| **Layout domain (#2562)** | — | Half-migrated hybrid: local reducer + optimistic overlay. **Freezes on a stale tree** when compose returns null; rollback leaves non-layout fields committed; ownership supersede is silent; docs describe a removed safety net | SM-024, SM-026, SM-027, SM-028 |
| **Cross-cutting** | — | Reconnect modeled 3+ inconsistent ways (4-state vs 6-state vs untyped map) with drifting retry caps/vocab; multi-desktop shared-status invariant violated by tab-id keying; specs stale | SM-003, SM-020, SM-029 |

## Top issues ranked

1. **SM-001 (critical)** — `Reconnecting(phase=Idle)` is a **no-exit state**: when an agent
   transport reconnects but the follow-up `connection.list` returns `None`, hosted tabs are
   never resolved. No timer, no frontend timeout, no fold → the terminal shows "Reconnecting…"
   forever; only manual Stop escapes. The exact stuck-Reconnecting class the release must kill.
2. **SM-012 (high)** — agent-mediated system monitoring hardcodes `Live` and never updates, so
   a mid-stream drop **freezes CPU/mem as if live permanently** (data-integrity on the
   monitoring surface; the code admits it's a deferred stub).
3. **SM-011 (high)** — the tab-strip status dot renders from an untyped `remoteStates` map that
   is **blind to `SessionLost`/`Failed`**; a lost session shows green/"connected". The compact
   indicator lies.
4. **SM-024 (high)** — the half-migrated layout domain (#2562) **freezes on a stale panel tree**
   with no user-visible error when the region references a tab absent from `tabContent`.
5. **SM-003 (high)** — the session region claims cross-desktop shared status but is keyed by
   per-window tab id, so daemon single-attach eviction leaves two desktops **permanently
   disagreeing** (one stuck reconnecting on a silently-stolen session).

Also high: **SM-002** (user-stopped tab silently resurrects — no cancel guard on the agent
recover fold), **SM-005** (no auth-failed/host-key states → doomed retry loops + host-key
prompts aborted by the connect deadline), **SM-020** (reconnect modeled 3+ inconsistent ways —
the structural root behind SM-011/SM-014), **SM-025** (two instances clobber the shared
session/workspace files — cross-instance data loss).

## Cross-cutting recommendation

The single highest-leverage structural fix is **SM-020 / SM-011**: converge every per-session
status onto the authoritative `session-lifecycle` region (one vocabulary, one backoff engine)
and retire the untyped `remoteStates` map. That removes the lying tab-dot (SM-011), gives
monitoring `Reconnecting` a home (SM-014), and stops each reconnect fix from having to be
written N times. Then complete the #2562 layout migration (SM-024/SM-027) and add a written
session-lifecycle spec (SM-029) so the invariants stop drifting from the code.

# Observability, Logging & Diagnostics — audit summary

**Angle:** observability / logging / diagnostics
**Date:** 2026-09-10
**Overall read:** *Partially field-supportable.* The **backend** has a genuinely good,
post-mortem-grade logging foundation (durable rotating file, secret-safe filters, in-app
LogViewer). But the **frontend and agent tiers are observability dead zones**: UI-side
failures — including the ~40 swallowed-error paths other experts found — never reach the
durable log and vanish when the window closes, panics/crashes leave no trace, and there is
no way to trace one session across the three processes. A supporter handed the shipped
`termihub.log` today would see the backend's side of a failure and nothing of what the user
actually saw.

---

## What is solid (build on it, don't rebuild)

- **Durable rotating file log** (`src-tauri/src/utils/file_log.rs`, #1570). Synchronous
  writes (survives SIGKILL/jetsam), size-capped (5 MiB × 3 = 15 MiB hard ceiling),
  platform-conventional location, startup banner records version + pid. This is
  well-designed and well-tested.
- **Secret hygiene in backend logs is careful.** Credential commands log `connection_id` +
  `credential_type`, never the value (`src-tauri/src/commands/credential.rs`). The file
  sink hard-clamps `russh=warn` even under a `TERMIHUB_FILE_LOG` override
  (`RUSSH_CLAMP`), so SSH packet/cipher internals can never reach a pasted log by accident.
- **In-app LogViewer** (`src/components/LogViewer/`) with level filters, search, copy, and
  save-to-file — a real diagnostics surface the user can reach without DevTools.
- **Failure-path coverage is decent in several backend areas:** transfer failure
  (`files/transfer/mod.rs:420`, WARN + transfer_id + error), agent reconnect attempts
  (`terminal/agent_manager.rs:2248-2668`, per-attempt WARN/ERROR), session close
  (`session/manager.rs:1136`), X11 forwarding (`backends/ssh/x11.rs`).

## Log-coverage map of the named failure modes

| Failure mode | Durable log? | Enough context? | Finding |
| --- | --- | --- | --- |
| Connect / auth failure (backend) | yes (file, INFO+) | host/id present | ok |
| Reconnect stall (agent) | yes, per-attempt WARN | agent_id, cause | ok |
| Session drop / close (direct) | yes, INFO | session_id | ok |
| **Session eviction across desktops (agent side)** | **no log** | — | OBS-012 |
| Transfer failure | yes, WARN | transfer_id, error | ok |
| **Teardown failure (UI-triggered)** | **frontend-only → lost** | — | OBS-001 |
| Credential-store partial migration | **DEBUG only / unlogged** | warnings dropped | OBS-007 |
| Plugin load failure | yes, WARN (`lib.rs:564`) | names | ok |
| Agent update | yes, INFO/WARN | host counts | ok |
| **~40 swallowed frontend errors** | **frontend-only or nowhere** | — | OBS-001 / OBS-005 |
| **Panic / crash (any tier)** | **no** | no backtrace | OBS-002 |
| SSH env-var apply failure | **swallowed, no log** | — | OBS-006 |

## Structure & correlation

Ad-hoc, not structured. Backend uses `tracing` well but leans on interpolated strings
(`"Agent {}: ..."`) more than structured fields, and there is **no correlation id** that
threads one session across frontend → backend → agent (OBS-004). No spans. A supporter
cannot reconstruct "what happened to session X" end-to-end.

## Frontend↔backend↔agent unification

Broken at both seams. **Frontend logs never cross into the backend** — `frontendLog` is a
pure in-JS pub/sub (`src/utils/frontendLog.ts`); nothing forwards it to the Rust tracing
pipeline, so the durable file contains zero frontend events and the `frontend=debug`
directive is effectively dead config (OBS-001). **Agent logs** reach the desktop only for
the interactive stdio channel (captured as WARN line-by-line, `agent_manager.rs:2196`);
`--daemon`/`--listen` agents log to stderr on the *remote* host with no file and no
rotation, unreachable by support (OBS-003).

## Log management

File level fixed at INFO (tunable only via undocumented `TERMIHUB_FILE_LOG` env var);
LogViewer/ring-buffer level via `RUST_LOG` only. No in-UI verbosity control (OBS-009).
Rotation & size cap are good. Export is manual copy/save of the in-memory buffer only, with
no redaction pass and no capture of the frontend entries lost on close (OBS-008).

## Diagnostics UX

Weak. Version appears only inside Update Settings; there is no About panel and no
one-click "copy debug info" (version + OS + log path + recent logs) for a bug report
(OBS-008). Log-file locations are documented only in `docs/testing.md`, not user-facing
docs/README (OBS-011).

## Crash reporting / telemetry

None of either. No `panic::set_hook`, and `[profile.dev] debug = 0` strips file/line from
backtraces (OBS-002). No telemetry/crash crates (sentry/breakpad/opentelemetry absent) —
a defensible privacy posture, noted as OBS-010 for a deliberate opt-in decision.

---

## Top gaps, ranked

1. **OBS-001 (high)** — Frontend logs are never durable; LogViewer is in-memory and dies
   with the window. The file a user pastes into an issue has **zero** UI-side signal.
2. **OBS-002 (high)** — No panic/crash capture anywhere; a crash leaves no durable trace
   and `debug=0` removes backtrace line info.
3. **OBS-005 (medium)** — Production `console.error` (ErrorBoundary React-crash path,
   FileEditor, ActivityBar) bypasses LogViewer *and* file — invisible to user and support.
4. **OBS-004 (medium)** — No correlation id / spans to trace one session across the three
   processes.
5. **OBS-003 (medium)** — Agent has no durable log and its logs don't reach support for
   daemon/listen roles.

## Finding index

- OBS-001 — Frontend logs never reach the durable file or backend (in-memory only)
- OBS-002 — No panic/crash reporting; backtraces stripped of line info
- OBS-003 — Agent has no durable log; agent logs don't reach support
- OBS-004 — No correlation id / spans across frontend↔backend↔agent
- OBS-005 — Production `console.error` bypasses LogViewer and file log
- OBS-006 — SSH env-var apply failures silently discarded, no log line
- OBS-007 — Credential-store migration failures logged only at DEBUG / not at all
- OBS-008 — No diagnostics / "copy debug info" surface; export has no redaction
- OBS-009 — No in-UI log-level control; file verbosity only via undocumented env var
- OBS-010 — No crash reporting or telemetry (privacy posture; consider minimal opt-in)
- OBS-011 — Log locations/troubleshooting only in testing docs, not user-facing
- OBS-012 — Agent cross-desktop session eviction has no diagnostic log

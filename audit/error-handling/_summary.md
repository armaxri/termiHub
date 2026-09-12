# Error handling & edge cases — audit summary

**Angle:** error-handling · **ID prefix:** `ERR` · **Scope:** whole tree, both stacks — Rust
error types/propagation (`core`, `src-tauri`, `agent`) and frontend error handling (`src/`),
plus the error surfaces (toasts, LogViewer, dialogs, banners). This is a **synthesis lens**: it
unifies the error-handling threads other experts surfaced (`workaround-rust`, `workaround-frontend`,
`backend-core-rust`, `backend-tauri-rust`, `ux-flows`, `state-machine-ux`, `concurrency-reliability`)
into two systemic taxonomies and adds the cross-cutting reads none of them owned.

**Findings:** 10 (0 critical · 4 high · 5 medium · 1 low)

| ID | Sev | Title |
| --- | --- | --- |
| ERR-001 | high | ~297 lock-poison unwrap/expect panic sites, applied backwards vs the new poison-recovering stores |
| ERR-002 | high | Frontend has no ERROR-level log channel — swallowed & console-logged failures are invisible to users |
| ERR-003 | high | Error type/variant erased at every IPC boundary; frontend re-derives category by matching English substrings |
| ERR-004 | high | Startup `.expect()` on config-dir creation crashes the app at launch, contradicting its own fallback comment |
| ERR-005 | medium | Agent network diagnostics panic via `Arc::try_unwrap().unwrap()` if a result-collector clone survives |
| ERR-006 | medium | `spawn_blocking` join `.expect()` re-panics on the async side, amplifying blocking-path panics |
| ERR-007 | medium | SSH env-var / X11-forward failures silently discarded with `let _ =` (configured feature becomes a no-op) |
| ERR-008 | medium | Error surfaces inconsistent & ephemeral — no single legible place a user finds "what went wrong" |
| ERR-009 | medium | Boundary / resource-exhaustion — unbounded/untyped allocation on untrusted input (OOM abort) |
| ERR-010 | low | No release `overflow-checks` — arithmetic that panics in tests silently wraps in shipped builds |

---

## The panic taxonomy

Reachable panic classes, by trigger source and blast radius. Panics **unwind** (no `panic = "abort"`
in any profile — good), so a single panic does not `abort()` the whole process by default; the
exception is **OOM**, which aborts. There is **no global panic hook, no telemetry, and no
`catch_unwind` around Tauri command futures or spawned tasks** (the only `catch_unwind` in the tree
wraps plugin FFI). The frontend *is* protected — a whole-app `ErrorBoundary` + per-panel
`PanelErrorBoundary` contain React render crashes (but log only to `console.error`, ERR-002/008).

| Class | Representative sites | Reachable from | Blast radius |
| --- | --- | --- | --- |
| **Poisoned `std::sync` locks** | ~297 `.(lock\|read\|write)().(unwrap\|expect)()` — 212 src-tauri, 52 core, 33 agent (ERR-001) | any prior panic under the lock (i.e. a *cascade*), incl. from remote/hostile input | **Whole subsystem** — session/credential/connection managers; every later access panics |
| **Startup `.expect()`** | `lib.rs:488/505/506` config-dir (ERR-004) | read-only/locked/full config dir, portable-on-read-only-media | **Whole app** — crash at launch, no UI |
| **`Arc::try_unwrap().unwrap()`** | `agent/src/network/mod.rs:50/71/107` (ERR-005) | user-run port-scan/ping/traceroute on an agent (timing-dependent) | Agent task → can drop the client transport loop |
| **`spawn_blocking` join `.expect()`** | `ssh_auth.rs:122`, `remote_exec.rs:618` (ERR-006) | any panic inside blocking SSH auth/exec | Command future re-panics + may poison SSH locks |
| **Unbounded alloc → OOM abort** | NDJSON no line cap (CORE-002), VNC server dims (CORE-008), remote reads/TFTP/zip (ERR-009) | remote agent, hostile VNC/SSH server, crafted plugin | **Whole process/agent** — abort, uncontainable |
| **Lossy `as` truncation / overflow** | `port as u16` (CORE-006), TFTP block (CORE-023); no release overflow-checks (ERR-010) | boundary/adversarial numeric input | Silent corruption in release; panic in test |

The single worst structural fact: **the poison-recovery discipline is applied backwards.** The new
projection stores (29 sites) survive poisoning via `.unwrap_or_else(|e| e.into_inner())`; the old
core managers holding live sessions and credentials do not. For a safety-critical release the
recovering code guards the cosmetic mirrors while the critical paths panic.

## The silent-failure taxonomy

Where a failure produces **no user signal and no durable record**:

| Class | Sites | Result |
| --- | --- | --- |
| **Swallowed FE catches** | ~44 `.catch(() => {})` / `=> null\|[]\|false` (ERR-002; WA-FE-005, ux-flows 0033) | Action fails, UI shows nothing; several are destructive kills in Open Connections |
| **No FE ERROR log channel** | `frontendLog` is **DEBUG-only** (`frontendLog.ts:31`); 5 `console.error` sites; **no `unhandledrejection` handler** (ERR-002/008) | Frontend errors never reach the user-openable LogViewer; go to a DevTools console users can't open, or nowhere |
| **Silent Rust discards on config paths** | SSH `set_env` (`connector.rs:256`), X11 forward (`x11.rs:348/357`) (ERR-007) | A **configured** feature silently no-ops (env vars dropped when server refuses `SetEnv`) |
| **Lying success on write/exec** | SSH shell-write (CORE-007), serial-write (CORE-018), exec exit-signal (CORE-004), Docker exit (CORE-010) | A privileged write reported successful when it was dropped/signal-killed |
| **Lying UI controls** | Transfer pause/resume/retry always toast success (ux-flows 0016); silent downloads (0017); credential silently discarded on auth-guess (0013 / ERR-003) | User believes an action worked when it didn't |

Common thread: **the app has no authoritative "what went wrong" record.** The one surface a user
can open and scroll back through — the LogViewer — receives backend logs and frontend DEBUG
breadcrumbs but, by construction, **never a frontend error** (ERR-002). Failures are either
swallowed, toasted-then-gone, or console-logged out of reach.

## Error-propagation & UX assessment

- **Propagation quality is good inside `core`, then collapses at the IPC seam.** `core` has a
  clean typed taxonomy (`CoreError`/`SessionError`/`FileError`, ERR-003). But ~270 Tauri commands
  return `Result<T, String>` and flatten the variant with `map_err(|e| e.to_string())` (75 sites in
  `commands/`). The frontend then **reconstructs the lost type by matching English substrings**
  (`classifyAgentError.ts`, `useConnectSavedConnection.ts`) — a decision as fragile as the wording of
  a russh log message, silently degrading to `"unknown"` on any reword, and locale-fatal. A
  destructive action (discard stored credential) hangs off one such substring guess.
- **UX is inconsistent and ephemeral** (ERR-008): 364 toasts vs 5 console.errors vs DEBUG-only logs
  vs bespoke banners — the same failure class lands in different, non-durable surfaces, and raw
  backend strings (with paths / key names / usernames) reach the UI uncurated on the `"unknown"` path.
- **Edge cases are handled unevenly**: the daemon frame reader caps length prefixes correctly (16 MiB),
  proving the team knows the pattern — yet NDJSON and VNC allocate from untrusted sizes unbounded
  (ERR-009). Frontend `panelTree` is null-safe on empty; the core panel tree is proptest-covered.

## Top risks (ranked)

1. **Lock-poison panic cascade on critical paths (ERR-001)** — one panic under a session/credential
   lock turns every later access into a panic; recovery exists but is wired to the wrong (cosmetic) code.
2. **No frontend error channel (ERR-002)** — failures are structurally un-diagnosable in-app; the
   fix (a `frontendError` + global `unhandledrejection` handler) is small and catches a whole class.
3. **Stringly-typed IPC + English-substring classification (ERR-003)** — brittle, silently-degrading,
   locale-fatal, and gating a destructive credential action on prose.
4. **Startup crash on config-dir failure (ERR-004)** — crash-at-launch on read-only/locked/portable
   environments, in direct contradiction of the code's own "fall back so the app can still start" comment.
5. **Unbounded allocation on untrusted input → OOM abort (ERR-009)** — the one panic class that even
   unwinding can't contain; trivial remote/agent/plugin DoS.

## Is failure handling release-adequate?

**Not yet, for the stated ventilator-grade bar** — though the gap is narrower than the raw counts
suggest, and the fixes are mostly mechanical rather than architectural. The foundations are sound
(typed core errors, panics unwind, projection stores already recover from poison, React error
boundaries, capped daemon frames, pervasive recovery-on-load for corrupt config). What is missing is
**consistency and legibility of failure**: recovery is applied backwards relative to criticality
(ERR-001), there is no durable user-facing error record (ERR-002/008), the type system's error
information is discarded exactly where it would be most useful (ERR-003), a common edge environment
crashes the app at launch (ERR-004), and a handful of untrusted-input paths can OOM-abort (ERR-009).

None of these is a crash on the *common* happy path, so there are **no criticals** — but a
safety-critical release requires that failures be graceful, legible, and recoverable, and today too
many are silent (swallowed catches, `let _ =` discards, lying controls) or fatal-and-opaque
(poison cascade, startup expect, OOM abort). The highest-leverage, lowest-risk work before release:
(1) unify lock-poison recovery + add a panic hook, (2) add a frontend error log channel + global
rejection handler, (3) a typed IPC error envelope to retire substring sniffing, (4) degrade startup
instead of `.expect()`, (5) cap the remaining untrusted-input allocations. Items 2 and 4 are each a
day of work and remove entire classes of silent/fatal failure.
</content>

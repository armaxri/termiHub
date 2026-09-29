# Concurrency, async & reliability audit

**Angle:** concurrency-reliability · **Scope:** async/concurrent code across `core/src`,
`src-tauri/src`, `agent/src`, plus frontend async coordination in `src/services`, `src/store`,
`src/hooks`. **ID prefix:** `CONC`.

**Findings:** 14 (0 critical · 4 high · 6 medium · 4 low)

## The concurrency model in brief

termiHub is a Tokio app split across three crates plus a React frontend:

- **`core`** — pure/algorithmic modules plus the I/O backends. Backends run a dedicated OS reader
  thread per session that bridges PTY/socket bytes into a `tokio::sync::mpsc` via a
  `std::sync::Mutex<Option<Sender>>` slot.
- **`src-tauri`** (desktop) — the Tauri command layer. Almost every backend/agent call is a
  synchronous, blocking method driven from an `async` command via `spawn_blocking`. The
  desktop↔agent transport is a per-agent detached `agent_io_task` that owns one russh channel and
  multiplexes N sessions, with an in-task reconnect loop. State is being migrated onto a
  **projection substrate**: a single `Projector` (one `std::sync::Mutex` over all regions) fans
  versioned diffs out to per-region IPC channels, with a single global intent `Dispatcher` lock.
- **`agent`** — a JSON-RPC server. Each client connection runs its own transport loop that
  processes requests **sequentially** (`call_raw().await` before the next read), but the shared
  `SessionManager` / `ConnectionStore` are reachable **concurrently from multiple client
  connections** (ADR-11 multi-client / daemon + client). Persistent sessions are backed by daemon
  subprocesses reached over a Unix-socket/named-pipe transport.
- **Frontend** — a Zustand store with an authoritative projection cache (`ProjectionClient`) that
  applies RFC-6902 diffs over an optimistic overlay, version-gated against acks.

Reconnect correctness spans all four layers: desktop `agent_io_task` reconnect → agent
`recover_sessions` → daemon `connect_for_recovery` → frontend session-lifecycle region folds.

## Systemic patterns (ranked)

1. **Guards held across `.await`/blocking network I/O.** The dominant pattern. Ranges from a true
   **lock-order inversion deadlock** (CONC-001) down to "correct but serializes everything behind
   one network call" (CONC-004, CONC-007, CONC-008, CONC-013). tokio-Mutex holds only park the
   task (no runtime freeze) but create reentrancy-deadlock risk and throughput cliffs; a single
   slow create/connect/unsubscribe stalls an entire map.
2. **Blocking with no timeout / no cancellation on the reconnect hot path.** The desktop→agent
   reconnect uses the **non-cancellable** blocking SSH connect (CONC-002) and `send_request`
   blocks forever with a *misleadingly-named* "timed out" error (CONC-003). Both make an agent
   drop a multi-minute, un-interruptible hang — the sharpest reliability risk for a
   "reconnect-correctness-is-paramount" release.
3. **Single global locks over sharded state.** The projector's one mutex over all regions plus the
   one intent-dispatcher lock (CONC-005) serialize unrelated domains and hold across delivery.
4. **Detached fire-and-forget tasks with cooperative-only shutdown.** Several long-lived tasks
   holding real resources (SSH channel, capture buffers, OS threads) have no abort handle and end
   only when a sender drops (CONC-009, CONC-011). Mostly bounded in practice, but no hard stop.
5. **Non-atomic register-after-spawn.** Abort handles registered *after* the task is already
   running open a lose-the-handle / miss-the-stop window (CONC-006).

## Top risks (ranked)

1. **CONC-001 (HIGH)** — AB-BA deadlock between the agent `ConnectionStore`'s `connections` and
   `folders` mutexes. Inconsistent lock order across `create`/`create_folder`/etc.; two concurrent
   client RPCs park permanently, hanging the whole connection-definitions subsystem.
2. **CONC-002 (HIGH)** — the agent reconnect loop calls the **non-cancellable** blocking SSH
   connect and never checks `alive` during connect/auth, so a user Disconnect (or shutdown) cannot
   interrupt a hung reconnect to a black-holed host until the OS TCP timeout. The cancellable
   variant exists and is used by the initial connect and tunnels — the reconnect path is the
   outlier.
3. **CONC-003 (HIGH)** — `AgentConnectionManager::send_request` uses `blocking_recv()` with **no
   timeout**; during a drop + multi-minute reconnect every in-flight and new agent RPC hangs for
   the full reconnect window, pinning `spawn_blocking` threads, and the error it eventually returns
   claims "timed out" though no timeout exists.
4. **CONC-004 (HIGH)** — the agent `SessionManager::create` holds the `sessions` mutex across the
   daemon spawn + connect (up to 30s+15s) / in-process SSH handshake, so one slow session creation
   freezes input/resize/list/close for **every** live session on that agent.
5. **CONC-005 (MEDIUM)** — the projector holds its single global regions mutex across
   `sink.deliver()` for every subscriber, and all regions share that one lock; one slow/blocked
   subscriber sink stalls all publish/subscribe/unsubscribe across every domain.

## Note on already-fixed lifecycle gaps

The `docs/audits/remote-agent-lifecycle-state-machine.md` gaps G1/G4/G6/G7 have since landed
(cancellable initial connect, single-writer `connectionState` #1234, self-reap on failed reconnect,
sender reconciliation). This audit builds on that and does **not** re-file them; the reconnect
gaps below are the ones still live in the code as of this pass.
</content>
</invoke>

# Architecture audit — overall (layering, boundaries, coupling)

Angle: `architecture-overall`. Scope: whole tree, emphasis on how the layers fit
together. Read-only. 11 findings (`ARCH-001`…`ARCH-011`).

## The architecture as-built (a short map)

termiHub is a Tauri 2 desktop app: a React/Zustand frontend in a WebView talking
to a Rust backend over Tauri IPC, plus a standalone Rust **agent** binary reached
over SSH+JSON-RPC for persistent remote sessions.

Three Rust crates, layered cleanly **downward** (verified — see ARCH-009 for the
one seam):

```
            plugin-api (repr(C) ABI, thiserror only)
                 ▲
   core (termihub-core)  ── ConnectionType trait + registry, SettingsSchema,
        │        ▲          backends (ssh/serial/telnet/docker/wsl/ftp/local),
        │        │          buffer, output, protocol, session transport traits.
        │        │          Transport-NEUTRAL: zero code refs to tauri/desktop/agent.
   ┌────┴───┐ ┌──┴─────┐
 src-tauri   agent      both are thin adapters implementing core's seam traits
 (desktop)  (daemon)    (OutputSink/ProcessSpawner/ProcessHandle).
```

- **Backend extensibility** is genuinely good: one `ConnectionType` async trait +
  runtime registry + JSON `SettingsSchema` drives a generic `DynamicForm`, so a
  new connection type needs zero frontend code (ADR-7/8/9). Plugins plug into the
  *same* registry (ARCH-008 notes the trust caveat, not an architecture defect).
- **State** is undergoing a large migration to a **stateless-UI projection
  substrate** (#2139): server-authoritative, per-region versioned JSON-diff
  channels (RFC-6902, single-writer dispatcher, multi-subscriber fan-out) that
  are transport-neutral (Tauri IPC or WebSocket for a remote client). The
  substrate core (`src-tauri/src/projection/`) is coherent, well-documented, and
  well-tested. ~11 domains have `*_projection` backend modules + `*Bridge.ts` /
  `useProjected*` frontend mirrors, in a consistent shape.

### Strengths worth preserving

- Clean crate dependency direction; `core` is honestly transport-neutral.
- The `ConnectionType`/schema/registry seam is a real abstraction, not leaky —
  backends, plugins, and remote agent types all flow through it uniformly.
- The projection substrate's *mechanism* is well-designed (single writer,
  versioned diffs, burst-coalescing, gap/resync, in-memory testable).
- Cancellation has one primitive end-to-end (`CancellationToken`, ~271 sites).
- Consistent per-domain module shape (`mod/projection/store + tests`).

## Top structural risks (prioritized)

1. **`appStore.ts` god-module (ARCH-001, high).** 8156 lines, ~361 fields, ~224
   actions in one store; the frontend serialization point. Slicing (#2077) has
   only peeled off peripheral features.
2. **The state migration is half-landed and undecided (ARCH-003, medium).** The
   projection substrate was a strangler meant to replace the typed IPC surface,
   but that surface **grew ~206 → ~279 commands** and was never retired; two full
   state mechanisms now coexist with dual maintenance (region seeds folded from
   the same managers the commands mutate). No definition of done.
3. **`lib.rs setup()` god-function (ARCH-002, medium)** and the backend
   serialization point: ~700 lines, incl. a ~325-line hand-written per-domain
   projection-registration block; ordering constraints encoded only in comments.
4. **Authority is misdocumented (ARCH-005, medium).** Backend `*_projection`
   headers still say "Shadow … not yet driving the live UI" for domains the
   frontend has already cut over (`appStore` holds no connections/settings/
   transfers slice). Reading the two ends of the codebase yields opposite answers
   to "who owns this state" — a real hazard for a safety-critical review.
5. **No structured error crosses IPC (ARCH-006, medium).** Three error families,
   all collapse to display strings on the wire; ~93 commands return
   `Result<_, String>`; the frontend sniffs message prefixes. Undermines graceful
   error recovery and error-message i18n.

### Also flagged

- **ARCH-004 (medium, workaround):** layout is the one domain still
  dual-authority — `appStore` holds the panel tree with local reducers + a live
  "fall back to local mutation" path; reducer removal deferred (#2562).
- **ARCH-007 (medium):** no central async-task ownership; 84 spawn sites, ~3
  handle registries, teardown is a hand-kept list — leak/orphan risk on exit.
- **ARCH-008 (medium):** native backend plugins run in-process unsandboxed with
  full app privileges (dlopen), while the weaker frontend plugins are sandboxed
  and default-off — inverted trust model; should be an explicit release decision.
- **ARCH-010 (medium):** agent session daemons are single-attach with silent
  takeover — a second desktop hijacks a live session's I/O; no attach-boundary
  surfacing.
- **ARCH-011 (medium, workaround):** `NetworkManager` initialized via a
  `*const → *mut` cast on shared managed state — UB-adjacent, on every launch.
- **ARCH-009 (low):** desktop and agent duplicate the core-backend registration
  block instead of sharing a core-provided default set.

## Release-blocking architectural concern

No single finding is a hard "do not ship" on its own, but **the state-migration
situation (ARCH-003 + ARCH-004 + ARCH-005 together) is the one structural theme
that should block a ventilator-grade release until resolved.** Shipping "two
state mechanisms, one domain still dual-authority with a fallback, and module
docs that misstate which one is authoritative" means no contributor — or auditor
— can reliably answer "which copy of this state is real?" on the safety-critical
path. The fix is a decision, not a rewrite: pick a definition of done for the
strangler, finish or formally freeze it per domain, close the layout dual-
authority (#2562), and reconcile the doc headers to the actual authority. The
`unsafe` const-to-mut init (ARCH-011) and the unsandboxed native-plugin default
(ARCH-008) are the two other items that a memory-safety / security-graded release
should explicitly close or consciously accept, not leave implicit.

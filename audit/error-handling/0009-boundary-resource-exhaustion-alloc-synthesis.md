---
id: ERR-009
title: Edge/boundary + resource-exhaustion synthesis — unbounded/untyped allocation on untrusted input
angle: error-handling
severity: medium
category: reliability
is_workaround: false
subsystem: core/src (ipc, backends/vnc), agent/src/daemon
evidence:
  - core/src/ipc/ndjson.rs:35
  - agent/src/daemon/protocol.rs:40
  - core/src/backends/vnc/mod.rs:349
status: open
---

## What
A cross-cutting look at how the input-facing parsers handle malformed / extreme / hostile boundary inputs shows an **inconsistent allocation-safety story** — some paths are correctly capped, several are not:

- **NDJSON transport — no line cap.** `core/src/ipc/ndjson.rs:35` `read_line` is a thin wrapper over tokio `read_line` with **no length limit**, despite the protocol being documented as a "1 MiB line cap." A single unterminated line from a remote agent grows the `String` without bound → OOM abort. (Already filed as backend-core **CORE-002**; re-surfaced here as the sharpest untrusted-input alloc.)
- **VNC framebuffer — server-controlled dimensions.** `core/src/backends/vnc/mod.rs:349–397` resizes the shadow buffer to `width × height` taken from the server's messages with no sanity bound → a hostile/broken VNC server dictates the allocation. (backend-core **CORE-008**.)
- **Daemon frame protocol — correctly capped (contrast).** `agent/src/daemon/protocol.rs:40,71–76,124–129` enforces `MAX_PAYLOAD_SIZE = 16 MiB` before `vec![0u8; length as usize]`. This is the *right* shape — but 16 MiB *per frame* from a local peer is still generous, and it shows the codebase knows the pattern yet did not apply it to NDJSON.
- **Remote file reads / TFTP / tunnels / plugin zips** — no size cap on remote reads (**CORE-013**), TFTP upload buffering + thread-per-request (**CORE-021/022**), unbounded tunnel connections (**CORE-027**), plugin zip bombs (**CORE-032**).

The recurring failure mode when a bound *is* missing is the worst one for a safety-critical app: **abort-on-OOM**, which the panic taxonomy (ERR-001) can't even contain because allocation failure aborts rather than unwinds.

## Why it matters
- **Trivial remote DoS / crash.** Several of these are reachable from a remote agent, a malicious/broken VNC or SSH server, or a crafted plugin — exactly the untrusted surfaces. An OOM abort takes the whole process (or agent) down; there is no graceful degradation and nothing logged.
- **Inconsistency is the tell.** The daemon frame reader proves the team knows to cap length-prefixed reads; NDJSON and VNC just weren't given the same treatment. This is a coverage gap, not a hard design problem.

## Evidence
- `core/src/ipc/ndjson.rs:35` — uncapped `read_line`.
- `agent/src/daemon/protocol.rs:40` — `MAX_PAYLOAD_SIZE = 16 * 1024 * 1024` cap (the correct pattern).
- `core/src/backends/vnc/mod.rs:349–397` — resize to server-supplied dims.

## Recommendation
Apply one uniform "cap before allocate" rule to every length-prefixed / streaming untrusted read: NDJSON gets a max-line limit (reject + close on overflow, matching the documented 1 MiB), VNC clamps server dimensions to a sane maximum, remote reads/TFTP get size caps. Where a cap is exceeded, return a typed error and tear the connection down gracefully — never let it reach the allocator. This finding unifies CORE-002/008/013/021/022/027/032 under the single "untrusted-input allocation" lens for triage; fix them as a set.
</content>

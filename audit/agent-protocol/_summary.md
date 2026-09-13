# Agent daemon & app↔agent protocol — audit summary

**Angle:** remote-protocol and agent/daemon expert. **Scope:** `agent/src/**`,
`docs/remote-protocol.md`, the desktop side of the protocol in `src-tauri/src` (remote
proxies, transport, agent manager/deploy), and the shared `core/src/protocol` + `core/src/ipc`.

## Architecture in brief

The desktop opens **one SSH exec channel per connection** and runs `termihub-agent --stdio`,
so there is **one agent process per desktop→agent channel serving exactly one client**
(`docs/remote-protocol.md`). The wire protocol is **JSON-RPC 2.0 over NDJSON** (one JSON
value per `\n`-terminated line, base64 for binary, 1 MiB line cap). The agent also has a
`--listen` TCP mode (shared `SessionManager`, sequential clients) that the desktop does not
use but ships in the binary.

Below the `--stdio` worker sit two local IPC layers on the agent host:
- **Session daemons** (`--daemon <id>`): detached processes that host persistent terminal
  sessions and outlive each worker, spoken to over a unix socket / Windows named pipe using a
  binary frame protocol `[type:1B][len:4B BE][payload]` with a 1 MiB output ring buffer.
- **Registry daemon** (`--registry-daemon`, ADR-11): a host-wide singleton giving cross-worker
  "who is attached" visibility and relaying the coordinated-update (`agent.update_pending`)
  signal.

The app can **auto-update agents**: it SFTP-uploads a new binary and calls
`agent.request_update{binaryPath}`; the agent copies it over its own executable and re-execs
(Unix only). An optional off-by-default GitHub self-update path exists.

## Trust model (as built)

- **Transport:** SSH provides encryption + authentication for the `--stdio` channel. There is
  **no protocol-level auth or authorization** — the agent trusts any principal that completes
  `initialize`. That means *any* SSH principal on the host can drive *every* verb, including
  the host-wide binary swap (AGT-003).
- **`--listen` TCP mode has no auth at all** and shares sessions across clients (AGT-002).
- **The two local daemons have no socket authentication and no peer-credential check** — the
  only gate is filesystem perms / named-pipe DACL, and that boundary is itself weakened
  (AGT-020, AGT-022).
- **The update chain has no code signature** — integrity rests on a SHA-256 sidecar fetched
  from the same channel as the binary, and the *apply* path verifies nothing at all
  (AGT-004, AGT-005).
- **The ~70 RPC DTOs and ~40 method names are hand-rebuilt on both sides with no shared crate
  and no compiler linkage** (confirmed with the code-duplication expert). Drift is invisible
  to the build and surfaces only at runtime — two live breaks already exist (AGT-001, AGT-009).

## Top risks (ranked)

1. **Unauthenticated arbitrary-binary update = RCE-as-agent, host-wide (AGT-003, critical).**
   Any initialized client can push an arbitrary absolute `binaryPath`; the agent copies it
   over itself and execs it, and every co-hosted client then runs it. `binaryPath` is
   validated only by `is_file()`.
2. **Update apply path performs no integrity check; binaries are never signed (AGT-004,
   AGT-005, critical/high).** Verification lives only in the self-update *download*; the
   pushed/coordinated/staged routes swap unverified bytes. The checksum is served next to the
   artifact, so it stops corruption, not substitution.
3. **Wire-contract drift with no compiler linkage — two confirmed live breaks (AGT-001 rename,
   AGT-009 delete), plus the whole family is latent (high).** Remote file rename and delete are
   *both* broken today (`-32602`). A shared protocol crate is the structural fix.
4. **Protocol versioning is decorative (AGT-010, high).** The desktop pins `protocolVersion
   "0.3.0"`, the major-check is meaningless for 0.x, and nothing gates on the negotiated
   version — the compatibility matrix in the spec is not actually enforced. Combined with
   auto-update-driven skew, this is a real forward/back-compat gap.
5. **Shared per-user `state.json` + unscoped recovery (AGT-015, high) and its data-loss
   siblings (AGT-016 clobber, AGT-017 silent-discard).** A second desktop's worker recovers
   and *evicts* the first desktop's live persistent sessions; concurrent workers lose each
   other's state; a corrupt read silently drops all sessions. This defeats the flagship
   "sessions survive" guarantee in the multi-desktop case the registry was built for.

Also notable: unauthenticated `--listen` mode + cross-client session inheritance (AGT-002);
no daemon socket auth / forgeable `agent.update_pending` (AGT-022); daemon/socket/log leaks on
a long-uptime host (AGT-018 zombies, AGT-019 stale files); no desktop-side request timeout
(AGT-012); desktop-side reads have no size cap so a compromised agent can OOM the desktop
(AGT-013); secrets possibly persisted plaintext (AGT-021).

## What is sound (so the fixes don't regress it)

The agent's inbound NDJSON reader is bounded and cancellation-safe (#2352/#1559, correct); the
binary frame protocol bounds the length before allocation; the on-disk binary swap is atomic;
the recovery dead-socket fast-fail (#2491) is real; detach-ordering and singleton election are
well-reasoned and tested; the Windows named-pipe DACL is a correct per-user analog; and
recovery deliberately trusts a live connect, not a recorded pid. Non-Unix update apply
fails closed. All method-name strings and error codes match across the two sides — the drift is
purely in param/field shapes.

## Finding index

| ID | Sev | Title |
| --- | --- | --- |
| AGT-001 | high | Remote file rename broken — `{from,to}` vs `old_path`/`new_path` |
| AGT-002 | high | `--listen` TCP mode unauthenticated + shares sessions across clients |
| AGT-003 | critical | Arbitrary `binaryPath` update = RCE-as-agent, host-wide |
| AGT-004 | critical | Update apply path performs no integrity verification |
| AGT-005 | high | Binaries never signed; checksum served from the same channel |
| AGT-006 | medium | No rollback on failed re-exec; a bad binary can brick the host |
| AGT-007 | medium | Dev/branch builds skip checksum enforcement (workaround) |
| AGT-008 | medium | Self-update env-overrides + live test hook ship in release (workaround) |
| AGT-009 | high | Remote file delete broken — missing `isDirectory` + `connectionId` casing |
| AGT-010 | high | Protocol version negotiation is decorative / matrix not enforced |
| AGT-011 | medium | Spec shows snake_case `initialize` params; agent requires camelCase |
| AGT-012 | medium | No desktop RPC request timeout; `blocking_recv` hangs forever |
| AGT-013 | medium | Desktop-side NDJSON reads have no size cap (agent can OOM desktop) |
| AGT-014 | low | Desktop reports hardcoded `clientVersion "0.1.0"` |
| AGT-015 | high | Shared `state.json` + unscoped recovery evicts another desktop's sessions |
| AGT-016 | medium | Concurrent workers clobber `state.json` (no file lock) |
| AGT-017 | medium | Corrupt `state.json` silently discards all sessions |
| AGT-018 | medium | Zombie session-daemon leak — no reaping (#2580) |
| AGT-019 | medium | Stale `.sock`/`.log` files never reclaimed (inode leak) |
| AGT-020 | medium | Predictable `/tmp` socket path, unverified parent, spoofable `USER` |
| AGT-021 | medium | Session settings (possibly secrets) persisted plaintext, no 0o600 |
| AGT-022 | medium | Daemon sockets unauthenticated; forgeable `agent.update_pending` |
| AGT-023 | low | Unbounded registry queues, no read timeout, eager 16 MiB alloc |
| AGT-024 | low | Wire-controlled unbounded scrollback ring-buffer capacity |
| AGT-025 | low | `Handle::current()` panic path in `ProcessHandle` |
| AGT-026 | low | Windows reconnect dead-socket / detach path untested |
| AGT-027 | low | Coordinated update fail-open; "gone = acked" reconnect race |
| AGT-028 | info | `connections.*` params flow untyped from frontend to agent |

28 findings — 2 critical, 6 high, 13 medium, 6 low, 1 info.

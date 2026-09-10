# Backend `core` crate — Rust engineering-quality audit

**Angle:** backend-core-rust · **Scope:** `core/src/**`, `core/tests`, `core/Cargo.toml`
**Findings:** 38 (0 critical · 11 high · 23 medium · 4 low · 0 info) · **ID prefix:** `CORE`

## Overall assessment

`core` is, on the whole, a **well-engineered crate**. The pure/algebraic modules
are genuinely strong: `buffer` (ring buffer), `output/coalescer`,
`output/screen_clear` (vte-based, chunk-boundary-correct), `monitoring/parser`
and `monitoring/status`, `reconnect_backoff`, `connection/validation`, the FTP
`listing_parser`, and the `session` transport traits are clean, defensively
written, and **thoroughly unit-tested** (golden tests, proptest for the panel
tree). Error types are consistent `thiserror` enums, the public trait surface
(`OutputSink`/`ProcessSpawner`/`ProcessHandle`/`LocalShellSpawner`) is minimal
and well-documented, and the feature-gating discipline in `Cargo.toml` is careful.

The risk is **not** in the algorithmic core — it is concentrated in the
**I/O-facing backends, the FFI plugin host, and the hand-rolled network
servers/parsers**, where remote/hostile input meets the system. The recurring
themes across the high/medium findings:

1. **Silent error swallowing on write/exec paths** — SSH shell writes
   (CORE-007), serial writes (CORE-018), SSH exec exit-signal (CORE-004), Docker
   exec exit code (CORE-010) all turn a failure into apparent success or silent
   input loss. On a "ventilator-grade" release, a privileged write reported as
   successful when it was signal-killed (CORE-004) is the sharpest example.
2. **Unbounded resource use on untrusted input** — no line cap on the NDJSON
   transport (CORE-002), no size cap on remote file reads (CORE-013), VNC
   framebuffer allocation from server-controlled dimensions (CORE-008),
   TFTP upload buffering + thread-per-request (CORE-021/022), unbounded tunnel
   connections (CORE-027), plugin zip bombs (CORE-032). Several are trivial
   remote DoS.
3. **FFI / native-plugin soundness** — the plugin host is the highest-risk
   subsystem: a field-drop-order use-after-free on teardown (CORE-029), an
   unbounded-lifetime borrow of a plugin-supplied pointer (CORE-036), a
   verify-then-load TOCTOU (CORE-034), and a lexical-only filesystem sandbox that
   a symlink defeats (CORE-030).
4. **Lossy `as` truncation & missing validation** — `port as u16` wrapping
   (CORE-006), TFTP block-number truncation (CORE-023), plus coordinate/offset
   casts flagged in passing.
5. **Latent panics on real paths** — session-log name truncation on a UTF-8
   boundary (CORE-001), empty-`Split` panel tree (CORE-038), tunnel lock poison
   (CORE-028).

### Riskiest modules (in priority order)

1. **`plugin/`** — native `dlopen` + C-ABI FFI; unsound drop order and borrows,
   TOCTOU load, symlink sandbox escape, zip-bomb. (CORE-029/030/032/034/036, +35)
2. **`backends/ssh/`** — exit-signal misclassification into a privileged-write
   success, no exec timeout, silent shell-write loss, port truncation.
   (CORE-004/005/006/007, +013)
3. **`embedded_servers/` (TFTP, HTTP)** — hand-rolled, unauthenticated,
   unbounded, no TID validation, listing XSS. (CORE-021/022/023/024/025)
4. **`backends/vnc` & `backends/rdp_sidecar`** — hostile-server framebuffer
   allocation; sidecar integrity TOCTOU + clipboard hang. (CORE-008/011/014)
5. **`backends/docker`** — container leak on partial connect, exec-exit-code
   default-success, GNU-only `find`. (CORE-009/010/012)
6. **`ipc/ndjson` & `backends/{telnet,serial,local_shell,wsl}`** — unbounded
   framing, no DNS, swallowed writes, lock-across-blocking-send, insecure temp,
   no Drop cleanup. (CORE-002/015/016/018/019/020)

## Top findings (ranked)

| Rank | ID | Sev | Finding |
| --- | --- | --- | --- |
| 1 | CORE-004 | high | SSH exec ignores `ExitSignal` → signal-killed privileged write reads as success (data-integrity) |
| 2 | CORE-029 | high | Plugin library dropped before the backend it created → use-after-free on teardown |
| 3 | CORE-030 | high | Plugin filesystem sandbox is lexical-only → symlink escapes granted roots |
| 4 | CORE-008 | high | VNC framebuffer allocated from unbounded server dimensions → process-abort DoS |
| 5 | CORE-002 | high | NDJSON `read_line` has no length cap → unbounded-memory DoS on the agent transport |
| 6 | CORE-005 | high | `ssh_exec_with_stdin` has no timeout → stalled server hangs connect/privileged-write |
| 7 | CORE-032 | high | Plugin package extraction unbounded + symlink entries → zip-bomb / sandbox escape |
| 8 | CORE-021/022 | high | Embedded TFTP buffers whole upload in memory + unbounded thread-per-request |
| 9 | CORE-015 | high | Telnet connect never resolves hostnames (literal `SocketAddr` parse) |
| 10 | CORE-016 | high | Local-shell reader holds output mutex across `blocking_send` → teardown deadlock |

Remaining highs/mediums (Docker leak & exec-exit default, RDP TOCTOU/clipboard
hang, remote-file unbounded reads, config password expansion, HTTP listing XSS,
traceroute correlation, tunnel bounds, session-log/panel-tree panics, ed25519
`verify_strict`, FFI context borrow, etc.) are individually filed as
`CORE-001`, `CORE-003`, `CORE-006`–`CORE-014`, `CORE-017`–`CORE-028`,
`CORE-031`, `CORE-033`–`CORE-038`.

## Notes on what is *sound* (no finding)

- **SSH host-key verification** is correctly strict (per-hop, known-hosts-only
  headless default, no blind-accept).
- **`sftp_ops` sudo command composition** is well-guarded (positional argv +
  `shlex` quoting) and well-tested.
- **`network/traceroute.rs` `unsafe`** (the only non-plugin/non-Windows `unsafe`)
  is sound — the standard socket2 `recv_from` `MaybeUninit` pattern with an
  accurate SAFETY comment (the *correlation* issue CORE-026 is logical, not a
  memory-safety one).
- **`legacy_pem.rs`** is an explicit, correct, well-tested workaround for a russh
  limitation; `left_pad` is safe under its callers' bounds.

## Method

Module structure mapped first; algorithmic/pure modules read directly by the
lead auditor; the substantial I/O backends, plugin FFI, network servers, and
config/layout were deep-read by parallel sub-audits, with every high/medium
finding's code quote spot-verified against the source before filing. No builds,
tests, or git operations were run (read-only audit).

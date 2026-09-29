# Rust backend buy-vs-build (crate-usage) audit — 2026-09-10

Angle: **is the Rust code maintaining its own implementation of a problem a mature,
well-maintained crate already solves?** Scope: `core/src/**`, `src-tauri/src/**`,
`agent/src/**`, `plugin-api/src`, plus the `Cargo.toml`s / `Cargo.lock` to see what
is already a dependency. Vendored code (`vendor/`, `rdp-sidecar/vendor`) and
`graft/` were excluded.

## Headline

The backend is, overall, an **exemplary application of the repo's own "prefer
libraries over custom code" rule**. The non-trivial concerns are already delegated
to maintained crates: RFB/VNC (`vnc-rs`), FTP + its `ls -l`/DOS listing parser
(`suppaftp`), SSH (`russh`), OpenSSH-config parsing (`ssh2-config`), CSV
(`csv`), JSON-Patch (`json-patch`), semver (`semver`), OS credential store
(`keyring`), Ed25519 signing (`ed25519-dalek`), ZIP (`zip`), dynamic-library
loading (`libloading`), TCP keepalive/socket tuning (`socket2`), ring buffer
(`ringbuf`), tilde/env path expansion (`shellexpand`), streaming XML (`quick-xml`),
fs-watch debouncing (`notify-debouncer-full`), MessagePack IPC (`rmp-serde`).
There is **no "use more crates" push to make** — most of the codebase is already
where you'd want it.

The findings below are the handful of genuine exceptions, ranked by payoff. The
two highest-value ones need **no new dependency** — they use a crate already in
the tree.

## Hand-rolled area → candidate crate → recommendation

| # | Hand-rolled area | file:line | Candidate crate | Recommendation |
|---|---|---|---|---|
| LIBBE-0001 | base64 encoder **and** a byte-level base64 `Read` decoder (~100 lines), comment says "no-dependency implementation" | `core/src/backends/docker/file_browser.rs:381-487` | **`base64`** (already in the workspace lock via src-tauri + agent; also `data-encoding` in-tree) | **adopt-existing** — add `base64` to the `docker` feature |
| LIBBE-0002 | NDJSON line framing via `AsyncBufReadExt::read_line` with **no length cap** (trust-boundary transport) | `core/src/ipc/ndjson.rs:35-41` | **`tokio_util::codec::LinesCodec::new_with_max_length`** (`tokio-util` already a dep) | **adopt-existing** — bounded codec + `Framed` |
| LIBBE-0003 | length-prefixed binary frame protocol (read_exact loops, manual size guard) | `agent/src/daemon/protocol.rs` | `tokio_util::codec::LengthDelimitedCodec` (`tokio-util` already a dep) | **keep-as-is (borderline)** — documented domain glue, tested; codec is a marginal, optional cleanup |
| LIBBE-0004 | ~8 separate exponential-backoff computations | see finding | `backon` / `tokio-retry`, or one internal helper | **low** — the *math* is trivial (keep), but consolidate the duplication into a shared helper |
| LIBBE-0005 | refcounted single-flight `RefPool` for shared SSH gateway sessions | `core/src/backends/ssh/session_pool.rs` | `deadpool` / `bb8` / `mobc` | **keep-as-is** — generic checkout/checkin pools do **not** fit the shared-`Arc`-reuse + generation-eviction (#1315) pattern |
| LIBBE-0006 | minimal TFTP server (RFC 1350 over `std::net::UdpSocket`) | `core/src/embedded_servers/tftp_server.rs` | `async-tftp` | **keep-as-is** — small, tested, avoids an async-runtime-shaped dep for a subordinate feature |
| LIBBE-0007 | (positive) overall library-first posture | workspace-wide | — | **info** — confirms no broad crate-adoption gap |

## Top opportunities (ranked by payoff)

1. **LIBBE-0002 — bound the NDJSON transport with `LinesCodec::new_with_max_length`
   (no new crate).** This is both a buy-vs-build win and a release-relevant
   reliability fix: the desktop↔agent JSON-RPC transport crosses a trust boundary
   (over SSH, possibly a hostile/compromised agent), and the current `read_line`
   grows an unbounded `String` on a newline-less peer → trivial OOM DoS. The
   backend-core angle flagged the same code as **CORE-002**; the buy-vs-build
   answer is that `tokio-util` (already depended on) ships the bounded line codec.
2. **LIBBE-0001 — replace the hand-rolled base64 with the `base64` crate (already
   in the workspace tree).** ~100 lines of hand-rolled encode + a custom `Read`
   decoder sit on the Docker-exec file-transfer path; the decoder is *lenient*
   (silently skips any non-alphabet, non-`=` byte) rather than erroring, which is
   exactly the kind of subtle behaviour a hardened crate gets right. The
   "no-dependency" comment is stale — `base64` is a non-optional dep of both
   `src-tauri` and `agent`, so it is already compiled in every shipping build.
3. **LIBBE-0004 — consolidate the ~8 exponential-backoff snippets.** Low urgency,
   but a maintenance smell: eight `base * 2^n`-clamped variants drift
   independently. A single internal helper (crate optional) removes the drift.

## Notes on judgement

Per the brief, this is a curated review, not a "add crates" sweep. Trivial
helpers (`shell_escape`, `join_path`, `keepalive_config`, the resize/exit-code
byte packers in the daemon protocol, `OutputCoalescer`) are **correctly left
hand-rolled** and are not flagged. LIBBE-0005/0006 document cases where keeping
the hand-rolled code is the *right* call, per the brief's request to record those
too.
</content>
</invoke>

---
id: LIBBE-007
title: Backend library-first posture is exemplary — no broad crate-adoption gap
angle: lib-usage-backend
severity: info
category: arch
is_workaround: false
subsystem: workspace-wide
evidence:
  - core/Cargo.toml:79
  - src-tauri/Cargo.toml:505
  - agent/Cargo.toml:386
status: open
---

## What
A positive/summary finding. The buy-vs-build sweep looked for reinvented wheels
across the categories in the brief (retry/backoff, connection pooling, framing,
ring/circular buffers, LRU, rate limiting, base64/hex, TOML/INI/CSV, path
canonicalization, host:port/URL parsing, glob, cron, semver, temp files, process
management, PTY, async channels, debounce/coalescing). The overwhelming result:
the non-trivial concerns are **already delegated to maintained crates**, exactly
as the repo's own "prefer libraries over custom code" standard demands.

## Why it matters
It bounds the audit: there is no systemic "hand-rolled everything" problem, so the
actionable findings are the few narrow exceptions (LIBBE-001..004), not a broad
adoption campaign. The brief explicitly asks this to be a curated review, not a
"use more crates" push — this finding records that the codebase is already at the
target state.

## Evidence
Representative adoptions confirmed in the source (not just declared):

- **Ring buffer** → `ringbuf::HeapRb` (`core/src/buffer/mod.rs:1`), not a
  hand-rolled circular buffer.
- **FTP `ls -l`/DOS listing parsing** → `suppaftp::list::ListParser`
  (`core/src/backends/ftp/listing_parser.rs:21`); the module keeps only the
  mapping into `FileEntry`, and documents *why* MLSD is parsed directly (suppaftp
  rejects real-world four-digit `UNIX.mode` and `cdir`/`pdir`).
- **OpenSSH `~/.ssh/config` parsing** → `ssh2-config` (`src-tauri/Cargo.toml:558`),
  not a hand-rolled tokenizer.
- **CSV / inventory parsing** → `csv` (`src-tauri/Cargo.toml:527`).
- **JSON-Patch (RFC 6902)** → `json-patch` (`src-tauri/Cargo.toml:532`).
- **semver comparison** → `semver` (`agent/Cargo.toml:424`, `src-tauri/Cargo.toml:551`).
- **base64 / hex** → `base64`, `hex` crates everywhere except the one lapse in
  LIBBE-001.
- **TCP keepalive / socket tuning** → `socket2` (`core/src/net.rs:13`).
- **tilde/env path expansion** → `shellexpand` (`core/Cargo.toml:163`).
- **fs-watch debounce** → `notify-debouncer-full` (`src-tauri/Cargo.toml:517`).
- **OS credential store** → `keyring` (`src-tauri/Cargo.toml:576`).
- **Ed25519 signing**, **ZIP**, **dynamic-lib loading**, **streaming XML**,
  **MessagePack IPC**, **RFB/VNC**, **SSH** → `ed25519-dalek`, `zip`,
  `libloading`, `quick-xml`, `rmp-serde`, `vnc-rs`, `russh` respectively.
- **Temp files / atomic writes** → `tempfile` (`agent/Cargo.toml:430`).
- **PTY** → `portable-pty`. **DNS** → `hickory-resolver`. **ICMP ping** →
  `surge-ping`.

Trivial helpers that are correctly *not* crate-ified: `shell_escape`,
`join_path`, the daemon resize/exit-code byte packers, `OutputCoalescer`,
`keepalive_config`. Host:port handling uses `rsplit_once(':')` on already-
validated internal id strings (`credential/types.rs:63`, `commands/session.rs:130`),
not untrusted network URL parsing, so a URL crate is unwarranted there.

## Recommendation
**info — no action.** Maintain the posture. The only live buy-vs-build work is
LIBBE-001 (base64), LIBBE-002 (LinesCodec), and the LIBBE-003/004 lower-priority
items; LIBBE-005/006 document correctly-kept hand-rolled code.
</content>

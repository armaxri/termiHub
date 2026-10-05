# libunftp (termiHub vendored fork)

Vendored fork of [`libunftp`](https://github.com/bolcom/libunftp) `0.23.1`, the
FTP server library behind termiHub's embedded FTP server. The upstream README is
kept as `README.upstream.md`.

**Fork base:** upstream `0.23.1`, commit
[`8d3f28c20c53acdd3c9a939957e4727e18e18af0`](https://github.com/bolcom/libunftp/commit/8d3f28c20c53acdd3c9a939957e4727e18e18af0)
(tag `libunftp-0.23.1`, also the tip of upstream `master` when the fork was
taken, 2026-10-06). The fork is registered in
[`vendor/vendored-forks.json`](../vendored-forks.json), and a weekly CI job
reports upstream releases, commits and advisories that the fork does not have
yet. See `docs/supply-chain.md` → "Vendored forks". Update both when re-basing
or reviewing upstream again.

It is consumed through the root `Cargo.toml` `[patch.crates-io]` table and is
excluded from the workspace, so it keeps upstream's own `rustfmt.toml` and lint
table and its sources stay comparable with upstream.

## Why this is vendored

termiHub runs one libunftp server per FTP session on a loopback port in PROXY
protocol mode, behind its own front relay (#3996). In 0.23.1 the PROXY v1 header
reader (`read_proxy_header` in `src/server/proxy_protocol.rs`) never ends when a
connection closes before its header is complete: at EOF `peek` returns `Ok(0)`,
no newline is found, and the zero-length `read` returns `Ok(0)` too, so the task
loops and burns a CPU core until the server stops. The relay always writes the
full header, so remote clients cannot trigger it, but any local process that
connects to a session's loopback port and closes can.

See [armaxri/termiHub#4099](https://github.com/armaxri/termiHub/issues/4099).

## What this fork changes

- `src/server/proxy_protocol.rs` `read_proxy_header`: when `peek` returns
  `Ok(0)` (EOF), return `ProxyError::ReadError` with
  `io::ErrorKind::UnexpectedEof`, so the header task logs the error and ends.
  The change is marked `termiHub fork delta (armaxri/termiHub#4099)`.
- `src/server/proxy_protocol.rs` tests: EOF before any header byte, and EOF
  after a partial header, both return that error within a timeout.

Packaging differences from the crates.io release (not code deltas):
`Cargo.toml` is the crates.io-normalised manifest with a fork note, without the
`[[test]]` targets of the upstream integration tests (`tests/` is not vendored)
and with the `unftp-sbe-fs` dev-dependency restored from crates.io (the
normalisation strips upstream's path dependency). Upstream's `CHANGELOG.md`,
`AGENTS.md`, `examples/`, `logo.png`, `Makefile` and CI files are not vendored.

Tests: the unit tests above; termiHub's
`core/src/embedded_servers/ftp_server/relay_tests.rs`
(`backend_header_reader_ends_when_a_connection_closes_without_a_header`)
connects to a real session backend, closes without a header and checks that no
task is left behind. Run the fork's own tests with `cargo test --lib` inside
this directory.

The delta is a few lines and upstream-compatible. The ready-to-submit bug report,
patch and retirement steps are in [`UPSTREAM.md`](UPSTREAM.md).

Everything else is upstream `0.23.1`, under the original Apache-2.0 license
(`LICENSE`, `COPYRIGHT`).

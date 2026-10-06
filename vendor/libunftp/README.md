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

The same listener trusts the PROXY header of any connection, so a local
process could connect to it directly and claim any client IP (access log,
passive-data switchboard key) and skip the relay's control-line cap. 0.23.1 has
no way to restrict who the listener serves, and it always binds the address
itself. The fork adds both, so the relay binds the listener and libunftp only
serves connections the relay opened. See
[armaxri/termiHub#4100](https://github.com/armaxri/termiHub/issues/4100).

## What this fork changes

- `src/server/proxy_protocol.rs` `read_proxy_header`: when `peek` returns
  `Ok(0)` (EOF), return `ProxyError::ReadError` with
  `io::ErrorKind::UnexpectedEof`, so the header task logs the error and ends.
- `src/server/proxy_protocol.rs` tests: EOF before any header byte, and EOF
  after a partial header, both return that error within a timeout.
- `Server::listen_with_listener(tokio::net::TcpListener)` (#4100): runs the
  server like `listen`, on a listener the caller already bound. `listen` and it
  share one body (`listen_on`); every listener mode (legacy, pooled, proxy)
  takes its control listener from `bind_control_listener`, which uses the
  prebound listener if there is one and binds the address otherwise.
- `ServerBuilder::proxy_protocol_peer_filter(Fn(SocketAddr) -> bool)` (#4100):
  in PROXY protocol mode, each accepted connection's peer address is passed to
  the filter before anything is read; a refused connection is logged and
  closed, so its header is never parsed.
- `src/server/ftpserver.rs` tests: a prebound proxy-mode server answers a
  peer the filter allows and closes one it refuses without a byte.

All fork changes are marked `termiHub fork delta (armaxri/termiHub#…)`.

Packaging differences from the crates.io release (not code deltas):
`Cargo.toml` is the crates.io-normalised manifest with a fork note, without the
`[[test]]` targets of the upstream integration tests (`tests/` is not vendored)
and with the `unftp-sbe-fs` dev-dependency restored from crates.io (the
normalisation strips upstream's path dependency), plus a
`[package.metadata.cargo-machete]` ignore for `tracing` (used only through the
`#[tracing_attributes::instrument]` expansion). Upstream's `CHANGELOG.md`,
`AGENTS.md`, `examples/`, `logo.png`, `Makefile` and CI files are not vendored.

Tests: the unit tests above; termiHub's
`core/src/embedded_servers/ftp_server/relay_tests.rs`:
`backend_header_reader_ends_when_a_connection_closes_without_a_header`
connects to a real session backend, closes without a header and checks that no
task is left behind, and
`direct_loopback_connection_with_a_forged_proxy_header_is_refused` checks that
direct loopback connections with forged headers are refused and logged while
relay-opened control and data connections work. Run the fork's own tests with `cargo test --lib` inside
this directory.

Both deltas are small and upstream-compatible (additive API, no behaviour
change for existing callers). The ready-to-submit bug report and patch (#4099),
the API proposal and patch (#4100), and the retirement steps are in
[`UPSTREAM.md`](UPSTREAM.md).

Everything else is upstream `0.23.1`, under the original Apache-2.0 license
(`LICENSE`, `COPYRIGHT`).

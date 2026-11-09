# libunftp (termiHub vendored fork)

Vendored fork of [`libunftp`](https://github.com/Cloudinvoke/libunftp) `0.24.0`, the
FTP server library behind termiHub's embedded FTP server. The upstream README is
kept as `README.upstream.md`. Upstream moved from `bolcom/libunftp` to
`https://github.com/Cloudinvoke/libunftp` on 2026-10-30 (libunftp#602); the old
`bolcom` links redirect.

**Fork base:** upstream `0.24.0`, commit
[`4714769978f17a17231ae1fae02cca8d8c918cfd`](https://github.com/Cloudinvoke/libunftp/commit/4714769978f17a17231ae1fae02cca8d8c918cfd)
(tag `libunftp-0.24.0`, the crates.io release; re-based from `0.23.1` on
2026-11-09, #5119). The fork is registered in
[`vendor/vendored-forks.json`](../vendored-forks.json), and a weekly CI job
reports upstream releases, commits and advisories that the fork does not have
yet. See `docs/supply-chain.md` → "Vendored forks". Update both when re-basing
or reviewing upstream again.

It is consumed through the root `Cargo.toml` `[patch.crates-io]` table and is
excluded from the workspace, so it keeps upstream's own `rustfmt.toml` and lint
table and its sources stay comparable with upstream.

## Why this is vendored

termiHub runs one libunftp server per FTP session on a loopback port in PROXY
protocol mode, behind its own front relay (#3996). That listener trusts the
PROXY header of any connection, so a local process could connect to it directly
and claim any client IP (access log, passive-data switchboard key) and skip the
relay's control-line cap. libunftp has no way to restrict who the listener
serves, and it always binds the address itself. The fork adds both, so the relay
binds the listener and libunftp only serves connections the relay opened. See
[armaxri/termiHub#4100](https://github.com/armaxri/termiHub/issues/4100).

Earlier deltas that are now upstream, and so dropped at the 0.24.0 re-base:

- The PROXY v1 header reader no longer spins on a connection closed before its
  header (#4099): merged upstream as `24e7e10a` (libunftp#582), released in
  0.24.0.
- `LIST` keeps the whole pathname, spaces included (#4923): upstream `7142d6c4`
  (#530) and `60ede984`, released in 0.24.0.

## What this fork changes

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

The delta touches only `src/server/ftpserver.rs` and `src/server/ftpserver/`;
every other file under `src/` is byte-identical to the 0.24.0 release.

All fork changes are marked `termiHub fork delta (armaxri/termiHub#…)`.

## Upstream review

Reviewed upstream up to
[`e9230bf1`](https://github.com/Cloudinvoke/libunftp/commit/e9230bf129ab16290e858782711d035c9c1e13bb)
(2026-11-08, #4923, re-checked at the re-base #5119). Everything up to the 0.24.0
release is in the base. Of the commits after it, none is ported:

- `3c02106c` (`SiteCommandContext` gets session context and becomes
  `#[non_exhaustive]`, breaking, unreleased): termiHub registers no SITE commands.
- `ed7c634a` / `f19fbc11` (start TLS right after the `AUTH TLS` reply): needs
  FTPS, which termiHub's server does not enable.
- The rest are release, project-move, author-metadata, docs and backend-crate
  commits outside the forked crate's code.

The 0.24.0 breaking change `9cbe7219` / `60652e4e` (`DataEvent::Got` / `Put`
paths now include the working directory) does not affect termiHub: its
`StatsTracker` only counts `bytes`.

Packaging differences from the crates.io release (not code deltas):
`Cargo.toml` is the crates.io-normalised manifest with a fork note, without the
`[[test]]` targets of the upstream integration tests (`tests/` is not vendored)
and with the `unftp-sbe-fs` dev-dependency restored from crates.io (the
normalisation strips upstream's path dependency), plus a
`[package.metadata.cargo-machete]` ignore for `tracing` (used only through the
`#[tracing_attributes::instrument]` expansion) and `rustls-webpki` (never named
in source; upstream declares it as the minimum patched verifier for
RUSTSEC-2026-0382, and `rustls` uses it). Upstream's `CHANGELOG.md`,
`AGENTS.md`, `CONTRIBUTING.md`, `RELEASE-CHECKLIST.md`, `examples/`, `logo.png`,
`Makefile` and CI files are not vendored.

Tests: the unit tests above (plus upstream's own, including the PROXY header
EOF tests that came with `24e7e10a`); termiHub's
`core/src/embedded_servers/ftp_server/relay_tests.rs`:
`backend_header_reader_ends_when_a_connection_closes_without_a_header`
connects to a real session backend, closes without a header and checks that no
task is left behind, and
`direct_loopback_connection_with_a_forged_proxy_header_is_refused` checks that
direct loopback connections with forged headers are refused and logged while
relay-opened control and data connections work. Run the fork's own tests with `cargo test --lib` inside
this directory.

The delta is small and upstream-compatible (additive API, no behaviour change
for existing callers). The API proposal and patch (#4100), the history of the
merged #4099 fix, and the retirement steps are in [`UPSTREAM.md`](UPSTREAM.md).

Everything else is upstream `0.24.0`, under the original Apache-2.0 license
(`LICENSE`, `COPYRIGHT`).

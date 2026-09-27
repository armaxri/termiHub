# serial2 (termiHub vendored fork)

Vendored fork of [`serial2`](https://github.com/de-vri-es/serial2-rs) `0.2.38`,
the cross-platform serial port crate that `serial2-tokio` (and termiHub's serial
backend) is built on. The upstream README is kept as `README.upstream.md`.

**Fork base:** upstream `0.2.38`, commit
[`448a20ece5e6e37236d247ed957042420672029b`](https://github.com/de-vri-es/serial2-rs/commit/448a20ece5e6e37236d247ed957042420672029b)
(tag `v0.2.38`). The fork is registered in
[`vendor/vendored-forks.json`](../vendored-forks.json), and a weekly CI job
reports upstream releases, commits and advisories that the fork does not have
yet — see `docs/supply-chain.md` → "Vendored forks". Update both when re-basing or
reviewing upstream again.

It is consumed through the root `Cargo.toml` `[patch.crates-io]` table (so the
crates.io `serial2-tokio` uses it too) and is excluded from the workspace: its
`rustfmt.toml` uses unstable options and its `doc-cfg` feature needs nightly.

## Why this is vendored

On macOS and iOS, upstream sets **every** baud rate with the `IOSSIOSPEED`
ioctl. Pseudo-terminals (a `socat` pty pair, a serial emulator's `tty.*`) and
drivers without custom-speed support reject that ioctl with `ENOTTY`
("Inappropriate ioctl for device"), so such a port cannot be opened at all —
upstream's own `tests/pair.rs` fails on macOS for the same reason.
`serial2-tokio` offers no way to wrap a port opened by other means, so the fix
has to live in `serial2`.

See [armaxri/termiHub#3701](https://github.com/armaxri/termiHub/issues/3701).

## What this fork changes

- `src/sys/unix/mod.rs` `SerialPort::set_configuration`: when the
  `IOSSIOSPEED` ioctl fails, and `can_fall_back_to_termios_speed` allows it,
  the settings (with the real speed) are applied with `tcsetattr` instead.
- `src/sys/unix/apple.rs` `can_fall_back_to_termios_speed`: the fallback is
  taken only for `ENOTTY` / `ENOTSUP` / `EOPNOTSUPP`, equal input and output
  speeds, and a standard termios rate (`B50`..`B230400`). A non-standard rate or
  any other error still returns the original error, so a rate is never silently
  dropped. Devices that accept the ioctl (real USB-serial adapters) take exactly
  the upstream path.

Tests: unit tests in `src/sys/unix/apple.rs`; upstream `tests/pair.rs` now
passes on macOS; termiHub's `core/src/backends/serial.rs` `macos_pty` tests open
an `openpty()` slave through the serial backend. Run the fork's own tests with
`cargo test --features unix` inside this directory.

The delta is small and upstream-compatible; upstreaming it would let the fork be
retired. The ready-to-submit patch, pull-request text and retirement steps are in
[`UPSTREAM.md`](UPSTREAM.md) (#3704).

Everything else is upstream `0.2.38`, under the original BSD-2-Clause /
Apache-2.0 licenses (`LICENSE-BSD`, `LICENSE-APACHE`).

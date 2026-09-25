// TOOL-010: enforce the "no `.unwrap()`/`.expect()`/`panic!` in production Rust"
// policy (see `.claude/CLAUDE.md` → Rust). Denied for non-test builds; test code
// (`#[cfg(test)]` modules and `tests/` crates) is exempt via `not(test)`.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

#[cfg(any(
    feature = "local-shell",
    feature = "serial",
    feature = "telnet",
    feature = "ssh",
    feature = "docker",
    feature = "ftp",
    feature = "mock-remote-desktop",
    feature = "vnc",
    feature = "rdp-sidecar"
))]
pub mod backends;
pub mod buffer;
pub mod config;
pub mod connection;
#[cfg(feature = "embedded-servers")]
pub mod embedded_servers;
pub mod errors;
pub mod files;
pub mod ipc;
pub mod layout;
pub mod monitoring;
#[cfg(any(feature = "telnet", feature = "ssh"))]
pub mod net;
pub mod network;
pub mod output;
#[cfg(feature = "plugin")]
pub mod plugin;
pub mod protocol;
pub mod reconnect_backoff;
pub mod restore_mode;
pub mod service;
pub mod session;
pub mod tool;
#[cfg(feature = "ssh")]
pub mod tunnel;
pub mod util;

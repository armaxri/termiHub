//! Concrete [`ConnectionType`](crate::connection::ConnectionType) implementations.
//!
//! These backends depend on optional platform libraries (e.g., `portable-pty`,
//! `serialport`) and are gated behind cargo features so that consumers that
//! don't need them can avoid the dependency.

#[cfg(feature = "local-shell")]
pub mod local_shell;

#[cfg(feature = "serial")]
pub mod serial;

#[cfg(feature = "telnet")]
pub mod telnet;

#[cfg(feature = "ssh")]
pub mod ssh;

#[cfg(feature = "docker")]
pub mod docker;

#[cfg(all(feature = "wsl", windows))]
pub mod wsl;

// Pure, platform-independent init-script helpers used by the Windows-only WSL
// backend (#2837). Compiled on every platform under `test` so the
// security-relevant logic is exercised by the macOS/Linux CI legs too.
#[cfg(any(all(feature = "wsl", windows), test))]
pub(crate) mod wsl_init_script;

// Pure, platform-independent argument building + `CREATE_NO_WINDOW` for the
// helper `wsl.exe` spawns (monitoring, process manager, init-script create;
// #3313). Compiled on every platform under `test`, like `wsl_init_script`.
#[cfg(any(all(feature = "wsl", windows), test))]
pub(crate) mod wsl_exec;

#[cfg(feature = "ftp")]
pub mod ftp;

#[cfg(feature = "mock-remote-desktop")]
pub mod mock_remote_desktop;

#[cfg(feature = "vnc")]
pub mod vnc;

#[cfg(feature = "rdp-sidecar")]
pub mod rdp_sidecar;

// Paths below are fully qualified rather than imported: both helpers are
// feature-gated, and an ungated `use` would be unused in an `ssh`-only build.

/// The error a connect returns when it is aborted by its cancellation token.
///
/// Deliberately identical to the SSH backend's cancel path
/// (`ssh::auth::connect_and_authenticate_cancellable`), which returns
/// `SessionError::SpawnFailed("Connection cancelled")`. Returning the same
/// variant and message from every backend lets the desktop UI classify a
/// cancelled connect uniformly regardless of connection type (PARITY-007 /
/// #952).
///
/// Gated to the backends that return it (directly, or via `race_connect`).
/// SSH has its own cancel path, so an `ssh`-only build would otherwise leave
/// this dead and fail per-feature clippy under `-D warnings` (#3318).
#[cfg(any(
    feature = "local-shell",
    feature = "serial",
    feature = "telnet",
    feature = "docker",
    all(feature = "wsl", windows),
    feature = "ftp",
    feature = "mock-remote-desktop",
    feature = "vnc",
    feature = "rdp-sidecar"
))]
pub(crate) fn connect_cancelled() -> crate::errors::SessionError {
    crate::errors::SessionError::SpawnFailed("Connection cancelled".to_string())
}

/// Race an optional cancellation token against a connect future.
///
/// When `cancel` is `None`, `connect` runs to completion unchanged — the
/// non-cancelled path is behavior-identical to awaiting `connect` directly, so
/// the happy path is byte-for-byte what it was before the override existed.
///
/// When the token fires first, `connect` is dropped — which aborts its
/// in-flight, cancel-on-drop awaits (async TCP/TLS/handshake I/O) and runs any
/// RAII / `kill_on_drop` guards it holds — and [`connect_cancelled`] is
/// returned promptly instead of waiting out the connect timeout. `biased`
/// polls the token first, so an *already*-cancelled token short-circuits
/// before `connect` is ever polled: no connect work is started.
///
/// This is only correct for connect steps that register no externally-visible
/// resource until they fully succeed (so dropping one part-way leaks nothing).
/// Multi-step backends that create a durable resource mid-connect (Docker: a
/// started container) race their *pre-resource* steps with this helper but must
/// thread the token through the remaining steps and clean up on cancel, rather
/// than rely on drop.
///
/// Generic over the success type so it wraps both a whole connect
/// (`Result<()>`) and an individual step that yields a value (e.g. a runtime
/// handle).
///
/// Gated to the backends that call it: `telnet` threads its token by hand and
/// `ssh` has its own cancel path, so a telnet- or ssh-only build would otherwise
/// leave this dead and fail per-feature clippy under `-D warnings` (#3318).
#[cfg(any(
    feature = "local-shell",
    feature = "serial",
    feature = "docker",
    all(feature = "wsl", windows),
    feature = "ftp",
    feature = "mock-remote-desktop",
    feature = "vnc",
    feature = "rdp-sidecar"
))]
pub(crate) async fn race_connect<T, F>(
    cancel: Option<tokio_util::sync::CancellationToken>,
    connect: F,
) -> Result<T, crate::errors::SessionError>
where
    F: std::future::Future<Output = Result<T, crate::errors::SessionError>>,
{
    match cancel {
        Some(token) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => Err(connect_cancelled()),
                res = connect => res,
            }
        }
        None => connect.await,
    }
}

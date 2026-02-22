//! Local shell backend implementing [`ConnectionType`](crate::connection::ConnectionType).
//!
//! Uses `portable-pty` for cross-platform PTY management. This is the
//! canonical local shell implementation, used by both the desktop and
//! agent crates (the desktop crate previously had its own implementation
//! in `src-tauri/src/terminal/local_shell.rs`).

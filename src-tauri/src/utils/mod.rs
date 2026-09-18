pub mod config_paths;
pub mod docker_detect;
pub mod download;
pub mod errors;
pub mod expand;
/// Rotating, size-capped application log file written to the platform's
/// conventional log directory (#1570).
pub mod file_log;
pub mod fs;
/// Efficient byte transport across the Tauri IPC boundary via base64 (PERF-009).
pub mod ipc_bytes;
pub mod log_capture;
/// macOS anti-throttling for the headless full-app E2E test bridge (#2480).
/// Test-bridge-only (SEC-005); compiled out of release builds.
#[cfg(all(target_os = "macos", feature = "test-bridge"))]
pub mod macos_unthrottle;
/// Schema-version migration + downgrade data-safety for the JSON config stores
/// (PER-001 / PER-004 / PER-010).
pub mod migrate;
pub mod panic_hook;
pub mod portable;
pub mod remote_exec;
pub mod shell_detect;
/// Single-instance enforcement (per user) for installed release builds
/// (PER-005 / SM-025). Prevents two copies clobbering shared config/session
/// files by focusing the running window and exiting the second launch.
pub mod single_instance;
pub mod ssh_auth;
pub mod ssh_key_convert;
pub mod ssh_key_validate;
/// Cross-platform WebSocket test bridge (#801) + its CSP relaxation.
/// Test-only (SEC-005); compiled out of release builds via the `test-bridge`
/// feature so the shipped binary can never be switched into bridge mode.
#[cfg(feature = "test-bridge")]
pub mod test_bridge;
pub mod version;
pub mod vscode;
/// Linux-only WebKitGTK webview console + page-load diagnostics for the full-app
/// test bridge (#2646). Test-bridge-only (SEC-005); compiled out of release.
#[cfg(all(target_os = "linux", feature = "test-bridge"))]
pub mod webview_console;
pub mod x11_detect;

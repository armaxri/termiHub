pub mod config_paths;
pub mod docker_detect;
pub mod download;
pub mod errors;
pub mod expand;
/// Rotating, size-capped application log file written to the platform's
/// conventional log directory (#1570).
pub mod file_log;
pub mod fs;
pub mod log_capture;
/// macOS anti-throttling for the headless full-app E2E test bridge (#2480).
#[cfg(target_os = "macos")]
pub mod macos_unthrottle;
/// Schema-version migration + downgrade data-safety for the JSON config stores
/// (PER-001 / PER-004 / PER-010).
pub mod migrate;
pub mod panic_hook;
pub mod portable;
pub mod remote_exec;
pub mod shell_detect;
pub mod ssh_auth;
pub mod ssh_key_convert;
pub mod ssh_key_validate;
pub mod test_bridge;
pub mod version;
pub mod vscode;
/// Linux-only WebKitGTK webview console + page-load diagnostics for the full-app
/// test bridge (#2646).
#[cfg(target_os = "linux")]
pub mod webview_console;
pub mod x11_detect;

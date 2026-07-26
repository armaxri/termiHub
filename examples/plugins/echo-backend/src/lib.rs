//! Example termiHub native terminal-backend plugin.
//!
//! `echo-backend` is the smallest useful plugin that exercises the native
//! terminal-backend path: every byte written to the session is echoed straight
//! back to the host's output channel, optionally prefixed with a configurable
//! string. It is a **reference** for the four exported ABI symbols and for
//! implementing [`PluginTerminalBackend`] — not a production backend.
//!
//! # The ABI contract
//!
//! A native plugin is a `cdylib` that exports exactly four `extern "C"` symbols,
//! resolved by the host loader (see [`termihub_plugin_api::symbols`]):
//!
//! | Symbol | Purpose |
//! | --- | --- |
//! | `termihub_plugin_abi_version` | ABI version this plugin was built against |
//! | `termihub_plugin_init` | fills in the plugin's [`PluginInfo`] metadata |
//! | `termihub_plugin_create_backend` | builds a session backend from config |
//! | `termihub_plugin_shutdown` | process-wide cleanup before unload |
//!
//! Everything crossing the boundary is `#[repr(C)]` or an opaque handle — see the
//! `termihub-plugin-api` crate docs for why Rust's own types must not.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use termihub_plugin_api::{
    PluginBackend, PluginError, PluginInfo, PluginOutputSender, PluginSessionConfig, PluginStatus,
    PluginTerminalBackend, CURRENT_PLUGIN_API_VERSION,
};

/// Session configuration this backend accepts, matching the `configSchema`
/// declared in `manifest.json`. All fields optional so an empty `{}` config works.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct EchoConfig {
    /// Text prepended to every echoed chunk (e.g. `"echo> "`).
    echo_prefix: String,
}

/// The running "session": it owns the host's output sink and echoes input to it.
struct EchoBackend {
    output: PluginOutputSender,
    prefix: Vec<u8>,
    alive: AtomicBool,
}

impl PluginTerminalBackend for EchoBackend {
    fn write_input(&self, data: &[u8]) -> Result<(), PluginError> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(PluginError::NotAlive);
        }
        if self.prefix.is_empty() {
            self.output.send(data)
        } else {
            let mut chunk = Vec::with_capacity(self.prefix.len() + data.len());
            chunk.extend_from_slice(&self.prefix);
            chunk.extend_from_slice(data);
            self.output.send(&chunk)
        }
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), PluginError> {
        // A pure echo has no PTY to resize.
        Ok(())
    }

    fn close(&self) -> Result<(), PluginError> {
        self.alive.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

/// Build a boxed backend from a parsed config and the host's output sink.
///
/// Factored out of the `extern "C"` shim so it can be unit-tested with the safe
/// wrapper (see the tests below), with no dynamic library involved.
fn build_backend(
    config: &EchoConfig,
    output: PluginOutputSender,
) -> Box<dyn PluginTerminalBackend> {
    Box::new(EchoBackend {
        output,
        prefix: config.echo_prefix.clone().into_bytes(),
        alive: AtomicBool::new(true),
    })
}

/// ABI version this plugin was compiled against. The host compares it to its own
/// [`CURRENT_PLUGIN_API_VERSION`] before calling anything else.
#[no_mangle]
pub extern "C" fn termihub_plugin_abi_version() -> u32 {
    CURRENT_PLUGIN_API_VERSION
}

/// Report this plugin's metadata into the host-allocated `out_info`.
///
/// # Safety
///
/// `out_info` must be a valid, writable pointer to a [`PluginInfo`]; ownership of
/// the strings written into it transfers to the host.
#[no_mangle]
pub unsafe extern "C" fn termihub_plugin_init(out_info: *mut PluginInfo) -> PluginStatus {
    if out_info.is_null() {
        return PluginStatus::Other;
    }
    // SAFETY: the caller guarantees `out_info` is valid and writable.
    unsafe {
        out_info.write(PluginInfo::new(
            "echo-backend",
            "Echo Backend",
            env!("CARGO_PKG_VERSION"),
            CURRENT_PLUGIN_API_VERSION,
        ));
    }
    PluginStatus::Ok
}

/// Create a session backend from the borrowed `config`, taking ownership of
/// `output`, and write the resulting [`PluginBackend`] into `out_backend`.
///
/// # Safety
///
/// `config` (if non-null) and `out_backend` must be valid pointers for the
/// duration of the call; `output` is consumed.
#[no_mangle]
pub unsafe extern "C" fn termihub_plugin_create_backend(
    config: *const PluginSessionConfig,
    output: PluginOutputSender,
    out_backend: *mut PluginBackend,
) -> PluginStatus {
    if out_backend.is_null() {
        return PluginStatus::Other;
    }

    // Parse the borrowed config JSON (empty/absent => defaults).
    let parsed = if config.is_null() {
        EchoConfig::default()
    } else {
        // SAFETY: caller guarantees `config` is valid for the call; `config_json`
        // borrows host-owned memory that outlives this function.
        let json = unsafe { (*config).config_json.as_str() };
        if json.trim().is_empty() {
            EchoConfig::default()
        } else {
            match serde_json::from_str::<EchoConfig>(json) {
                Ok(cfg) => cfg,
                Err(_) => return PluginStatus::InvalidConfig,
            }
        }
    };

    let backend = PluginBackend::from_boxed(build_backend(&parsed, output));
    // SAFETY: caller guarantees `out_backend` is valid and writable.
    unsafe {
        out_backend.write(backend);
    }
    PluginStatus::Ok
}

/// Process-wide cleanup before the library is unloaded. Nothing to do here.
#[no_mangle]
pub extern "C" fn termihub_plugin_shutdown() {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use termihub_plugin_api::LoadedBackend;

    /// Drive the backend through the safe host-side wrapper, exactly as the host
    /// loader would — no dynamic library needed.
    fn loaded(prefix: &str) -> (LoadedBackend, mpsc::Receiver<Vec<u8>>) {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let output = PluginOutputSender::from_sender(tx);
        let cfg = EchoConfig {
            echo_prefix: prefix.to_string(),
        };
        let backend = PluginBackend::from_boxed(build_backend(&cfg, output));
        // SAFETY: `backend` was just produced by `from_boxed`.
        (unsafe { LoadedBackend::from_raw(backend) }, rx)
    }

    #[test]
    fn abi_version_matches_the_api_crate() {
        assert_eq!(termihub_plugin_abi_version(), CURRENT_PLUGIN_API_VERSION);
    }

    #[test]
    fn echoes_input_back() {
        let (backend, rx) = loaded("");
        backend.write_input(b"hello").unwrap();
        assert_eq!(rx.recv().unwrap(), b"hello".to_vec());
    }

    #[test]
    fn applies_configured_prefix() {
        let (backend, rx) = loaded("echo> ");
        backend.write_input(b"hi").unwrap();
        assert_eq!(rx.recv().unwrap(), b"echo> hi".to_vec());
    }

    #[test]
    fn not_alive_after_close() {
        let (backend, _rx) = loaded("");
        assert!(backend.is_alive());
        backend.close().unwrap();
        assert!(!backend.is_alive());
        assert!(backend.write_input(b"x").is_err());
    }

    #[test]
    fn init_reports_metadata() {
        let mut info = PluginInfo::empty();
        // SAFETY: `&mut info` is a valid, writable PluginInfo pointer.
        let status = unsafe { termihub_plugin_init(&mut info) };
        assert_eq!(status, PluginStatus::Ok);
        assert_eq!(info.id.as_str(), "echo-backend");
        assert_eq!(info.api_version, CURRENT_PLUGIN_API_VERSION);
    }
}

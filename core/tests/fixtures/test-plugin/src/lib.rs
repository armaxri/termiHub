//! A minimal native plugin `cdylib` fixture for the host-loader round-trip test
//! (`core/tests/plugin_host_roundtrip.rs`, #1995).
//!
//! It implements the sound, `#[repr(C)]` opaque-handle ABI from
//! `termihub-plugin-api` (#1990): an echo backend that writes any input it
//! receives straight back to the host's output channel. The four exported
//! symbols mirror the contract documented in `termihub_plugin_api::symbols`.
//!
//! Two knobs let the single fixture drive every test scenario:
//!
//! * `termihub_plugin_abi_version` reads the `TERMIHUB_TEST_PLUGIN_ABI`
//!   environment variable at call time, so the test can force an incompatible
//!   value without rebuilding.
//! * `termihub_plugin_init` is gated behind the `export-init` feature (on by
//!   default), so a `--no-default-features` build omits it and exercises the
//!   loader's missing-symbol path.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
#[cfg(feature = "export-init")]
use termihub_plugin_api::PluginInfo;
use termihub_plugin_api::{
    PluginBackend, PluginError, PluginHostBridge, PluginOutputSender, PluginSessionConfig,
    PluginStatus, PluginTerminalBackend, PluginWriteMode, CURRENT_PLUGIN_API_VERSION,
};

/// A backend that echoes written input straight back to the host output sink.
struct EchoBackend {
    output: PluginOutputSender,
    alive: AtomicBool,
}

impl PluginTerminalBackend for EchoBackend {
    fn write_input(&self, data: &[u8]) -> Result<(), PluginError> {
        self.output.send(data)
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), PluginError> {
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

/// Report the ABI version. Honours `TERMIHUB_TEST_PLUGIN_ABI` so the test can
/// force an incompatible value at load time.
#[no_mangle]
pub extern "C" fn termihub_plugin_abi_version() -> u32 {
    std::env::var("TERMIHUB_TEST_PLUGIN_ABI")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(CURRENT_PLUGIN_API_VERSION)
}

/// Fill in the plugin metadata. Omitted from `--no-default-features` builds so
/// the loader's missing-symbol handling can be tested.
///
/// # Safety
///
/// `out_info` must be a valid, writable `*mut PluginInfo`.
#[cfg(feature = "export-init")]
#[no_mangle]
pub unsafe extern "C" fn termihub_plugin_init(out_info: *mut PluginInfo) -> PluginStatus {
    if out_info.is_null() {
        return PluginStatus::Other;
    }
    // SAFETY: caller guarantees `out_info` is valid and writable.
    unsafe {
        out_info.write(PluginInfo::new(
            "test-echo",
            "Test Echo",
            "0.1.0",
            CURRENT_PLUGIN_API_VERSION,
        ));
    }
    PluginStatus::Ok
}

/// Optional capability-bridge probe driven by the session config, so the
/// host-loader tests can exercise the runtime permission enforcement (#2018)
/// across the real dlopen boundary. Absent for the plain echo scenarios.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ProbeConfig {
    /// One of `"network"`, `"readfile"`, `"writefile"`, `"appendfile"`,
    /// `"createfile"`, `"statpath"`, `"listdir"`; empty means "no probe, just
    /// echo".
    probe: String,
    /// Target host for the `network` probe.
    probe_host: String,
    /// Target port for the `network` probe.
    probe_port: u16,
    /// Target path for the filesystem probes.
    probe_path: String,
    /// Bytes to write for the `writefile`/`appendfile`/`createfile` probes.
    probe_data: String,
}

/// Run the requested capability probe through the host `bridge` and report the
/// outcome as a single line on the `output` sink. The test asserts on this line
/// to prove the host actually enforces (or grants) the capability end-to-end.
fn run_probe(cfg: &ProbeConfig, bridge: &PluginHostBridge, output: &PluginOutputSender) {
    match cfg.probe.as_str() {
        "network" => {
            let line = match bridge.open_connection(&cfg.probe_host, cfg.probe_port) {
                Ok(mut stream) => {
                    // Prove the mediated stream is usable, best-effort.
                    let _ = stream.write_all(b"ping");
                    b"NETWORK_OK".to_vec()
                }
                Err(PluginError::PermissionDenied) => b"NETWORK_DENIED".to_vec(),
                Err(_) => b"NETWORK_ERR".to_vec(),
            };
            let _ = output.send(&line);
        }
        "readfile" => {
            let line = match bridge.read_file(&cfg.probe_path) {
                Ok(bytes) => {
                    let mut line = b"READ_OK:".to_vec();
                    line.extend_from_slice(&bytes);
                    line
                }
                Err(PluginError::PermissionDenied) => b"READ_DENIED".to_vec(),
                Err(_) => b"READ_ERR".to_vec(),
            };
            let _ = output.send(&line);
        }
        "writefile" | "appendfile" | "createfile" => {
            let mode = match cfg.probe.as_str() {
                "appendfile" => PluginWriteMode::Append,
                "createfile" => PluginWriteMode::CreateNew,
                _ => PluginWriteMode::Truncate,
            };
            let line = match bridge.write_file(&cfg.probe_path, cfg.probe_data.as_bytes(), mode) {
                Ok(()) => b"WRITE_OK".to_vec(),
                Err(PluginError::PermissionDenied) => b"WRITE_DENIED".to_vec(),
                Err(_) => b"WRITE_ERR".to_vec(),
            };
            let _ = output.send(&line);
        }
        "statpath" => {
            let line = match bridge.stat(&cfg.probe_path) {
                Ok(meta) if meta.exists && meta.is_dir => b"STAT_DIR".to_vec(),
                Ok(meta) if meta.exists => format!("STAT_FILE:{}", meta.len).into_bytes(),
                Ok(_) => b"STAT_ABSENT".to_vec(),
                Err(PluginError::PermissionDenied) => b"STAT_DENIED".to_vec(),
                Err(_) => b"STAT_ERR".to_vec(),
            };
            let _ = output.send(&line);
        }
        "listdir" => {
            let line = match bridge.list_dir(&cfg.probe_path) {
                Ok(mut entries) => {
                    entries.sort();
                    format!("LIST_OK:{}", entries.join(",")).into_bytes()
                }
                Err(PluginError::PermissionDenied) => b"LIST_DENIED".to_vec(),
                Err(_) => b"LIST_ERR".to_vec(),
            };
            let _ = output.send(&line);
        }
        _ => {}
    }
}

/// Create an [`EchoBackend`] session.
///
/// If the config declares a `probe`, first exercise the host capability `bridge`
/// and report the outcome on `output` (the #2018 runtime-enforcement path);
/// otherwise the `bridge` is simply dropped and the backend is a plain echo.
///
/// # Safety
///
/// `out_backend` must be a valid, writable `*mut PluginBackend`.
#[no_mangle]
pub unsafe extern "C" fn termihub_plugin_create_backend(
    config: *const PluginSessionConfig,
    output: PluginOutputSender,
    bridge: PluginHostBridge,
    out_backend: *mut PluginBackend,
) -> PluginStatus {
    if out_backend.is_null() {
        return PluginStatus::Other;
    }

    // Parse the optional probe config (absent/empty => plain echo).
    let cfg = if config.is_null() {
        ProbeConfig::default()
    } else {
        // SAFETY: caller guarantees `config` is valid for the call; `config_json`
        // borrows host-owned memory that outlives this function.
        let json = unsafe { (*config).config_json.as_str() };
        serde_json::from_str::<ProbeConfig>(json).unwrap_or_default()
    };
    if !cfg.probe.is_empty() {
        run_probe(&cfg, &bridge, &output);
    }
    // The echo backend keeps no network/filesystem state, so the bridge is done.
    drop(bridge);

    let backend = PluginBackend::from_boxed(Box::new(EchoBackend {
        output,
        alive: AtomicBool::new(true),
    }));
    // SAFETY: caller guarantees `out_backend` is valid and writable.
    unsafe {
        out_backend.write(backend);
    }
    PluginStatus::Ok
}

/// Process-wide cleanup before unload. Nothing to do for the echo fixture.
#[no_mangle]
pub extern "C" fn termihub_plugin_shutdown() {}

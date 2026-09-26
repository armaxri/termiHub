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
//!   environment variable at call time (`"major.minor"`, or a raw packed `u32`
//!   to simulate a pre-freeze plugin), so the test can force an incompatible
//!   value without rebuilding. `TERMIHUB_TEST_PLUGIN_INFO_ABI` likewise
//!   overrides the version reported in `PluginInfo`, to simulate a plugin whose
//!   two version reports disagree.
//! * `termihub_plugin_init` is gated behind the `export-init` feature (on by
//!   default), so a `--no-default-features` build omits it and exercises the
//!   loader's missing-symbol path.
//! * `TERMIHUB_TEST_PLUGIN_RUSTC` / `TERMIHUB_TEST_PLUGIN_PANIC` override the
//!   build toolchain reported in `PluginInfo` (ABI 1.1, PLG-013), to simulate a
//!   plugin built with another compiler or panic strategy.
//! * The `abi-1-0` feature builds a faithful **ABI 1.0** plugin: it reports
//!   ABI 1.0, writes only the frozen 1.0 `PluginInfo` prefix (no toolchain
//!   record) and never reads the 1.1 host context — the shape of a plugin built
//!   before #3576.
//! * The `context` probe (ABI 1.1 builds) reports the host context it received
//!   and logs through it; writing `?cancelled` to such a session reports the
//!   cancellation flag (PLG-014).

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
#[cfg(feature = "export-init")]
use termihub_plugin_api::PluginInfo;
use termihub_plugin_api::{
    AbiVersion, PluginBackend, PluginError, PluginHostBridge, PluginHostServices,
    PluginOutputSender, PluginSessionConfig, PluginStatus, PluginTerminalBackend,
    PluginWriteMode,
};

/// The ABI this build reports: a faithful 1.0 plugin under `abi-1-0`, else the
/// SDK's current ABI.
#[cfg(feature = "abi-1-0")]
const FIXTURE_ABI: AbiVersion = AbiVersion::new(1, 0);
#[cfg(not(feature = "abi-1-0"))]
const FIXTURE_ABI: AbiVersion = termihub_plugin_api::CURRENT_PLUGIN_ABI_VERSION;

/// A backend that echoes written input straight back to the host output sink.
struct EchoBackend {
    output: PluginOutputSender,
    alive: AtomicBool,
    /// The ABI 1.1 host services, kept for the `?cancelled` query.
    services: Option<PluginHostServices>,
}

impl PluginTerminalBackend for EchoBackend {
    fn write_input(&self, data: &[u8]) -> Result<(), PluginError> {
        if data == b"?cancelled" {
            let reply = match &self.services {
                Some(services) => format!("CANCELLED:{}", services.is_cancelled()),
                None => "CANCELLED:none".to_owned(),
            };
            return self.output.send(reply.as_bytes());
        }
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

/// Read an ABI override from `var`: `"major.minor"`, or a raw packed `u32`.
fn abi_override(var: &str) -> Option<u32> {
    let value = std::env::var(var).ok()?;
    AbiVersion::parse(&value)
        .map(AbiVersion::to_packed)
        .or_else(|| value.parse().ok())
}

/// Report the ABI version. Honours `TERMIHUB_TEST_PLUGIN_ABI` so the test can
/// force an incompatible value at load time.
#[no_mangle]
pub extern "C" fn termihub_plugin_abi_version() -> u32 {
    abi_override("TERMIHUB_TEST_PLUGIN_ABI").unwrap_or(FIXTURE_ABI.to_packed())
}

/// `PluginInfo` exactly as ABI 1.0 froze it — what a pre-1.1 plugin writes.
#[cfg(all(feature = "export-init", feature = "abi-1-0"))]
#[repr(C)]
struct PluginInfoV1_0 {
    id: termihub_plugin_api::FfiString,
    name: termihub_plugin_api::FfiString,
    version: termihub_plugin_api::FfiString,
    api_version: u32,
}

/// Write the fixture's metadata as a faithful ABI 1.0 plugin: only the 1.0
/// prefix of the host's (larger) `PluginInfo`.
///
/// # Safety
///
/// `out_info` must be valid and writable for at least the 1.0 prefix.
#[cfg(all(feature = "export-init", feature = "abi-1-0"))]
unsafe fn write_info(out_info: *mut PluginInfo) {
    let info = PluginInfoV1_0 {
        id: "test-echo".into(),
        name: "Test Echo".into(),
        version: "0.1.0".into(),
        api_version: abi_override("TERMIHUB_TEST_PLUGIN_INFO_ABI")
            .unwrap_or(FIXTURE_ABI.to_packed()),
    };
    // SAFETY: caller contract.
    unsafe { out_info.cast::<PluginInfoV1_0>().write(info) };
}

/// Write the fixture's metadata as a current-ABI plugin, honoring the ABI and
/// toolchain overrides.
///
/// # Safety
///
/// `out_info` must be valid and writable.
#[cfg(all(feature = "export-init", not(feature = "abi-1-0")))]
unsafe fn write_info(out_info: *mut PluginInfo) {
    let mut info = PluginInfo::new("test-echo", "Test Echo", "0.1.0");
    if let Some(packed) = abi_override("TERMIHUB_TEST_PLUGIN_INFO_ABI") {
        info.api_version = packed;
    }
    if let Ok(rustc) = std::env::var("TERMIHUB_TEST_PLUGIN_RUSTC") {
        info.rustc = rustc.into();
    }
    if let Ok(panic) = std::env::var("TERMIHUB_TEST_PLUGIN_PANIC") {
        info.panic_strategy = match panic.as_str() {
            "abort" => termihub_plugin_api::PanicStrategy::Abort,
            "unwind" => termihub_plugin_api::PanicStrategy::Unwind,
            _ => termihub_plugin_api::PanicStrategy::Unknown,
        }
        .to_wire();
    }
    // SAFETY: caller contract.
    unsafe { out_info.write(info) };
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
    unsafe { write_info(out_info) };
    PluginStatus::Ok
}

/// Optional capability-bridge probe driven by the session config, so the
/// host-loader tests can exercise the runtime permission enforcement (#2018)
/// across the real dlopen boundary. Absent for the plain echo scenarios.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ProbeConfig {
    /// One of `"network"`, `"connlimit"`, `"readfile"`, `"writefile"`,
    /// `"appendfile"`, `"createfile"`, `"statpath"`, `"listdir"`; empty means "no
    /// probe, just echo".
    probe: String,
    /// Target host for the `network` probe.
    probe_host: String,
    /// Target port for the `network`/`connlimit` probe.
    probe_port: u16,
    /// Number of connections the `connlimit` probe opens and holds concurrently.
    probe_count: u16,
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
        "connlimit" => {
            // Open `probe_count` connections and hold them all open at once, so
            // the host's per-session concurrency ceiling (#2028) governs how many
            // succeed. A ceiling refusal now surfaces as the dedicated
            // `ResourceLimit` status (#2030), distinct from a permission denial —
            // only that status counts as `denied` here, so the assertion proves
            // the host reports the new status on the ceiling path. Report the
            // allowed/denied split as a single line.
            let mut held = Vec::new();
            let mut ok = 0u16;
            let mut denied = 0u16;
            for _ in 0..cfg.probe_count {
                match bridge.open_connection(&cfg.probe_host, cfg.probe_port) {
                    Ok(stream) => {
                        ok += 1;
                        held.push(stream);
                    }
                    Err(PluginError::ResourceLimit) => denied += 1,
                    Err(_) => {}
                }
            }
            let _ = output.send(format!("CONNLIMIT:{ok}:{denied}").as_bytes());
            // Hold the streams until after the line is sent, then drop them.
            drop(held);
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
    if cfg.probe == "settings" {
        // Report the plugin-level settings the host delivered (PLG-008) as a
        // single line, so a test can assert they crossed the real ABI boundary.
        let settings_json = if config.is_null() {
            ""
        } else {
            // SAFETY: caller guarantees `config` is valid for the call;
            // `settings_json` borrows host-owned memory that outlives this call.
            unsafe { (*config).settings_json.as_str() }
        };
        let mut line = b"SETTINGS:".to_vec();
        line.extend_from_slice(settings_json.as_bytes());
        let _ = output.send(&line);
    } else if cfg.probe == "context" {
        let line = context_probe_line(config);
        let _ = output.send(line.as_bytes());
    } else if !cfg.probe.is_empty() {
        run_probe(&cfg, &bridge, &output);
    }
    let services = session_services(config);
    // The echo backend keeps no network/filesystem state, so the bridge is done.
    drop(bridge);

    let backend = PluginBackend::from_boxed(Box::new(EchoBackend {
        output,
        alive: AtomicBool::new(true),
        services,
    }));
    // SAFETY: caller guarantees `out_backend` is valid and writable.
    unsafe {
        out_backend.write(backend);
    }
    PluginStatus::Ok
}

/// Report the ABI 1.1 host context as `CTX:<host version>|<data dir>|<data
/// dir writable>|<cancelled>|<log status>`, logging a line through it. A 1.0
/// build never reads the context and reports `CTX:none`.
#[cfg(not(feature = "abi-1-0"))]
fn context_probe_line(config: *const PluginSessionConfig) -> String {
    if config.is_null() {
        return "CTX:none".to_owned();
    }
    // SAFETY: an ABI 1.1 plugin on a 1.1+ host, during the create call.
    let Some(ctx) = (unsafe { (*config).context() }) else {
        return "CTX:none".to_owned();
    };
    let data_dir = ctx
        .data_dir
        .as_ref()
        .map(|d| d.display().to_string())
        .unwrap_or_else(|| "-".to_owned());
    let writable = ctx
        .data_dir
        .as_ref()
        .is_some_and(|d| std::fs::write(d.join("probe.txt"), b"ok").is_ok());
    let log = ctx
        .services
        .log(termihub_plugin_api::PluginLogLevel::Info, "context probe")
        .is_ok();
    format!(
        "CTX:{}|{}|{}|{}|{}",
        ctx.host_version,
        data_dir,
        writable,
        ctx.services.is_cancelled(),
        log
    )
}

#[cfg(feature = "abi-1-0")]
fn context_probe_line(_config: *const PluginSessionConfig) -> String {
    "CTX:none".to_owned()
}

/// Keep the session's host services (ABI 1.1) for the `?cancelled` query.
#[cfg(not(feature = "abi-1-0"))]
fn session_services(config: *const PluginSessionConfig) -> Option<PluginHostServices> {
    if config.is_null() {
        return None;
    }
    // SAFETY: an ABI 1.1 plugin on a 1.1+ host, during the create call.
    unsafe { (*config).context() }.map(|ctx| ctx.services)
}

#[cfg(feature = "abi-1-0")]
fn session_services(_config: *const PluginSessionConfig) -> Option<PluginHostServices> {
    None
}

/// Process-wide cleanup before unload. Nothing to do for the echo fixture.
#[no_mangle]
pub extern "C" fn termihub_plugin_shutdown() {}

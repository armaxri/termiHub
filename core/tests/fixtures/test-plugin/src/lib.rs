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

use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(feature = "export-init")]
use termihub_plugin_api::PluginInfo;
use termihub_plugin_api::{
    PluginBackend, PluginError, PluginOutputSender, PluginSessionConfig, PluginStatus,
    PluginTerminalBackend, CURRENT_PLUGIN_API_VERSION,
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

/// Create an [`EchoBackend`] session.
///
/// # Safety
///
/// `out_backend` must be a valid, writable `*mut PluginBackend`.
#[no_mangle]
pub unsafe extern "C" fn termihub_plugin_create_backend(
    _config: *const PluginSessionConfig,
    output: PluginOutputSender,
    out_backend: *mut PluginBackend,
) -> PluginStatus {
    if out_backend.is_null() {
        return PluginStatus::Other;
    }
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

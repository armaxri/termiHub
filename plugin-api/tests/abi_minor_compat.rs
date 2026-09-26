//! An **older-minor plugin on a newer host** (#3367 PLG-003, #3576).
//!
//! This crate is now at ABI **1.1** (PLG-013 toolchain record, PLG-014 host
//! context). This test proves the 1.1 additions are genuinely append-only by
//! driving the real 1.1 host-side types with a **1.0-shaped plugin**: code that
//! only knows the 1.0 layouts, reproduced here verbatim from the 1.0 freeze
//! (`PluginInfoV1_0`, `PluginSessionConfigV1_0`). It checks that
//!
//! * a 1.0 plugin still passes the load gate on a 1.1 host;
//! * a 1.0 plugin's `plugin_init` writes only the 1.0 prefix of the host's 1.1
//!   `PluginInfo`, the appended toolchain fields keep their host defaults, and
//!   the host reads them only when the plugin's ABI supports 1.1;
//! * a 1.0 plugin reading the 1.1 `PluginSessionConfig` sees exactly the 1.0
//!   fields at the 1.0 offsets, whatever the appended context pointer holds;
//! * a still-newer host (simulated 1.2) can keep growing the host-owned tables
//!   without disturbing a plugin compiled against 1.1.

use core::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};

use termihub_plugin_api::capabilities::PluginWriteMode;
use termihub_plugin_api::{
    AbiVersion, FfiByteSlice, FfiOwnedBytes, FfiStr, FfiString, PanicStrategy, PluginError,
    PluginFileMetadata, PluginHostBridge, PluginHostBridgeVTable, PluginInfo, PluginSessionConfig,
    PluginStatus, PluginTcpStream, Toolchain, ABI_1_1, CURRENT_PLUGIN_ABI_VERSION,
};

const ABI_1_0: AbiVersion = AbiVersion::new(1, 0);

#[test]
fn older_minor_plugin_passes_the_load_gate_on_a_newer_host() {
    assert_eq!(CURRENT_PLUGIN_ABI_VERSION, ABI_1_1);
    assert_eq!(
        ABI_1_0.check_host_compatibility(CURRENT_PLUGIN_ABI_VERSION),
        Ok(())
    );
    // …but the reverse (a 1.1 plugin on a 1.0 host) is refused.
    assert!(ABI_1_1.check_host_compatibility(ABI_1_0).is_err());
    // The host gates the 1.1 additions on the plugin's minor.
    assert!(!ABI_1_0.supports(ABI_1_1));
    assert!(ABI_1_1.supports(ABI_1_1));
}

// --- The 1.0 layouts, verbatim from the freeze. ---

/// `PluginInfo` exactly as ABI 1.0 froze it.
#[repr(C)]
struct PluginInfoV1_0 {
    id: FfiString,
    name: FfiString,
    version: FfiString,
    api_version: u32,
}

/// `PluginSessionConfig` exactly as ABI 1.0 froze it.
#[repr(C)]
struct PluginSessionConfigV1_0 {
    config_json: FfiStr,
    settings_json: FfiStr,
}

/// A 1.0 plugin's `termihub_plugin_init`: writes a 1.0-sized `PluginInfo`
/// through the pointer the (1.1) host passes.
unsafe extern "C" fn plugin_1_0_init(out: *mut PluginInfo) -> PluginStatus {
    let info = PluginInfoV1_0 {
        id: FfiString::from_string("old".to_owned()),
        name: FfiString::from_string("Old Plugin".to_owned()),
        version: FfiString::from_string("0.1.0".to_owned()),
        api_version: ABI_1_0.to_packed(),
    };
    // SAFETY: the host passes a valid, writable pointer to at least a 1.0
    // `PluginInfo`; a 1.0 plugin writes exactly that prefix.
    unsafe { out.cast::<PluginInfoV1_0>().write(info) };
    PluginStatus::Ok
}

/// A 1.0 plugin reading its session config: only the 1.0 fields.
unsafe fn plugin_1_0_read_config(config: *const PluginSessionConfig) -> (String, String) {
    // SAFETY: the host's config starts with the 1.0 prefix.
    let old = unsafe { &*config.cast::<PluginSessionConfigV1_0>() };
    // SAFETY: both strings are live for the call.
    unsafe {
        (
            old.config_json.as_str().to_owned(),
            old.settings_json.as_str().to_owned(),
        )
    }
}

#[test]
fn a_1_0_plugin_fills_only_the_1_0_prefix_of_the_1_1_plugin_info() {
    let mut info = PluginInfo::empty();
    // SAFETY: `&mut info` is a valid 1.1 PluginInfo, a superset of 1.0.
    assert_eq!(unsafe { plugin_1_0_init(&mut info) }, PluginStatus::Ok);
    assert_eq!(info.id.as_str(), "old");
    assert_eq!(info.name.as_str(), "Old Plugin");
    assert_eq!(info.abi_version(), ABI_1_0);
    // The appended 1.1 fields kept the host's empty defaults…
    assert_eq!(info.rustc.as_str(), "");
    assert_eq!(info.panic_strategy, PanicStrategy::WIRE_UNKNOWN);
    // …and the host would not read them anyway: the plugin is 1.0.
    assert!(!info.abi_version().supports(ABI_1_1));
    drop(info); // the untouched defaults are empty FfiStrings: dropping is sound
}

#[test]
fn a_1_1_plugin_reports_its_toolchain() {
    let info = PluginInfo::new("new", "New Plugin", "0.2.0");
    assert!(info.abi_version().supports(ABI_1_1));
    let reported = info.toolchain();
    assert_eq!(reported, Toolchain::current());
    assert!(reported.is_known());
    assert_eq!(
        reported.check_host_compatibility(&Toolchain::current()),
        Ok(())
    );
}

#[test]
fn a_1_0_plugin_reads_the_1_1_session_config_through_its_prefix() {
    let config = PluginSessionConfig::with_settings(r#"{"a":1}"#, r#"{"s":2}"#);
    // SAFETY: `config` is live for the call.
    let (cfg, settings) = unsafe { plugin_1_0_read_config(&config) };
    assert_eq!(cfg, r#"{"a":1}"#);
    assert_eq!(settings, r#"{"s":2}"#);
    // And the host passes no context to a plugin that cannot read it.
    assert!(config.host_context.is_null());
}

// --- A simulated ABI 1.2 host keeps growing host-owned tables. ---

/// A 1.2 host's bridge table: the frozen prefix, then an appended callback.
#[repr(C)]
struct HostBridgeVTableV1_2 {
    base: PluginHostBridgeVTable,
    later: unsafe extern "C" fn(ctx: *mut c_void) -> PluginStatus,
}

static READS: AtomicUsize = AtomicUsize::new(0);

unsafe extern "C" fn host_open(
    _ctx: *mut c_void,
    _host: FfiStr,
    _port: u16,
    _out: *mut PluginTcpStream,
) -> PluginStatus {
    PluginStatus::PermissionDenied
}
unsafe extern "C" fn host_read_file(
    _ctx: *mut c_void,
    _path: FfiStr,
    out: *mut FfiOwnedBytes,
) -> PluginStatus {
    READS.fetch_add(1, Ordering::SeqCst);
    // SAFETY: the plugin passes a valid, writable out-parameter.
    unsafe { out.write(FfiOwnedBytes::from_vec(b"from a 1.2 host".to_vec())) };
    PluginStatus::Ok
}
unsafe extern "C" fn host_write_file(
    _ctx: *mut c_void,
    _path: FfiStr,
    _data: FfiByteSlice,
    _mode: PluginWriteMode,
) -> PluginStatus {
    PluginStatus::Other
}
unsafe extern "C" fn host_stat(
    _ctx: *mut c_void,
    _path: FfiStr,
    _out: *mut PluginFileMetadata,
) -> PluginStatus {
    PluginStatus::Other
}
unsafe extern "C" fn host_list(
    _ctx: *mut c_void,
    _path: FfiStr,
    _out: *mut FfiOwnedBytes,
) -> PluginStatus {
    PluginStatus::Other
}
unsafe extern "C" fn host_later(_ctx: *mut c_void) -> PluginStatus {
    PluginStatus::Ok
}

static HOST_BRIDGE_V1_2: HostBridgeVTableV1_2 = HostBridgeVTableV1_2 {
    base: PluginHostBridgeVTable {
        open_connection: host_open,
        read_file: host_read_file,
        write_file: host_write_file,
        stat_path: host_stat,
        list_dir: host_list,
    },
    later: host_later,
};

#[test]
fn older_minor_plugin_uses_a_grown_host_bridge_through_its_prefix() {
    READS.store(0, Ordering::SeqCst);
    // SAFETY: the callbacks ignore `ctx`, and no destructor is installed.
    let bridge =
        unsafe { PluginHostBridge::from_raw(std::ptr::null_mut(), &HOST_BRIDGE_V1_2.base, None) };

    let bytes = bridge.read_file("/anything").expect("prefix call works");
    assert_eq!(bytes, b"from a 1.2 host");
    assert_eq!(READS.load(Ordering::SeqCst), 1);
    assert!(matches!(
        bridge.open_connection("example.invalid", 22),
        Err(PluginError::PermissionDenied)
    ));
    let _ = HOST_BRIDGE_V1_2.later;
}

// --- Enums. ---

#[test]
fn host_never_hands_a_plugin_a_status_it_cannot_decode() {
    for status in [
        PluginStatus::Ok,
        PluginStatus::PermissionDenied,
        PluginStatus::ResourceLimit,
    ] {
        assert_eq!(status.for_peer(ABI_1_0), status);
        assert_eq!(status.for_peer(ABI_1_1), status);
        assert_eq!(status.for_peer(AbiVersion::new(0, 4)), PluginStatus::Other);
    }
}

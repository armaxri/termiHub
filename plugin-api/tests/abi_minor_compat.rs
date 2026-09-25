//! An **older-minor plugin on a newer host** (#3367, PLG-003).
//!
//! ABI 1.0 is the only real version today, so this test simulates a future
//! host at ABI **1.1** that has used both append-only growth points the
//! `version` module sanctions:
//!
//! * it appended a callback to the host-owned capability-bridge vtable (the
//!   PLG-014 "host context" shape), and
//! * it appended a field to the host-allocated `PluginInfo` out-parameter (the
//!   PLG-013 "toolchain record" shape).
//!
//! It then drives both with code compiled against **this** crate — i.e. a
//! plugin built for ABI 1.0 — and checks that the 1.0 plugin still loads and
//! works, and that the host only touches the 1.1 addition when the plugin's
//! ABI `supports` it.

use core::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};

use termihub_plugin_api::capabilities::PluginWriteMode;
use termihub_plugin_api::{
    AbiVersion, FfiByteSlice, FfiOwnedBytes, FfiStr, FfiString, PluginError, PluginFileMetadata,
    PluginHostBridge, PluginHostBridgeVTable, PluginInfo, PluginStatus, PluginTcpStream,
    CURRENT_PLUGIN_ABI_VERSION,
};

/// The simulated newer host.
const HOST_1_1: AbiVersion = AbiVersion::new(1, 1);
/// The minor that introduced the simulated additions.
const SINCE_1_1: AbiVersion = AbiVersion::new(1, 1);

#[test]
fn older_minor_plugin_passes_the_load_gate_on_a_newer_host() {
    // This crate *is* the 1.0 plugin.
    assert_eq!(CURRENT_PLUGIN_ABI_VERSION, AbiVersion::new(1, 0));
    assert_eq!(
        CURRENT_PLUGIN_ABI_VERSION.check_host_compatibility(HOST_1_1),
        Ok(())
    );
    // …but the reverse (a 1.1 plugin on this 1.0 host) is refused.
    assert!(HOST_1_1
        .check_host_compatibility(CURRENT_PLUGIN_ABI_VERSION)
        .is_err());
}

// --- Growth point 1: host-owned bridge vtable gains an entry in 1.1. ---

/// The 1.1 host's bridge table: the frozen 1.0 prefix, then an appended
/// callback. `#[repr(C)]` guarantees `base` sits at offset 0.
#[repr(C)]
struct HostBridgeVTableV1_1 {
    base: PluginHostBridgeVTable,
    log: unsafe extern "C" fn(ctx: *mut c_void, message: FfiStr) -> PluginStatus,
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
    unsafe { out.write(FfiOwnedBytes::from_vec(b"from a 1.1 host".to_vec())) };
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
unsafe extern "C" fn host_log(_ctx: *mut c_void, _message: FfiStr) -> PluginStatus {
    PluginStatus::Ok
}

static HOST_BRIDGE_V1_1: HostBridgeVTableV1_1 = HostBridgeVTableV1_1 {
    base: PluginHostBridgeVTable {
        open_connection: host_open,
        read_file: host_read_file,
        write_file: host_write_file,
        stat_path: host_stat,
        list_dir: host_list,
    },
    log: host_log,
};

#[test]
fn older_minor_plugin_uses_a_grown_host_bridge_through_its_prefix() {
    READS.store(0, Ordering::SeqCst);
    // The 1.1 host hands out its larger table; the 1.0 plugin sees only the
    // 1.0 prefix it was compiled with, which is unchanged.
    // SAFETY: the callbacks ignore `ctx`, and no destructor is installed.
    let bridge =
        unsafe { PluginHostBridge::from_raw(std::ptr::null_mut(), &HOST_BRIDGE_V1_1.base, None) };

    let bytes = bridge.read_file("/anything").expect("prefix call works");
    assert_eq!(bytes, b"from a 1.1 host");
    assert_eq!(READS.load(Ordering::SeqCst), 1);
    assert!(matches!(
        bridge.open_connection("example.invalid", 22),
        Err(PluginError::PermissionDenied)
    ));
    // The appended callback is simply invisible to the 1.0 plugin; the table
    // still carries it for newer plugins.
    let _ = HOST_BRIDGE_V1_1.log;
}

// --- Growth point 2: host-allocated PluginInfo gains a field in 1.1. ---

/// The 1.1 host's `PluginInfo`: the frozen 1.0 prefix plus an appended field.
#[repr(C)]
struct PluginInfoV1_1 {
    base: PluginInfo,
    toolchain: FfiString,
}

impl PluginInfoV1_1 {
    fn empty() -> Self {
        Self {
            base: PluginInfo::empty(),
            toolchain: FfiString::empty(),
        }
    }

    /// Host-side read of the appended field, gated on the plugin's minor.
    fn toolchain(&self) -> Option<&str> {
        self.base
            .abi_version()
            .supports(SINCE_1_1)
            .then(|| self.toolchain.as_str())
    }
}

/// A 1.0 plugin's `termihub_plugin_init`: writes a 1.0-sized `PluginInfo`.
unsafe extern "C" fn plugin_1_0_init(out: *mut PluginInfo) -> PluginStatus {
    // SAFETY: the host passes a valid, writable pointer to (at least) a PluginInfo.
    unsafe { out.write(PluginInfo::new("old", "Old Plugin", "0.1.0")) };
    PluginStatus::Ok
}

#[test]
fn host_reads_an_appended_out_param_field_only_when_the_plugin_supports_it() {
    // Older-minor plugin: fills only the 1.0 prefix; the host's appended field
    // keeps its empty default and is not read.
    let mut info = PluginInfoV1_1::empty();
    // SAFETY: `base` is the struct's first field (repr(C)), a valid PluginInfo.
    let status = unsafe { plugin_1_0_init(&mut info.base) };
    assert_eq!(status, PluginStatus::Ok);
    assert_eq!(info.base.id.as_str(), "old");
    assert_eq!(info.base.abi_version(), AbiVersion::new(1, 0));
    assert_eq!(info.toolchain(), None);
    drop(info); // appended default is an empty FfiString: dropping it is sound

    // A plugin built for 1.1 fills the appended field too, and the host reads it.
    let mut info = PluginInfoV1_1::empty();
    info.base = PluginInfo::with_abi_version("new", "New Plugin", "0.2.0", SINCE_1_1);
    info.toolchain = FfiString::from_string("rustc 1.98.0".to_owned());
    assert_eq!(info.toolchain(), Some("rustc 1.98.0"));
}

// --- Growth point 3: enums. ---

#[test]
fn host_never_hands_a_plugin_a_status_it_cannot_decode() {
    // Every variant that exists at the freeze is 1.0, so a 1.x peer gets it
    // unchanged; a peer without that minor (here the pre-freeze major 0) is
    // downgraded to `Other` instead of receiving an undecodable discriminant.
    for status in [
        PluginStatus::Ok,
        PluginStatus::PermissionDenied,
        PluginStatus::ResourceLimit,
    ] {
        assert_eq!(status.for_peer(AbiVersion::new(1, 0)), status);
        assert_eq!(status.for_peer(AbiVersion::new(1, 7)), status);
        assert_eq!(status.for_peer(AbiVersion::new(0, 4)), PluginStatus::Other);
    }
}

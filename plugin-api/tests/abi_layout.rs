//! Layout freeze for native plugin ABI **1.0** (#3367, PLG-003), plus the
//! **1.1** appends (#3576, PLG-013/PLG-014).
//!
//! The ABI is `major.minor` with an **append-only** rule for minors (see
//! `termihub_plugin_api::version`). This test is what makes that rule
//! enforceable: it pins, for every type that crosses the FFI boundary,
//!
//! * the **offset of every 1.0 field** — reordering, removing, or retyping one
//!   moves an offset and fails here;
//! * the **exact size** of every struct that is frozen for all of 1.x (passed by
//!   value, or allocated/owned by the plugin) — growing one fails here;
//! * a **minimum size** for host-owned, by-pointer structs that a later minor may
//!   append to — appending passes, shrinking fails;
//! * every **enum discriminant** and every **exported symbol name**.
//!
//! If this test fails you are making a breaking change. Either make it additive
//! (append to a host-owned table, add an optional symbol, add an enum variant
//! gated by `PluginStatus::for_peer`) and bump the **minor**, or — as a
//! deliberate maintainer decision — bump the **major** and re-baseline this file.

use std::mem::{align_of, offset_of, size_of};

use termihub_plugin_api::capabilities::PluginWriteMode;
use termihub_plugin_api::symbols::{
    SYMBOL_PLUGIN_ABI_VERSION, SYMBOL_PLUGIN_CREATE_BACKEND, SYMBOL_PLUGIN_INIT,
    SYMBOL_PLUGIN_SHUTDOWN,
};
use termihub_plugin_api::{
    AbiVersion, FfiByteSlice, FfiOwnedBytes, FfiStr, FfiString, PanicStrategy, PluginBackend,
    PluginBackendVTable, PluginFileMetadata, PluginHostBridge, PluginHostBridgeVTable,
    PluginHostContext, PluginHostServices, PluginHostServicesVTable, PluginInfo, PluginLogLevel,
    PluginOutputSender, PluginSessionConfig, PluginStatus, PluginTcpStream, PluginTcpStreamVTable,
    ABI_1_1, CURRENT_PLUGIN_ABI_VERSION,
};

/// Pointer width — every pointer, `usize`, and function pointer in the ABI.
const P: usize = size_of::<usize>();

#[test]
fn abi_major_is_frozen_at_1() {
    // A major bump is a maintainer decision that re-baselines this whole file.
    assert_eq!(CURRENT_PLUGIN_ABI_VERSION.major, 1);
    assert_eq!(AbiVersion::new(1, 0).to_packed(), 0x0001_0000);
}

#[test]
fn abi_minor_is_1_1() {
    // Bump deliberately, together with a new "appended in 1.N" block below.
    assert_eq!(CURRENT_PLUGIN_ABI_VERSION, AbiVersion::new(1, 1));
    assert_eq!(ABI_1_1.to_packed(), 0x0001_0001);
}

#[test]
fn ffi_carriers_are_frozen() {
    // Passed by value everywhere: frozen for all of 1.x.
    assert_eq!(offset_of!(FfiByteSlice, ptr), 0);
    assert_eq!(offset_of!(FfiByteSlice, len), P);
    assert_eq!(size_of::<FfiByteSlice>(), 2 * P);

    assert_eq!(offset_of!(FfiStr, ptr), 0);
    assert_eq!(offset_of!(FfiStr, len), P);
    assert_eq!(size_of::<FfiStr>(), 2 * P);

    // ptr, len, cap, free (nullable fn pointer).
    assert_eq!(size_of::<FfiString>(), 4 * P);
    assert_eq!(size_of::<FfiOwnedBytes>(), 4 * P);
    assert_eq!(align_of::<FfiString>(), P);
}

#[test]
fn plugin_owned_and_by_value_structs_are_frozen() {
    // The plugin's backend vtable is a static inside the plugin: frozen.
    assert_eq!(offset_of!(PluginBackendVTable, write_input), 0);
    assert_eq!(offset_of!(PluginBackendVTable, resize), P);
    assert_eq!(offset_of!(PluginBackendVTable, close), 2 * P);
    assert_eq!(offset_of!(PluginBackendVTable, is_alive), 3 * P);
    assert_eq!(offset_of!(PluginBackendVTable, destroy), 4 * P);
    assert_eq!(size_of::<PluginBackendVTable>(), 5 * P);

    // Plugin-allocated out-parameter of create_backend: frozen.
    assert_eq!(offset_of!(PluginBackend, state), 0);
    assert_eq!(offset_of!(PluginBackend, vtable), P);
    assert_eq!(size_of::<PluginBackend>(), 2 * P);

    // Passed by value into create_backend: frozen (ctx, fn/vtable, destroy).
    assert_eq!(size_of::<PluginOutputSender>(), 3 * P);
    assert_eq!(size_of::<PluginHostBridge>(), 3 * P);

    // Plugin-allocated out-parameters of bridge calls: frozen.
    assert_eq!(offset_of!(PluginTcpStream, state), 0);
    assert_eq!(offset_of!(PluginTcpStream, vtable), P);
    assert_eq!(size_of::<PluginTcpStream>(), 2 * P);

    assert_eq!(offset_of!(PluginFileMetadata, exists), 0);
    assert_eq!(offset_of!(PluginFileMetadata, is_dir), 1);
    assert_eq!(offset_of!(PluginFileMetadata, len), 8);
    assert_eq!(size_of::<PluginFileMetadata>(), 16);
}

#[test]
fn host_owned_structs_keep_their_1_0_prefix() {
    // Host-owned / host-allocated, reached by pointer: a minor may append, so
    // only the 1.0 prefix is pinned (offsets) plus a minimum size.
    assert_eq!(offset_of!(PluginHostBridgeVTable, open_connection), 0);
    assert_eq!(offset_of!(PluginHostBridgeVTable, read_file), P);
    assert_eq!(offset_of!(PluginHostBridgeVTable, write_file), 2 * P);
    assert_eq!(offset_of!(PluginHostBridgeVTable, stat_path), 3 * P);
    assert_eq!(offset_of!(PluginHostBridgeVTable, list_dir), 4 * P);
    assert!(size_of::<PluginHostBridgeVTable>() >= 5 * P);

    assert_eq!(offset_of!(PluginTcpStreamVTable, read), 0);
    assert_eq!(offset_of!(PluginTcpStreamVTable, write), P);
    assert_eq!(offset_of!(PluginTcpStreamVTable, destroy), 2 * P);
    assert!(size_of::<PluginTcpStreamVTable>() >= 3 * P);

    assert_eq!(offset_of!(PluginSessionConfig, config_json), 0);
    assert_eq!(offset_of!(PluginSessionConfig, settings_json), 2 * P);
    assert!(size_of::<PluginSessionConfig>() >= 4 * P);

    assert_eq!(offset_of!(PluginInfo, id), 0);
    assert_eq!(offset_of!(PluginInfo, name), 4 * P);
    assert_eq!(offset_of!(PluginInfo, version), 8 * P);
    assert_eq!(offset_of!(PluginInfo, api_version), 12 * P);
    assert!(size_of::<PluginInfo>() >= 12 * P + 4);
}

#[test]
fn abi_1_1_appends_sit_after_the_1_0_prefix() {
    // PLG-013: the toolchain record is appended to the host-allocated
    // PluginInfo, after `api_version` (padded to pointer alignment).
    assert_eq!(offset_of!(PluginInfo, rustc), 13 * P);
    assert_eq!(offset_of!(PluginInfo, panic_strategy), 17 * P);
    assert!(size_of::<PluginInfo>() >= 17 * P + 4);
    assert_eq!(PanicStrategy::WIRE_UNKNOWN, 0);
    assert_eq!(PanicStrategy::WIRE_UNWIND, 1);
    assert_eq!(PanicStrategy::WIRE_ABORT, 2);

    // PLG-014: the host-context pointer is appended to the session config.
    assert_eq!(offset_of!(PluginSessionConfig, host_context), 4 * P);
    assert!(size_of::<PluginSessionConfig>() >= 5 * P);

    // The context itself is host-owned and reached by pointer: prefix pinned,
    // later minors may append.
    assert_eq!(offset_of!(PluginHostContext, host_version), 0);
    assert_eq!(offset_of!(PluginHostContext, data_dir), 2 * P);
    assert_eq!(offset_of!(PluginHostContext, services_ctx), 4 * P);
    assert_eq!(offset_of!(PluginHostContext, services_vtable), 5 * P);
    assert!(size_of::<PluginHostContext>() >= 6 * P);

    // The services table is a host static: prefix pinned, may grow.
    assert_eq!(offset_of!(PluginHostServicesVTable, retain), 0);
    assert_eq!(offset_of!(PluginHostServicesVTable, release), P);
    assert_eq!(offset_of!(PluginHostServicesVTable, log), 2 * P);
    assert_eq!(offset_of!(PluginHostServicesVTable, is_cancelled), 3 * P);
    assert!(size_of::<PluginHostServicesVTable>() >= 4 * P);

    // The services handle (ctx, vtable) is frozen from 1.1 on.
    assert_eq!(size_of::<PluginHostServices>(), 2 * P);

    // Log levels travel as u32 wire values.
    assert_eq!(PluginLogLevel::Error.as_wire(), 1);
    assert_eq!(PluginLogLevel::Warn.as_wire(), 2);
    assert_eq!(PluginLogLevel::Info.as_wire(), 3);
    assert_eq!(PluginLogLevel::Debug.as_wire(), 4);
    assert_eq!(PluginLogLevel::Trace.as_wire(), 5);
}

#[test]
fn enum_discriminants_are_frozen() {
    assert_eq!(size_of::<PluginStatus>(), 4);
    let status = [
        (PluginStatus::Ok, 0),
        (PluginStatus::ChannelClosed, 1),
        (PluginStatus::NotAlive, 2),
        (PluginStatus::InvalidConfig, 3),
        (PluginStatus::Io, 4),
        (PluginStatus::VersionMismatch, 5),
        (PluginStatus::Panic, 6),
        (PluginStatus::PermissionDenied, 7),
        (PluginStatus::Other, 8),
        (PluginStatus::ResourceLimit, 9),
    ];
    for (variant, value) in status {
        assert_eq!(variant as i32, value, "{variant:?}");
        assert_eq!(variant.since(), AbiVersion::new(1, 0), "{variant:?}");
    }

    assert_eq!(size_of::<PluginWriteMode>(), 4);
    assert_eq!(PluginWriteMode::Truncate as i32, 0);
    assert_eq!(PluginWriteMode::Append as i32, 1);
    assert_eq!(PluginWriteMode::CreateNew as i32, 2);
}

#[test]
fn exported_symbol_names_are_frozen() {
    assert_eq!(SYMBOL_PLUGIN_ABI_VERSION, b"termihub_plugin_abi_version\0");
    assert_eq!(SYMBOL_PLUGIN_INIT, b"termihub_plugin_init\0");
    assert_eq!(
        SYMBOL_PLUGIN_CREATE_BACKEND,
        b"termihub_plugin_create_backend\0"
    );
    assert_eq!(SYMBOL_PLUGIN_SHUTDOWN, b"termihub_plugin_shutdown\0");
}

//! End-to-end tests for native plugin ABI **1.1** (#3576, PLG-013/PLG-014)
//! with the fixture `cdylib`:
//!
//! * **Toolchain enforcement** — a plugin reporting another rustc, another
//!   panic strategy, or no toolchain at all is refused; the matching one loads.
//!   Driven through the plugin runner's loader directly (the gate the runner
//!   applies before any plugin code runs), because the fixture reads its
//!   toolchain overrides from an environment the runner's scrubbed spawn does
//!   not pass on.
//! * **Host context** — through the real host and its sandboxed plugin runner
//!   (ADR-19), an ABI 1.1 session receives the app version, a private
//!   host-created data directory, a working log callback and a cancellation
//!   flag that flips on plugin unload.
//! * **ABI 1.0 compatibility** — a faithful 1.0 build of the fixture (the
//!   `abi-1-0` feature: 1.0 `PluginInfo` prefix, never reads the context) is
//!   refused without the explicit unverified-toolchain acceptance, and with it
//!   loads and behaves exactly as before: echo, settings, no context, no data
//!   directory.
#![cfg(feature = "plugin")]

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

mod plugin_fixture;
mod plugin_runner_support;
use plugin_fixture::{artifact_name, fixture_library, Variant};

use termihub_core::connection::{plugin_type_id, ConnectionType, ConnectionTypeRegistry};
use termihub_core::plugin::{
    native_trust_binding, parse_manifest, AbiVersion, BackendLoadOptions, HostError,
    InstalledPlugin, NativeTrustStore, PluginHost, PluginState, ToolchainIncompatibility,
    CURRENT_PLUGIN_ABI_VERSION, PLUGIN_DATA_DIR_NAME,
};
use termihub_plugin_runner::loader::{load_plugin_library, PluginLibrary};

/// Open `path` with the runner's loader — the exact gate sequence the
/// sandboxed runner applies — mapping its error as the host does.
fn load_with(path: &Path, options: &BackendLoadOptions<'_>) -> Result<PluginLibrary, HostError> {
    load_plugin_library(path, options).map_err(HostError::from)
}

fn load(path: &Path) -> Result<PluginLibrary, HostError> {
    load_with(path, &BackendLoadOptions::default())
}

async fn next_line(rx: &mut termihub_core::connection::OutputReceiver) -> String {
    let chunk = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("output within the timeout")
        .expect("a chunk");
    String::from_utf8(chunk).expect("UTF-8 line")
}

/// Run `f` with the fixture's toolchain overrides set, then clear them. The
/// fixture reads them from the process environment, so every scenario in this
/// binary runs sequentially inside the single test below to avoid env races.
fn with_env<T>(vars: &[(&str, &str)], f: impl FnOnce() -> T) -> T {
    for (k, v) in vars {
        std::env::set_var(k, v);
    }
    let out = f();
    for (k, _) in vars {
        std::env::remove_var(k);
    }
    out
}

fn expect_toolchain_refusal(result: Result<PluginLibrary, HostError>) -> ToolchainIncompatibility {
    match result {
        Err(HostError::IncompatibleToolchain(detail)) => detail,
        Err(other) => panic!("expected IncompatibleToolchain, got {other:?}"),
        Ok(_) => panic!("expected IncompatibleToolchain, got a successful load"),
    }
}

#[tokio::test]
async fn abi_1_1_end_to_end() {
    // One test, sequential scenarios: the toolchain overrides are process-wide.
    abi_1_1_plugin_toolchain_is_enforced();
    host_hands_a_1_1_plugin_its_context_and_keeps_a_1_0_plugin_unchanged(
        termihub_core::plugin::sandbox::PluginRunnerConfig::new(
            plugin_runner_support::runner_binary(),
        ),
    )
    .await;
}

fn abi_1_1_plugin_toolchain_is_enforced() {
    let work = tempfile::TempDir::new().unwrap();
    let lib_path = fixture_library(Variant::Default, work.path());

    // --- Toolchain enforcement across a real dlopen. ---
    let detail = expect_toolchain_refusal(with_env(
        &[("TERMIHUB_TEST_PLUGIN_RUSTC", "0.0.1 (0123456789abcdef)")],
        || load(&lib_path),
    ));
    assert!(matches!(
        detail,
        ToolchainIncompatibility::RustcMismatch { .. }
    ));
    assert!(detail.to_string().contains("0.0.1"), "{detail}");

    let detail =
        expect_toolchain_refusal(with_env(&[("TERMIHUB_TEST_PLUGIN_PANIC", "abort")], || {
            load(&lib_path)
        }));
    assert!(matches!(
        detail,
        ToolchainIncompatibility::PanicStrategyMismatch { .. }
    ));

    // A plugin claiming 1.1 but reporting no toolchain fails closed — and the
    // 1.0 acceptance does not rescue it.
    let detail = expect_toolchain_refusal(with_env(&[("TERMIHUB_TEST_PLUGIN_RUSTC", "")], || {
        load_with(
            &lib_path,
            &BackendLoadOptions {
                accept_unverified_toolchain: true,
                ..BackendLoadOptions::default()
            },
        )
    }));
    assert!(matches!(
        detail,
        ToolchainIncompatibility::PluginUnknown { .. }
    ));

    // The matching toolchain loads and is recorded.
    let lib = load(&lib_path).expect("matching toolchain loads");
    assert_eq!(lib.info().abi_version, CURRENT_PLUGIN_ABI_VERSION);
    let toolchain = lib
        .info()
        .toolchain
        .clone()
        .expect("1.1 reports a toolchain");
    assert!(toolchain.is_known(), "{toolchain}");
}

fn manifest(id: &str, api: &str) -> String {
    format!(
        r#"{{
            "id": "{id}", "name": "Echo", "version": "1.0.0", "author": "test",
            "description": "echo fixture", "license": "MIT", "apiVersion": "{api}",
            "platforms": ["windows", "linux", "macos"], "permissions": ["terminal"],
            "extensions": {{ "terminalBackend": {{
                "connectionType": "echo", "displayName": "Echo",
                "configSchema": {{ "type": "object", "properties": {{}} }}
            }} }},
            "settings": {{ "greeting": {{ "type": "string", "default": "hi", "description": "Greeting." }} }}
        }}"#
    )
}

/// Lay a plugin down under `root/<id>` and return its `InstalledPlugin`.
fn install(root: &Path, lib: &Path, id: &str, api: &str) -> InstalledPlugin {
    let dir = root.join(id);
    std::fs::create_dir_all(dir.join("backend")).unwrap();
    std::fs::copy(lib, dir.join("backend").join(artifact_name())).unwrap();
    let src = manifest(id, api);
    std::fs::write(dir.join("manifest.json"), &src).unwrap();
    let manifest = parse_manifest(&src).unwrap();
    manifest.validate().unwrap();
    InstalledPlugin {
        manifest,
        state: PluginState::Installed,
        error_message: None,
        installed_at: 0,
    }
}

fn trust(root: &Path, id: &str, accept_unverified_toolchain: bool) {
    let mut store = NativeTrustStore::load(root);
    store.set_native_enabled(true).unwrap();
    let binding = native_trust_binding(root, id).unwrap();
    store
        .acknowledge_with_toolchain_acceptance(id, &binding, accept_unverified_toolchain)
        .unwrap();
}

fn session(registry: &Arc<Mutex<ConnectionTypeRegistry>>, id: &str) -> Box<dyn ConnectionType> {
    registry
        .lock()
        .unwrap()
        .create(&plugin_type_id(id, "echo"))
        .expect("registered")
}

async fn host_hands_a_1_1_plugin_its_context_and_keeps_a_1_0_plugin_unchanged(
    runner: termihub_core::plugin::sandbox::PluginRunnerConfig,
) {
    let work = tempfile::TempDir::new().unwrap();
    let v1_1 = fixture_library(Variant::Default, work.path());
    let v1_0 = fixture_library(Variant::Abi10, work.path());
    let root = work.path().join("plugins");
    let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
    let host = PluginHost::new(&root, Arc::clone(&registry))
        .with_host_version("9.8.7")
        .with_runner(runner);

    // --- ABI 1.1 through the real host: data dir, version, log, cancel. ---
    let new = install(&root, &v1_1, "echo-new", "1.1");
    trust(&root, "echo-new", false);
    host.load(&new).expect("1.1 plugin loads");
    let data_dir = root.join(PLUGIN_DATA_DIR_NAME).join("echo-new");
    assert!(data_dir.is_dir(), "the host creates the data directory");

    let mut conn = session(&registry, "echo-new");
    let mut rx = conn.subscribe_output();
    conn.connect(serde_json::json!({ "probe": "context" }))
        .await
        .unwrap();
    let line = next_line(&mut rx).await;
    let fields: Vec<&str> = line.strip_prefix("CTX:").unwrap().split('|').collect();
    assert_eq!(fields[0], "9.8.7");
    assert_eq!(
        Path::new(fields[1]).canonicalize().unwrap(),
        data_dir.canonicalize().unwrap()
    );
    assert_eq!(&fields[2..], ["true", "false", "true"], "{line}");
    assert!(
        data_dir.join("probe.txt").is_file(),
        "the plugin owns its dir"
    );

    conn.write(b"?cancelled").unwrap();
    assert_eq!(next_line(&mut rx).await, "CANCELLED:false");
    // Unload ends the sessions (bounded stop); the plugin-wide cancellation it
    // starts with is observable before that.
    host.sandboxed_plugin("echo-new")
        .expect("served by the runner")
        .signal_shutdown();
    conn.write(b"?cancelled").unwrap();
    assert_eq!(next_line(&mut rx).await, "CANCELLED:true");
    host.unload("echo-new");
    assert!(!conn.is_connected(), "unload stops the runner");
    conn.disconnect().await.unwrap();
    drop(conn);

    // --- ABI 1.0: refused without the explicit acceptance… ---
    let old = install(&root, &v1_0, "echo-old", "1.0");
    trust(&root, "echo-old", false);
    match host.load(&old) {
        // The runner's loader refuses it, with the host's message.
        Err(err @ HostError::RunnerLoad { .. }) => assert_eq!(
            err.to_string(),
            HostError::UnverifiedToolchain {
                abi: AbiVersion::new(1, 0)
            }
            .to_string()
        ),
        Err(other) => panic!("expected the runner's UnverifiedToolchain refusal, got {other:?}"),
        Ok(()) => panic!("a 1.0 plugin must not load without the acceptance"),
    }
    assert!(!host.is_loaded("echo-old"));

    // …and with it, loads and behaves exactly as a 1.0 plugin always did.
    trust(&root, "echo-old", true);
    host.load(&old).expect("accepted 1.0 plugin loads");
    assert!(
        !root.join(PLUGIN_DATA_DIR_NAME).join("echo-old").exists(),
        "a 1.0 plugin gets no data directory"
    );

    let mut conn = session(&registry, "echo-old");
    let mut rx = conn.subscribe_output();
    conn.connect(serde_json::json!({ "probe": "settings" }))
        .await
        .unwrap();
    let settings = next_line(&mut rx).await;
    let json: serde_json::Value =
        serde_json::from_str(settings.strip_prefix("SETTINGS:").unwrap()).unwrap();
    assert_eq!(
        json["greeting"], "hi",
        "1.0 fields still delivered: {settings}"
    );
    conn.write(b"plain echo").unwrap();
    assert_eq!(next_line(&mut rx).await, "plain echo");
    conn.write(b"?cancelled").unwrap();
    assert_eq!(
        next_line(&mut rx).await,
        "CANCELLED:none",
        "no context for 1.0"
    );
    conn.disconnect().await.unwrap();
    drop(conn);
    host.unload("echo-old");
}

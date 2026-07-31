//! End-to-end test that a plugin-provided backend becomes a usable connection
//! type (#1999).
//!
//! Where `plugin_host_roundtrip.rs` (#1995) exercises loading a library and
//! driving a [`PluginConnectionType`] directly, this test drives the remaining
//! *wiring*: it loads plugins through the real [`PluginHost`] into a shared
//! [`ConnectionTypeRegistry`] and then, using only the registry (the same path
//! the desktop `SessionManager` takes), it
//!
//! * creates a session by `type_id` and runs full terminal I/O
//!   (connect → write → output → disconnect),
//! * confirms the plugin's manifest `configSchema` surfaced as the type's
//!   `settings_schema` (so the dynamic form renders with no bespoke UI),
//! * confirms two plugins declaring the same `connectionType` are disambiguated
//!   (the second suffixed with its plugin id), and
//! * confirms sessions are independent — closing one leaves the other running.
//!
//! Like the round-trip test it builds the real `cdylib` fixture with `cargo` and
//! genuinely `dlopen`s it, and is gated on the `plugin` feature.
#![cfg(feature = "plugin")]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use termihub_core::connection::{ConnectionType, ConnectionTypeRegistry, FieldType};
use termihub_core::plugin::{
    parse_manifest, HostLifecycleHook, InstalledPlugin, PluginHost, PluginManager, PluginState,
};

/// Path to the fixture plugin's `Cargo.toml` (the same echo `cdylib` the
/// round-trip test uses).
fn fixture_manifest() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("test-plugin")
        .join("Cargo.toml")
}

/// The platform-specific file name cargo produces for the fixture `cdylib`.
fn artifact_name() -> String {
    format!(
        "{}termihub_test_plugin{}",
        std::env::consts::DLL_PREFIX,
        std::env::consts::DLL_SUFFIX
    )
}

/// Build the fixture into `target_dir`, returning the freshly-built library path.
fn build_fixture(target_dir: &Path) -> PathBuf {
    let status = Command::new(env!("CARGO"))
        .arg("build")
        .arg("--manifest-path")
        .arg(fixture_manifest())
        .arg("--target-dir")
        .arg(target_dir)
        .status()
        .expect("failed to spawn cargo to build the fixture plugin");
    assert!(status.success(), "building the fixture plugin failed");
    target_dir.join("debug").join(artifact_name())
}

/// A manifest declaring a terminal backend of connection type `connection_type`,
/// with a small `configSchema` carrying one string property.
fn manifest_json(id: &str, name: &str, connection_type: &str) -> String {
    format!(
        r#"{{
            "id": "{id}",
            "name": "{name}",
            "version": "1.0.0",
            "author": "test",
            "description": "echo backend fixture",
            "license": "MIT",
            "apiVersion": "1.0",
            "platforms": ["windows", "linux", "macos"],
            "permissions": ["terminal"],
            "extensions": {{
                "terminalBackend": {{
                    "connectionType": "{connection_type}",
                    "displayName": "Echo",
                    "configSchema": {{
                        "type": "object",
                        "properties": {{
                            "echoPrefix": {{
                                "type": "string",
                                "description": "Text prepended to every echoed chunk."
                            }}
                        }}
                    }}
                }}
            }}
        }}"#
    )
}

/// Install a plugin `id` into `root/<id>/` by writing its manifest and copying
/// the built `lib` into `backend/`, then return the [`InstalledPlugin`] the host
/// consumes.
fn install(
    root: &Path,
    lib: &Path,
    id: &str,
    name: &str,
    connection_type: &str,
) -> InstalledPlugin {
    let dir = root.join(id);
    let backend = dir.join("backend");
    std::fs::create_dir_all(&backend).expect("create plugin backend dir");
    std::fs::copy(lib, backend.join(artifact_name())).expect("copy backend library");

    // Write the manifest to disk too, so a `PluginManager` scanning the root sees
    // an installed plugin (the direct `host.load` callers use the return value and
    // don't need it, but the startup-load test scans from disk).
    let manifest_src = manifest_json(id, name, connection_type);
    std::fs::write(dir.join("manifest.json"), &manifest_src).expect("write manifest");

    let manifest = parse_manifest(&manifest_src).expect("fixture manifest should parse");
    manifest
        .validate()
        .expect("fixture manifest should validate");
    InstalledPlugin {
        manifest,
        state: PluginState::Installed,
        error_message: None,
        installed_at: 0,
    }
}

/// Lay down a plugin `id` on disk with a valid manifest that declares a terminal
/// backend but **no** backend library, so loading it fails with
/// `LibraryNotFound` — used to prove a broken enabled plugin surfaces as `Error`
/// at startup without aborting the rest of the load.
fn write_manifest_only(root: &Path, id: &str, name: &str, connection_type: &str) {
    let dir = root.join(id);
    std::fs::create_dir_all(&dir).expect("create plugin dir");
    std::fs::write(
        dir.join("manifest.json"),
        manifest_json(id, name, connection_type),
    )
    .expect("write manifest");
}

/// Drive a full terminal round trip through a connection created from the
/// registry: connect, write, read the echoed output, disconnect.
async fn round_trip(conn: &mut Box<dyn ConnectionType>, payload: &[u8]) {
    let mut rx = conn.subscribe_output();
    conn.connect(serde_json::json!({ "echoPrefix": "" }))
        .await
        .expect("connect should succeed");
    assert!(conn.is_connected());

    conn.write(payload).expect("write should succeed");
    let out = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("echoed output should arrive within the timeout")
        .expect("output channel should yield a chunk");
    assert_eq!(out, payload);
}

#[tokio::test]
async fn plugin_type_is_creatable_and_listed_through_the_registry() {
    let tmp = tempfile::TempDir::new().unwrap();
    let lib = build_fixture(&tmp.path().join("target"));
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();

    let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
    let host = PluginHost::new(root.clone(), Arc::clone(&registry));

    // Load two plugins that BOTH declare connectionType "echo". The first keeps
    // the plain id; the second must be disambiguated with its plugin id.
    let plugin_a = install(&root, &lib, "echo-a", "Echo A", "echo");
    let plugin_b = install(&root, &lib, "echo-b", "Echo B", "echo");
    host.load(&plugin_a).expect("first plugin should load");
    host.load(&plugin_b).expect("second plugin should load");

    // --- 1. Both types are surfaced, the collision disambiguated. ---
    let types = registry.lock().unwrap().available_types();
    let ids: Vec<String> = types.iter().map(|t| t.type_id.clone()).collect();
    assert!(ids.contains(&"echo".to_string()), "got {ids:?}");
    assert!(ids.contains(&"echo-echo-b".to_string()), "got {ids:?}");

    // The disambiguated type's display name is suffixed with the plugin name.
    let echo_b = types.iter().find(|t| t.type_id == "echo-echo-b").unwrap();
    assert_eq!(echo_b.display_name, "Echo (Echo B)");

    // --- 2. The manifest configSchema surfaced as the type's settings schema. ---
    let echo = types.iter().find(|t| t.type_id == "echo").unwrap();
    assert_eq!(
        echo.schema.groups.len(),
        1,
        "configSchema should yield one group"
    );
    let field = &echo.schema.groups[0].fields[0];
    assert_eq!(field.key, "echoPrefix");
    assert_eq!(field.label, "Echo Prefix"); // humanized from the key
    assert!(matches!(field.field_type, FieldType::Text));

    // --- 3. A session created BY TYPE ID runs full I/O through the plugin. ---
    let mut conn = registry
        .lock()
        .unwrap()
        .create("echo")
        .expect("plugin type should be creatable by id");
    round_trip(&mut conn, b"hello via registry").await;
    conn.disconnect().await.expect("disconnect should succeed");
    assert!(!conn.is_connected());

    // The disambiguated second plugin is equally usable.
    let mut conn_b = registry.lock().unwrap().create("echo-echo-b").unwrap();
    round_trip(&mut conn_b, b"second plugin").await;
    conn_b.disconnect().await.unwrap();

    // --- 4. Unloading a plugin unregisters exactly its (effective) type. ---
    host.unload("echo-b");
    let after: Vec<String> = registry
        .lock()
        .unwrap()
        .available_types()
        .into_iter()
        .map(|t| t.type_id)
        .collect();
    assert!(after.contains(&"echo".to_string()));
    assert!(!after.contains(&"echo-echo-b".to_string()));
}

#[tokio::test]
async fn already_enabled_plugin_is_loaded_at_startup_without_a_toggle() {
    // The gap #2010 closes: the manager's scan restores a plugin's persisted
    // enabled flag but does no loading, so an already-enabled plugin's connection
    // type is never registered until the user toggles it off/on. Here we lay a
    // plugin down on disk exactly as a previous session left it, then wire up a
    // fresh manager+host over a shared registry (as `lib.rs` does at startup) and
    // confirm `load_enabled_plugins` registers and makes the type creatable with
    // no enable() call in sight.
    let tmp = tempfile::TempDir::new().unwrap();
    let lib = build_fixture(&tmp.path().join("target"));
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();

    // A broken enabled plugin alongside the healthy one: it declares a terminal
    // backend but ships no backend library, so its load must fail. It must
    // surface as `Error` and must NOT prevent the healthy plugin from loading or
    // abort startup.
    let _ = install(&root, &lib, "echo", "Echo", "echo");
    write_manifest_only(&root, "broken", "Broken", "broken");

    // Fresh "startup": manager wired to a real host over a shared registry.
    // Nothing toggles either plugin — this is a cold start with both persisted as
    // enabled (no state file → enabled by default).
    let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
    let host = Arc::new(PluginHost::new(root.clone(), Arc::clone(&registry)));
    let manager = PluginManager::with_hook(
        root.clone(),
        Arc::new(HostLifecycleHook::new(Arc::clone(&host))),
    );

    // Before the startup load, the type is not registered.
    assert!(
        !registry.lock().unwrap().has_type("echo"),
        "type must not be registered before the startup load"
    );

    // Drive the startup load path.
    let loaded = manager
        .load_enabled_plugins()
        .expect("startup load should not error");

    // The healthy plugin's type is now registered and creatable — no toggle.
    assert!(
        registry.lock().unwrap().has_type("echo"),
        "already-enabled plugin should be loaded at startup"
    );
    let mut conn = registry
        .lock()
        .unwrap()
        .create("echo")
        .expect("plugin type should be creatable straight after startup load");
    round_trip(&mut conn, b"loaded at startup").await;
    conn.disconnect().await.unwrap();

    // The broken plugin surfaced as Error, but startup carried on and the healthy
    // one still loaded — and, being enabled and successfully loaded by the wired
    // host, it is promoted to `Active` (the state the frontend loaders gate on),
    // not left resting at `Installed` (#2234).
    let broken = loaded
        .iter()
        .find(|p| p.manifest.id == "broken")
        .expect("broken plugin should be among those attempted");
    assert_eq!(broken.state, PluginState::Error);
    assert!(broken.error_message.is_some());
    let echo = loaded.iter().find(|p| p.manifest.id == "echo").unwrap();
    assert_eq!(echo.state, PluginState::Active);
    assert!(echo.error_message.is_none());
}

#[tokio::test]
async fn sessions_are_independent_so_closing_one_leaves_the_other_running() {
    let tmp = tempfile::TempDir::new().unwrap();
    let lib = build_fixture(&tmp.path().join("target"));
    let root = tmp.path().join("plugins");
    std::fs::create_dir_all(&root).unwrap();

    let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
    let host = PluginHost::new(root.clone(), Arc::clone(&registry));
    host.load(&install(&root, &lib, "echo-a", "Echo A", "echo"))
        .expect("plugin should load");

    // Two independent sessions of the same plugin type.
    let mut first = registry.lock().unwrap().create("echo").unwrap();
    let mut second = registry.lock().unwrap().create("echo").unwrap();

    let mut second_rx = second.subscribe_output();
    first.connect(serde_json::json!({})).await.unwrap();
    second.connect(serde_json::json!({})).await.unwrap();
    assert!(first.is_connected() && second.is_connected());

    // Closing the first session must not disturb the second.
    first.disconnect().await.unwrap();
    assert!(!first.is_connected());
    assert!(
        second.is_connected(),
        "closing one session killed the other"
    );

    // The surviving session still does full I/O.
    second
        .write(b"still alive")
        .expect("second session still writable");
    let out = tokio::time::timeout(Duration::from_secs(5), second_rx.recv())
        .await
        .expect("second session should still echo")
        .expect("output chunk");
    assert_eq!(out, b"still alive");

    second.disconnect().await.unwrap();
}

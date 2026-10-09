//! Data-safety tests for the plugin stores on the shared persistence layer
//! (#4334, DUP2-003 / PER2-004): unique fsynced temp files, the version gate
//! and the corrupt-file backup for `plugin-state.json`, the plugin settings
//! store, the native-plugin trust file and the publisher trust store.

use std::path::Path;

use serde_json::{Map, Value};
use tempfile::TempDir;

use super::manager::{PluginManager, PluginManagerError};
use super::native_trust::{NativeTrustStore, TrustBinding, NATIVE_TRUST_FILE_NAME};
use super::plugin_state::{self, STATE_FILE_NAME};
use super::trust_store::{TrustStore, TRUST_STORE_FILE_NAME};
use super::{PluginState, MANIFEST_FILE_NAME};

const SETTINGS_FILE: &str = "plugin-settings.json";

/// A theme-only (frontend) plugin manifest.
fn theme_manifest(id: &str) -> String {
    format!(
        r#"{{"id":"{id}","name":"Theme","version":"1.0.0","author":"t","description":"d",
        "license":"MIT","apiVersion":"1.0","platforms":["linux","macos","windows"],
        "permissions":["terminal"],"extensions":{{"theme":{{"themes":[
        {{"id":"dark","name":"Dark","file":"themes/dark.json"}}]}}}}}}"#
    )
}

/// A native-backend plugin manifest.
fn native_manifest(id: &str) -> String {
    format!(
        r#"{{"id":"{id}","name":"Native","version":"1.0.0","author":"t","description":"d",
        "license":"MIT","apiVersion":"1.0","platforms":["linux","macos","windows"],
        "permissions":["terminal"],"extensions":{{"terminalBackend":{{
        "connectionType":"native","displayName":"Native","configSchema":{{}}}}}}}}"#
    )
}

/// Lay an installed plugin directory down under `root`.
fn install_dir(root: &Path, id: &str, manifest: &str) {
    let dir = root.join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(MANIFEST_FILE_NAME), manifest).unwrap();
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

/// A root with an enabled native plugin and an enabled theme plugin whose
/// native trust is acknowledged, and a corrupt `plugin-state.json`.
fn corrupt_root() -> TempDir {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    install_dir(root, "nat", &native_manifest("nat"));
    install_dir(root, "thm", &theme_manifest("thm"));
    let mut store = plugin_state::StateStore::default();
    for id in ["nat", "thm"] {
        store.plugins.insert(
            id.into(),
            plugin_state::PluginStateRecord {
                enabled: true,
                installed_at: 1,
                ..Default::default()
            },
        );
    }
    plugin_state::write(root, &store).unwrap();
    let mut trust = NativeTrustStore::load(root);
    trust.set_native_enabled(true).unwrap();
    let manifest = super::parse_manifest(&native_manifest("nat")).unwrap();
    trust
        .acknowledge("nat", &TrustBinding::new("hash", &manifest))
        .unwrap();
    std::fs::write(root.join(STATE_FILE_NAME), "{ \"plugins\": { torn").unwrap();
    tmp
}

// ── plugin-state.json ───────────────────────────────────────────────────────

/// PER2-004: a corrupt `plugin-state.json` is backed up and rebuilt from the
/// installed plugin directories instead of being a hard error; every rebuilt
/// plugin is disabled (fail safe), the native one needs re-acknowledgment.
#[test]
fn a_corrupt_state_file_is_backed_up_and_rebuilt_disabled() {
    let tmp = corrupt_root();
    let root = tmp.path();

    let store = plugin_state::read(root).expect("recovered, not an error");

    assert_eq!(
        read(&root.join(format!("{STATE_FILE_NAME}.bak"))),
        "{ \"plugins\": { torn"
    );
    for id in ["nat", "thm"] {
        let record = &store.plugins[id];
        assert!(!record.enabled, "{id} is disabled after recovery");
        assert!(record.auto_disabled_reason.is_some(), "{id} says why");
    }
    // The rebuilt store is on disk and parses.
    let on_disk = plugin_state::read(root).unwrap();
    assert!(!on_disk.plugins["nat"].enabled);
    // The native plugin's trust acknowledgment is gone: re-enabling it needs
    // the user to trust it again.
    let trust = NativeTrustStore::load(root);
    assert!(trust.ack("nat").is_none());
    assert!(trust.is_native_enabled(), "the global switch is untouched");
}

/// The recovered native plugin stays disabled across a fresh manager scan.
#[test]
fn list_and_uninstall_survive_a_corrupt_state_file() {
    let tmp = corrupt_root();
    let mgr = PluginManager::new(tmp.path());

    let listed = mgr.list().expect("list never hard-fails on a corrupt file");
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().all(|p| p.state == PluginState::Disabled));

    std::fs::write(tmp.path().join(STATE_FILE_NAME), "garbage").unwrap();
    mgr.uninstall("thm")
        .expect("uninstall never hard-fails on a corrupt file");
    assert!(!tmp.path().join("thm").exists());
}

/// A state file written by a newer schema is never overwritten.
#[test]
fn a_newer_state_file_is_refused() {
    let tmp = TempDir::new().unwrap();
    let newer = r#"{"version":99,"plugins":{}}"#;
    std::fs::write(tmp.path().join(STATE_FILE_NAME), newer).unwrap();
    let store = plugin_state::read(tmp.path()).unwrap();
    assert!(plugin_state::write(tmp.path(), &store).is_err());
    assert_eq!(read(&tmp.path().join(STATE_FILE_NAME)), newer);
}

/// A newer-schema state file this build cannot parse is not treated as
/// corrupt: the plugins read as disabled, but nothing is backed up, rewritten
/// or revoked.
#[test]
fn an_unparseable_newer_state_file_is_left_alone() {
    let tmp = corrupt_root();
    let root = tmp.path();
    let newer = r#"{"version":99,"plugins":["a new shape"]}"#;
    std::fs::write(root.join(STATE_FILE_NAME), newer).unwrap();

    let store = plugin_state::read(root).unwrap();
    assert!(store.plugins.values().all(|r| !r.enabled));
    assert_eq!(read(&root.join(STATE_FILE_NAME)), newer);
    assert!(!root.join(format!("{STATE_FILE_NAME}.bak")).exists());
    assert!(NativeTrustStore::load(root).ack("nat").is_some());
}

/// PER2-004: concurrent auto-disables (the host's crash handling) serialize,
/// so no update is lost, and no shared temp file is left behind.
#[test]
fn concurrent_auto_disables_lose_no_update() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    std::thread::scope(|s| {
        for i in 0..16 {
            s.spawn(move || {
                plugin_state::record_auto_disable(root, &format!("p{i}"), "crashed").unwrap();
            });
        }
    });
    let store = plugin_state::read(root).unwrap();
    assert_eq!(store.plugins.len(), 16, "every auto-disable is kept");
    let names: Vec<String> = std::fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec![STATE_FILE_NAME.to_owned()]);
}

// ── plugin-settings.json ────────────────────────────────────────────────────

/// A corrupt settings store reads as empty and is backed up before the next
/// save replaces it, instead of failing every settings call.
#[test]
fn a_corrupt_settings_store_is_backed_up_and_reset() {
    let tmp = TempDir::new().unwrap();
    install_dir(tmp.path(), "thm", &theme_manifest("thm"));
    let mgr = PluginManager::new(tmp.path());
    std::fs::write(tmp.path().join(SETTINGS_FILE), "{ torn").unwrap();

    assert!(mgr.get_settings("thm").unwrap().is_empty());
    let mut values = Map::new();
    values.insert("k".into(), Value::from("v"));
    mgr.update_settings("thm", values.clone()).unwrap();

    assert_eq!(
        read(&tmp.path().join(format!("{SETTINGS_FILE}.bak"))),
        "{ torn"
    );
    assert_eq!(mgr.get_settings("thm").unwrap(), values);
}

/// A settings store written by a newer schema is never overwritten.
#[test]
fn a_newer_settings_store_is_refused() {
    let tmp = TempDir::new().unwrap();
    install_dir(tmp.path(), "thm", &theme_manifest("thm"));
    let mgr = PluginManager::new(tmp.path());
    let newer = r#"{"version":99,"plugins":{}}"#;
    std::fs::write(tmp.path().join(SETTINGS_FILE), newer).unwrap();

    assert!(matches!(
        mgr.update_settings("thm", Map::new()),
        Err(PluginManagerError::Store(_))
    ));
    assert_eq!(read(&tmp.path().join(SETTINGS_FILE)), newer);
}

// ── native-plugin-trust.json ────────────────────────────────────────────────

/// A corrupt native trust file fails closed on load and is backed up before
/// the next save replaces it.
#[test]
fn a_corrupt_native_trust_file_is_backed_up_before_overwrite() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join(NATIVE_TRUST_FILE_NAME);
    std::fs::write(&path, "{ torn").unwrap();

    let mut trust = NativeTrustStore::load(tmp.path());
    assert!(!trust.is_native_enabled());
    trust.set_native_enabled(true).unwrap();

    assert_eq!(
        read(&tmp.path().join(format!("{NATIVE_TRUST_FILE_NAME}.bak"))),
        "{ torn"
    );
    assert!(NativeTrustStore::load(tmp.path()).is_native_enabled());
}

/// A native trust file written by a newer schema fails closed and is never
/// overwritten.
#[test]
fn a_newer_native_trust_file_fails_closed_and_is_refused() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join(NATIVE_TRUST_FILE_NAME);
    let newer = r#"{"version":99,"nativePluginsEnabled":true,"acks":{}}"#;
    std::fs::write(&path, newer).unwrap();

    let mut trust = NativeTrustStore::load(tmp.path());
    assert!(
        !trust.is_native_enabled(),
        "a newer file authorizes nothing"
    );
    assert!(trust.set_native_enabled(true).is_err());
    assert_eq!(read(&path), newer);
}

// ── trust-store.json ────────────────────────────────────────────────────────

/// A corrupt publisher trust store degrades to the bundled keys and is backed
/// up before a pin replaces it.
#[test]
fn a_corrupt_publisher_store_is_backed_up_before_overwrite() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join(TRUST_STORE_FILE_NAME);
    std::fs::write(&path, "{ torn").unwrap();

    let mut store = TrustStore::load(tmp.path()).expect("degrades, not an error");
    assert!(!store.is_trusted("sha256:k"));
    store.pin("sha256:k", "pk", "label").unwrap();

    assert_eq!(
        read(&tmp.path().join(format!("{TRUST_STORE_FILE_NAME}.bak"))),
        "{ torn"
    );
    assert!(TrustStore::load(tmp.path()).unwrap().is_trusted("sha256:k"));
}

/// A publisher trust store written by a newer schema trusts no pinned key and
/// is never overwritten.
#[test]
fn a_newer_publisher_store_fails_closed_and_is_refused() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join(TRUST_STORE_FILE_NAME);
    let newer = r#"{"version":99,"publishers":[{"keyId":"sha256:k","publicKey":"pk",
        "label":"l","source":"user-pinned","addedAt":"t"}]}"#;
    std::fs::write(&path, newer).unwrap();

    let mut store = TrustStore::load(tmp.path()).unwrap();
    assert!(!store.is_trusted("sha256:k"));
    assert!(store.pin("sha256:other", "pk2", "l2").is_err());
    assert_eq!(read(&path), newer);
}

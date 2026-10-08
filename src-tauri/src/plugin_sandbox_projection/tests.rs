use std::sync::{Arc, Mutex};

use serde_json::json;
use termihub_core::connection::ConnectionTypeRegistry;
use termihub_core::plugin::sandbox::PluginRunnerConfig;
use termihub_core::plugin::{
    native_library_hash, parse_manifest, InstalledPlugin, NativeTrustStore, PluginHost, PluginState,
};

use super::*;
use crate::projection::Projector;

const MANIFEST: &str = r#"{
    "id": "acme",
    "name": "Acme",
    "version": "1.0.0",
    "author": "tester",
    "description": "sandbox projection test",
    "license": "MIT",
    "apiVersion": "1.0",
    "platforms": ["linux", "macos", "windows"],
    "permissions": ["terminal"],
    "extensions": {
        "terminalBackend": {
            "connectionType": "acme",
            "displayName": "Acme",
            "configSchema": {}
        }
    }
}"#;

/// Install a trusted native plugin whose library is a dummy file (the runner
/// never gets far enough to open it).
fn trusted_plugin(root: &std::path::Path) -> InstalledPlugin {
    let backend = root.join("acme").join("backend");
    std::fs::create_dir_all(&backend).unwrap();
    let lib = format!(
        "{}acme{}",
        std::env::consts::DLL_PREFIX,
        std::env::consts::DLL_SUFFIX
    );
    std::fs::write(backend.join(lib), b"not a real library").unwrap();
    let hash = native_library_hash(root, "acme").unwrap();
    let mut trust = NativeTrustStore::load(root);
    trust.set_native_enabled(true).unwrap();
    trust.acknowledge("acme", hash).unwrap();
    InstalledPlugin {
        manifest: parse_manifest(MANIFEST).unwrap(),
        state: PluginState::Installed,
        error_message: None,
        installed_at: 0,
    }
}

fn registry() -> Arc<Mutex<ConnectionTypeRegistry>> {
    Arc::new(Mutex::new(ConnectionTypeRegistry::new()))
}

#[test]
fn an_in_process_host_projects_no_sandbox() {
    let tmp = tempfile::TempDir::new().unwrap();
    let host = PluginHost::new(tmp.path(), registry());
    assert_eq!(
        snapshot(&host),
        json!({ "outOfProcess": false, "plugins": {} })
    );
}

#[test]
fn a_refused_plugin_is_projected_with_its_badge() {
    let tmp = tempfile::TempDir::new().unwrap();
    let host = PluginHost::new(tmp.path(), registry()).with_runner(Some(PluginRunnerConfig::new(
        tmp.path().join("missing-runner"),
    )));
    let plugin = trusted_plugin(tmp.path());
    assert!(host.load(&plugin).is_err());

    let view = snapshot(&host);
    assert_eq!(view["outOfProcess"], true);
    assert_eq!(view["plugins"]["acme"]["isolation"], "runnerMissing");
    assert!(view["plugins"]["acme"]["detail"].is_string());
    assert_eq!(view["plugins"]["acme"]["denials"], json!([]));

    // Disabling the plugin clears the row's status.
    host.unload("acme");
    assert_eq!(snapshot(&host)["plugins"], json!({}));
}

#[test]
fn publishing_an_unchanged_host_emits_nothing() {
    let tmp = tempfile::TempDir::new().unwrap();
    let host = PluginHost::new(tmp.path(), registry()).with_runner(Some(PluginRunnerConfig::new(
        tmp.path().join("missing-runner"),
    )));
    let projector = Projector::new();
    projector.register_region(PLUGIN_SANDBOX_REGION, snapshot(&host));
    assert_eq!(
        projector.publish_with(PLUGIN_SANDBOX_REGION, || snapshot(&host)),
        None,
        "an idle host must not produce diffs"
    );

    let plugin = trusted_plugin(tmp.path());
    assert!(host.load(&plugin).is_err());
    assert_eq!(
        projector.publish_with(PLUGIN_SANDBOX_REGION, || snapshot(&host)),
        Some(1),
        "a refused load reaches subscribers as a diff"
    );
}

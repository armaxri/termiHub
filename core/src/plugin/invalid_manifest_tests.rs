//! Installed plugins whose `manifest.json` no longer parses or validates
//! (#4392): listed in the `Error` state with the reason instead of being
//! hidden, never enabled or loaded, and still uninstallable.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tempfile::TempDir;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use super::manager::{
    installed_backend_types, InstalledPlugin, PluginLifecycleHook, PluginManager,
    PluginManagerError,
};
use super::{PluginState, MANIFEST_FILE_NAME};

/// A valid theme-only manifest; `extra` is spliced in as additional top-level
/// keys (e.g. `"filesystemPaths": ["/"]`) to make it fail validation.
fn manifest(id: &str, name: &str, extra: &str) -> String {
    format!(
        r#"{{"id":"{id}","name":"{name}","version":"1.2.3","author":"tester",
        "description":"d","license":"MIT","apiVersion":"1.0",
        "platforms":["linux","macos","windows"],"permissions":["terminal","filesystem"],
        "updateUrl":"https://example.com/update.json",
        "extensions":{{"theme":{{"themes":[{{"id":"dark","name":"Dark","file":"themes/dark.json"}}]}}}}
        {extra}}}"#
    )
}

/// Install a valid plugin `id`, then overwrite its installed manifest with
/// `replacement` — the state a plugin installed before a validation rule was
/// tightened is left in.
fn install_then_corrupt(root: &Path, id: &str, replacement: &str) -> PluginManager {
    let mgr = PluginManager::new(root);
    let pkg_dir = TempDir::new().unwrap();
    let pkg = make_package(pkg_dir.path(), &manifest(id, "Old Plugin", ""));
    mgr.install(&pkg, true, false).unwrap();
    std::fs::write(root.join(id).join(MANIFEST_FILE_NAME), replacement).unwrap();
    mgr
}

fn make_package(dir: &Path, manifest: &str) -> PathBuf {
    let path = dir.join("plugin.termihub-plugin");
    let mut zip = ZipWriter::new(std::fs::File::create(&path).unwrap());
    let opts = SimpleFileOptions::default();
    zip.start_file(MANIFEST_FILE_NAME, opts).unwrap();
    zip.write_all(manifest.as_bytes()).unwrap();
    zip.start_file("themes/dark.json", opts).unwrap();
    zip.write_all(b"{}").unwrap();
    zip.finish().unwrap();
    path
}

fn root() -> (TempDir, PathBuf) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("plugins");
    (tmp, root)
}

fn assert_placeholder(plugin: &InstalledPlugin, id: &str) {
    assert_eq!(plugin.manifest.id, id);
    assert_eq!(plugin.state, PluginState::Error);
    assert!(
        plugin.invalid_manifest,
        "flagged as an invalid manifest (#4578)"
    );
    // Nothing capability-bearing from the rejected manifest is carried over.
    assert!(plugin.manifest.extensions.is_empty());
    assert!(plugin.manifest.permissions.is_empty());
    assert!(plugin.manifest.filesystem_paths.is_empty());
    assert!(plugin.manifest.update_url.is_none());
    assert!(plugin.manifest.settings.is_none());
}

#[test]
fn invalid_manifest_is_listed_as_error_with_the_reason() {
    let (_tmp, root) = root();
    let bad = manifest("old-plugin", "Old Plugin", r#","filesystemPaths":["/"]"#);
    let mgr = install_then_corrupt(&root, "old-plugin", &bad);

    let listed = mgr.list().unwrap();
    assert_eq!(listed.len(), 1, "the invalid plugin must not be hidden");
    let plugin = &listed[0];
    assert_placeholder(plugin, "old-plugin");
    assert_eq!(plugin.manifest.name, "Old Plugin");
    assert_eq!(plugin.manifest.version, "1.2.3");
    assert_eq!(plugin.manifest.author, "tester");
    let message = plugin.error_message.as_deref().unwrap();
    assert!(message.contains("filesystem root"), "reason: {message}");
    assert!(plugin.installed_at > 0);

    let got = mgr.get("old-plugin").unwrap();
    assert_eq!(&got, plugin);
}

#[test]
fn unparseable_manifest_is_listed_with_a_lenient_name() {
    let (_tmp, root) = root();
    // An unknown key fails the strict parse; the name is still readable.
    let bad = manifest("old-plugin", "Old Plugin", r#","futureField":true"#);
    let mgr = install_then_corrupt(&root, "old-plugin", &bad);
    let plugin = mgr.get("old-plugin").unwrap();
    assert_placeholder(&plugin, "old-plugin");
    assert_eq!(plugin.manifest.name, "Old Plugin");
    assert!(plugin
        .error_message
        .as_deref()
        .unwrap()
        .contains("futureField"));

    // Not even JSON: the id stands in for the name.
    std::fs::write(root.join("old-plugin").join(MANIFEST_FILE_NAME), "not json").unwrap();
    let plugin = mgr.get("old-plugin").unwrap();
    assert_placeholder(&plugin, "old-plugin");
    assert_eq!(plugin.manifest.name, "old-plugin");
    assert!(plugin.error_message.is_some());
}

#[test]
fn manifest_id_not_matching_its_directory_is_an_error() {
    let (_tmp, root) = root();
    let other = manifest("other-id", "Other", "");
    let mgr = install_then_corrupt(&root, "old-plugin", &other);
    let plugin = mgr.get("old-plugin").unwrap();
    assert_placeholder(&plugin, "old-plugin");
    assert!(plugin
        .error_message
        .as_deref()
        .unwrap()
        .contains("does not match"));
}

#[test]
fn directories_that_are_not_plugins_stay_hidden() {
    let (_tmp, root) = root();
    std::fs::create_dir_all(root.join("no-manifest")).unwrap();
    std::fs::create_dir_all(root.join("Not_A_Slug")).unwrap();
    std::fs::write(root.join("Not_A_Slug").join(MANIFEST_FILE_NAME), "{}").unwrap();
    let mgr = PluginManager::new(&root);
    assert!(mgr.list().unwrap().is_empty());
    assert!(matches!(
        mgr.get("no-manifest"),
        Err(PluginManagerError::NotFound(_))
    ));
}

#[test]
fn invalid_plugin_is_never_enabled_or_loaded() {
    #[derive(Default)]
    struct RecordingHook {
        enabled: Mutex<Vec<String>>,
    }
    impl PluginLifecycleHook for RecordingHook {
        fn on_enable(&self, plugin: &InstalledPlugin) -> Result<(), String> {
            self.enabled
                .lock()
                .unwrap()
                .push(plugin.manifest.id.clone());
            Ok(())
        }
    }

    let (_tmp, root) = root();
    let bad = manifest("old-plugin", "Old Plugin", r#","filesystemPaths":["/"]"#);
    install_then_corrupt(&root, "old-plugin", &bad);

    let hook = Arc::new(RecordingHook::default());
    let mgr = PluginManager::with_hook(&root, hook.clone());

    let err = mgr.enable("old-plugin").unwrap_err();
    assert!(
        matches!(&err, PluginManagerError::InvalidManifest { id, reason }
            if id == "old-plugin" && reason.contains("filesystem root")),
        "{err:?}"
    );
    assert!(mgr.load_enabled_plugins().unwrap().is_empty());
    assert!(hook.enabled.lock().unwrap().is_empty(), "never loaded");
    // Still listed as Error (not flipped to Installed by the refused enable).
    assert_eq!(mgr.get("old-plugin").unwrap().state, PluginState::Error);
    assert!(installed_backend_types(&root).is_empty());
}

#[test]
fn invalid_plugin_can_be_uninstalled() {
    let (_tmp, root) = root();
    let bad = manifest("old-plugin", "Old Plugin", r#","filesystemPaths":["/"]"#);
    let mgr = install_then_corrupt(&root, "old-plugin", &bad);
    assert_eq!(mgr.list().unwrap().len(), 1);

    mgr.uninstall("old-plugin").unwrap();

    assert!(!root.join("old-plugin").exists());
    assert!(mgr.list().unwrap().is_empty());
    assert!(matches!(
        mgr.get("old-plugin"),
        Err(PluginManagerError::NotFound(_))
    ));
}

#[test]
fn invalid_manifest_flag_is_set_only_for_a_rejected_manifest() {
    // A load failure: a valid manifest whose host hook refuses to load it.
    struct FailingHook;
    impl PluginLifecycleHook for FailingHook {
        fn on_enable(&self, _plugin: &InstalledPlugin) -> Result<(), String> {
            Err("backend failed to load".into())
        }
    }

    let (_tmp, root) = root();
    let mgr = PluginManager::with_hook(&root, Arc::new(FailingHook));
    let pkg_dir = TempDir::new().unwrap();
    let pkg = make_package(pkg_dir.path(), &manifest("broken", "Broken", ""));
    let installed = mgr.install(&pkg, true, false).unwrap();
    assert_eq!(installed.state, PluginState::Error);
    assert!(
        !installed.invalid_manifest,
        "a load failure is not an invalid manifest"
    );
    let failed = mgr.load_enabled_plugins().unwrap();
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].state, PluginState::Error);
    assert!(!failed[0].invalid_manifest);
    // A valid manifest is never flagged when listed either.
    assert!(!mgr.get("broken").unwrap().invalid_manifest);

    // The rejected manifest is flagged, and the flag reaches the wire.
    let bad = manifest("old-plugin", "Old Plugin", r#","filesystemPaths":["/"]"#);
    let mgr = install_then_corrupt(&root, "old-plugin", &bad);
    let invalid = mgr.get("old-plugin").unwrap();
    assert!(invalid.invalid_manifest);
    let wire = serde_json::to_value(&invalid).unwrap();
    assert_eq!(wire["invalidManifest"], serde_json::json!(true));
    let wire = serde_json::to_value(mgr.get("broken").unwrap()).unwrap();
    assert!(wire.get("invalidManifest").is_none(), "omitted when false");
}

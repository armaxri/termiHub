//! Tests for the plugins backup section (#3515).

use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};
use termihub_core::plugin::{
    generate_keypair, NativeTrustStore, PluginManager, PluginState, TrustStore,
    NATIVE_TRUST_FILE_NAME,
};

use super::pending::{apply_pending_restore, ROLLBACK_DIR};
use super::plugins::{self, MAX_PLUGINS_BACKUP_TOTAL_BYTES, MAX_PLUGIN_BACKUP_BYTES};
use super::restore::{self, MANIFEST_FILE, PENDING_DIR};
use super::*;
use crate::credential::vault::{ConflictStrategy, VaultError};

const PASSPHRASE: &str = "correct horse battery staple";
const THEME_ID: &str = "nice-theme";
const NATIVE_ID: &str = "native-shell";

fn theme_manifest(id: &str, version: &str) -> String {
    json!({
        "id": id, "name": "Theme", "version": version, "author": "tester",
        "description": "a theme", "license": "MIT", "apiVersion": "1.0",
        "platforms": ["linux", "macos", "windows"], "permissions": ["terminal"],
        "extensions": {"theme": {"themes": [
            {"id": "dark", "name": "Dark", "file": "themes/dark.json"}
        ]}}
    })
    .to_string()
}

fn native_manifest(id: &str) -> String {
    json!({
        "id": id, "name": "Native", "version": "1.0.0", "author": "tester",
        "description": "native plugin", "license": "MIT", "apiVersion": "1.0",
        "platforms": ["linux", "macos", "windows"], "permissions": ["terminal"],
        "extensions": {"terminalBackend": {
            "connectionType": "native", "displayName": "Native", "configSchema": {}
        }}
    })
    .to_string()
}

fn plugins_root(dir: &Path) -> std::path::PathBuf {
    dir.join(plugins::PLUGINS_DIR)
}

/// Install a plugin directory by hand: manifest plus extra files.
fn install(dir: &Path, id: &str, manifest: &str, files: &[(&str, &[u8])]) {
    let plugin = plugins_root(dir).join(id);
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("manifest.json"), manifest).unwrap();
    for (rel, bytes) in files {
        let path = plugin.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
}

fn write_root(dir: &Path, file: &str, doc: &Value) {
    let root = plugins_root(dir);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(file), serde_json::to_string_pretty(doc).unwrap()).unwrap();
}

fn read_root(dir: &Path, file: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(plugins_root(dir).join(file)).unwrap()).unwrap()
}

/// A machine with a theme plugin, a native plugin (acknowledged here), their
/// state (with signer records) and settings, and one pinned publisher.
fn populated_source() -> (tempfile::TempDir, Value) {
    let src = tempfile::tempdir().unwrap();
    install(
        src.path(),
        THEME_ID,
        &theme_manifest(THEME_ID, "1.0.0"),
        &[("themes/dark.json", b"{\"bg\":\"#000\"}")],
    );
    install(
        src.path(),
        NATIVE_ID,
        &native_manifest(NATIVE_ID),
        &[("backend/libnative.so", &[0u8, 1, 2, 255])],
    );
    let key = generate_keypair("ACME");
    let publisher = json!({
        "keyId": key.key_id, "publicKey": key.public_key, "label": "ACME",
        "source": "user-pinned", "addedAt": "2026-09-01T00:00:00Z"
    });
    write_root(
        src.path(),
        "plugin-state.json",
        &json!({"plugins": {
            THEME_ID: {"enabled": true, "installedAt": 1, "packageSha256": "sha256:aa",
                       "signer": {"kind": "signed", "keyId": key.key_id}},
            NATIVE_ID: {"enabled": true, "installedAt": 2, "signer": {"kind": "unsigned"}},
            "orphan": {"enabled": true, "installedAt": 3}
        }}),
    );
    write_root(
        src.path(),
        "plugin-settings.json",
        &json!({"plugins": {THEME_ID: {"accent": "blue"}}}),
    );
    write_root(
        src.path(),
        "trust-store.json",
        &json!({"publishers": [publisher.clone()]}),
    );
    // This machine trusts the native plugin; that must never travel.
    let mut native_trust = NativeTrustStore::load(&plugins_root(src.path()));
    native_trust.set_native_enabled(true).unwrap();
    native_trust.acknowledge(NATIVE_ID, "hash-of-lib").unwrap();
    (src, publisher)
}

fn backup_of(dir: &Path, encrypt: bool) -> Result<export::BuiltBackup, VaultError> {
    export::build(
        dir,
        &BackupExportOptions {
            sections: vec![plugins::SECTION_ID.to_string()],
            include_credentials: false,
            encrypt,
        },
        encrypt.then_some(PASSPHRASE),
        None,
        "2026-09-26T00:00:00+00:00".into(),
        "0.0.0-test".into(),
    )
}

fn plugins_request(mode: RestoreMode, conflicts: ConflictStrategy) -> BackupRestoreRequest {
    BackupRestoreRequest {
        sections: vec![SectionRestoreChoice {
            id: plugins::SECTION_ID.into(),
            mode,
            conflicts,
        }],
        credentials: None,
    }
}

fn restore_and_boot(
    json: &str,
    dir: &Path,
    mode: RestoreMode,
    conflicts: ConflictStrategy,
) -> Result<BackupRestoreResult, VaultError> {
    let opened = restore::open(json, Some(PASSPHRASE))?;
    let result = restore::apply(&opened, dir, &plugins_request(mode, conflicts), None)?;
    assert!(apply_pending_restore(dir).is_none());
    Ok(result)
}

fn preview_of(json: &str, dir: &Path) -> BackupSectionPreview {
    let opened = restore::open(json, Some(PASSPHRASE)).unwrap();
    restore::plan(&opened, dir, |_| unreachable!("no credentials"))
        .sections
        .remove(0)
}

fn file(dir: &Path, id: &str, rel: &str) -> Vec<u8> {
    std::fs::read(plugins_root(dir).join(id).join(rel)).unwrap()
}

#[test]
fn plugins_round_trip_with_state_signers_settings_and_publishers() {
    let (src, publisher) = populated_source();
    let built = backup_of(src.path(), true).unwrap();
    assert_eq!(built.sections, vec!["plugins"]);
    assert!(built.warnings.is_empty());

    let dst = tempfile::tempdir().unwrap();
    let preview = preview_of(&built.json, dst.path());
    assert_eq!(preview.status, SectionStatus::Ok);
    assert_eq!((preview.item_count, preview.new_count), (2, 2));
    assert!(preview.notes.iter().any(|n| n.contains(NATIVE_ID)));

    let result = restore_and_boot(
        &built.json,
        dst.path(),
        RestoreMode::Merge,
        ConflictStrategy::Skip,
    )
    .unwrap();
    assert!(result.restart_required);
    assert_eq!(result.sections[0].resulting_count, 2);

    // Files come back byte for byte, including binary ones.
    assert_eq!(
        file(dst.path(), THEME_ID, "themes/dark.json"),
        b"{\"bg\":\"#000\"}"
    );
    assert_eq!(
        file(dst.path(), NATIVE_ID, "backend/libnative.so"),
        vec![0u8, 1, 2, 255]
    );

    // State records (incl. the signer record) are restored as-is; the orphan
    // record for a plugin that is not installed is not carried over.
    let state = read_root(dst.path(), "plugin-state.json");
    let src_state = read_root(src.path(), "plugin-state.json");
    assert_eq!(state["plugins"][THEME_ID], src_state["plugins"][THEME_ID]);
    assert_eq!(
        state["plugins"][NATIVE_ID]["signer"],
        json!({"kind": "unsigned"})
    );
    assert!(state["plugins"].get("orphan").is_none());
    assert_eq!(
        read_root(dst.path(), "plugin-settings.json"),
        json!({"plugins": {THEME_ID: {"accent": "blue"}}})
    );

    // The real plugin stores read what was restored.
    let root = plugins_root(dst.path());
    let listed = PluginManager::new(&root).list().unwrap();
    let states: Vec<(String, PluginState)> = listed
        .iter()
        .map(|p| (p.manifest.id.clone(), p.state))
        .collect();
    assert_eq!(
        states,
        vec![
            (NATIVE_ID.to_string(), PluginState::Disabled),
            (THEME_ID.to_string(), PluginState::Installed),
        ]
    );
    let pinned = TrustStore::load(&root).unwrap();
    assert!(pinned.is_trusted(publisher["keyId"].as_str().unwrap()));
}

#[test]
fn a_restored_native_plugin_needs_re_acknowledgment() {
    let (src, _) = populated_source();
    let built = backup_of(src.path(), true).unwrap();
    assert!(
        !built.json.contains("hash-of-lib"),
        "native acknowledgments must never be backed up"
    );

    // A fresh machine: the source's global switch and ack do not travel.
    let dst = tempfile::tempdir().unwrap();
    restore_and_boot(
        &built.json,
        dst.path(),
        RestoreMode::Replace,
        ConflictStrategy::Skip,
    )
    .unwrap();
    let root = plugins_root(dst.path());
    assert!(!root.join(NATIVE_TRUST_FILE_NAME).exists());
    let trust = NativeTrustStore::load(&root);
    assert!(!trust.is_native_enabled());
    assert!(!trust.is_acknowledged(NATIVE_ID, "hash-of-lib"));
    assert_eq!(
        read_root(dst.path(), "plugin-state.json")["plugins"][NATIVE_ID]["enabled"],
        json!(false)
    );

    // The same machine: its own trust file is left exactly as it was, and the
    // restored native plugin still comes back turned off.
    let before = std::fs::read(plugins_root(src.path()).join(NATIVE_TRUST_FILE_NAME)).unwrap();
    restore_and_boot(
        &built.json,
        src.path(),
        RestoreMode::Replace,
        ConflictStrategy::Skip,
    )
    .unwrap();
    let after = std::fs::read(plugins_root(src.path()).join(NATIVE_TRUST_FILE_NAME)).unwrap();
    assert_eq!(before, after);
    let listed = PluginManager::new(plugins_root(src.path())).list().unwrap();
    let native = listed.iter().find(|p| p.manifest.id == NATIVE_ID).unwrap();
    assert_eq!(native.state, PluginState::Disabled);
}

#[test]
fn merge_skip_keeps_installed_plugins_and_overwrite_replaces_them() {
    let (src, _) = populated_source();
    let json = backup_of(src.path(), true).unwrap().json;

    let dst = tempfile::tempdir().unwrap();
    install(
        dst.path(),
        THEME_ID,
        &theme_manifest(THEME_ID, "2.0.0"),
        &[("themes/dark.json", b"mine")],
    );
    install(
        dst.path(),
        "local-only",
        &theme_manifest("local-only", "1.0.0"),
        &[],
    );
    let preview = preview_of(&json, dst.path());
    assert_eq!(
        (
            preview.new_count,
            preview.conflict_count,
            preview.current_count
        ),
        (1, 1, 2)
    );
    assert!(!preview.conflicts_keep_existing);

    restore_and_boot(&json, dst.path(), RestoreMode::Merge, ConflictStrategy::Skip).unwrap();
    assert_eq!(file(dst.path(), THEME_ID, "themes/dark.json"), b"mine");
    assert!(plugins_root(dst.path()).join(NATIVE_ID).is_dir());
    assert!(plugins_root(dst.path()).join("local-only").is_dir());

    restore_and_boot(
        &json,
        dst.path(),
        RestoreMode::Merge,
        ConflictStrategy::Overwrite,
    )
    .unwrap();
    assert_eq!(
        file(dst.path(), THEME_ID, "themes/dark.json"),
        b"{\"bg\":\"#000\"}"
    );
    assert!(plugins_root(dst.path()).join("local-only").is_dir());
    assert_eq!(preview_of(&json, dst.path()).unchanged_count, 2);
}

#[test]
fn replace_removes_plugins_not_in_the_backup() {
    let (src, _) = populated_source();
    let json = backup_of(src.path(), true).unwrap().json;
    let dst = tempfile::tempdir().unwrap();
    install(
        dst.path(),
        "local-only",
        &theme_manifest("local-only", "1.0.0"),
        &[],
    );
    write_root(
        dst.path(),
        "plugin-state.json",
        &json!({"plugins": {"local-only": {"enabled": true, "installedAt": 9}}}),
    );
    let result = restore_and_boot(
        &json,
        dst.path(),
        RestoreMode::Replace,
        ConflictStrategy::Skip,
    )
    .unwrap();
    assert_eq!(result.sections[0].resulting_count, 2);
    assert!(!plugins_root(dst.path()).join("local-only").exists());
    assert!(read_root(dst.path(), "plugin-state.json")["plugins"]
        .get("local-only")
        .is_none());
    assert!(!dst.path().join(ROLLBACK_DIR).exists());
}

#[test]
fn plugins_over_the_size_caps_are_skipped_with_a_warning() {
    let src = tempfile::tempdir().unwrap();
    let too_big = usize::try_from(MAX_PLUGIN_BACKUP_BYTES).unwrap() + 1;
    install(
        src.path(),
        "huge",
        &theme_manifest("huge", "1.0.0"),
        &[("blob.bin", &vec![7u8; too_big])],
    );
    // Two plugins that each fit, but not both: the second hits the total cap.
    let big = usize::try_from(MAX_PLUGINS_BACKUP_TOTAL_BYTES / 2).unwrap() + 1024;
    assert!((big as u64) < MAX_PLUGIN_BACKUP_BYTES);
    install(
        src.path(),
        "big-a",
        &theme_manifest("big-a", "1.0.0"),
        &[("blob.bin", &vec![1u8; big])],
    );
    install(
        src.path(),
        "big-b",
        &theme_manifest("big-b", "1.0.0"),
        &[("blob.bin", &vec![2u8; big])],
    );
    install(src.path(), "small", &theme_manifest("small", "1.0.0"), &[]);

    let built = backup_of(src.path(), true).unwrap();
    assert!(built.json.len() <= MAX_BACKUP_FILE_BYTES);
    assert_eq!(built.warnings.len(), 2, "{:?}", built.warnings);
    assert!(built.warnings.iter().any(|w| w.contains("\"huge\"")));
    assert!(built.warnings.iter().any(|w| w.contains("\"big-b\"")));

    let opened = restore::open(&built.json, Some(PASSPHRASE)).unwrap();
    let doc: plugins::PluginsDoc = serde_json::from_value(opened.sections[0].data.clone()).unwrap();
    let ids: Vec<&str> = doc.packages.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, vec!["big-a", "small"]);
}

#[test]
fn plugins_are_never_exported_or_restored_unencrypted() {
    let (src, _) = populated_source();
    assert!(matches!(
        backup_of(src.path(), false),
        Err(VaultError::WeakPassphrase { .. })
    ));
    let infos = export::section_infos(src.path());
    let info = infos.iter().find(|i| i.id == "plugins").unwrap();
    assert!(info.present && info.requires_encryption && info.item_count == 2);

    // A hand-made unencrypted backup carrying plugin code is refused.
    let data = backup_section_data(src.path());
    let json = container(vec![section(1, data)], false);
    let dst = tempfile::tempdir().unwrap();
    let opened = restore::open(&json, None).unwrap();
    let preview = restore::plan(&opened, dst.path(), |_| unreachable!());
    assert_eq!(preview.sections[0].status, SectionStatus::Invalid);
    let req = plugins_request(RestoreMode::Merge, ConflictStrategy::Skip);
    assert!(restore::apply(&opened, dst.path(), &req, None).is_err());
    assert!(!plugins_root(dst.path()).exists());
}

fn backup_section_data(dir: &Path) -> Value {
    let (section, _) = plugins::export_section(dir).unwrap().unwrap();
    section.data
}

fn section(schema_version: u32, data: Value) -> BackupSection {
    BackupSection {
        id: plugins::SECTION_ID.into(),
        schema_version,
        data,
    }
}

fn container(sections: Vec<BackupSection>, encrypt: bool) -> String {
    let contents = BackupContents {
        format: BACKUP_FORMAT_ID.into(),
        format_version: BACKUP_FORMAT_VERSION,
        created_at: "t".into(),
        sections,
        credentials: None,
    };
    let (envelope, contents) = if encrypt {
        let plaintext = serde_json::to_vec(&contents).unwrap();
        let envelope =
            crate::credential::crypto::encrypt_with_password(PASSPHRASE, &plaintext).unwrap();
        (Some(envelope), None)
    } else {
        (None, Some(contents))
    };
    serde_json::to_string(&BackupFile {
        format: BACKUP_FORMAT_ID.into(),
        format_version: BACKUP_FORMAT_VERSION,
        created_at: "t".into(),
        app_version: "v".into(),
        encrypted: encrypt,
        envelope,
        contents,
    })
    .unwrap()
}

fn assert_refused(data: Value, schema_version: u32, expected: SectionStatus) {
    let json = container(vec![section(schema_version, data)], true);
    let dst = tempfile::tempdir().unwrap();
    assert_eq!(preview_of(&json, dst.path()).status, expected);
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let req = plugins_request(RestoreMode::Replace, ConflictStrategy::Skip);
    assert!(restore::apply(&opened, dst.path(), &req, None).is_err());
    assert!(!dst.path().join(PENDING_DIR).exists());
    assert!(!plugins_root(dst.path()).exists());
    assert!(!dst.path().parent().unwrap().join("evil").exists());
}

#[test]
fn newer_plugin_sections_are_refused() {
    let (src, _) = populated_source();
    let data = backup_section_data(src.path());
    assert_refused(
        data.clone(),
        plugins::SCHEMA_VERSION + 1,
        SectionStatus::Newer,
    );
    let mut newer_doc = data;
    newer_doc["version"] = json!("2");
    assert_refused(newer_doc, 1, SectionStatus::Newer);
}

#[test]
fn hostile_plugin_sections_are_refused() {
    let (src, _) = populated_source();
    let data = backup_section_data(src.path());
    let b64 = |s: &str| BASE64.encode(s);

    let mut traversal = data.clone();
    traversal["packages"][0]["files"]
        .as_array_mut()
        .unwrap()
        .push(json!({"path": "../../evil", "data": b64("x")}));
    assert_refused(traversal, 1, SectionStatus::Invalid);

    let mut absolute = data.clone();
    absolute["packages"][0]["files"]
        .as_array_mut()
        .unwrap()
        .push(json!({"path": "/etc/evil", "data": b64("x")}));
    assert_refused(absolute, 1, SectionStatus::Invalid);

    let mut bad_id = data.clone();
    bad_id["packages"][0]["id"] = json!("../evil");
    assert_refused(bad_id, 1, SectionStatus::Invalid);

    // The manifest must name the directory it is restored into.
    let mut mismatch = data.clone();
    mismatch["packages"][0]["id"] = json!("other-id");
    assert_refused(mismatch, 1, SectionStatus::Invalid);

    // A pinned publisher whose key id does not match its key.
    let mut forged = data.clone();
    forged["publishers"][0]["keyId"] = json!("sha256:00");
    assert_refused(forged, 1, SectionStatus::Invalid);

    // A plugin over the per-plugin cap inside a (hand-made) backup.
    let mut oversize = data;
    let too_big = usize::try_from(MAX_PLUGIN_BACKUP_BYTES).unwrap() + 1;
    oversize["packages"][0]["files"]
        .as_array_mut()
        .unwrap()
        .push(json!({"path": "big.bin", "data": BASE64.encode(vec![0u8; too_big])}));
    assert_refused(oversize, 1, SectionStatus::Invalid);
}

#[test]
fn failed_startup_swap_rolls_plugin_directories_back() {
    let (src, _) = populated_source();
    std::fs::write(src.path().join("macros.json"), r#"{"version":"1","macros":[]}"#).unwrap();
    let json = export::build(
        src.path(),
        &BackupExportOptions {
            sections: vec!["macros".into(), plugins::SECTION_ID.into()],
            include_credentials: false,
            encrypt: true,
        },
        Some(PASSPHRASE),
        None,
        "t".into(),
        "v".into(),
    )
    .unwrap()
    .json;

    let dst = tempfile::tempdir().unwrap();
    install(
        dst.path(),
        THEME_ID,
        &theme_manifest(THEME_ID, "0.1.0"),
        &[("themes/dark.json", b"original")],
    );
    install(
        dst.path(),
        "local-only",
        &theme_manifest("local-only", "1.0.0"),
        &[],
    );
    let original_state = json!({"plugins": {THEME_ID: {"enabled": true, "installedAt": 5}}});
    write_root(dst.path(), "plugin-state.json", &original_state);

    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let mut req = plugins_request(RestoreMode::Replace, ConflictStrategy::Skip);
    req.sections.push(SectionRestoreChoice {
        id: "macros".into(),
        mode: RestoreMode::Replace,
        conflicts: ConflictStrategy::Skip,
    });
    restore::apply(&opened, dst.path(), &req, None).unwrap();

    // macros.json cannot be written (a directory is in the way) — after the
    // plugin directories were already swapped.
    std::fs::create_dir(dst.path().join("macros.json")).unwrap();
    let warning = apply_pending_restore(dst.path()).expect("the failure is reported");
    assert!(warning.message.contains("previous data was kept"));
    assert_eq!(file(dst.path(), THEME_ID, "themes/dark.json"), b"original");
    assert!(plugins_root(dst.path()).join("local-only").is_dir());
    assert!(!plugins_root(dst.path()).join(NATIVE_ID).exists());
    assert_eq!(read_root(dst.path(), "plugin-state.json"), original_state);
    assert!(!dst.path().join(PENDING_DIR).exists());
    assert!(!dst.path().join(ROLLBACK_DIR).exists());
}

#[test]
fn interrupted_plugin_swap_resumes() {
    let (src, _) = populated_source();
    let json = backup_of(src.path(), true).unwrap().json;
    let dst = tempfile::tempdir().unwrap();
    install(
        dst.path(),
        THEME_ID,
        &theme_manifest(THEME_ID, "0.1.0"),
        &[("themes/dark.json", b"original")],
    );
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let req = plugins_request(RestoreMode::Replace, ConflictStrategy::Skip);
    restore::apply(&opened, dst.path(), &req, None).unwrap();

    // Simulate a crash right after the original theme directory was moved into
    // the rollback directory, before the staged copy was moved into place.
    let rollback = dst.path().join(ROLLBACK_DIR);
    let saved = rollback.join("plugins").join(THEME_ID);
    std::fs::create_dir_all(saved.parent().unwrap()).unwrap();
    std::fs::rename(plugins_root(dst.path()).join(THEME_ID), &saved).unwrap();
    std::fs::write(
        rollback.join("rollback.json"),
        json!({"entries": [], "dirs": [
            {"file": format!("plugins/{THEME_ID}"), "existed": true},
            {"file": format!("plugins/{NATIVE_ID}"), "existed": false}
        ]})
        .to_string(),
    )
    .unwrap();

    assert!(apply_pending_restore(dst.path()).is_none());
    assert_eq!(
        file(dst.path(), THEME_ID, "themes/dark.json"),
        b"{\"bg\":\"#000\"}"
    );
    assert!(plugins_root(dst.path()).join(NATIVE_ID).is_dir());
    assert!(!rollback.exists());
}

#[test]
fn manifests_naming_unsafe_plugin_paths_are_discarded() {
    for manifest in [
        json!({"formatVersion": 2, "files": [], "dirs": ["plugins/../../evil"]}),
        json!({"formatVersion": 2, "files": [], "dirs": ["macros"]}),
        json!({"formatVersion": 2, "files": ["plugins/native-plugin-trust.json"]}),
        json!({"formatVersion": 1, "files": [], "dirs": ["plugins/ok"]}),
        json!({"formatVersion": 3, "files": []}),
    ] {
        let dst = tempfile::tempdir().unwrap();
        let pending = dst.path().join(PENDING_DIR);
        std::fs::create_dir_all(pending.join("plugins")).unwrap();
        std::fs::write(pending.join("plugins/native-plugin-trust.json"), "{}").unwrap();
        std::fs::write(pending.join(MANIFEST_FILE), manifest.to_string()).unwrap();
        assert!(apply_pending_restore(dst.path()).is_some(), "{manifest}");
        assert!(!pending.exists());
        assert!(!plugins_root(dst.path())
            .join(NATIVE_TRUST_FILE_NAME)
            .exists());
    }
}

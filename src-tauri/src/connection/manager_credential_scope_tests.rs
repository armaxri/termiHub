//! Per-connection secrets are scoped by connection file (#3591): a main-store
//! `x` and an external-file `x` never share, overwrite or delete each other's
//! saved secrets, and secrets saved before the scoping are migrated.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::connection::recording_credential_store::RecordingStore;
use crate::connection::settings::ExternalFileConfig;
use crate::terminal::backend::ConnectionConfig;

const PW: CredentialType = CredentialType::Password;

fn manager(dir: &Path, store: &Arc<RecordingStore>) -> ConnectionManager {
    ConnectionManager::new_for_test(dir, store.clone()).unwrap()
}

fn ssh(id: &str, name: &str) -> SavedConnection {
    SavedConnection {
        icon: None,
        id: id.to_string(),
        name: name.to_string(),
        config: ConnectionConfig {
            type_id: "ssh".to_string(),
            settings: json!({"host": format!("{name}-host"), "username": "u", "authMethod": "password"}),
        },
        folder_id: None,
        terminal_options: None,
        source_file: None,
    }
}

/// `c` carrying a typed password it saves.
fn with_password(mut c: SavedConnection, password: &str) -> SavedConnection {
    c.config.settings["password"] = json!(password);
    c.config.settings["savePassword"] = json!(true);
    c
}

fn in_file(mut c: SavedConnection, file: &str) -> SavedConnection {
    c.source_file = Some(file.to_string());
    c
}

fn path(dir: &Path, name: &str) -> String {
    dir.join(name).to_str().unwrap().to_string()
}

fn configure(mgr: &ConnectionManager, files: &[&str]) {
    let mut settings = mgr.get_settings();
    settings.external_connection_files = files
        .iter()
        .map(|path| ExternalFileConfig {
            path: path.to_string(),
            enabled: true,
        })
        .collect();
    mgr.save_settings(settings).unwrap();
}

/// The saved password of connection `id` in `source` (`None` = main store),
/// looked up exactly as the credential commands do.
fn password(
    mgr: &ConnectionManager,
    store: &RecordingStore,
    id: &str,
    source: Option<&str>,
) -> Option<String> {
    store
        .get(&mgr.connection_credential_key(id, source, PW))
        .unwrap()
}

fn scoped(mgr: &ConnectionManager, file: &str, id: &str) -> String {
    owner_id(id, Some(&mgr.file_scope(file)))
}

// ── the issue's regression test ─────────────────────────────────────────────

#[test]
fn same_path_connections_in_different_files_keep_their_own_passwords() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let file = path(dir.path(), "team.json");
    configure(&mgr, &[&file]);

    // Save: each keeps its own password.
    mgr.save_connection(with_password(ssh("x", "x"), "MAIN"))
        .unwrap();
    mgr.save_connection_routed(in_file(with_password(ssh("x", "x"), "EXT"), &file))
        .unwrap();
    assert_eq!(password(&mgr, &store, "x", None).as_deref(), Some("MAIN"));
    assert_eq!(
        password(&mgr, &store, "x", Some(&file)).as_deref(),
        Some("EXT")
    );

    // A password saved from the prompt overwrites only its own connection's.
    let key = mgr.connection_credential_key("x", Some(&file), PW);
    store.set(&key, "EXT2").unwrap();
    assert_eq!(password(&mgr, &store, "x", None).as_deref(), Some("MAIN"));

    // Rename: the renamed one takes its own password along.
    mgr.save_connection(ssh("x", "y")).unwrap();
    assert_eq!(password(&mgr, &store, "y", None).as_deref(), Some("MAIN"));
    assert_eq!(
        password(&mgr, &store, "x", Some(&file)).as_deref(),
        Some("EXT2")
    );

    mgr.save_connection_routed(in_file(ssh("x", "z"), &file))
        .unwrap();
    assert_eq!(
        password(&mgr, &store, "z", Some(&file)).as_deref(),
        Some("EXT2")
    );
    assert_eq!(password(&mgr, &store, "y", None).as_deref(), Some("MAIN"));

    // Delete: removes only the deleted connection's password.
    mgr.save_connection(with_password(ssh("z", "z"), "MAIN-Z"))
        .unwrap();
    mgr.delete_connection_routed("z", Some(&file)).unwrap();
    assert_eq!(password(&mgr, &store, "z", None).as_deref(), Some("MAIN-Z"));
    assert_eq!(password(&mgr, &store, "z", Some(&file)), None);
}

#[test]
fn deleting_a_main_connection_never_deletes_an_external_ones_secret() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let file = path(dir.path(), "team.json");
    configure(&mgr, &[&file]);
    mgr.save_connection(with_password(ssh("x", "x"), "MAIN"))
        .unwrap();
    mgr.save_connection_routed(in_file(with_password(ssh("x", "x"), "EXT"), &file))
        .unwrap();

    mgr.delete_connection_routed("x", None).unwrap();

    assert_eq!(password(&mgr, &store, "x", None), None);
    assert_eq!(
        password(&mgr, &store, "x", Some(&file)).as_deref(),
        Some("EXT")
    );
}

#[test]
fn two_external_files_do_not_share_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let a = path(dir.path(), "a.json");
    let b = path(dir.path(), "b.json");
    configure(&mgr, &[&a, &b]);
    mgr.save_connection_routed(in_file(with_password(ssh("x", "x"), "A"), &a))
        .unwrap();
    mgr.save_connection_routed(in_file(with_password(ssh("x", "x"), "B"), &b))
        .unwrap();

    mgr.delete_connection_routed("x", Some(&a)).unwrap();

    assert_eq!(password(&mgr, &store, "x", Some(&a)), None);
    assert_eq!(password(&mgr, &store, "x", Some(&b)).as_deref(), Some("B"));
}

// ── moves between files ─────────────────────────────────────────────────────

#[test]
fn moving_a_connection_between_files_carries_its_secret() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let a = path(dir.path(), "a.json");
    let b = path(dir.path(), "b.json");
    configure(&mgr, &[&a, &b]);
    mgr.save_connection(with_password(ssh("x", "x"), "X"))
        .unwrap();

    // main → a → b → main; the id stays `x` throughout.
    mgr.move_connection_to_file("x", None, Some(a.clone()))
        .unwrap();
    assert_eq!(password(&mgr, &store, "x", Some(&a)).as_deref(), Some("X"));
    assert_eq!(password(&mgr, &store, "x", None), None);

    mgr.move_connection_to_file("x", Some(&a), Some(b.clone()))
        .unwrap();
    assert_eq!(password(&mgr, &store, "x", Some(&b)).as_deref(), Some("X"));
    assert_eq!(password(&mgr, &store, "x", Some(&a)), None);

    mgr.move_connection_to_file("x", Some(&b), None).unwrap();
    assert_eq!(password(&mgr, &store, "x", None).as_deref(), Some("X"));
    assert_eq!(password(&mgr, &store, "x", Some(&b)), None);
}

#[test]
fn moving_onto_a_same_id_connection_keeps_both_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let file = path(dir.path(), "team.json");
    configure(&mgr, &[&file]);
    mgr.save_connection(with_password(ssh("x", "x"), "MAIN"))
        .unwrap();
    mgr.save_connection_routed(in_file(with_password(ssh("x", "x"), "EXT"), &file))
        .unwrap();

    let moved = mgr
        .move_connection_to_file("x", None, Some(file.clone()))
        .unwrap();

    assert_eq!(moved.id, "x (1)");
    assert_eq!(
        password(&mgr, &store, "x (1)", Some(&file)).as_deref(),
        Some("MAIN")
    );
    assert_eq!(
        password(&mgr, &store, "x", Some(&file)).as_deref(),
        Some("EXT")
    );
    assert_eq!(password(&mgr, &store, "x", None), None);
}

// ── migration of secrets saved before the scoping ───────────────────────────

/// An external file written before #3591 (no file id), holding `ids`.
fn legacy_file(dir: &Path, name: &str, ids: &[&str]) -> String {
    let file = path(dir, name);
    let conns = ids.iter().map(|id| ssh(id, id)).collect();
    save_external_file(&file, name, vec![], conns, &crate::credential::NullStore).unwrap();
    file
}

#[test]
fn an_unshared_legacy_secret_moves_to_the_scoped_key() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::with(&[("x", PW, "X")]));
    let mgr = manager(dir.path(), &store);
    let file = legacy_file(dir.path(), "team.json", &["x"]);
    configure(&mgr, &[&file]);

    mgr.migrate_credential_scopes();

    assert_eq!(
        store.value(&scoped(&mgr, &file, "x"), PW).as_deref(),
        Some("X")
    );
    assert_eq!(store.value("x", PW), None);
    assert!(mgr.take_credential_scope_notices().is_empty());
}

#[test]
fn a_legacy_secret_shared_with_the_main_store_is_copied_and_noticed_once() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::with(&[("x", PW, "X")]));
    let mgr = manager(dir.path(), &store);
    mgr.save_connection(ssh("x", "x")).unwrap();
    let file = legacy_file(dir.path(), "team.json", &["x"]);
    configure(&mgr, &[&file]);

    mgr.migrate_credential_scopes();

    // The main store keeps the key; the external connection gets a copy.
    assert_eq!(store.value("x", PW).as_deref(), Some("X"));
    assert_eq!(
        store.value(&scoped(&mgr, &file, "x"), PW).as_deref(),
        Some("X")
    );
    let notices = mgr.take_credential_scope_notices();
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0].file_name, "team.json");
    assert!(
        notices[0].message.contains(": x."),
        "{}",
        notices[0].message
    );
    assert!(mgr.take_credential_scope_notices().is_empty());
}

#[test]
fn a_legacy_secret_shared_by_two_files_goes_once_both_have_a_copy() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::with(&[("x", PW, "X")]));
    let mgr = manager(dir.path(), &store);
    let a = legacy_file(dir.path(), "a.json", &["x"]);
    let b = legacy_file(dir.path(), "b.json", &["x"]);
    configure(&mgr, &[&a, &b]);

    mgr.migrate_credential_scopes();

    assert_eq!(
        store.value(&scoped(&mgr, &a, "x"), PW).as_deref(),
        Some("X")
    );
    assert_eq!(
        store.value(&scoped(&mgr, &b, "x"), PW).as_deref(),
        Some("X")
    );
    assert_eq!(store.value("x", PW), None);
    assert_eq!(mgr.take_credential_scope_notices().len(), 2);
}

#[test]
fn migration_waits_for_the_store_to_unlock() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::with(&[("x", PW, "X")]));
    store.locked.store(true, Ordering::SeqCst);
    let mgr = manager(dir.path(), &store);
    let file = legacy_file(dir.path(), "team.json", &["x"]);
    configure(&mgr, &[&file]);

    mgr.load_unified_view().unwrap();
    mgr.migrate_credential_scopes();
    assert!(store.calls().is_empty(), "{:?}", store.calls());

    store.locked.store(false, Ordering::SeqCst);
    mgr.migrate_credential_scopes();
    assert_eq!(
        store.value(&scoped(&mgr, &file, "x"), PW).as_deref(),
        Some("X")
    );
}

#[test]
fn a_secret_removed_after_migration_is_not_copied_again() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::with(&[("x", PW, "X")]));
    let mgr = manager(dir.path(), &store);
    mgr.save_connection(ssh("x", "x")).unwrap();
    let file = legacy_file(dir.path(), "team.json", &["x"]);
    configure(&mgr, &[&file]);
    mgr.migrate_credential_scopes();

    // Rejected at connect and cleared, like the connect flow does.
    store
        .remove(&mgr.connection_credential_key("x", Some(&file), PW))
        .unwrap();
    mgr.migrate_credential_scopes();
    mgr.load_unified_view().unwrap();

    assert_eq!(password(&mgr, &store, "x", Some(&file)), None);
    assert_eq!(store.value("x", PW).as_deref(), Some("X"));
}

#[test]
fn deleting_a_main_connection_first_migrates_a_file_sharing_its_key() {
    // The store was locked while the file loaded; the main connection is
    // deleted right after unlocking.
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::with(&[("x", PW, "X")]));
    store.locked.store(true, Ordering::SeqCst);
    let mgr = manager(dir.path(), &store);
    mgr.save_connection(ssh("x", "x")).unwrap();
    let file = legacy_file(dir.path(), "team.json", &["x"]);
    configure(&mgr, &[&file]);
    mgr.load_unified_view().unwrap();
    store.locked.store(false, Ordering::SeqCst);

    mgr.delete_connection_routed("x", None).unwrap();

    assert_eq!(store.value("x", PW), None);
    assert_eq!(
        store.value(&scoped(&mgr, &file, "x"), PW).as_deref(),
        Some("X")
    );
}

// ── file identity ───────────────────────────────────────────────────────────

#[test]
fn a_renamed_file_keeps_its_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let old = path(dir.path(), "old.json");
    configure(&mgr, &[&old]);
    mgr.save_connection_routed(in_file(with_password(ssh("x", "x"), "EXT"), &old))
        .unwrap();

    let new = path(dir.path(), "new.json");
    std::fs::rename(&old, &new).unwrap();
    configure(&mgr, &[&new]);

    assert_eq!(
        password(&mgr, &store, "x", Some(&new)).as_deref(),
        Some("EXT")
    );
}

#[test]
fn a_copied_file_does_not_inherit_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let original = path(dir.path(), "a.json");
    let copy = path(dir.path(), "b.json");
    configure(&mgr, &[&original, &copy]);
    mgr.save_connection_routed(in_file(with_password(ssh("x", "x"), "EXT"), &original))
        .unwrap();
    std::fs::copy(&original, &copy).unwrap();

    assert_eq!(password(&mgr, &store, "x", Some(&copy)), None);
    assert_eq!(
        password(&mgr, &store, "x", Some(&original)).as_deref(),
        Some("EXT")
    );
}

#[test]
fn rewriting_an_external_file_keeps_its_id() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let file = path(dir.path(), "team.json");
    configure(&mgr, &[&file]);
    mgr.save_connection_routed(in_file(with_password(ssh("x", "x"), "EXT"), &file))
        .unwrap();

    mgr.save_external_file(&file, "team", vec![], vec![ssh("x", "x")])
        .unwrap();

    assert_eq!(
        password(&mgr, &store, "x", Some(&file)).as_deref(),
        Some("EXT")
    );
}

// ── consumers of the scoped keys ────────────────────────────────────────────

#[test]
fn a_jump_host_in_an_external_file_uses_its_own_saved_password() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let file = path(dir.path(), "team.json");
    configure(&mgr, &[&file]);
    mgr.save_connection_routed(in_file(with_password(ssh("gw", "gw"), "GW"), &file))
        .unwrap();
    // A leftover under the bare id (e.g. a deleted main-store `gw`) is not it.
    store
        .set(&CredentialKey::new("gw", PW), "STALE-BARE")
        .unwrap();

    let mut settings = json!({"host": "t", "proxyJump": [{"connectionId": "gw"}]});
    mgr.resolve_jump_host_refs(&mut settings, Some("target"))
        .unwrap();

    assert_eq!(settings["proxyJump"][0]["password"], "GW");
}

#[test]
fn vault_owners_name_external_connections_by_their_scoped_owner_id() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RecordingStore::default());
    let mgr = manager(dir.path(), &store);
    let file = path(dir.path(), "team.json");
    configure(&mgr, &[&file]);
    mgr.save_connection(ssh("x", "x")).unwrap();
    mgr.save_connection_routed(in_file(ssh("x", "x"), &file))
        .unwrap();

    let owners = mgr.credential_owner_names().unwrap();

    assert_eq!(owners.get("x").map(String::as_str), Some("x"));
    assert_eq!(
        owners.get(&scoped(&mgr, &file, "x")).map(String::as_str),
        Some("x (team.json)")
    );
}

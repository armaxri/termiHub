//! File-scoped credential owner ids and file identity (#3591).

use super::*;
use crate::connection::recording_credential_store::RecordingStore;
use crate::credential::master_password::MasterPasswordStore;
use crate::terminal::backend::ConnectionConfig;

const PW: CredentialType = CredentialType::Password;
const KEY: CredentialType = CredentialType::KeyPassphrase;
const SCOPE: &str = "5d0c3a1e-0b8e-4c55-9d6f-2a8b7c1e4f00";

fn conn(id: &str) -> SavedConnection {
    SavedConnection {
        icon: None,
        id: id.to_string(),
        name: id.to_string(),
        config: ConnectionConfig {
            type_id: "ssh".to_string(),
            settings: serde_json::json!({"host": "h", "authMethod": "password"}),
        },
        folder_id: None,
        terminal_options: None,
        source_file: None,
    }
}

fn scoped(id: &str) -> String {
    owner_id(id, Some(SCOPE))
}

fn write_file(path: &Path, file_id: Option<&str>) {
    let mut doc = serde_json::json!({"version": "2", "children": []});
    if let Some(id) = file_id {
        doc["fileId"] = serde_json::json!(id);
    }
    std::fs::write(path, doc.to_string()).unwrap();
}

fn file_id_in(path: &Path) -> Option<String> {
    read_file_id(path.to_str().unwrap())
}

fn s(p: &Path) -> String {
    p.to_str().unwrap().to_string()
}

// ── owner ids ───────────────────────────────────────────────────────────────

#[test]
fn main_store_owner_ids_are_the_bare_connection_id() {
    assert_eq!(owner_id("Work/x", None), "Work/x");
}

#[test]
fn external_owner_ids_are_prefixed_by_the_file_scope() {
    assert_eq!(
        owner_id("Work/x", Some(SCOPE)),
        format!("connection-file:{SCOPE}:Work/x")
    );
    // The scoped key round-trips through the map-key form every store uses.
    let key = CredentialKey::new(&owner_id("a:b", Some(SCOPE)), PW);
    assert_eq!(CredentialKey::from_map_key(&key.to_string()), Some(key));
}

#[test]
fn only_canonical_uuids_are_valid_file_ids() {
    assert!(is_valid_file_id(SCOPE));
    assert!(!is_valid_file_id(&SCOPE.to_uppercase()));
    assert!(!is_valid_file_id(&format!("{{{SCOPE}}}")));
    assert!(!is_valid_file_id("../../etc"));
    assert!(!is_valid_file_id(""));
}

// ── file identity ───────────────────────────────────────────────────────────

#[test]
fn a_file_without_an_id_is_stamped_and_bound() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.json");
    write_file(&file, None);
    let scopes = FileScopes::load(dir.path().join(STATE_FILE_NAME));

    let id = scopes.resolve(&s(&file), &[s(&file)]);

    assert!(is_valid_file_id(&id));
    assert_eq!(file_id_in(&file).as_deref(), Some(id.as_str()));
    assert_eq!(scopes.resolve(&s(&file), &[s(&file)]), id);
    assert!(
        !scopes.is_migrated(&id),
        "an existing file may hold old secrets"
    );
}

#[test]
fn bindings_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.json");
    write_file(&file, None);
    let state = dir.path().join(STATE_FILE_NAME);
    let id = FileScopes::load(state.clone()).resolve(&s(&file), &[s(&file)]);
    FileScopes::load(state.clone()).complete_migration(&id, None, &[]);

    let reloaded = FileScopes::load(state);
    assert_eq!(reloaded.binding(&s(&file)).as_deref(), Some(id.as_str()));
    assert!(reloaded.is_migrated(&id));
}

#[test]
fn a_renamed_file_keeps_its_id() {
    let dir = tempfile::tempdir().unwrap();
    let old = dir.path().join("old.json");
    let new = dir.path().join("new.json");
    write_file(&old, None);
    let scopes = FileScopes::load(dir.path().join(STATE_FILE_NAME));
    let id = scopes.resolve(&s(&old), &[s(&old)]);
    std::fs::rename(&old, &new).unwrap();

    assert_eq!(scopes.resolve(&s(&new), &[s(&new)]), id);
    assert_eq!(scopes.binding(&s(&old)), None, "the old path is released");
}

#[test]
fn a_copied_file_gets_a_fresh_id_and_nothing_to_inherit() {
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("a.json");
    let copy = dir.path().join("b.json");
    write_file(&original, None);
    let scopes = FileScopes::load(dir.path().join(STATE_FILE_NAME));
    let configured = [s(&original), s(&copy)];
    let id = scopes.resolve(&s(&original), &configured);
    std::fs::copy(&original, &copy).unwrap();

    let copy_id = scopes.resolve(&s(&copy), &configured);

    assert_ne!(copy_id, id);
    assert_eq!(file_id_in(&copy).as_deref(), Some(copy_id.as_str()));
    assert!(
        scopes.is_migrated(&copy_id),
        "a copy must not inherit old secrets"
    );
    assert_eq!(scopes.resolve(&s(&original), &configured), id);
}

#[test]
fn a_bound_path_keeps_its_id_when_the_file_claims_another() {
    // A file edited to claim another file's id cannot read that file's secrets.
    let dir = tempfile::tempdir().unwrap();
    let victim = dir.path().join("victim.json");
    let other = dir.path().join("other.json");
    write_file(&victim, None);
    write_file(&other, None);
    let scopes = FileScopes::load(dir.path().join(STATE_FILE_NAME));
    let configured = [s(&victim), s(&other)];
    let victim_id = scopes.resolve(&s(&victim), &configured);
    let other_id = scopes.resolve(&s(&other), &configured);

    write_file(&other, Some(&victim_id));

    assert_eq!(scopes.resolve(&s(&other), &configured), other_id);
    assert_eq!(scopes.resolve(&s(&victim), &configured), victim_id);
}

#[test]
fn a_file_that_lost_its_id_gets_it_back() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.json");
    write_file(&file, None);
    let scopes = FileScopes::load(dir.path().join(STATE_FILE_NAME));
    let id = scopes.resolve(&s(&file), &[s(&file)]);
    write_file(&file, None); // rewritten by a tool that drops unknown fields

    assert_eq!(scopes.resolve(&s(&file), &[s(&file)]), id);
    assert_eq!(file_id_in(&file).as_deref(), Some(id.as_str()));
}

#[test]
fn an_id_already_in_a_new_file_is_adopted_unmigrated() {
    // Another machine stamped the shared file; this machine still has to
    // migrate its own old secrets for it.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.json");
    write_file(&file, Some(SCOPE));
    let scopes = FileScopes::load(dir.path().join(STATE_FILE_NAME));

    assert_eq!(scopes.resolve(&s(&file), &[s(&file)]), SCOPE);
    assert!(!scopes.is_migrated(SCOPE));
}

#[test]
fn an_invalid_id_in_a_file_is_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.json");
    write_file(&file, Some("not-a-uuid"));
    let scopes = FileScopes::load(dir.path().join(STATE_FILE_NAME));

    let id = scopes.resolve(&s(&file), &[s(&file)]);
    assert!(is_valid_file_id(&id));
    assert_eq!(file_id_in(&file).as_deref(), Some(id.as_str()));
}

#[test]
fn a_missing_file_is_bound_but_not_migrated() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("later.json");
    let scopes = FileScopes::load(dir.path().join(STATE_FILE_NAME));

    let id = scopes.resolve(&s(&file), &[s(&file)]);
    assert!(!scopes.is_migrated(&id));
    // Created later without an id: it gets the bound one.
    write_file(&file, None);
    assert_eq!(scopes.resolve(&s(&file), &[s(&file)]), id);
    assert_eq!(file_id_in(&file).as_deref(), Some(id.as_str()));
}

#[test]
fn notices_are_taken_once() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join(STATE_FILE_NAME);
    let scopes = FileScopes::load(state.clone());
    let notice = ScopeNotice {
        file_path: "/f.json".to_string(),
        connection_names: vec!["x".to_string()],
    };
    scopes.complete_migration(SCOPE, Some(notice.clone()), &[]);

    // Persisted until shown, so a crash before showing it keeps it.
    assert_eq!(FileScopes::load(state.clone()).take_notices(), vec![notice]);
    assert!(FileScopes::load(state).take_notices().is_empty());
}

#[test]
fn kept_bare_keys_survive_a_restart_until_forgotten() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join(STATE_FILE_NAME);
    FileScopes::load(state.clone()).complete_migration(SCOPE, None, &["x".to_string()]);

    let reloaded = FileScopes::load(state.clone());
    assert_eq!(reloaded.kept_bare_keys(), vec!["x".to_string()]);
    reloaded.forget_kept_bare_keys(&["x".to_string()]);
    assert!(FileScopes::load(state).kept_bare_keys().is_empty());
}

#[test]
fn a_corrupt_state_file_starts_over() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join(STATE_FILE_NAME);
    std::fs::write(&state, "{ not json").unwrap();
    let scopes = FileScopes::load(state.clone());
    assert_eq!(scopes.binding("/anything"), None);
    assert!(state.with_extension("json.bak").exists());
}

// ── migration of pre-#3591 secrets ──────────────────────────────────────────

fn alone(_: &str) -> LegacyHolders {
    LegacyHolders::default()
}

#[test]
fn an_unshared_secret_moves_to_the_scoped_key() {
    let store = RecordingStore::with(&[("x", PW, "X"), ("x", KEY, "XK")]);
    let result = migrate_legacy_keys(SCOPE, &[conn("x")], alone, &store).unwrap();
    assert_eq!(result, MigratedKeys::default());
    assert_eq!(store.value(&scoped("x"), PW).as_deref(), Some("X"));
    assert_eq!(store.value(&scoped("x"), KEY).as_deref(), Some("XK"));
    assert_eq!(store.value("x", PW), None);
    assert_eq!(store.value("x", KEY), None);
}

#[test]
fn a_secret_shared_with_the_main_store_is_copied_and_reported() {
    let store = RecordingStore::with(&[("x", PW, "X")]);
    let shared = migrate_legacy_keys(
        SCOPE,
        &[conn("x")],
        |_| LegacyHolders {
            shared: true,
            keep_bare_key: true,
        },
        &store,
    )
    .unwrap();
    assert_eq!(shared.shared, vec!["x".to_string()]);
    assert_eq!(shared.kept_bare, vec!["x".to_string()]);
    assert_eq!(store.value("x", PW).as_deref(), Some("X"));
    assert_eq!(store.value(&scoped("x"), PW).as_deref(), Some("X"));
}

#[test]
fn an_existing_scoped_secret_is_never_overwritten() {
    let store = RecordingStore::with(&[("x", PW, "OLD"), (&scoped("x"), PW, "NEW")]);
    migrate_legacy_keys(SCOPE, &[conn("x")], alone, &store).unwrap();
    assert_eq!(store.value(&scoped("x"), PW).as_deref(), Some("NEW"));
    // Nothing was copied, so the bare key is not this migration's to delete.
    assert_eq!(store.value("x", PW).as_deref(), Some("OLD"));
}

#[test]
fn migration_is_idempotent() {
    let store = RecordingStore::with(&[("x", PW, "X")]);
    let holders = |_: &str| LegacyHolders {
        shared: true,
        keep_bare_key: true,
    };
    migrate_legacy_keys(SCOPE, &[conn("x")], holders, &store).unwrap();
    let after_first = store.snapshot();
    let again = migrate_legacy_keys(SCOPE, &[conn("x")], holders, &store).unwrap();
    assert_eq!(again, MigratedKeys::default());
    assert_eq!(store.snapshot(), after_first);
}

#[test]
fn a_failed_copy_deletes_nothing() {
    let mut store = RecordingStore::with(&[("x", PW, "X")]);
    store.fail_sets = true;
    assert!(migrate_legacy_keys(SCOPE, &[conn("x")], alone, &store).is_err());
    // Only the failed batch's own rollback may remove anything.
    assert!(
        !store.calls().iter().any(|c| c.starts_with("remove x:")),
        "{:?}",
        store.calls()
    );
    assert_eq!(store.value("x", PW).as_deref(), Some("X"));
}

#[test]
fn a_locked_store_is_left_untouched() {
    let mut store = RecordingStore::with(&[("x", PW, "X")]);
    store.fail_gets = true;
    assert!(migrate_legacy_keys(SCOPE, &[conn("x")], alone, &store).is_err());
    assert!(store.calls().iter().all(|c| c.starts_with("get")));
}

#[test]
fn every_copy_is_written_before_any_bare_key_is_deleted() {
    let store = RecordingStore::with(&[("a", PW, "A"), ("b", PW, "B")]);
    migrate_legacy_keys(SCOPE, &[conn("a"), conn("b")], alone, &store).unwrap();
    let calls = store.calls();
    let last_set = calls.iter().rposition(|c| c.starts_with("set")).unwrap();
    let first_remove = calls.iter().position(|c| c.starts_with("remove")).unwrap();
    assert!(last_set < first_remove, "{calls:?}");
}

#[test]
fn the_copy_is_durable_in_the_master_password_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = MasterPasswordStore::new(dir.path().join("credentials.enc"));
    store.setup("pw").unwrap();
    store.set(&CredentialKey::new("x", PW), "X").unwrap();

    migrate_legacy_keys(SCOPE, &[conn("x")], alone, &store).unwrap();

    store.lock();
    store.unlock("pw").unwrap();
    assert_eq!(
        store
            .get(&CredentialKey::new(&scoped("x"), PW))
            .unwrap()
            .as_deref(),
        Some("X")
    );
    assert_eq!(store.get(&CredentialKey::new("x", PW)).unwrap(), None);
}

#[test]
fn the_copy_works_in_the_os_keychain_store() {
    let _mock = crate::credential::os_keychain::test_support::install_mock();
    let store = crate::credential::OsKeychainStore::new();
    store.set(&CredentialKey::new("kc-x", PW), "X").unwrap();

    migrate_legacy_keys(SCOPE, &[conn("kc-x")], alone, &store).unwrap();

    assert_eq!(
        store
            .get(&CredentialKey::new(&scoped("kc-x"), PW))
            .unwrap()
            .as_deref(),
        Some("X")
    );
    assert_eq!(store.get(&CredentialKey::new("kc-x", PW)).unwrap(), None);
}

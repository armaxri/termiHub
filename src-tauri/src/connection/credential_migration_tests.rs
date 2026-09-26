//! Credential migration applies id changes as one permutation (#3578).

use super::*;
use crate::connection::recording_credential_store::RecordingStore;
use crate::credential::master_password::MasterPasswordStore;

const PW: CredentialType = CredentialType::Password;
const KEY: CredentialType = CredentialType::KeyPassphrase;
const SUDO: CredentialType = CredentialType::SudoPassword;

fn change(old: &str, new: &str) -> ConnectionIdChange {
    ConnectionIdChange::new(old, new)
}

fn migrate_all(changes: &[ConnectionIdChange], store: &dyn CredentialStore) -> Result<()> {
    migrate_credentials(changes, |_| true, |_| false, store)
}

#[test]
fn a_swap_exchanges_secrets() {
    let store = RecordingStore::with(&[("a", PW, "A"), ("b", PW, "B")]);
    migrate_all(&[change("a", "b"), change("b", "a")], &store).unwrap();
    assert_eq!(store.value("a", PW).as_deref(), Some("B"));
    assert_eq!(store.value("b", PW).as_deref(), Some("A"));
}

#[test]
fn a_chain_shifts_every_secret_without_clobbering() {
    // `a` takes `b`'s name, `b` becomes `b (1)`, which becomes `b (1) (1)`.
    let store = RecordingStore::with(&[("a", PW, "A"), ("b", PW, "B"), ("b (1)", PW, "B1")]);
    migrate_all(
        &[
            change("a", "b"),
            change("b", "b (1)"),
            change("b (1)", "b (1) (1)"),
        ],
        &store,
    )
    .unwrap();
    assert_eq!(store.value("a", PW), None);
    assert_eq!(store.value("b", PW).as_deref(), Some("A"));
    assert_eq!(store.value("b (1)", PW).as_deref(), Some("B"));
    assert_eq!(store.value("b (1) (1)", PW).as_deref(), Some("B1"));
}

#[test]
fn every_credential_type_moves_including_sudo() {
    let store = RecordingStore::with(&[("a", PW, "p"), ("a", KEY, "k"), ("a", SUDO, "s")]);
    migrate_all(&[change("a", "z")], &store).unwrap();
    assert_eq!(store.value("z", PW).as_deref(), Some("p"));
    assert_eq!(store.value("z", KEY).as_deref(), Some("k"));
    assert_eq!(store.value("z", SUDO).as_deref(), Some("s"));
    assert!(store.snapshot().keys().all(|k| k.starts_with("z:")));
}

#[test]
fn all_reads_come_before_writes_and_writes_before_deletes() {
    let store = RecordingStore::with(&[("a", PW, "A"), ("b", PW, "B"), ("c", PW, "C")]);
    migrate_all(
        &[change("a", "x"), change("b", "a"), change("c", "b")],
        &store,
    )
    .unwrap();
    let calls = store.calls();
    let last_get = calls.iter().rposition(|c| c.starts_with("get")).unwrap();
    let first_set = calls.iter().position(|c| c.starts_with("set")).unwrap();
    let last_set = calls.iter().rposition(|c| c.starts_with("set")).unwrap();
    let first_remove = calls.iter().position(|c| c.starts_with("remove")).unwrap();
    assert!(last_get < first_set && last_set < first_remove, "{calls:?}");
    // Only `c` is left without an owner; `a` and `b` were rewritten.
    assert_eq!(
        calls.iter().filter(|c| c.starts_with("remove")).count(),
        1,
        "{calls:?}"
    );
    assert_eq!(store.value("x", PW).as_deref(), Some("A"));
    assert_eq!(store.value("a", PW).as_deref(), Some("B"));
    assert_eq!(store.value("b", PW).as_deref(), Some("C"));
    assert_eq!(store.value("c", PW), None);
}

#[test]
fn a_secret_left_behind_by_a_swap_partner_is_removed_not_inherited() {
    // Only `a` has a secret; after the swap, the connection now at `a` (the old
    // `b`) must not inherit `a`'s secret.
    let store = RecordingStore::with(&[("a", PW, "A")]);
    migrate_all(&[change("a", "b"), change("b", "a")], &store).unwrap();
    assert_eq!(store.value("b", PW).as_deref(), Some("A"));
    assert_eq!(store.value("a", PW), None);
}

#[test]
fn a_failed_write_deletes_nothing() {
    let mut store = RecordingStore::with(&[("a", PW, "A"), ("b", PW, "B")]);
    store.fail_sets = true;
    assert!(migrate_all(&[change("a", "b"), change("b", "b (1)")], &store).is_err());
    assert!(
        !store.calls().iter().any(|c| c.starts_with("remove")),
        "{:?}",
        store.calls()
    );
    assert_eq!(store.value("a", PW).as_deref(), Some("A"));
    assert_eq!(store.value("b", PW).as_deref(), Some("B"));
}

#[test]
fn a_locked_store_is_left_untouched() {
    let mut store = RecordingStore::with(&[("a", PW, "A")]);
    store.fail_gets = true;
    assert!(migrate_all(&[change("a", "b")], &store).is_err());
    assert!(store.calls().iter().all(|c| c.starts_with("get")));
    assert_eq!(store.value("a", PW).as_deref(), Some("A"));
}

#[test]
fn connections_without_auth_never_touch_the_store() {
    let store = RecordingStore {
        fail_gets: true,
        ..Default::default()
    };
    migrate_credentials(&[change("a", "b")], |_| false, |_| false, &store).unwrap();
    assert!(store.calls().is_empty());
}

#[test]
fn an_old_id_still_owned_by_an_unmoved_connection_keeps_its_secret() {
    // A move between files: the old id is still used by another connection.
    let store = RecordingStore::with(&[("n", PW, "N")]);
    migrate_credentials(&[change("n", "n (1)")], |_| true, |id| id == "n", &store).unwrap();
    assert_eq!(store.value("n", PW).as_deref(), Some("N"));
    assert_eq!(store.value("n (1)", PW).as_deref(), Some("N"));
}

#[test]
fn named_credentials_are_never_touched() {
    let named_id = named::owner_id("cred-1");
    let store = RecordingStore::with(&[(&named_id, PW, "shared")]);
    migrate_all(&[change(&named_id, "x"), change("y", &named_id)], &store).unwrap();
    assert!(store.calls().is_empty());
    assert_eq!(store.value(&named_id, PW).as_deref(), Some("shared"));
}

#[test]
fn a_swap_is_atomic_in_the_master_password_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = MasterPasswordStore::new(dir.path().join("credentials.enc"));
    store.setup("pw").unwrap();
    store.set(&CredentialKey::new("a", PW), "A").unwrap();
    store.set(&CredentialKey::new("b", PW), "B").unwrap();
    store.set(&CredentialKey::new("b", KEY), "BK").unwrap();

    migrate_all(&[change("a", "b"), change("b", "a")], &store).unwrap();

    store.lock();
    store.unlock("pw").unwrap();
    assert_eq!(
        store.get(&CredentialKey::new("a", PW)).unwrap().as_deref(),
        Some("B")
    );
    assert_eq!(
        store.get(&CredentialKey::new("b", PW)).unwrap().as_deref(),
        Some("A")
    );
    assert_eq!(
        store.get(&CredentialKey::new("a", KEY)).unwrap().as_deref(),
        Some("BK")
    );
    assert_eq!(store.get(&CredentialKey::new("b", KEY)).unwrap(), None);
}

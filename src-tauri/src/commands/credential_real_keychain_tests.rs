//! Opt-in tests of the OS keychain credential store and the store switch
//! against the **real** macOS Keychain (#5514).
//!
//! Every other credential test uses the `keyring` mock, which cannot show
//! what the real keychain returns for an item that was never written, or for
//! one an earlier, differently signed build wrote (`errSecAuthFailed`). These
//! cover: a read of a never-written key, set/get/delete, choosing the OS
//! keychain store and switching away from it (to a master password, back, and
//! to `none`), saving over a leftover item this build may not read (#5527), and
//! an update to a differently signed build (#5527): a re-signed copy of this
//! test binary stands in for it.
//!
//! They touch the keychain only when `TERMIHUB_REAL_KEYCHAIN_TESTS=1` is set
//! **and** the build's keychain namespace is a per-run CI namespace
//! (`TERMIHUB_DEV_NAME=ci-…`, so the service is `termiHub-dev-ci-…`): never
//! the installed app's `termiHub` service, never a developer checkout's own
//! namespace. A drop guard deletes every item a test may have written.
//!
//! `scripts/internal/real-keychain-tests.sh` runs them in a throwaway
//! keychain with a per-run namespace; CI runs it on the macOS `Run Tests` leg.

use keyring::Entry;

use super::{collect_credentials_for_migration, migrate_credentials};
use super::{perform_switch, MigrationStatus};
use crate::commands::credential_vault::keys_for_owners;
use crate::credential::keychain_namespace::KeychainNamespace;
use crate::credential::keychain_unread::{PlatformUnreadItems, UnreadItems};
use crate::credential::os_keychain::test_support::install_platform;
use crate::credential::os_keychain::ItemPolicy;
use crate::credential::{
    CredentialKey, CredentialManager, CredentialStore, CredentialType, OsKeychainStore, StorageMode,
};

/// The opt-in flag; only `1` enables the tests.
const FLAG: &str = "TERMIHUB_REAL_KEYCHAIN_TESTS";
/// The prefix the per-run namespace must give the credential service.
const CI_SERVICE_PREFIX: &str = "termiHub-dev-ci-";
/// The connection ids the tests write credentials for.
const CONNECTIONS: [&str; 3] = ["Chooser test (SSH)", "ci-5514-leftover", "ci-5527-update"];
/// Set (to the parent's index directory) only in the re-signed copy the
/// update test runs.
const UPDATE_DIR_ENV: &str = "TERMIHUB_KEYCHAIN_UPDATE_DIR";
/// The helper test the re-signed copy runs.
const UPDATE_HELPER: &str =
    "commands::credential::real_keychain_tests::update_helper_the_updated_build_saves_over_the_old_item";

/// The credential service of this run, or `None` (test skipped) unless the
/// tests are enabled. Panics when enabled without a per-run CI namespace, so
/// a misconfigured run fails instead of touching a real namespace.
fn ci_service(test: &str) -> Option<String> {
    if std::env::var(FLAG).ok().as_deref() != Some("1") {
        eprintln!("skipping {test}: set {FLAG}=1 to run it against the real OS keychain");
        return None;
    }
    let service = KeychainNamespace::current().name("termiHub");
    assert!(
        service.starts_with(CI_SERVICE_PREFIX),
        "{test}: refusing to touch keychain service {service}; set TERMIHUB_DEV_NAME=ci-<run>"
    );
    Some(service)
}

/// Deletes every item of [`CONNECTIONS`] under the run's service on drop,
/// also when the test panics, without reading them (so also an item another
/// build wrote, #5527). Declared after the keyring guard, so it runs while
/// the platform keyring is still installed.
struct Cleanup {
    service: String,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        for id in CONNECTIONS {
            for t in CredentialType::ALL {
                let account = CredentialKey::new(id, t).to_string();
                let deleted = Entry::new(&self.service, &account)
                    .map_err(|e| e.to_string())
                    .and_then(|e| PlatformUnreadItems.delete(&e).map_err(|c| c.to_string()));
                if let Err(e) = deleted {
                    eprintln!("could not delete {}/{account}: {e}", self.service);
                }
            }
        }
    }
}

/// A store with the installed app's [`ItemPolicy`], so it reads the real
/// keychain for keys it never wrote; its index lives in `dir`.
fn release_store(dir: &std::path::Path) -> OsKeychainStore {
    let mut store =
        OsKeychainStore::with_index_file(dir.join(crate::credential::keychain_index::FILE_NAME));
    store.set_item_policy_for_test(ItemPolicy::Release);
    store
}

/// Keep keychain access prompts from appearing: a read macOS would ask about
/// fails with `errSecAuthFailed` instead.
fn no_prompts() -> security_framework::os::macos::keychain::KeychainUserInteractionLock {
    security_framework::os::macos::keychain::SecKeychain::disable_user_interaction()
        .expect("disable keychain user interaction")
}

fn password(id: &str) -> CredentialKey {
    CredentialKey::new(id, CredentialType::Password)
}

/// Switch `mgr` to `target`, migrating (or, for `none`, removing) every
/// credential the current store holds for `owner` — what the
/// `switch_credential_store` command does.
fn switch(mgr: &CredentialManager, target: StorageMode, master: Option<&str>, owner: &str) {
    let probe = keys_for_owners(&[owner.to_string()]);
    let creds = collect_credentials_for_migration(mgr, &mgr.get_mode(), &probe)
        .unwrap_or_else(|e| panic!("switch to {target:?} refused: {e}"));
    let result = perform_switch(
        mgr,
        target.clone(),
        master.map(str::to_string),
        &creds,
        migrate_credentials,
        |_| {},
    )
    .unwrap_or_else(|e| panic!("switch to {target:?} failed: {e}"));
    assert_eq!(result.status, MigrationStatus::Success, "{result:?}");
    assert!(!result.rolled_back);
    assert_eq!(mgr.get_mode(), target);
}

#[test]
fn never_written_keys_read_as_absent_and_round_trip() {
    let Some(service) = ci_service("never_written_keys_read_as_absent_and_round_trip") else {
        return;
    };
    let _keyring = install_platform();
    let _cleanup = Cleanup {
        service: service.clone(),
    };
    let dir = tempfile::tempdir().unwrap();
    let store = release_store(dir.path());
    let id = CONNECTIONS[0];

    for t in CredentialType::ALL {
        let key = CredentialKey::new(id, t);
        assert_eq!(store.get(&key).unwrap(), None, "{key} was never written");
    }
    store.seed_key_index(&keys_for_owners(&[id.to_string()]));
    assert!(store.list_keys().unwrap().is_empty());

    store.set(&password(id), "ci-5514-secret").unwrap();
    assert_eq!(
        store.get(&password(id)).unwrap().as_deref(),
        Some("ci-5514-secret")
    );
    assert_eq!(store.list_keys().unwrap(), vec![password(id)]);
    store.remove(&password(id)).unwrap();
    assert_eq!(store.get(&password(id)).unwrap(), None);
    assert!(store.list_keys().unwrap().is_empty());
}

#[test]
fn a_fresh_os_keychain_store_saves_resolves_and_switches_away() {
    let Some(service) = ci_service("a_fresh_os_keychain_store_saves_resolves_and_switches_away")
    else {
        return;
    };
    let _keyring = install_platform();
    let _cleanup = Cleanup {
        service: service.clone(),
    };
    let dir = tempfile::tempdir().unwrap();
    let mgr = CredentialManager::new(StorageMode::None, dir.path().to_path_buf());
    let id = CONNECTIONS[0];

    // The first-save chooser: none -> OS keychain, nothing to migrate.
    switch(&mgr, StorageMode::OsKeychain, None, id);
    for t in CredentialType::ALL {
        assert_eq!(mgr.get(&CredentialKey::new(id, t)).unwrap(), None);
    }
    mgr.set(&password(id), "ci-5514-secret").unwrap();
    assert_eq!(
        mgr.get(&password(id)).unwrap().as_deref(),
        Some("ci-5514-secret")
    );

    // Away to a master password and back.
    switch(
        &mgr,
        StorageMode::MasterPassword,
        Some("ci-5514-master"),
        id,
    );
    assert_eq!(
        mgr.get(&password(id)).unwrap().as_deref(),
        Some("ci-5514-secret")
    );
    switch(&mgr, StorageMode::OsKeychain, None, id);
    assert_eq!(
        mgr.get(&password(id)).unwrap().as_deref(),
        Some("ci-5514-secret")
    );

    // To none: the secret leaves the keychain.
    switch(&mgr, StorageMode::None, None, id);
    let reopened = OsKeychainStore::new();
    assert_eq!(reopened.get(&password(id)).unwrap(), None);
    let probe = Entry::new(&service, &password(id).to_string()).unwrap();
    assert!(matches!(probe.get_password(), Err(keyring::Error::NoEntry)));
}

/// A leftover item another binary wrote (here `/usr/bin/security`, whose
/// access list trusts only itself — exactly what an earlier, differently
/// signed termiHub build leaves behind) must not strand a fresh store, and a
/// dev build (this test build) saves over it without a prompt (#5527).
#[test]
fn a_leftover_item_this_build_may_not_read_does_not_strand_the_store() {
    let Some(service) =
        ci_service("a_leftover_item_this_build_may_not_read_does_not_strand_the_store")
    else {
        return;
    };
    let _keyring = install_platform();
    let _cleanup = Cleanup {
        service: service.clone(),
    };
    let id = CONNECTIONS[1];
    let account = password(id).to_string();
    let _leftover = ForeignItem::add(&service, &account);
    // No access prompt may appear: the keychain answers errSecAuthFailed.
    let _no_ui = no_prompts();

    let dir = tempfile::tempdir().unwrap();
    let mgr = CredentialManager::new(StorageMode::None, dir.path().to_path_buf());
    switch(&mgr, StorageMode::OsKeychain, None, id);
    assert_eq!(mgr.get(&password(id)).unwrap(), None);
    mgr.remove_all_for_connection(id).unwrap();

    mgr.set(&password(id), "ci-5514-secret").unwrap();
    assert_eq!(
        mgr.get(&password(id)).unwrap().as_deref(),
        Some("ci-5514-secret")
    );

    switch(
        &mgr,
        StorageMode::MasterPassword,
        Some("ci-5514-master"),
        id,
    );
    switch(&mgr, StorageMode::OsKeychain, None, id);
    assert_eq!(
        mgr.get(&password(id)).unwrap().as_deref(),
        Some("ci-5514-secret")
    );
    switch(&mgr, StorageMode::None, None, id);
    // Replaced by the saved secret, which the switch to none removed.
    assert!(!ForeignItem::exists(&service, &account));
}

/// The installed app's policy: a leftover it may not read reads as absent
/// (#5514), and saving over it replaces it (#5527).
#[test]
fn a_release_store_saves_over_a_leftover_it_may_not_read() {
    let Some(service) = ci_service("a_release_store_saves_over_a_leftover_it_may_not_read") else {
        return;
    };
    let _keyring = install_platform();
    let _cleanup = Cleanup {
        service: service.clone(),
    };
    let id = CONNECTIONS[1];
    let account = password(id).to_string();
    let _leftover = ForeignItem::add(&service, &account);
    let _no_ui = no_prompts();

    let dir = tempfile::tempdir().unwrap();
    let store = release_store(dir.path());
    assert_eq!(store.get(&password(id)).unwrap(), None);
    store.set(&password(id), "ci-5527-secret").unwrap();
    assert_eq!(
        store.get(&password(id)).unwrap().as_deref(),
        Some("ci-5527-secret")
    );
    assert_eq!(store.list_keys().unwrap(), vec![password(id)]);
    store.remove(&password(id)).unwrap();
    assert!(!ForeignItem::exists(&service, &account));
}

/// An update of the unsigned app: the old build saved a password, a build
/// with a new ad-hoc signature (a re-signed copy of this test binary) cannot
/// read it, gets an error that says how to recover, and saving the secret
/// again replaces the item — after which the old build is the one locked out.
#[test]
fn an_update_signed_differently_can_replace_what_the_old_build_saved() {
    let Some(service) =
        ci_service("an_update_signed_differently_can_replace_what_the_old_build_saved")
    else {
        return;
    };
    let _keyring = install_platform();
    let _cleanup = Cleanup {
        service: service.clone(),
    };
    let _no_ui = no_prompts();
    let id = CONNECTIONS[2];
    let dir = tempfile::tempdir().unwrap();
    let store = release_store(dir.path());
    store.set(&password(id), "before-update").unwrap();
    assert_eq!(
        store.get(&password(id)).unwrap().as_deref(),
        Some("before-update")
    );

    let updated = UpdatedBuild::new();
    let output = std::process::Command::new(&updated.path)
        .args([UPDATE_HELPER, "--exact", "--ignored", "--test-threads=1"])
        .env(UPDATE_DIR_ENV, dir.path())
        .output()
        .expect("run the re-signed test binary");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "the updated build failed:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );

    // The item now trusts the updated build only.
    let err = store.get(&password(id)).unwrap_err().to_string();
    assert!(err.contains("errSecAuthFailed"), "{err}");
}

/// Run by [`an_update_signed_differently_can_replace_what_the_old_build_saved`]
/// in the re-signed copy only; a no-op anywhere else.
#[test]
#[ignore = "helper: an_update_signed_differently_can_replace_what_the_old_build_saved"]
fn update_helper_the_updated_build_saves_over_the_old_item() {
    let Some(dir) = std::env::var_os(UPDATE_DIR_ENV) else {
        return;
    };
    let Some(_service) = ci_service("update_helper_the_updated_build_saves_over_the_old_item")
    else {
        return;
    };
    let _keyring = install_platform();
    let _no_ui = no_prompts();
    let store = release_store(std::path::Path::new(&dir));
    let id = CONNECTIONS[2];
    assert_eq!(store.list_keys().unwrap(), vec![password(id)]);

    // Fail closed, with the recovery path in the message.
    let err = store.get(&password(id)).unwrap_err().to_string();
    assert!(err.contains("errSecAuthFailed"), "{err}");
    assert!(err.contains("save it to replace the item"), "{err}");

    store.set(&password(id), "after-update").unwrap();
    assert_eq!(
        store.get(&password(id)).unwrap().as_deref(),
        Some("after-update")
    );
}

/// A copy of this test binary with a new ad-hoc signature (another code
/// directory hash, as every rebuild or update of an unsigned build has),
/// deleted on drop.
struct UpdatedBuild {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}

impl UpdatedBuild {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("termihub-updated");
        let exe = std::env::current_exe().unwrap();
        // `-c` clones on APFS, so the copy costs no disk until it is re-signed.
        let copied = std::process::Command::new("/bin/cp")
            .arg("-c")
            .arg(&exe)
            .arg(&path)
            .status()
            .is_ok_and(|s| s.success())
            || std::fs::copy(&exe, &path).is_ok();
        assert!(copied, "could not copy the test binary");
        let signed = std::process::Command::new("/usr/bin/codesign")
            .args([
                "--force",
                "--sign",
                "-",
                "--identifier",
                "termihub-dev-ci-update",
            ])
            .arg(&path)
            .output()
            .expect("run codesign");
        // Captured: codesign's "replacing existing signature" on the
        // inherited stderr would split the test's `... ok` line.
        assert!(
            signed.status.success(),
            "could not re-sign the test binary: {}",
            String::from_utf8_lossy(&signed.stderr)
        );
        Self { _dir: dir, path }
    }
}

/// A generic-password item written by `/usr/bin/security`, deleted again on
/// drop with the same tool (its owner).
struct ForeignItem {
    service: String,
    account: String,
}

impl ForeignItem {
    fn add(service: &str, account: &str) -> Self {
        assert!(service.starts_with(CI_SERVICE_PREFIX));
        let status = std::process::Command::new("/usr/bin/security")
            .args([
                "add-generic-password",
                "-s",
                service,
                "-a",
                account,
                "-w",
                "ci-5514-leftover",
            ])
            .status()
            .expect("run /usr/bin/security");
        assert!(status.success(), "could not add the leftover item");
        Self {
            service: service.to_string(),
            account: account.to_string(),
        }
    }

    fn exists(service: &str, account: &str) -> bool {
        std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", service, "-a", account])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
}

impl Drop for ForeignItem {
    fn drop(&mut self) {
        let _ = std::process::Command::new("/usr/bin/security")
            .args([
                "delete-generic-password",
                "-s",
                &self.service,
                "-a",
                &self.account,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

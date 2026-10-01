//! The shared named-credential journey across an app restart (#3557, #4012).
//!
//! Two SSH connections share one credential. Every step goes through the real
//! on-disk registry and a real master-password store, and "restart" means
//! dropping both and loading fresh ones from the same config directory — the
//! same pair `boot` builds at startup. Connection secrets are resolved through
//! the connect path's own lookup ([`resolve_credential`]).

use std::path::Path;

use serde_json::{json, Value};

use super::*;
use crate::connection::jump_host_resolver::resolve_credential;
use crate::connection::manager::prepare_for_storage;
use crate::credential::CredentialManager;
use crate::terminal::backend::ConnectionConfig;

const MASTER: &str = "master-pw";
const SECRET: &str = "shared-sentinel-4012";
const WRONG: &str = "wrong-password";

/// The app's state as `boot` rebuilds it from the config directory.
struct App {
    store: CredentialManager,
    registry: NamedCredentialRegistry,
}

impl App {
    /// First launch: set up the master password and an empty registry.
    fn first_launch(dir: &Path) -> Self {
        let store = CredentialManager::new(StorageMode::MasterPassword, dir.to_path_buf());
        store
            .with_master_password_store(|s| s.setup(MASTER))
            .unwrap()
            .unwrap();
        Self::load_registry(dir, store)
    }

    /// A later launch: the store starts locked until the user unlocks it.
    fn restart(self, dir: &Path) -> Self {
        drop(self);
        let store = CredentialManager::new(StorageMode::MasterPassword, dir.to_path_buf());
        Self::load_registry(dir, store)
    }

    fn load_registry(dir: &Path, store: CredentialManager) -> Self {
        let (registry, warnings) = NamedCredentialRegistry::load(dir);
        assert!(warnings.is_empty(), "clean load: {warnings:?}");
        Self { store, registry }
    }

    fn unlock(&self) {
        self.store
            .with_master_password_store(|s| s.unlock(MASTER))
            .unwrap()
            .unwrap();
    }

    fn lock(&self) {
        self.store.with_master_password_store(|s| s.lock()).unwrap();
    }

    /// The password the connect path would use for `connection`.
    fn connect_secret(&self, connection: &SavedConnection) -> anyhow::Result<Option<String>> {
        resolve_credential(
            &connection.id,
            Some(&connection.id),
            &connection.config.settings,
            "password",
            &self.store,
        )
    }

    fn rotate(&self, id: &str, secret: &str) {
        self.registry
            .rotate(&self.store, &StorageMode::MasterPassword, id, secret)
            .unwrap();
    }
}

/// An SSH connection referencing shared credential `credential_id`, saved the
/// way the connection editor saves it (a typed password is never kept).
fn shared_ssh(
    id: &str,
    name: &str,
    credential_id: &str,
    store: &CredentialManager,
) -> SavedConnection {
    let settings: Value = json!({
        "host": "127.0.0.1", "port": 2222, "username": "testuser",
        "authMethod": "password", "credentialRef": credential_id,
        "password": "typed-but-ignored", "savePassword": true,
    });
    let connection = SavedConnection {
        extra: Default::default(),
        id: id.to_string(),
        name: name.to_string(),
        config: ConnectionConfig {
            type_id: "ssh".to_string(),
            settings,
        },
        folder_id: None,
        terminal_options: None,
        icon: None,
        source_file: None,
    };
    prepare_for_storage(connection, None, store).unwrap()
}

fn assert_both_resolve(app: &App, connections: &[SavedConnection], expected: &str) {
    for connection in connections {
        assert_eq!(
            app.connect_secret(connection).unwrap().as_deref(),
            Some(expected),
            "{} resolves the shared secret",
            connection.name
        );
    }
}

#[test]
fn two_connections_share_one_credential_across_restart_lock_rotate_and_delete() {
    let dir = tempfile::tempdir().unwrap();
    let app = App::first_launch(dir.path());
    let cred = app
        .registry
        .create(
            &app.store,
            &StorageMode::MasterPassword,
            "Lab login",
            NamedCredentialKind::Password,
            SECRET,
        )
        .unwrap();
    let connections = [
        shared_ssh("conn-a", "Lab A", &cred.id, &app.store),
        shared_ssh("conn-b", "Lab B", &cred.id, &app.store),
    ];
    // The reference is authoritative: no per-connection secret was stored.
    for connection in &connections {
        assert!(connection.config.settings.get("password").is_none());
        let own = CredentialKey::new(&connection.id, CredentialType::Password);
        assert_eq!(app.store.get(&own).unwrap(), None);
    }
    assert_both_resolve(&app, &connections, SECRET);

    // Restart: the credential survives, the store comes back locked.
    let app = app.restart(dir.path());
    assert_eq!(app.registry.list().len(), 1);
    assert_eq!(app.registry.get(&cred.id).unwrap().name, "Lab login");
    assert!(
        app.connect_secret(&connections[0]).is_err(),
        "a locked store refuses rather than connecting without the secret"
    );
    app.unlock();
    assert_both_resolve(&app, &connections, SECRET);

    // Lock / unlock in one session.
    app.lock();
    assert!(app.connect_secret(&connections[1]).is_err());
    app.unlock();
    assert_both_resolve(&app, &connections, SECRET);

    // Rotate to a wrong secret: both connections follow, and it persists.
    app.rotate(&cred.id, WRONG);
    assert_both_resolve(&app, &connections, WRONG);
    let app = app.restart(dir.path());
    app.unlock();
    assert_both_resolve(&app, &connections, WRONG);
    assert!(app.registry.get(&cred.id).unwrap().rotated_at.is_some());

    // ...and back.
    app.rotate(&cred.id, SECRET);
    assert_both_resolve(&app, &connections, SECRET);

    // Delete is refused while both connections use it, naming both.
    let usages = find_usages(&cred.id, &connections, &[]);
    let err = app
        .registry
        .delete(&app.store, &StorageMode::MasterPassword, &cred.id, usages)
        .unwrap_err();
    match err {
        NamedCredentialError::InUse { usages, .. } => {
            let names: Vec<_> = usages.iter().map(|u| u.owner_name.as_str()).collect();
            assert_eq!(names, ["Lab A", "Lab B"]);
        }
        other => panic!("expected InUse, got {other:?}"),
    }

    // The refusal changed nothing, also after a restart.
    let app = app.restart(dir.path());
    app.unlock();
    assert!(app.registry.get(&cred.id).is_some());
    assert_both_resolve(&app, &connections, SECRET);
}

#[test]
fn deleting_an_unused_credential_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let app = App::first_launch(dir.path());
    let cred = app
        .registry
        .create(
            &app.store,
            &StorageMode::MasterPassword,
            "Old",
            NamedCredentialKind::Password,
            SECRET,
        )
        .unwrap();
    app.registry
        .delete(
            &app.store,
            &StorageMode::MasterPassword,
            &cred.id,
            Vec::new(),
        )
        .unwrap();

    let app = app.restart(dir.path());
    app.unlock();
    assert!(app.registry.list().is_empty());
    assert_eq!(
        app.store
            .get(&secret_key(&cred.id, NamedCredentialKind::Password))
            .unwrap(),
        None,
        "the secret went with the metadata"
    );
}

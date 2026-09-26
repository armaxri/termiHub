//! Loading `embedded_servers.json` with the one-time move of legacy plaintext
//! passwords into the credential store, and writing it back without them
//! (#3514). The secret routing itself lives in [`super::secrets`].

use anyhow::{Context, Result};

use super::config::{EmbeddedServerStore, STORE_VERSION};
use super::secrets::ServerSecrets;
use super::storage::EmbeddedServerStorage;
use crate::connection::recovery::{RecoveryResult, RecoveryWarning};

/// Load the store and migrate any legacy plaintext passwords (#3514).
///
/// The passwords are stripped from the returned configs and held by `secrets`.
/// With an unlocked store they move into it and the file is rewritten without
/// them at once; with a locked store the file is left as-is until the unlock;
/// with no store they are kept for this session only, the file is stripped and
/// a warning is returned for the startup notice.
pub(crate) fn load_and_migrate(
    storage: &EmbeddedServerStorage,
    secrets: &ServerSecrets,
) -> Result<RecoveryResult<EmbeddedServerStore>> {
    let mut result = storage
        .load_with_recovery()
        .context("Failed to load embedded servers")?;
    let found = secrets.absorb_legacy(&mut result.data);
    if found == 0 {
        return Ok(result);
    }
    tracing::info!(
        count = found,
        "Found plaintext embedded server passwords; moving them to the credential store"
    );
    let outcome = secrets.reconcile();
    if outcome.rewrite {
        persist_store(storage, secrets, &result.data)
            .context("Failed to rewrite embedded servers without passwords")?;
    }
    if outcome.moved_to_session > 0 {
        result.warnings.push(RecoveryWarning {
            file_name: "embedded_servers.json".to_string(),
            message: format!(
                "{} embedded server password(s) were removed from embedded_servers.json. \
                 Credential storage is off, so they are kept only until termiHub restarts; \
                 enable a credential store in Settings, or re-enter them after a restart.",
                outcome.moved_to_session
            ),
            details: None,
        });
    }
    Ok(result)
}

/// Write `store` without passwords — or, while legacy plaintext still awaits a
/// locked store, verbatim with that plaintext kept (see
/// [`ServerSecrets::disk_view`]).
pub(crate) fn persist_store(
    storage: &EmbeddedServerStorage,
    secrets: &ServerSecrets,
    store: &EmbeddedServerStore,
) -> Result<()> {
    let view = secrets.disk_view(store);
    if view.version == STORE_VERSION {
        storage.save(&view)
    } else {
        storage.save_verbatim(&view)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use tempfile::TempDir;

    use super::*;
    use crate::embedded_servers::config::{FtpAuth, STORE_VERSION_LEGACY_PLAINTEXT};
    use crate::embedded_servers::secrets::tests::{
        ftp, http, FakeStore, LOCKED, UNAVAILABLE, UNLOCKED,
    };
    use crate::embedded_servers::secrets::{credential_key, AuthSlot};

    const FILE: &str = "embedded_servers.json";

    /// Write a pre-#3514 file carrying plaintext passwords.
    fn legacy_file(dir: &TempDir) -> EmbeddedServerStorage {
        let path = dir.path().join(FILE);
        let legacy = EmbeddedServerStore {
            version: STORE_VERSION_LEGACY_PLAINTEXT.to_string(),
            servers: vec![ftp("srv-1", "hunter2"), http("srv-2", "s3cret")],
        };
        fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();
        EmbeddedServerStorage::at_path(path)
    }

    fn raw(dir: &TempDir) -> String {
        fs::read_to_string(dir.path().join(FILE)).unwrap()
    }

    fn ftp_password(store: &EmbeddedServerStore) -> String {
        match &store.servers[0].ftp_auth {
            Some(FtpAuth::Credentials { password, .. }) => password.clone(),
            _ => String::new(),
        }
    }

    #[test]
    fn plaintext_file_is_migrated_into_an_unlocked_store_and_rewritten() {
        let dir = TempDir::new().unwrap();
        let storage = legacy_file(&dir);
        let store = FakeStore::new(UNLOCKED);
        let secrets = ServerSecrets::new(store.clone());

        let result = load_and_migrate(&storage, &secrets).unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(
            ftp_password(&result.data),
            "",
            "in-memory configs are stripped"
        );
        assert_eq!(
            store.raw(&credential_key("srv-1", AuthSlot::FtpLogin)),
            Some("hunter2".to_string())
        );
        assert_eq!(
            store.raw(&credential_key("srv-2", AuthSlot::HttpBasic)),
            Some("s3cret".to_string())
        );
        let file = raw(&dir);
        assert!(
            !file.contains("hunter2") && !file.contains("s3cret"),
            "{file}"
        );
        assert!(!file.contains("password"), "{file}");
        assert!(
            file.contains(&format!("\"version\": \"{STORE_VERSION}\"")),
            "{file}"
        );

        // A second load is a no-op and servers still start with their password.
        let secrets = ServerSecrets::new(store);
        let mut again = load_and_migrate(&storage, &secrets).unwrap().data;
        secrets.resolve(&mut again.servers[0]).unwrap();
        assert_eq!(ftp_password(&again), "hunter2");
    }

    #[test]
    fn locked_store_leaves_the_file_until_the_unlock() {
        let dir = TempDir::new().unwrap();
        let storage = legacy_file(&dir);
        let before = raw(&dir);
        let store = FakeStore::new(LOCKED);
        let secrets = ServerSecrets::new(store.clone());

        let data = load_and_migrate(&storage, &secrets).unwrap().data;
        assert_eq!(raw(&dir), before, "nothing rewritten while locked");

        // An edit while locked must not destroy the pending plaintext.
        persist_store(&storage, &secrets, &data).unwrap();
        assert!(raw(&dir).contains("hunter2"));

        store.set_status(UNLOCKED);
        assert!(secrets.reconcile().rewrite);
        persist_store(&storage, &secrets, &data).unwrap();
        let file = raw(&dir);
        assert!(
            !file.contains("hunter2") && !file.contains("s3cret"),
            "{file}"
        );
        assert_eq!(
            store.raw(&credential_key("srv-1", AuthSlot::FtpLogin)),
            Some("hunter2".to_string())
        );
    }

    #[test]
    fn none_mode_strips_the_file_and_warns() {
        let dir = TempDir::new().unwrap();
        let storage = legacy_file(&dir);
        let secrets = ServerSecrets::new(FakeStore::new(UNAVAILABLE));

        let result = load_and_migrate(&storage, &secrets).unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0]
            .message
            .contains("Credential storage is off"));
        let file = raw(&dir);
        assert!(
            !file.contains("hunter2") && !file.contains("s3cret"),
            "{file}"
        );

        // Still usable for this session.
        let mut data = result.data;
        secrets.resolve(&mut data.servers[0]).unwrap();
        assert_eq!(ftp_password(&data), "hunter2");
    }

    #[test]
    fn file_without_passwords_loads_untouched() {
        let dir = TempDir::new().unwrap();
        let storage = EmbeddedServerStorage::at_path(dir.path().join(FILE));
        let secrets = ServerSecrets::new(Arc::new(crate::credential::NullStore));
        let result = load_and_migrate(&storage, &secrets).unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.servers.is_empty());
        assert!(!dir.path().join(FILE).exists(), "no needless write");
    }

    /// Agent-hosted servers (#2214) get the resolved password over the
    /// `service.start` RPC — held only in the agent's memory, which persists no
    /// embedded-server state — while the desktop's configs stay stripped.
    #[test]
    fn agent_start_params_carry_the_resolved_password_only() {
        let store = FakeStore::new(UNLOCKED);
        let secrets = ServerSecrets::new(store);
        let mut saved = ftp("srv-1", "hunter2");
        secrets.capture(&mut saved).unwrap();
        let stripped = serde_json::to_string(&saved).unwrap();
        assert!(!stripped.contains("hunter2"));

        let mut to_start = saved.clone();
        secrets.resolve(&mut to_start).unwrap();
        let params =
            crate::embedded_servers::server_manager::service_start_params("srv-1", &to_start)
                .unwrap();
        assert_eq!(params["config"]["ftpAuth"]["password"], "hunter2");
    }
}

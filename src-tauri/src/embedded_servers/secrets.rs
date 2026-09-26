//! Embedded-server passwords in the credential store (#3514).
//!
//! FTP login passwords and HTTP Basic-auth passwords (PROD-0035) used to be
//! written in plaintext to `embedded_servers.json`. They now live in the same
//! credential store as connection passwords (master password / OS keychain),
//! following the connection pattern: **store on save, strip from the JSON,
//! resolve at start**.
//!
//! # Storage keys
//!
//! One [`CredentialType::Password`] entry per server and auth kind, under the
//! owner id `embedded-server:<server id>:ftp` (FTP login) or
//! `embedded-server:<server id>:http` (HTTP Basic auth) — see [`owner_id`]. A
//! server has at most one FTP user, so there is no per-user component.
//!
//! # Store modes
//!
//! - **Unlocked store** — passwords are written on save and read at start.
//! - **Locked master-password store** — saving a new password fails with a
//!   clear "unlock first" error; starting a server whose password is not held
//!   in memory fails likewise (the credential manager also emits its
//!   unlock-needed event, so the UI prompts exactly as for connections).
//! - **No store (`none` mode)** — mirrors connections, whose passwords are never
//!   persisted in that mode: an embedded-server password is kept **in memory for
//!   the current session only** and never written anywhere, so it must be
//!   re-entered after a restart (starting without it fails with a message saying
//!   so).
//!
//! # Migration of legacy plaintext
//!
//! Passwords found in a loaded file are [absorbed](ServerSecrets::absorb_legacy)
//! into memory and [reconciled](ServerSecrets::reconcile) into the store as one
//! all-or-nothing [`set_many`](CredentialStore::set_many) batch, after which the
//! file is rewritten without them (schema version `2`). While the store is
//! locked the file is left untouched — rewriting it would lose the only copy —
//! and the migration completes on the first reconcile after the unlock. With no
//! store the passwords are moved to the session-only memory and stripped from
//! the file (the caller surfaces a warning).
//!
//! Secrets are never logged; only credential keys and counts are.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use zeroize::{Zeroize, Zeroizing};

use super::config::{
    EmbeddedServerConfig, EmbeddedServerStore, FtpAuth, STORE_VERSION,
    STORE_VERSION_LEGACY_PLAINTEXT,
};
use crate::credential::{CredentialKey, CredentialStore, CredentialStoreStatus, CredentialType};
use crate::utils::errors::TerminalError;

/// Prefix of every embedded-server credential owner id.
pub const OWNER_PREFIX: &str = "embedded-server:";

/// How long [`ServerSecrets::reconcile`] waits after a failed store write
/// before retrying — it runs on every status poll, so a persistently failing
/// backend (e.g. no Secret Service) must not be hammered or flood the log.
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(60);

/// Which of a server's passwords a secret belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AuthSlot {
    /// The password of an FTP server's `credentials` login.
    FtpLogin,
    /// The password of an HTTP server's Basic authentication.
    HttpBasic,
}

impl AuthSlot {
    /// Every slot, so cleanup can act on all of a server's secrets.
    pub const ALL: [AuthSlot; 2] = [AuthSlot::FtpLogin, AuthSlot::HttpBasic];

    fn suffix(self) -> &'static str {
        match self {
            AuthSlot::FtpLogin => "ftp",
            AuthSlot::HttpBasic => "http",
        }
    }

    /// Human-readable name, for error messages and vault labels.
    pub fn label(self) -> &'static str {
        match self {
            AuthSlot::FtpLogin => "FTP login",
            AuthSlot::HttpBasic => "HTTP Basic auth",
        }
    }
}

/// Credential owner id for one of a server's passwords.
pub fn owner_id(server_id: &str, slot: AuthSlot) -> String {
    format!("{OWNER_PREFIX}{server_id}:{}", slot.suffix())
}

/// Credential-store key for one of a server's passwords.
pub fn credential_key(server_id: &str, slot: AuthSlot) -> CredentialKey {
    CredentialKey::new(&owner_id(server_id, slot), CredentialType::Password)
}

/// The slots whose password `config` needs to start.
pub fn active_slots(config: &EmbeddedServerConfig) -> Vec<AuthSlot> {
    let mut slots = Vec::new();
    if matches!(config.ftp_auth, Some(FtpAuth::Credentials { .. })) {
        slots.push(AuthSlot::FtpLogin);
    }
    if config.http_auth.is_some() {
        slots.push(AuthSlot::HttpBasic);
    }
    slots
}

fn password_mut(config: &mut EmbeddedServerConfig, slot: AuthSlot) -> Option<&mut String> {
    match slot {
        AuthSlot::FtpLogin => match config.ftp_auth.as_mut() {
            Some(FtpAuth::Credentials { password, .. }) => Some(password),
            _ => None,
        },
        AuthSlot::HttpBasic => config.http_auth.as_mut().map(|auth| &mut auth.password),
    }
}

/// Clear every password in `config`, returning the non-empty ones.
pub fn take_passwords(config: &mut EmbeddedServerConfig) -> Vec<(AuthSlot, Zeroizing<String>)> {
    let mut taken = Vec::new();
    for slot in AuthSlot::ALL {
        if let Some(password) = password_mut(config, slot) {
            let value = Zeroizing::new(std::mem::take(password));
            if !value.is_empty() {
                taken.push((slot, value));
            }
        }
    }
    taken
}

/// Clear every password in `store` (the shape written to disk).
pub fn strip_store(store: &mut EmbeddedServerStore) {
    for config in &mut store.servers {
        drop(take_passwords(config));
    }
}

/// A password held in memory rather than (yet) in the credential store.
struct HeldSecret {
    value: Zeroizing<String>,
    /// `true` while the secret is still in `embedded_servers.json` as legacy
    /// plaintext (migration pending an unlock); such secrets are written back on
    /// every save so a rewrite never loses the only copy.
    on_disk: bool,
}

/// What a [`ServerSecrets::reconcile`] pass changed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReconcileOutcome {
    /// Legacy plaintext left the file's responsibility: rewrite the file.
    pub rewrite: bool,
    /// Legacy passwords moved to session-only memory because no credential
    /// store is configured.
    pub moved_to_session: usize,
    /// Passwords written to the credential store.
    pub stored: usize,
}

/// Routes embedded-server passwords between the configs, the credential store
/// and (when the store cannot take them) memory.
pub struct ServerSecrets {
    store: Arc<dyn CredentialStore>,
    held: Mutex<HashMap<(String, AuthSlot), HeldSecret>>,
    last_failure: Mutex<Option<Instant>>,
}

impl ServerSecrets {
    pub fn new(store: Arc<dyn CredentialStore>) -> Self {
        Self {
            store,
            held: Mutex::new(HashMap::new()),
            last_failure: Mutex::new(None),
        }
    }

    fn lock_held(&self) -> MutexGuard<'_, HashMap<(String, AuthSlot), HeldSecret>> {
        self.held.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Strip legacy plaintext passwords from a freshly loaded `store`, holding
    /// them in memory as still-on-disk until [`reconcile`](Self::reconcile)
    /// moves them. Returns how many were found.
    pub fn absorb_legacy(&self, store: &mut EmbeddedServerStore) -> usize {
        let mut held = self.lock_held();
        let mut found = 0;
        for config in &mut store.servers {
            for (slot, value) in take_passwords(config) {
                held.insert(
                    (config.id.clone(), slot),
                    HeldSecret {
                        value,
                        on_disk: true,
                    },
                );
                found += 1;
            }
        }
        found
    }

    /// Move held passwords into the credential store when it can take them.
    ///
    /// Unlocked: one all-or-nothing batch; on failure everything stays held and
    /// a later pass retries. Locked: nothing happens. No store: legacy on-disk
    /// secrets become session-only so the caller strips them from the file.
    pub fn reconcile(&self) -> ReconcileOutcome {
        let mut held = self.lock_held();
        if held.is_empty() {
            return ReconcileOutcome::default();
        }
        match self.store.status() {
            CredentialStoreStatus::Unlocked => {
                let mut last_failure = self.last_failure.lock().unwrap_or_else(|e| e.into_inner());
                if last_failure.is_some_and(|at| at.elapsed() < RETRY_AFTER_FAILURE) {
                    return ReconcileOutcome::default();
                }
                let mut entries: Vec<(CredentialKey, String)> = held
                    .iter()
                    .map(|((id, slot), secret)| {
                        (credential_key(id, *slot), secret.value.as_str().to_owned())
                    })
                    .collect();
                let result = self.store.set_many(&entries);
                for (_, value) in entries.iter_mut() {
                    value.zeroize();
                }
                match result {
                    Ok(()) => {
                        *last_failure = None;
                        let stored = held.len();
                        let rewrite = held.values().any(|s| s.on_disk);
                        held.clear();
                        tracing::info!(
                            count = stored,
                            "Moved embedded server passwords into the credential store"
                        );
                        ReconcileOutcome {
                            rewrite,
                            moved_to_session: 0,
                            stored,
                        }
                    }
                    Err(e) => {
                        *last_failure = Some(Instant::now());
                        tracing::warn!(
                            error = %e,
                            "Could not move embedded server passwords into the credential \
                             store; will retry"
                        );
                        ReconcileOutcome::default()
                    }
                }
            }
            CredentialStoreStatus::Unavailable => {
                let mut moved = 0;
                for secret in held.values_mut().filter(|s| s.on_disk) {
                    secret.on_disk = false;
                    moved += 1;
                }
                ReconcileOutcome {
                    rewrite: moved > 0,
                    moved_to_session: moved,
                    stored: 0,
                }
            }
            CredentialStoreStatus::Locked => ReconcileOutcome::default(),
        }
    }

    /// Build the store as it must be written to disk: every password stripped,
    /// except legacy plaintext still awaiting migration, which is written back
    /// (with the legacy schema version) so a rewrite never destroys it.
    pub fn disk_view(&self, store: &EmbeddedServerStore) -> EmbeddedServerStore {
        let held = self.lock_held();
        let mut view = store.clone();
        strip_store(&mut view);
        let mut legacy = false;
        for config in &mut view.servers {
            for slot in AuthSlot::ALL {
                let Some(secret) = held
                    .get(&(config.id.clone(), slot))
                    .filter(|secret| secret.on_disk)
                else {
                    continue;
                };
                if let Some(password) = password_mut(config, slot) {
                    *password = secret.value.as_str().to_owned();
                    legacy = true;
                }
            }
        }
        view.version = if legacy {
            STORE_VERSION_LEGACY_PLAINTEXT
        } else {
            STORE_VERSION
        }
        .to_string();
        view
    }

    /// On save: move `config`'s passwords into the credential store (or the
    /// session memory in `none` mode) and strip them from `config`.
    ///
    /// An empty password keeps the saved one — the editor shows the field blank
    /// because configs are handed out stripped. Secrets for auth the config no
    /// longer uses (e.g. FTP switched to anonymous) are removed, best-effort.
    pub fn capture(&self, config: &mut EmbeddedServerConfig) -> Result<(), TerminalError> {
        let active = active_slots(config);
        let passwords = take_passwords(config);
        let status = self.store.status();
        let mut held = self.lock_held();

        if status == CredentialStoreStatus::Unavailable {
            for (slot, value) in passwords {
                held.insert(
                    (config.id.clone(), slot),
                    HeldSecret {
                        value,
                        on_disk: false,
                    },
                );
            }
        } else if !passwords.is_empty() {
            let mut entries: Vec<(CredentialKey, String)> = passwords
                .iter()
                .map(|(slot, value)| (credential_key(&config.id, *slot), value.to_string()))
                .collect();
            let result = self.store.set_many(&entries);
            for (_, value) in entries.iter_mut() {
                value.zeroize();
            }
            result.map_err(|e| {
                TerminalError::EmbeddedServerError(if status == CredentialStoreStatus::Locked {
                    format!(
                        "The credential store is locked. Unlock it to save the password for \
                         embedded server \"{}\".",
                        config.name
                    )
                } else {
                    format!("Could not save the server password to the credential store: {e}")
                })
            })?;
            for (slot, _) in &passwords {
                held.remove(&(config.id.clone(), *slot));
            }
        }

        for slot in AuthSlot::ALL.into_iter().filter(|s| !active.contains(s)) {
            held.remove(&(config.id.clone(), slot));
            if status != CredentialStoreStatus::Unavailable {
                if let Err(e) = self.store.remove(&credential_key(&config.id, slot)) {
                    tracing::warn!(
                        key = %credential_key(&config.id, slot),
                        error = %e,
                        "Failed to remove an unused embedded server password (best-effort)"
                    );
                }
            }
        }
        Ok(())
    }

    /// On start: fill in every password `config` needs.
    ///
    /// Fails with a user-facing message when the store is locked or holds no
    /// password for the server.
    pub fn resolve(&self, config: &mut EmbeddedServerConfig) -> Result<(), TerminalError> {
        for slot in active_slots(config) {
            let value = self.lookup(&config.id, &config.name, slot)?;
            if let Some(password) = password_mut(config, slot) {
                *password = value.as_str().to_owned();
            }
        }
        Ok(())
    }

    fn lookup(
        &self,
        server_id: &str,
        server_name: &str,
        slot: AuthSlot,
    ) -> Result<Zeroizing<String>, TerminalError> {
        if let Some(secret) = self.lock_held().get(&(server_id.to_string(), slot)) {
            return Ok(secret.value.clone());
        }
        let key = credential_key(server_id, slot);
        match self.store.get(&key) {
            Ok(Some(value)) if !value.is_empty() => Ok(Zeroizing::new(value)),
            Ok(_) => {
                let mut message = format!(
                    "No saved password for the {} of embedded server \"{server_name}\". Edit \
                     the server and enter the password again.",
                    slot.label()
                );
                if self.store.status() == CredentialStoreStatus::Unavailable {
                    message.push_str(
                        " Credential storage is off, so embedded server passwords are only kept \
                         until termiHub restarts; enable a credential store in Settings to keep \
                         them.",
                    );
                }
                Err(TerminalError::EmbeddedServerError(message))
            }
            Err(e) => Err(TerminalError::EmbeddedServerError(
                if self.store.status() == CredentialStoreStatus::Locked {
                    format!(
                        "The credential store is locked. Unlock it to start embedded server \
                         \"{server_name}\"."
                    )
                } else {
                    format!("Could not read the server password from the credential store: {e}")
                },
            )),
        }
    }

    /// On delete: drop every secret of `server_id` (best-effort for the store,
    /// like connection deletion — a locked store leaves a harmless orphan).
    pub fn forget(&self, server_id: &str) {
        let mut held = self.lock_held();
        for slot in AuthSlot::ALL {
            held.remove(&(server_id.to_string(), slot));
            if let Err(e) = self
                .store
                .remove_all_for_connection(&owner_id(server_id, slot))
            {
                tracing::warn!(
                    owner = %owner_id(server_id, slot),
                    error = %e,
                    "Failed to remove embedded server credentials (best-effort, proceeding \
                     with delete)"
                );
            }
        }
    }
}

/// Credential owners for every configured server, labelled for the vault's
/// import preview (and probed by its export, since the OS keychain cannot
/// enumerate its items).
pub fn vault_owners(configs: &[EmbeddedServerConfig]) -> Vec<(String, String)> {
    configs
        .iter()
        .flat_map(|config| {
            AuthSlot::ALL.into_iter().map(move |slot| {
                (
                    owner_id(&config.id, slot),
                    format!("{} ({})", config.name, slot.label()),
                )
            })
        })
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::embedded_servers::config::{HttpBasicAuth, ServerType};
    use anyhow::{bail, Result};
    use std::sync::atomic::{AtomicU8, Ordering};

    pub(crate) const UNLOCKED: u8 = 0;
    pub(crate) const LOCKED: u8 = 1;
    pub(crate) const UNAVAILABLE: u8 = 2;

    /// In-memory credential store whose status can be switched, mimicking the
    /// master-password store (locked → every access errors) and the null store
    /// (`none` mode → writes vanish).
    pub(crate) struct FakeStore {
        map: Mutex<HashMap<String, String>>,
        status: AtomicU8,
    }

    impl FakeStore {
        pub(crate) fn new(status: u8) -> Arc<Self> {
            Arc::new(Self {
                map: Mutex::new(HashMap::new()),
                status: AtomicU8::new(status),
            })
        }
        pub(crate) fn set_status(&self, status: u8) {
            self.status.store(status, Ordering::SeqCst);
        }
        pub(crate) fn raw(&self, key: &CredentialKey) -> Option<String> {
            self.map.lock().unwrap().get(&key.to_string()).cloned()
        }
        fn len(&self) -> usize {
            self.map.lock().unwrap().len()
        }
        fn check(&self) -> Result<bool> {
            match self.status.load(Ordering::SeqCst) {
                LOCKED => bail!("Store is locked"),
                UNAVAILABLE => Ok(false),
                _ => Ok(true),
            }
        }
    }

    impl CredentialStore for FakeStore {
        fn get(&self, key: &CredentialKey) -> Result<Option<String>> {
            if !self.check()? {
                return Ok(None);
            }
            Ok(self.raw(key))
        }
        fn set(&self, key: &CredentialKey, value: &str) -> Result<()> {
            if self.check()? {
                self.map
                    .lock()
                    .unwrap()
                    .insert(key.to_string(), value.to_string());
            }
            Ok(())
        }
        fn remove(&self, key: &CredentialKey) -> Result<()> {
            if self.check()? {
                self.map.lock().unwrap().remove(&key.to_string());
            }
            Ok(())
        }
        fn remove_all_for_connection(&self, connection_id: &str) -> Result<()> {
            if self.check()? {
                let prefix = format!("{connection_id}:");
                self.map
                    .lock()
                    .unwrap()
                    .retain(|k, _| !k.starts_with(&prefix));
            }
            Ok(())
        }
        fn list_keys(&self) -> Result<Vec<CredentialKey>> {
            Ok(Vec::new())
        }
        fn status(&self) -> CredentialStoreStatus {
            match self.status.load(Ordering::SeqCst) {
                LOCKED => CredentialStoreStatus::Locked,
                UNAVAILABLE => CredentialStoreStatus::Unavailable,
                _ => CredentialStoreStatus::Unlocked,
            }
        }
    }

    pub(crate) fn ftp(id: &str, password: &str) -> EmbeddedServerConfig {
        EmbeddedServerConfig {
            id: id.to_string(),
            name: format!("{id} name"),
            server_type: ServerType::Ftp,
            root_directory: "/tmp".to_string(),
            bind_host: "127.0.0.1".to_string(),
            port: 2121,
            auto_start: false,
            read_only: false,
            directory_listing: None,
            ftp_auth: Some(FtpAuth::Credentials {
                username: "admin".to_string(),
                password: password.to_string(),
            }),
            http_auth: None,
            max_transfer_bytes: None,
        }
    }

    pub(crate) fn http(id: &str, password: &str) -> EmbeddedServerConfig {
        EmbeddedServerConfig {
            server_type: ServerType::Http,
            ftp_auth: None,
            http_auth: Some(HttpBasicAuth {
                username: "u".to_string(),
                password: password.to_string(),
            }),
            ..ftp(id, "")
        }
    }

    fn ftp_password(config: &EmbeddedServerConfig) -> &str {
        match &config.ftp_auth {
            Some(FtpAuth::Credentials { password, .. }) => password,
            _ => panic!("not an FTP credentials config"),
        }
    }

    #[test]
    fn owner_ids_are_stable_and_distinct_per_slot() {
        assert_eq!(
            credential_key("srv-1", AuthSlot::FtpLogin).to_string(),
            "embedded-server:srv-1:ftp:password"
        );
        assert_eq!(
            credential_key("srv-1", AuthSlot::HttpBasic).to_string(),
            "embedded-server:srv-1:http:password"
        );
        // The master-password store parses keys back with `from_map_key`.
        let parsed = CredentialKey::from_map_key("embedded-server:srv-1:ftp:password").unwrap();
        assert_eq!(parsed, credential_key("srv-1", AuthSlot::FtpLogin));
    }

    #[test]
    fn capture_stores_the_password_and_strips_it() {
        let store = FakeStore::new(UNLOCKED);
        let secrets = ServerSecrets::new(store.clone());
        let mut config = ftp("srv-1", "hunter2");
        secrets.capture(&mut config).unwrap();
        assert_eq!(ftp_password(&config), "");
        assert_eq!(
            store.raw(&credential_key("srv-1", AuthSlot::FtpLogin)),
            Some("hunter2".to_string())
        );
        let mut web = http("srv-2", "s3cret");
        secrets.capture(&mut web).unwrap();
        assert_eq!(web.http_auth.as_ref().unwrap().password, "");
        assert_eq!(
            store.raw(&credential_key("srv-2", AuthSlot::HttpBasic)),
            Some("s3cret".to_string())
        );
    }

    #[test]
    fn capture_with_empty_password_keeps_the_saved_one() {
        let store = FakeStore::new(UNLOCKED);
        let secrets = ServerSecrets::new(store.clone());
        secrets.capture(&mut ftp("srv-1", "hunter2")).unwrap();
        secrets.capture(&mut ftp("srv-1", "")).unwrap();
        assert_eq!(
            store.raw(&credential_key("srv-1", AuthSlot::FtpLogin)),
            Some("hunter2".to_string())
        );
    }

    #[test]
    fn capture_removes_the_secret_of_auth_no_longer_used() {
        let store = FakeStore::new(UNLOCKED);
        let secrets = ServerSecrets::new(store.clone());
        secrets.capture(&mut ftp("srv-1", "hunter2")).unwrap();
        let mut anonymous = ftp("srv-1", "");
        anonymous.ftp_auth = Some(FtpAuth::Anonymous);
        secrets.capture(&mut anonymous).unwrap();
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn resolve_fills_the_password_at_start() {
        let store = FakeStore::new(UNLOCKED);
        let secrets = ServerSecrets::new(store.clone());
        secrets.capture(&mut ftp("srv-1", "hunter2")).unwrap();
        let mut config = ftp("srv-1", "");
        secrets.resolve(&mut config).unwrap();
        assert_eq!(ftp_password(&config), "hunter2");
    }

    #[test]
    fn resolve_without_a_saved_password_refuses_with_a_clear_message() {
        let secrets = ServerSecrets::new(FakeStore::new(UNLOCKED));
        let err = secrets.resolve(&mut ftp("srv-1", "")).unwrap_err();
        assert!(err.to_string().contains("No saved password"), "{err}");
    }

    #[test]
    fn anonymous_servers_need_no_password() {
        let secrets = ServerSecrets::new(FakeStore::new(LOCKED));
        let mut config = ftp("srv-1", "");
        config.ftp_auth = Some(FtpAuth::Anonymous);
        secrets.resolve(&mut config).unwrap();
        secrets.capture(&mut config).unwrap();
    }

    #[test]
    fn locked_store_refuses_to_save_or_start_with_an_unlock_message() {
        let store = FakeStore::new(UNLOCKED);
        let secrets = ServerSecrets::new(store.clone());
        secrets.capture(&mut ftp("srv-1", "hunter2")).unwrap();
        store.set_status(LOCKED);

        let err = secrets.capture(&mut ftp("srv-1", "new")).unwrap_err();
        assert!(err.to_string().contains("locked"), "{err}");
        let err = secrets.resolve(&mut ftp("srv-1", "")).unwrap_err();
        assert!(err.to_string().contains("Unlock it to start"), "{err}");
        assert!(!err.to_string().contains("hunter2"));

        store.set_status(UNLOCKED);
        let mut config = ftp("srv-1", "");
        secrets.resolve(&mut config).unwrap();
        assert_eq!(
            ftp_password(&config),
            "hunter2",
            "the old password survived"
        );
    }

    #[test]
    fn none_mode_keeps_the_password_for_the_session_only() {
        let store = FakeStore::new(UNAVAILABLE);
        let secrets = ServerSecrets::new(store.clone());
        let mut config = ftp("srv-1", "hunter2");
        secrets.capture(&mut config).unwrap();
        assert_eq!(ftp_password(&config), "", "never left in the config");

        let mut start = ftp("srv-1", "");
        secrets.resolve(&mut start).unwrap();
        assert_eq!(ftp_password(&start), "hunter2");

        // A restart (fresh memory) has lost it and says why.
        let restarted = ServerSecrets::new(store);
        let err = restarted.resolve(&mut ftp("srv-1", "")).unwrap_err();
        assert!(
            err.to_string().contains("Credential storage is off"),
            "{err}"
        );
    }

    #[test]
    fn session_passwords_move_into_a_store_enabled_later() {
        let store = FakeStore::new(UNAVAILABLE);
        let secrets = ServerSecrets::new(store.clone());
        secrets.capture(&mut ftp("srv-1", "hunter2")).unwrap();
        store.set_status(UNLOCKED);
        let outcome = secrets.reconcile();
        assert_eq!(outcome.stored, 1);
        assert!(!outcome.rewrite, "nothing was on disk");
        assert_eq!(
            store.raw(&credential_key("srv-1", AuthSlot::FtpLogin)),
            Some("hunter2".to_string())
        );
    }

    #[test]
    fn migration_moves_legacy_plaintext_into_an_unlocked_store() {
        let store = FakeStore::new(UNLOCKED);
        let secrets = ServerSecrets::new(store.clone());
        let mut loaded = EmbeddedServerStore {
            version: STORE_VERSION_LEGACY_PLAINTEXT.to_string(),
            servers: vec![ftp("srv-1", "hunter2"), http("srv-2", "s3cret")],
        };
        assert_eq!(secrets.absorb_legacy(&mut loaded), 2);
        assert_eq!(ftp_password(&loaded.servers[0]), "");

        let outcome = secrets.reconcile();
        assert_eq!(outcome.stored, 2);
        assert!(outcome.rewrite);
        assert_eq!(store.len(), 2);

        let view = secrets.disk_view(&loaded);
        assert_eq!(view.version, STORE_VERSION);
        let json = serde_json::to_string(&view).unwrap();
        assert!(
            !json.contains("hunter2") && !json.contains("s3cret"),
            "{json}"
        );
    }

    #[test]
    fn migration_waits_for_the_unlock_without_losing_the_plaintext() {
        let store = FakeStore::new(LOCKED);
        let secrets = ServerSecrets::new(store.clone());
        let mut loaded = EmbeddedServerStore {
            version: STORE_VERSION_LEGACY_PLAINTEXT.to_string(),
            servers: vec![ftp("srv-1", "hunter2")],
        };
        secrets.absorb_legacy(&mut loaded);
        assert_eq!(secrets.reconcile(), ReconcileOutcome::default());

        // Any rewrite while locked keeps the legacy plaintext (the only copy).
        let view = secrets.disk_view(&loaded);
        assert_eq!(view.version, STORE_VERSION_LEGACY_PLAINTEXT);
        assert_eq!(ftp_password(&view.servers[0]), "hunter2");
        // The server can still start with it meanwhile.
        let mut start = ftp("srv-1", "");
        secrets.resolve(&mut start).unwrap();
        assert_eq!(ftp_password(&start), "hunter2");

        store.set_status(UNLOCKED);
        let outcome = secrets.reconcile();
        assert!(outcome.rewrite);
        assert_eq!(ftp_password(&secrets.disk_view(&loaded).servers[0]), "");
        assert_eq!(
            store.raw(&credential_key("srv-1", AuthSlot::FtpLogin)),
            Some("hunter2".to_string())
        );
    }

    #[test]
    fn migration_in_none_mode_strips_the_file_and_keeps_the_session_copy() {
        let secrets = ServerSecrets::new(FakeStore::new(UNAVAILABLE));
        let mut loaded = EmbeddedServerStore {
            version: STORE_VERSION_LEGACY_PLAINTEXT.to_string(),
            servers: vec![ftp("srv-1", "hunter2")],
        };
        secrets.absorb_legacy(&mut loaded);
        let outcome = secrets.reconcile();
        assert_eq!(outcome.moved_to_session, 1);
        assert!(outcome.rewrite);
        let view = secrets.disk_view(&loaded);
        assert_eq!(ftp_password(&view.servers[0]), "");
        assert_eq!(view.version, STORE_VERSION);
        let mut start = ftp("srv-1", "");
        secrets.resolve(&mut start).unwrap();
        assert_eq!(ftp_password(&start), "hunter2");
    }

    #[test]
    fn forget_removes_every_secret_of_the_server() {
        let store = FakeStore::new(UNLOCKED);
        let secrets = ServerSecrets::new(store.clone());
        secrets.capture(&mut ftp("srv-1", "hunter2")).unwrap();
        secrets.capture(&mut http("srv-2", "keep")).unwrap();
        secrets.forget("srv-1");
        assert_eq!(
            store.raw(&credential_key("srv-1", AuthSlot::FtpLogin)),
            None
        );
        assert_eq!(store.len(), 1, "other servers keep theirs");
    }

    #[test]
    fn forget_drops_session_secrets_too() {
        let secrets = ServerSecrets::new(FakeStore::new(UNAVAILABLE));
        secrets.capture(&mut ftp("srv-1", "hunter2")).unwrap();
        secrets.forget("srv-1");
        assert!(secrets.resolve(&mut ftp("srv-1", "")).is_err());
    }

    #[test]
    fn vault_owners_label_every_slot() {
        let owners = vault_owners(&[ftp("srv-1", "")]);
        assert!(owners.contains(&(
            "embedded-server:srv-1:ftp".to_string(),
            "srv-1 name (FTP login)".to_string()
        )));
        assert_eq!(owners.len(), 2);
    }
}

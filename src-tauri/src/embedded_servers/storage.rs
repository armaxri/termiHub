use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tauri::AppHandle;

use super::config::{EmbeddedServerConfig, EmbeddedServerStore};
use super::secrets::strip_store;
use crate::connection::recovery::{RecoveryResult, RecoveryWarning};
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{
    guard_not_newer, load_versioned, salvage_list_store, LoadOutcome, Salvage, VersionedStore,
};

const FILE_NAME: &str = "embedded_servers.json";

/// `embedded_servers.json` joins the shared schema-migration layer (#3946).
/// The store type lives in `termihub_core`; the trait lives here.
impl VersionedStore for EmbeddedServerStore {
    const STORE_NAME: &'static str = FILE_NAME;
    // v1 → v2 (#3514) changes no shape — v2 only stops writing passwords, and
    // the manager moves any v1 plaintext into the credential store — so the
    // default identity `migrate` is correct and the version is left to it.
    const CURRENT_VERSION: u32 = EmbeddedServerStore::CURRENT_VERSION;

    fn salvage(raw: &str, file_name: &str) -> Salvage<Self> {
        salvage_list_store::<Self, EmbeddedServerConfig>(raw, file_name, "servers")
    }
}

/// Handles reading/writing the embedded_servers.json configuration file.
pub struct EmbeddedServerStorage {
    file_path: PathBuf,
}

impl EmbeddedServerStorage {
    /// Create a new storage instance, resolving the config directory.
    ///
    /// If `TERMIHUB_CONFIG_DIR` is set it overrides the default Tauri config directory.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let config_dir = resolve_config_dir(Some(app_handle))?;
        fs::create_dir_all(&config_dir).context("Failed to create config directory")?;
        Ok(Self {
            file_path: config_dir.join(FILE_NAME),
        })
    }

    /// Storage backed by an explicit file path (tests only).
    #[cfg(test)]
    pub(crate) fn at_path(file_path: PathBuf) -> Self {
        Self { file_path }
    }

    /// Load with recovery through the shared schema-migration layer (#3946):
    ///
    /// * missing file → defaults;
    /// * no `version` → legacy v1 (plaintext passwords the manager migrates);
    /// * written by a **newer** schema → defaults in memory plus a warning, and
    ///   the file is left untouched (no backup, no rewrite); both save paths
    ///   refuse to overwrite it afterwards;
    /// * corrupt → backed up to `.bak`, then salvaged per server, or reset only
    ///   when even the container is unparseable.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<EmbeddedServerStore>> {
        if !self.file_path.exists() {
            return Ok(RecoveryResult {
                data: EmbeddedServerStore::default(),
                warnings: Vec::new(),
            });
        }

        let data =
            fs::read_to_string(&self.file_path).context("Failed to read embedded servers file")?;

        let parse_error = match load_versioned::<EmbeddedServerStore>(&data) {
            // A v1 file is not rewritten here: the manager's legacy-password
            // migration owns that rewrite (#3514).
            LoadOutcome::Loaded { data: store, .. } => {
                return Ok(RecoveryResult {
                    data: store,
                    warnings: Vec::new(),
                });
            }
            LoadOutcome::Newer(err) => {
                tracing::error!("{err}");
                return Ok(RecoveryResult {
                    data: EmbeddedServerStore::default(),
                    warnings: vec![RecoveryWarning {
                        file_name: FILE_NAME.to_string(),
                        message: format!(
                            "This file was written by a newer version of termiHub (schema v{}). \
                             It was left unchanged to avoid data loss; changes made now will not \
                             be saved over it. Update termiHub to use this data.",
                            err.found
                        ),
                        details: Some(err.to_string()),
                    }],
                });
            }
            LoadOutcome::Corrupt(detail) => detail,
        };

        // Parse failed — back up the corrupt file first.
        let backup_path = self.file_path.with_extension("json.bak");
        let _ = fs::copy(&self.file_path, &backup_path);
        tracing::warn!(
            "Embedded servers file is corrupt, backed up to {}",
            backup_path.display()
        );

        // Granular recovery (PER-004): drop only the individually-corrupt server
        // entries and keep the rest (and the unknown top-level fields); reset the
        // whole store only when even the container is unparseable.
        if let Salvage::Recovered {
            data: store,
            warnings,
        } = EmbeddedServerStore::salvage(&data, FILE_NAME)
        {
            // Verbatim: the salvaged entries may still carry legacy plaintext
            // passwords the manager has yet to migrate into the credential store
            // (#3514); stripping them here would lose the only copy.
            self.save_verbatim(&store)
                .context("Failed to save salvaged embedded servers")?;
            return Ok(RecoveryResult {
                data: store,
                warnings,
            });
        }

        let warning = RecoveryWarning {
            file_name: FILE_NAME.to_string(),
            message: "Embedded servers file was corrupt and has been reset.".to_string(),
            details: Some(parse_error),
        };

        let defaults = EmbeddedServerStore::default();
        self.save(&defaults)
            .context("Failed to save defaults after recovery")?;

        Ok(RecoveryResult {
            data: defaults,
            warnings: vec![warning],
        })
    }

    /// Refuse to overwrite a file written by a newer schema. Re-reads the
    /// on-disk version on every save, so it holds across restarts and after a
    /// newer-version load reset the in-memory store to defaults.
    fn guard_not_newer(&self) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            EmbeddedServerStore::STORE_NAME,
            <EmbeddedServerStore as VersionedStore>::CURRENT_VERSION,
        )
    }

    /// Save the store to disk as pretty-printed JSON.
    ///
    /// The write is **atomic** (temp file in the same directory → `sync_all` →
    /// rename over the target): a crash, power loss, or full disk mid-write
    /// leaves `embedded_servers.json` holding either the complete previous
    /// contents or the complete new contents, never a truncated mix that the
    /// recovery path would discard as corrupt (#2320 torn-write class, #2327).
    ///
    /// Every password is stripped and the current schema version stamped: the
    /// passwords live in the credential store (#3514). This is enforced here,
    /// independently of the manager, so no save path can leak one to disk.
    pub fn save(&self, store: &EmbeddedServerStore) -> Result<()> {
        self.guard_not_newer()?;
        let mut stripped = store.clone();
        strip_store(&mut stripped);
        stripped.version = EmbeddedServerStore::CURRENT_VERSION.to_string();
        let mut value =
            serde_json::to_value(&stripped).context("Failed to serialize embedded servers")?;
        remove_password_keys(&mut value);
        let data =
            serde_json::to_string_pretty(&value).context("Failed to serialize embedded servers")?;
        write_atomic(&self.file_path, &data).context("Failed to write embedded servers file")?;
        Ok(())
    }

    /// Save `store` exactly as given — only for a store still holding legacy
    /// plaintext passwords whose migration into the credential store is pending
    /// (a locked store), so a rewrite never destroys the only copy (#3514).
    pub fn save_verbatim(&self, store: &EmbeddedServerStore) -> Result<()> {
        self.guard_not_newer()?;
        let data =
            serde_json::to_string_pretty(store).context("Failed to serialize embedded servers")?;
        write_atomic(&self.file_path, &data).context("Failed to write embedded servers file")?;
        Ok(())
    }
}

/// Drop the (already emptied) `password` keys from a serialized store, so the
/// file carries no password field at all (#3514).
///
/// Downgrade safety: a build from before #3514 requires the field, so it
/// fails to parse a credentialed entry and its per-entry salvage drops it
/// (after backing the file up to `embedded_servers.json.bak`). That fails
/// closed — writing `"password": ""` instead would make such a build serve
/// the FTP login / HTTP Basic auth with an empty password.
pub(crate) fn remove_password_keys(value: &mut serde_json::Value) {
    let Some(servers) = value.get_mut("servers").and_then(|s| s.as_array_mut()) else {
        return;
    };
    for server in servers {
        for auth in ["ftpAuth", "httpAuth"] {
            if let Some(obj) = server.get_mut(auth).and_then(|a| a.as_object_mut()) {
                obj.remove("password");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> EmbeddedServerStorage {
        EmbeddedServerStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    /// #3514: `save` never writes a password, whatever the caller passes.
    #[test]
    fn save_strips_every_password() {
        use super::super::config::{FtpAuth, HttpBasicAuth, ServerType};

        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let server = |id: &str| EmbeddedServerConfig {
            id: id.to_string(),
            name: id.to_string(),
            server_type: ServerType::Ftp,
            root_directory: "/tmp".to_string(),
            bind_host: "127.0.0.1".to_string(),
            port: 2121,
            auto_start: false,
            read_only: false,
            directory_listing: None,
            ftp_auth: Some(FtpAuth::Credentials {
                username: "admin".to_string(),
                password: "hunter2".to_string(),
            }),
            http_auth: Some(HttpBasicAuth {
                username: "u".to_string(),
                password: "s3cret".to_string(),
            }),
            max_transfer_bytes: None,
        };
        let store = EmbeddedServerStore {
            version: "1".to_string(),
            extra: Default::default(),
            servers: vec![server("a"), server("b")],
        };
        storage.save(&store).unwrap();
        let raw = fs::read_to_string(&storage.file_path).unwrap();
        assert!(!raw.contains("hunter2") && !raw.contains("s3cret"), "{raw}");
        assert!(!raw.contains("password"), "no password field at all: {raw}");
        assert!(raw.contains("\"admin\""), "usernames are kept: {raw}");

        let reloaded = storage.load_with_recovery().unwrap();
        assert!(reloaded.warnings.is_empty());
        assert_eq!(
            reloaded.data.version,
            EmbeddedServerStore::CURRENT_VERSION.to_string()
        );
        assert_eq!(reloaded.data.servers.len(), 2);
    }

    #[test]
    fn load_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.servers.is_empty());
    }

    #[test]
    fn save_and_reload() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let store = EmbeddedServerStore::default();
        storage.save(&store).unwrap();
        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert!(result.data.servers.is_empty());
    }

    /// Regression (#2327): a `save` that cannot durably complete must fail
    /// **without** clobbering the previously-saved servers. The old
    /// truncate-in-place `fs::write` opens the existing file for writing (which a
    /// read-only *directory* does not block) and reports success, so this test
    /// fails red on it; the atomic temp+rename write cannot create its temp file
    /// in a read-only directory and therefore errors while leaving the prior
    /// `embedded_servers.json` untouched.
    #[cfg(unix)]
    #[test]
    fn failed_save_preserves_previous_servers() {
        use super::super::config::{EmbeddedServerConfig, ServerType};
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let store = EmbeddedServerStore {
            version: "1".to_string(),
            extra: Default::default(),
            servers: vec![EmbeddedServerConfig {
                id: "srv-1".to_string(),
                name: "docs".to_string(),
                server_type: ServerType::Http,
                root_directory: "/tmp/docs".to_string(),
                bind_host: "127.0.0.1".to_string(),
                port: 8080,
                auto_start: false,
                read_only: true,
                directory_listing: Some(true),
                ftp_auth: None,
                http_auth: None,
                max_transfer_bytes: None,
            }],
        };
        storage.save(&store).unwrap();
        let before = fs::read_to_string(&storage.file_path).unwrap();

        let restore = fs::metadata(dir.path()).unwrap().permissions();
        let mut ro = restore.clone();
        ro.set_mode(0o500);
        fs::set_permissions(dir.path(), ro).unwrap();

        // A privileged/root process can create files regardless of mode — skip.
        let probe = dir.path().join(".probe");
        if fs::write(&probe, b"x").is_ok() {
            let _ = fs::remove_file(&probe);
            fs::set_permissions(dir.path(), restore).unwrap();
            return;
        }

        let result = storage.save(&store);
        fs::set_permissions(dir.path(), restore).unwrap();

        assert!(
            result.is_err(),
            "a save that cannot durably complete must report an error"
        );
        let after = fs::read_to_string(&storage.file_path).unwrap();
        assert_eq!(
            before, after,
            "a failed save must leave the previous servers fully intact"
        );
        serde_json::from_str::<EmbeddedServerStore>(&after).expect("preserved store still parses");
    }

    #[test]
    fn corrupt_file_triggers_recovery() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(&storage.file_path, "not valid json!!!").unwrap();
        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.data.servers.is_empty());
        // Backup should exist.
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
    }

    /// PER-004 granular salvage: a file with one valid server and one corrupt
    /// entry keeps the valid server and drops only the corrupt one (rather than
    /// resetting every embedded server the user configured).
    #[test]
    fn corrupt_entry_is_dropped_and_rest_survive() {
        use super::super::config::{EmbeddedServerConfig, ServerType};

        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let good = EmbeddedServerStore {
            version: "1".to_string(),
            extra: Default::default(),
            servers: vec![EmbeddedServerConfig {
                id: "srv-1".to_string(),
                name: "docs".to_string(),
                server_type: ServerType::Http,
                root_directory: "/tmp/docs".to_string(),
                bind_host: "127.0.0.1".to_string(),
                port: 8080,
                auto_start: false,
                read_only: true,
                directory_listing: Some(true),
                ftp_auth: None,
                http_auth: None,
                max_transfer_bytes: None,
            }],
        };
        // Serialize the valid store, then append a corrupt (non-object) entry so
        // the whole-file parse fails but the good server can still be salvaged.
        let mut value = serde_json::to_value(&good).unwrap();
        value["servers"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!("corrupt server entry"));
        fs::write(
            &storage.file_path,
            serde_json::to_string_pretty(&value).unwrap(),
        )
        .unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.data.servers.len(), 1, "the valid server survives");
        assert_eq!(result.data.servers[0].id, "srv-1");
        assert_eq!(result.warnings.len(), 1, "one entry was dropped");
        assert!(result.warnings[0].message.contains("index 1"));

        // The corrupt file must have been backed up.
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());

        // The rewritten file must now parse cleanly and hold only the survivor.
        let reloaded = storage.load_with_recovery().unwrap();
        assert!(reloaded.warnings.is_empty());
        assert_eq!(reloaded.data.servers.len(), 1);
    }

    // ── Schema versioning + downgrade safety (#3946, part of #2744) ────────

    fn server_json(id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "name": id,
            "serverType": "http",
            "rootDirectory": "/tmp/docs",
            "bindHost": "127.0.0.1",
            "port": 8080,
        })
    }

    /// A file written by a newer schema must never be overwritten — by either
    /// save path — and loading it leaves it untouched.
    #[test]
    fn newer_file_is_left_intact_and_never_overwritten() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let newer = serde_json::json!({
            "version": "99",
            "servers": [server_json("future")],
            "fromTheFuture": true,
        })
        .to_string();
        fs::write(&storage.file_path, &newer).unwrap();

        let loaded = storage.load_with_recovery().unwrap();
        assert!(loaded.data.servers.is_empty());
        assert_eq!(loaded.warnings.len(), 1);
        assert!(loaded.warnings[0].message.contains("newer version"));
        assert!(!storage.file_path.with_extension("json.bak").exists());

        assert!(storage.save(&loaded.data).is_err(), "save must refuse");
        assert!(
            storage.save_verbatim(&loaded.data).is_err(),
            "save_verbatim must refuse"
        );
        assert_eq!(fs::read_to_string(&storage.file_path).unwrap(), newer);
    }

    /// A newer file whose shape this build cannot even parse is not treated as
    /// corruption: no backup, no reset.
    #[test]
    fn newer_unparseable_shape_is_not_reset_as_corrupt() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let newer = r#"{"version": "99", "servers": {"a": "new shape"}}"#;
        fs::write(&storage.file_path, newer).unwrap();

        let loaded = storage.load_with_recovery().unwrap();
        assert_eq!(loaded.warnings.len(), 1);
        assert!(loaded.warnings[0].message.contains("newer version"));
        assert_eq!(fs::read_to_string(&storage.file_path).unwrap(), newer);
        assert!(!storage.file_path.with_extension("json.bak").exists());
    }

    /// A pre-versioning file has no `version`; it is legacy v1 and must load
    /// intact rather than being reset as corrupt.
    #[test]
    fn unversioned_file_loads_as_legacy_v1() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let raw = serde_json::json!({"servers": [server_json("a"), server_json("b")]});
        fs::write(&storage.file_path, raw.to_string()).unwrap();

        let loaded = storage.load_with_recovery().unwrap();
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
        assert_eq!(loaded.data.servers.len(), 2);
        assert_eq!(
            loaded.data.version,
            EmbeddedServerStore::LEGACY_PLAINTEXT_VERSION.to_string()
        );
        assert!(!storage.file_path.with_extension("json.bak").exists());
    }

    /// Top-level fields this build does not know survive a load/save round trip.
    #[test]
    fn unknown_top_level_fields_are_preserved() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let raw = serde_json::json!({
            "version": EmbeddedServerStore::CURRENT_VERSION.to_string(),
            "servers": [server_json("a")],
            "futureSetting": {"nested": [1, 2]},
        });
        fs::write(&storage.file_path, raw.to_string()).unwrap();

        let loaded = storage.load_with_recovery().unwrap();
        storage.save(&loaded.data).unwrap();

        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&storage.file_path).unwrap()).unwrap();
        assert_eq!(
            saved["futureSetting"],
            serde_json::json!({"nested": [1, 2]})
        );
        assert_eq!(saved["servers"].as_array().unwrap().len(), 1);
    }

    /// Salvage keeps the unknown top-level fields too, not just the good entries.
    #[test]
    fn salvage_preserves_unknown_top_level_fields() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let raw = serde_json::json!({
            "version": EmbeddedServerStore::CURRENT_VERSION.to_string(),
            "servers": [server_json("a"), {"id": "broken"}],
            "futureSetting": true,
        });
        fs::write(&storage.file_path, raw.to_string()).unwrap();

        let loaded = storage.load_with_recovery().unwrap();
        assert_eq!(loaded.data.servers.len(), 1);
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&storage.file_path).unwrap()).unwrap();
        assert_eq!(saved["futureSetting"], true);
    }

    // ── Unknown per-entry fields (#3951, part of #2744) ────────────────────

    fn saved_servers(storage: &EmbeddedServerStorage) -> Vec<serde_json::Value> {
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&storage.file_path).unwrap()).unwrap();
        saved["servers"].as_array().unwrap().clone()
    }

    /// Fields a newer build wrote into a single server entry survive an older
    /// build's load → save.
    #[test]
    fn unknown_server_fields_survive_load_save_round_trip() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let mut entry = server_json("a");
        entry["futureField"] = serde_json::json!({"nested": [1, 2]});
        let raw = serde_json::json!({
            "version": EmbeddedServerStore::CURRENT_VERSION.to_string(),
            "servers": [entry, server_json("b")],
        });
        fs::write(&storage.file_path, raw.to_string()).unwrap();

        let loaded = storage.load_with_recovery().unwrap();
        storage.save(&loaded.data).unwrap();

        let servers = saved_servers(&storage);
        assert_eq!(servers.len(), 2);
        assert_eq!(
            servers[0]["futureField"],
            serde_json::json!({"nested": [1, 2]})
        );
        assert!(servers[1].get("futureField").is_none());
    }

    /// The verbatim save path (legacy passwords awaiting migration) keeps them
    /// too.
    #[test]
    fn unknown_server_fields_survive_a_verbatim_save() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let mut entry = server_json("a");
        entry["futureField"] = serde_json::json!("kept");
        let raw = serde_json::json!({"servers": [entry]});
        fs::write(&storage.file_path, raw.to_string()).unwrap();

        let loaded = storage.load_with_recovery().unwrap();
        storage.save_verbatim(&loaded.data).unwrap();

        assert_eq!(saved_servers(&storage)[0]["futureField"], "kept");
    }

    /// Granular salvage rewrites the file; the surviving entries keep their
    /// unknown fields.
    #[test]
    fn salvage_keeps_unknown_server_fields() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let mut entry = server_json("a");
        entry["futureField"] = serde_json::json!(7);
        let raw = serde_json::json!({
            "version": EmbeddedServerStore::CURRENT_VERSION.to_string(),
            "servers": [entry, {"id": "broken"}],
        });
        fs::write(&storage.file_path, raw.to_string()).unwrap();

        let loaded = storage.load_with_recovery().unwrap();
        assert_eq!(loaded.data.servers.len(), 1);
        let servers = saved_servers(&storage);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["futureField"], 7);
    }
}

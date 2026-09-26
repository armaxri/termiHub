//! Tests for carrying shared named credentials through the connection
//! export / import (#3564).

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use super::transfer::{self, METADATA_KEY, SECRETS_KEY};
use super::*;
use crate::connection::manager::ConnectionManager;
use crate::credential::crypto::DecryptError;
use crate::credential::{CredentialManager, NullStore};
use crate::terminal::backend::{ConnectionConfig, RemoteAgentConfig};

const PW: &str = "export-pass";
const MODE: StorageMode = StorageMode::MasterPassword;

/// One simulated machine: a credential store, a registry and a connection
/// manager, all in their own temp dir.
struct Machine {
    _dir: tempfile::TempDir,
    store: Arc<CredentialManager>,
    registry: NamedCredentialRegistry,
    connections: ConnectionManager,
}

impl Machine {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(unlocked_manager(dir.path()));
        let (registry, _) = NamedCredentialRegistry::load(dir.path());
        let connections = ConnectionManager::new_for_test(dir.path(), store.clone()).unwrap();
        Self {
            _dir: dir,
            store,
            registry,
            connections,
        }
    }

    fn create(&self, name: &str, secret: &str) -> NamedCredential {
        self.registry
            .create(
                &*self.store,
                &MODE,
                name,
                NamedCredentialKind::Password,
                secret,
            )
            .unwrap()
    }

    fn save_ssh(&self, name: &str, credential_ref: &str) {
        self.connections
            .save_connection(SavedConnection {
                id: name.to_string(),
                name: name.to_string(),
                config: ConnectionConfig {
                    type_id: "ssh".to_string(),
                    settings: json!({
                        "host": "example.com",
                        "username": "me",
                        "authMethod": "password",
                        "credentialRef": credential_ref,
                    }),
                },
                folder_id: None,
                terminal_options: None,
                icon: None,
                source_file: None,
            })
            .unwrap();
    }

    fn save_agent(&self, name: &str, credential_ref: &str) {
        self.connections
            .save_agent(SavedRemoteAgent {
                id: name.to_string(),
                name: name.to_string(),
                config: RemoteAgentConfig {
                    host: "agent.example.com".to_string(),
                    username: "me".to_string(),
                    auth_method: "password".to_string(),
                    credential_ref: Some(credential_ref.to_string()),
                    ..RemoteAgentConfig::default()
                },
                agent_settings: Default::default(),
            })
            .unwrap();
    }

    fn export(&self, password: Option<&str>) -> String {
        let base = self
            .connections
            .export_encrypted_json(password, None)
            .unwrap();
        transfer::add_to_export(&base, password, &self.registry, &*self.store).unwrap()
    }

    fn import(&self, json: &str, password: Option<&str>) -> transfer::PreparedImport {
        let prepared =
            transfer::prepare_import(json, password, &self.registry, &*self.store, &MODE).unwrap();
        self.connections
            .import_encrypted_json(&prepared.json, password)
            .unwrap();
        prepared
    }

    fn connection_ref(&self, name: &str) -> Option<String> {
        let all = self.connections.get_all().unwrap();
        let conn = all.connections.iter().find(|c| c.name == name).unwrap();
        settings_ref(&conn.config.settings).map(str::to_string)
    }

    fn agent_ref(&self, name: &str) -> Option<String> {
        let all = self.connections.get_all().unwrap();
        let agent = all.agents.iter().find(|a| a.name == name).unwrap();
        agent_ref(agent).map(str::to_string)
    }

    fn resolve(&self, id: &str) -> Option<String> {
        self.registry
            .resolve(&*self.store, id, &CredentialType::Password)
            .unwrap()
    }
}

fn unlocked_manager(dir: &Path) -> CredentialManager {
    let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.to_path_buf());
    mgr.with_master_password_store(|s| s.setup("master-pw"))
        .unwrap()
        .unwrap();
    mgr
}

#[test]
fn export_without_references_is_unchanged() {
    let a = Machine::new();
    a.create("Unused", "s3cret");
    let base = a.connections.export_encrypted_json(Some(PW), None).unwrap();
    let out = transfer::add_to_export(&base, Some(PW), &a.registry, &*a.store).unwrap();
    assert_eq!(out, base);
}

#[test]
fn export_carries_only_referenced_credentials_and_seals_their_secrets() {
    let a = Machine::new();
    let used = a.create("Bastion", "bastion-secret");
    a.create("Unrelated", "unrelated-secret");
    a.save_ssh("web", &used.id);

    let out = a.export(Some(PW));
    let doc: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        doc[METADATA_KEY],
        json!([{ "id": used.id, "name": "Bastion", "kind": "password" }])
    );
    assert!(doc[SECRETS_KEY].is_object());
    assert!(!out.contains("bastion-secret"), "secret leaked in clear");
    assert!(!out.contains("Unrelated"));
    assert!(!out.contains("unrelated-secret"));
}

#[test]
fn export_without_password_carries_references_only() {
    let a = Machine::new();
    let used = a.create("Bastion", "bastion-secret");
    a.save_ssh("web", &used.id);

    let out = a.export(None);
    let doc: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(doc[METADATA_KEY][0]["id"], json!(used.id));
    assert!(doc.get(SECRETS_KEY).is_none());
    assert!(!transfer::has_sealed_secrets(&out));
    assert!(!out.contains("bastion-secret"));
}

#[test]
fn round_trip_recreates_the_credential_so_connections_resolve_without_prompt() {
    let a = Machine::new();
    let cred = a.create("Bastion", "bastion-secret");
    a.save_ssh("web", &cred.id);
    a.save_agent("agent-1", &cred.id);
    let file = a.export(Some(PW));
    assert!(transfer::has_sealed_secrets(&file));

    let b = Machine::new();
    let prepared = b.import(&file, Some(PW));
    assert_eq!(prepared.imported_count, 1);
    assert!(prepared.warnings.is_empty(), "{:?}", prepared.warnings);

    // Same id kept, so the references are unchanged and resolve.
    assert_eq!(b.connection_ref("web"), Some(cred.id.clone()));
    assert_eq!(b.agent_ref("agent-1"), Some(cred.id.clone()));
    assert_eq!(b.registry.get(&cred.id).unwrap().name, "Bastion");
    assert_eq!(b.resolve(&cred.id), Some("bastion-secret".to_string()));
}

#[test]
fn round_trip_through_a_folder() {
    let a = Machine::new();
    let cred = a.create("Bastion", "bastion-secret");
    a.connections
        .save_folder(crate::connection::config::ConnectionFolder {
            id: "Work".to_string(),
            name: "Work".to_string(),
            parent_id: None,
            is_expanded: true,
        })
        .unwrap();
    a.connections
        .save_connection(SavedConnection {
            id: "Work/web".to_string(),
            name: "web".to_string(),
            config: ConnectionConfig {
                type_id: "ssh".to_string(),
                settings: json!({ "authMethod": "password", "credentialRef": cred.id }),
            },
            folder_id: Some("Work".to_string()),
            terminal_options: None,
            icon: None,
            source_file: None,
        })
        .unwrap();
    let file = a.export(Some(PW));

    let b = Machine::new();
    b.import(&file, Some(PW));
    assert_eq!(b.connection_ref("web"), Some(cred.id.clone()));
    assert_eq!(b.resolve(&cred.id), Some("bastion-secret".to_string()));
}

#[test]
fn existing_credential_with_same_id_is_never_overwritten() {
    let a = Machine::new();
    let cred = a.create("Bastion", "old-secret");
    a.save_ssh("web", &cred.id);
    let file = a.export(Some(PW));
    // The exporting machine rotates afterwards; re-importing the older file
    // must not roll the secret back.
    a.registry
        .rotate(&*a.store, &MODE, &cred.id, "new-secret")
        .unwrap();
    a.connections.delete_connection("web").unwrap();

    let prepared = a.import(&file, Some(PW));
    assert!(prepared.created.is_empty());
    assert_eq!(prepared.imported_count, 0);
    assert_eq!(a.registry.list().len(), 1);
    assert_eq!(a.resolve(&cred.id), Some("new-secret".to_string()));
    assert_eq!(a.connection_ref("web"), Some(cred.id));
}

#[test]
fn existing_credential_without_a_secret_is_filled_in() {
    let a = Machine::new();
    let cred = a.create("Bastion", "bastion-secret");
    a.save_ssh("web", &cred.id);
    let file = a.export(Some(PW));
    a.store
        .remove(&secret_key(&cred.id, NamedCredentialKind::Password))
        .unwrap();
    a.connections.delete_connection("web").unwrap();

    let prepared = a.import(&file, Some(PW));
    assert_eq!(prepared.imported_count, 1);
    assert_eq!(a.resolve(&cred.id), Some("bastion-secret".to_string()));
}

#[test]
fn name_clash_with_a_different_secret_is_imported_under_a_suffixed_name() {
    let a = Machine::new();
    let cred = a.create("Bastion", "theirs");
    a.save_ssh("web", &cred.id);
    let file = a.export(Some(PW));

    let b = Machine::new();
    let local = b.create("Bastion", "mine");
    let prepared = b.import(&file, Some(PW));

    assert_eq!(prepared.created.len(), 1);
    let imported = b.registry.get(&cred.id).unwrap();
    assert_eq!(imported.name, "Bastion (imported)");
    assert_eq!(b.connection_ref("web"), Some(cred.id.clone()));
    assert_eq!(b.resolve(&cred.id), Some("theirs".to_string()));
    // The local credential is untouched.
    assert_eq!(b.resolve(&local.id), Some("mine".to_string()));
    assert!(prepared.warnings.iter().any(|w| w.contains("(imported)")));
}

#[test]
fn name_clash_with_an_identical_secret_reuses_the_local_credential() {
    let a = Machine::new();
    let cred = a.create("Bastion", "same-secret");
    a.save_ssh("web", &cred.id);
    a.save_agent("agent-1", &cred.id);
    let file = a.export(Some(PW));

    let b = Machine::new();
    let local = b.create("bastion", "same-secret");
    let prepared = b.import(&file, Some(PW));

    assert!(prepared.created.is_empty());
    assert_eq!(b.registry.list().len(), 1);
    assert_eq!(b.connection_ref("web"), Some(local.id.clone()));
    assert_eq!(b.agent_ref("agent-1"), Some(local.id));
}

#[test]
fn import_without_password_creates_the_credential_without_a_secret() {
    let a = Machine::new();
    let cred = a.create("Bastion", "bastion-secret");
    a.save_ssh("web", &cred.id);
    let file = a.export(Some(PW));

    let b = Machine::new();
    let prepared = b.import(&file, None);
    assert_eq!(prepared.created.len(), 1);
    assert_eq!(b.connection_ref("web"), Some(cred.id.clone()));
    assert_eq!(b.resolve(&cred.id), None);
    assert!(prepared
        .warnings
        .iter()
        .any(|w| w.contains("without its secret")));
}

#[test]
fn storage_off_drops_the_references_with_a_warning() {
    let a = Machine::new();
    let cred = a.create("Bastion", "bastion-secret");
    a.save_ssh("web", &cred.id);
    let file = a.export(Some(PW));

    let registry = NamedCredentialRegistry::in_memory();
    let prepared =
        transfer::prepare_import(&file, Some(PW), &registry, &NullStore, &StorageMode::None)
            .unwrap();
    assert!(registry.list().is_empty());
    assert!(prepared.created.is_empty());
    assert_eq!(prepared.warnings.len(), 1);
    assert!(prepared.warnings[0].contains("Bastion"));

    let doc: Value = serde_json::from_str(&prepared.json).unwrap();
    let settings = &doc["children"][0]["config"]["config"];
    assert!(settings.get("credentialRef").is_none(), "{settings}");
    assert_eq!(settings["host"], "example.com");
}

#[test]
fn locked_store_refuses_the_import() {
    let a = Machine::new();
    let cred = a.create("Bastion", "bastion-secret");
    a.save_ssh("web", &cred.id);
    let file = a.export(Some(PW));

    let b = Machine::new();
    b.store.with_master_password_store(|s| s.lock()).unwrap();
    let err = transfer::prepare_import(&file, Some(PW), &b.registry, &*b.store, &MODE)
        .unwrap_err()
        .to_string();
    assert!(err.contains("Unlock"), "{err}");
    assert!(b.registry.list().is_empty());
}

#[test]
fn wrong_password_fails_before_anything_changes() {
    let a = Machine::new();
    let cred = a.create("Bastion", "bastion-secret");
    a.save_ssh("web", &cred.id);
    let file = a.export(Some(PW));

    let b = Machine::new();
    let err = transfer::prepare_import(&file, Some("nope-nope"), &b.registry, &*b.store, &MODE)
        .unwrap_err();
    assert!(err.chain().any(|c| matches!(
        c.downcast_ref::<DecryptError>(),
        Some(DecryptError::WrongPassword)
    )));
    assert!(b.registry.list().is_empty());
}

#[test]
fn old_format_file_imports_unchanged() {
    let old = r#"{
        "version": "2",
        "children": [
            {"type": "connection", "name": "web",
             "config": {"type": "ssh", "config": {"host": "h", "credentialRef": "nc-x"}}}
        ],
        "agents": []
    }"#;
    let b = Machine::new();
    let prepared = transfer::prepare_import(old, Some(PW), &b.registry, &*b.store, &MODE).unwrap();
    assert_eq!(prepared.json, old);
    assert!(prepared.created.is_empty() && prepared.warnings.is_empty());
}

#[test]
fn rollback_removes_created_credentials_and_their_secrets() {
    let a = Machine::new();
    let cred = a.create("Bastion", "bastion-secret");
    a.save_ssh("web", &cred.id);
    let file = a.export(Some(PW));

    let b = Machine::new();
    let prepared =
        transfer::prepare_import(&file, Some(PW), &b.registry, &*b.store, &MODE).unwrap();
    transfer::rollback(&prepared.created, &b.registry, &*b.store, &MODE);
    assert!(b.registry.list().is_empty());
    assert_eq!(
        b.store
            .get(&secret_key(&cred.id, NamedCredentialKind::Password))
            .unwrap(),
        None
    );
}

#[test]
fn import_credential_mints_a_new_id_when_taken_and_numbers_name_clashes() {
    let dir = tempfile::tempdir().unwrap();
    let store = unlocked_manager(dir.path());
    let reg = NamedCredentialRegistry::in_memory();
    let pw = NamedCredentialKind::Password;
    let first = reg
        .import_credential(&store, &MODE, "nc-1", "Prod", pw, Some("a"))
        .unwrap();
    assert_eq!((first.id.as_str(), first.name.as_str()), ("nc-1", "Prod"));
    let second = reg
        .import_credential(&store, &MODE, "nc-1", "prod", pw, None)
        .unwrap();
    assert_ne!(second.id, "nc-1");
    assert_eq!(second.name, "prod (imported)");
    let third = reg
        .import_credential(&store, &MODE, "nc-3", "PROD", pw, None)
        .unwrap();
    assert_eq!(third.name, "PROD (imported 2)");
    // The first credential's secret is untouched.
    assert_eq!(
        reg.resolve(&store, "nc-1", &CredentialType::Password)
            .unwrap(),
        Some("a".to_string())
    );

    let long = "n".repeat(MAX_NAME_LEN);
    reg.import_credential(&store, &MODE, "nc-4", &long, pw, None)
        .unwrap();
    let clashed = reg
        .import_credential(&store, &MODE, "nc-5", &long, pw, None)
        .unwrap();
    assert!(clashed.name.chars().count() <= MAX_NAME_LEN);
    assert!(clashed.name.ends_with(" (imported)"));
}

//! Backup → staged restore → **app restart** journeys (PROD-068, #3509, #3515,
//! #4012).
//!
//! A restore never touches the live stores while the app runs: it stages the
//! files and `boot` swaps them in at the next start
//! ([`apply_pending_restore`]). These tests drive that whole path and then read
//! the result back through the real stores a restarted app builds — the
//! connection manager, the macro store, the settings, a freshly opened
//! master-password store, the SSH host-key verifier and the plugin manager —
//! instead of comparing raw JSON.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use termihub_core::backends::ssh::host_key::{HostKeyInfo, HostKeyVerifier, KnownHostsStatus};
use termihub_core::plugin::{PluginManager, PluginState};

use super::pending::apply_pending_restore;
use super::plugins::{self, PLUGINS_DIR};
use super::restore::{self, PENDING_DIR};
use super::tests::{choice, mp_manager, options, PASSPHRASE};
use super::tests_plugins::{install, plugins_root, theme_manifest};
use super::*;
use crate::connection::config::SavedConnection;
use crate::connection::credential_scope::owner_id;
use crate::connection::jump_host_resolver::resolve_credential;
use crate::connection::manager::ConnectionManager;
use crate::credential::types::StorageMode;
use crate::credential::vault::{self, ConflictStrategy};
use crate::credential::CredentialManager;
use crate::macros::config::{Macro, MacroStore};
use crate::macros::storage::MacroStorage;
use crate::session::ssh_host_key_verifier::{
    SshHostKeyEventSink, SshHostKeyPromptEvent, SshHostKeyVerifier,
};
use crate::session::ssh_trust_store::SshTrustStore;
use crate::terminal::backend::ConnectionConfig;

const SAVED_PASSWORD: &str = "sentinel-saved-password-4012";
const THEME: &str = "solarized-light";
const MACRO_NAME: &str = "Deploy release";
const HOST: &str = "fixture.example";
const HOST_KEY: &str = "SHA256:restoredHostKey4012";
const THEME_PLUGIN: &str = "restored-theme";

fn created_at() -> String {
    "2026-10-01T00:00:00+00:00".into()
}

/// A master-password store as a *restarted* app opens it: locked, then
/// unlocked with the user's master password.
fn reopen_store(dir: &Path) -> Arc<CredentialManager> {
    let store = CredentialManager::new(StorageMode::MasterPassword, dir.to_path_buf());
    store
        .with_master_password_store(|s| s.unlock("master-pw"))
        .unwrap()
        .unwrap();
    Arc::new(store)
}

fn ssh_with_saved_password(name: &str) -> SavedConnection {
    SavedConnection {
        extra: Default::default(),
        id: String::new(),
        name: name.to_string(),
        config: ConnectionConfig {
            type_id: "ssh".to_string(),
            settings: json!({
                "host": HOST, "port": 22, "username": "ops", "authMethod": "password",
                "password": SAVED_PASSWORD, "savePassword": true,
            }),
        },
        folder_id: None,
        terminal_options: None,
        icon: None,
        source_file: None,
    }
}

/// Machine A: a connection with a saved password, a macro and a theme.
fn populate_source(dir: &Path) -> (Arc<CredentialManager>, String) {
    let store = Arc::new(mp_manager(dir));
    let connections = ConnectionManager::new_for_test(dir, store.clone()).unwrap();
    let id = connections
        .save_connection(ssh_with_saved_password("Prod"))
        .unwrap();
    let mut settings = connections.get_settings();
    settings.theme = Some(THEME.to_string());
    connections.save_settings(settings).unwrap();

    let macro_ = Macro {
        id: "m-deploy".into(),
        name: MACRO_NAME.into(),
        description: None,
        tags: vec!["release".into()],
        steps: Vec::new(),
        created_at: created_at(),
        updated_at: created_at(),
    };
    MacroStorage::new_test(dir)
        .save(&MacroStore {
            macros: vec![macro_],
            ..MacroStore::default()
        })
        .unwrap();
    (store, id)
}

#[test]
fn restore_after_restart_brings_back_connections_macro_theme_and_saved_password() {
    let src = tempfile::tempdir().unwrap();
    let (src_store, conn_id) = populate_source(src.path());
    let secrets = vault::collect_entries(&*src_store, std::slice::from_ref(&conn_id)).unwrap();
    let sealed = vault::seal(&secrets, PASSPHRASE, created_at()).unwrap();
    let json = export::build(
        src.path(),
        &options(&["connections", "settings", "macros"], true, true),
        Some(PASSPHRASE),
        Some(sealed),
        created_at(),
        "0.0.0-test".into(),
    )
    .unwrap()
    .json;
    assert!(!json.contains(SAVED_PASSWORD));

    // Machine B: its own master password, nothing else yet.
    let dst = tempfile::tempdir().unwrap();
    let dst_store = mp_manager(dst.path());
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let req = BackupRestoreRequest {
        sections: ["connections", "settings", "macros"]
            .iter()
            .map(|id| choice(id, RestoreMode::Replace, ConflictStrategy::Skip))
            .collect(),
        credentials: Some(ConflictStrategy::Overwrite),
    };
    let result = restore::apply(&opened, dst.path(), &req, Some(&dst_store)).unwrap();
    assert!(result.restart_required);
    assert_eq!(result.credentials.unwrap().imported_count, 1);

    // Staged only: the running app still sees its old (empty) stores.
    assert!(dst.path().join(PENDING_DIR).exists());
    assert!(!dst.path().join("connections.json").exists());
    assert!(MacroStorage::new_test(dst.path())
        .load_with_recovery()
        .unwrap()
        .data
        .macros
        .is_empty());

    // Restart: boot swaps the staged files in, the stores load from disk.
    drop(dst_store);
    assert!(apply_pending_restore(dst.path()).is_none());
    assert!(!dst.path().join(PENDING_DIR).exists());
    let store = reopen_store(dst.path());
    let connections = ConnectionManager::new_for_test(dst.path(), store.clone()).unwrap();

    let all = connections.get_all().unwrap().connections;
    let prod = all.iter().find(|c| c.name == "Prod").expect("connection");
    assert_eq!(prod.id, conn_id);
    assert_eq!(prod.config.settings["host"], HOST);
    assert!(prod.config.settings.get("password").is_none());
    let password = resolve_credential(
        &prod.id,
        Some(&owner_id(&prod.id, None)),
        &prod.config.settings,
        "password",
        &*store,
    )
    .unwrap();
    assert_eq!(password.as_deref(), Some(SAVED_PASSWORD));

    assert_eq!(connections.get_settings().theme.as_deref(), Some(THEME));
    let macros = MacroStorage::new_test(dst.path())
        .load_with_recovery()
        .unwrap();
    assert!(macros.warnings.is_empty());
    let names: Vec<_> = macros.data.macros.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(names, [MACRO_NAME]);
}

#[derive(Default)]
struct CountingSink(AtomicUsize);

impl SshHostKeyEventSink for CountingSink {
    fn emit_prompt(&self, _: &SshHostKeyPromptEvent) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn host_key(fingerprint: &str) -> HostKeyInfo {
    HostKeyInfo {
        host: HOST.to_string(),
        port: 22,
        key_type: "ssh-ed25519".to_string(),
        fingerprint: fingerprint.to_string(),
        known_hosts: KnownHostsStatus::Unknown,
    }
}

#[tokio::test]
async fn restored_host_key_and_plugins_after_restart_connect_without_a_prompt() {
    let src = tempfile::tempdir().unwrap();
    std::fs::write(
        src.path().join("ssh_known_hosts.json"),
        json!({ format!("{HOST}:22"): [HOST_KEY] }).to_string(),
    )
    .unwrap();
    install(
        src.path(),
        THEME_PLUGIN,
        &theme_manifest(THEME_PLUGIN, "2.1.0"),
        &[("themes/dark.json", b"{}")],
    );
    std::fs::write(
        plugins_root(src.path()).join("plugin-state.json"),
        json!({"plugins": {THEME_PLUGIN: {"enabled": false, "installedAt": 7}}}).to_string(),
    )
    .unwrap();
    let ids = ["sshKnownHosts", plugins::SECTION_ID];
    let json = export::build(
        src.path(),
        &options(&ids, true, false),
        Some(PASSPHRASE),
        None,
        created_at(),
        "0.0.0-test".into(),
    )
    .unwrap()
    .json;

    let dst = tempfile::tempdir().unwrap();
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let req = BackupRestoreRequest {
        sections: ids
            .iter()
            .map(|id| choice(id, RestoreMode::Merge, ConflictStrategy::Skip))
            .collect(),
        credentials: None,
    };
    restore::apply(&opened, dst.path(), &req, None).unwrap();
    assert!(!dst.path().join(PLUGINS_DIR).join(THEME_PLUGIN).exists());

    // Restart.
    assert!(apply_pending_restore(dst.path()).is_none());

    // The connect path's verifier trusts the restored key: no prompt.
    let sink = Arc::new(CountingSink::default());
    let verifier = SshHostKeyVerifier::new(
        Arc::new(SshTrustStore::open(dst.path().to_path_buf())),
        sink.clone(),
    );
    let trusted =
        tokio::time::timeout(Duration::from_secs(5), verifier.verify(&host_key(HOST_KEY)))
            .await
            .expect("a trusted key never waits on a prompt");
    assert!(trusted);
    assert_eq!(sink.0.load(Ordering::SeqCst), 0, "no host-key prompt");
    // A different key is still caught (unattended: refused without asking).
    assert!(!verifier.verify_unattended(&host_key("SHA256:other")).await);

    // The plugin manager lists the restored plugin with its restored state.
    let listed = PluginManager::new(plugins_root(dst.path())).list().unwrap();
    let states: Vec<_> = listed
        .iter()
        .map(|p| (p.manifest.id.as_str(), p.manifest.version.as_str(), p.state))
        .collect();
    assert_eq!(states, [(THEME_PLUGIN, "2.1.0", PluginState::Disabled)]);
}

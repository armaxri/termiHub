//! Tests for the unified backup and restore (PROD-068).

use std::path::Path;

use anyhow::Result;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use super::pending::{apply_pending_restore, ROLLBACK_DIR};
use super::restore::{self, PENDING_DIR, STAGING_DIR};
use super::sections::{self, SECTIONS};
use super::*;
use crate::credential::types::{CredentialKey, CredentialType, StorageMode};
use crate::credential::vault::{self, ConflictStrategy, VaultError, VaultSecret};
use crate::credential::{CredentialManager, CredentialStore, CredentialStoreStatus};

pub(super) const PASSPHRASE: &str = "correct horse battery staple";
const CRED_SECRET: &str = "sentinel-credential-7f3c";
pub(super) const SERVER_SECRET: &str = "sentinel-ftp-password-19ad";
const HOST_MARKER: &str = "sentinel-host.example";

// --- fixtures ---

/// Stamp `doc` with the schema version the owning store's own writer (its
/// default document) uses — never a literal — so a store's version bump keeps
/// these fixtures current instead of silently making them "older" backups.
fn at_current(file: &str, mut doc: Value) -> Value {
    let spec = sections::spec_for_file(file).unwrap();
    let obj = doc.as_object_mut().unwrap();
    match spec.default_doc().get("version") {
        Some(version) => obj.insert("version".into(), version.clone()),
        None => obj.remove("version"),
    };
    doc
}

/// A schema version one past what the section's store supports.
fn newer_than_current(id: &str) -> String {
    (sections::spec(id).unwrap().current_version + 1).to_string()
}

fn connections_doc() -> Value {
    at_current(
        "connections.json",
        json!({
            "children": [
                {"type": "folder", "name": "Work", "isExpanded": true, "children": [
                    {"type": "connection", "name": "Prod",
                     "config": {"type": "ssh", "config": {"host": HOST_MARKER, "username": "ops"}}}
                ]},
                {"type": "connection", "name": "Local",
                 "config": {"type": "local", "config": {"shell": "bash"}}}
            ],
            "agents": [
                {"id": "agent-1", "name": "Pi",
                 "config": {"host": "pi.local", "port": 22, "username": "pi"}}
            ]
        }),
    )
}

fn macros_doc(items: &[(&str, &str)]) -> Value {
    let macros: Vec<Value> = items
        .iter()
        .map(|(id, name)| json!({"id": id, "name": name, "tags": [], "steps": []}))
        .collect();
    at_current("macros.json", json!({"macros": macros}))
}

fn schedule_doc(id: &str, name: &str) -> Value {
    json!({"id": id, "name": name,
           "action": {"kind": "workflow", "workflowId": "wf1"},
           "targets": {"kind": "connections", "connectionIds": ["c1"]},
           "rule": {"kind": "daily", "time": "09:00"},
           "missedRuns": "skip", "enabled": false, "createdAt": "", "updatedAt": ""})
}

fn fixture_docs() -> Vec<(&'static str, Value)> {
    vec![
        ("connections.json", connections_doc()),
        (
            "settings.json",
            json!({"version": "1", "theme": "dark", "credentialStorageMode": "none",
                   "customThemes": [{"id": "t1", "name": "Mine"}],
                   "keybindingOverrides": []}),
        ),
        (
            "workspaces.json",
            json!({"version": "2", "workspaces": [{"id": "w1", "name": "Dev", "tabGroups": []}]}),
        ),
        (
            "macros.json",
            macros_doc(&[("m1", "Deploy"), ("m2", "Logs")]),
        ),
        (
            "workflows.json",
            json!({"version": "1", "workflows": [{"id": "wf1", "name": "Nightly"}]}),
        ),
        (
            "schedules.json",
            json!({"version": "1", "paused": false, "schedules": [schedule_doc("sch1", "Health")]}),
        ),
        ("tunnels.json", json!({"version": "1", "tunnels": []})),
        (
            "embedded_servers.json",
            // Passwords live in the credential store (#3514); legacy plaintext
            // is covered by `tests_embedded_servers`.
            json!({"version": "2", "servers": [{
                "id": "s1", "name": "FTP", "serverType": "ftp", "rootDirectory": "/tmp",
                "bindHost": "127.0.0.1", "port": 2121,
                "ftpAuth": {"type": "credentials", "username": "u"}
            }]}),
        ),
        (
            "wol-devices.json",
            json!({"devices": [{"id": "d1", "name": "NAS", "mac": "AA:BB:CC:DD:EE:FF",
                                "broadcast": "255.255.255.255", "port": 9}]}),
        ),
        (
            "http-monitors.json",
            json!({"monitors": [{"id": "h1", "url": "https://example.com", "intervalMs": 1000,
                                 "method": "GET", "expectedStatus": 200, "timeoutMs": 500}]}),
        ),
        (
            "network-tool-history.json",
            json!({"version": "1", "runs": []}),
        ),
        (
            "ssh_known_hosts.json",
            json!({"server.example:22": ["SHA256:AAAA", "SHA256:BBBB"]}),
        ),
        (
            "rdp_known_hosts.json",
            json!({"desk.example:3389": ["sha256:11:22"]}),
        ),
    ]
}

pub(super) fn write_doc(dir: &Path, file: &str, doc: &Value) {
    std::fs::write(dir.join(file), serde_json::to_string_pretty(doc).unwrap()).unwrap();
}

fn populate(dir: &Path) {
    for (file, doc) in fixture_docs() {
        write_doc(dir, file, &at_current(file, doc));
    }
}

pub(super) fn read_doc(dir: &Path, file: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir.join(file)).unwrap()).unwrap()
}

fn all_ids() -> Vec<String> {
    SECTIONS.iter().map(|s| s.id.to_string()).collect()
}

pub(super) fn options(
    ids: &[&str],
    encrypt: bool,
    include_credentials: bool,
) -> BackupExportOptions {
    BackupExportOptions {
        sections: ids.iter().map(|s| s.to_string()).collect(),
        include_credentials,
        encrypt,
    }
}

fn build(dir: &Path, opts: &BackupExportOptions, creds: Option<vault::VaultExportFile>) -> String {
    export::build(
        dir,
        opts,
        Some(PASSPHRASE),
        creds,
        "2026-09-26T00:00:00+00:00".into(),
        "0.0.0-test".into(),
    )
    .unwrap()
    .json
}

pub(super) fn choice(
    id: &str,
    mode: RestoreMode,
    conflicts: ConflictStrategy,
) -> SectionRestoreChoice {
    SectionRestoreChoice {
        id: id.into(),
        mode,
        conflicts,
    }
}

pub(super) fn request(sections: Vec<SectionRestoreChoice>) -> BackupRestoreRequest {
    BackupRestoreRequest {
        sections,
        credentials: None,
    }
}

pub(super) fn no_creds(_: &vault::OpenedVault) -> BackupCredentialsPreview {
    unreachable!("backup has no credentials")
}

pub(super) fn restore_and_boot(
    json: &str,
    dir: &Path,
    req: &BackupRestoreRequest,
) -> BackupRestoreResult {
    let opened = restore::open(json, Some(PASSPHRASE)).unwrap();
    let result = restore::apply(&opened, dir, req, None).unwrap();
    assert!(apply_pending_restore(dir).is_none());
    result
}

fn sealed_vault(entries: &[(&str, &str)]) -> vault::VaultExportFile {
    let secrets: Vec<VaultSecret> = entries
        .iter()
        .map(|(id, v)| {
            (
                CredentialKey::new(id, CredentialType::Password),
                Zeroizing::new(v.to_string()),
            )
        })
        .collect();
    vault::seal(&secrets, PASSPHRASE, "2026-09-26T00:00:00+00:00".into()).unwrap()
}

pub(super) fn mp_manager(dir: &Path) -> CredentialManager {
    let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.to_path_buf());
    mgr.with_master_password_store(|s| s.setup("master-pw"))
        .unwrap()
        .unwrap();
    mgr
}

pub(super) fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

pub(super) fn assert_not_on_disk(dir: &Path, needle: &str) {
    for path in walk(dir) {
        let text = String::from_utf8_lossy(&std::fs::read(&path).unwrap()).to_string();
        assert!(
            !text.contains(needle),
            "{needle} found in {}",
            path.display()
        );
    }
}

// --- round trip ---

#[test]
fn round_trip_every_section_encrypted() {
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    let ids = all_ids();
    let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    let json = build(src.path(), &options(&ids, true, false), None);

    // Nothing but the header is readable. Each needle is matched as a quoted
    // JSON string, exactly as plaintext would serialize it: the ciphertext is
    // random base64, so a bare short alphanumeric needle such as `NAS` occurs
    // in it by chance (~1% of runs for this fixture) and made this flaky.
    for needle in [HOST_MARKER, SERVER_SECRET, "Deploy", "NAS"] {
        assert!(
            !json.contains(&format!("\"{needle}\"")),
            "{needle} leaked into the encrypted backup"
        );
    }
    let header = restore::header(&json).unwrap();
    assert!(header.encrypted && header.needs_passphrase);

    let dst = tempfile::tempdir().unwrap();
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let preview = restore::plan(&opened, dst.path(), no_creds);
    assert_eq!(preview.sections.len(), SECTIONS.len());
    let macros = preview.sections.iter().find(|s| s.id == "macros").unwrap();
    assert_eq!((macros.item_count, macros.new_count), (2, 2));
    assert!(preview
        .sections
        .iter()
        .all(|s| s.status == SectionStatus::Ok));

    let choices = SECTIONS
        .iter()
        .map(|s| choice(s.id, RestoreMode::Replace, ConflictStrategy::Skip))
        .collect();
    let result = restore_and_boot(&json, dst.path(), &request(choices));
    assert!(result.restart_required);

    for spec in SECTIONS {
        let mut expected = spec
            .normalize(read_doc(src.path(), spec.file_name))
            .unwrap();
        if spec.id == "settings" {
            // This machine's credential-storage keys are never restored.
            sections::preserve_local_settings(&mut expected, None);
        }
        let actual = spec
            .normalize(read_doc(dst.path(), spec.file_name))
            .unwrap();
        assert_eq!(actual, expected, "{} did not round-trip", spec.id);
    }
    assert!(!dst.path().join(PENDING_DIR).exists());
    assert!(!dst.path().join(ROLLBACK_DIR).exists());
}

#[test]
fn unencrypted_backup_refuses_encryption_only_sections_and_needs_no_passphrase() {
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    let err = export::build(
        src.path(),
        &options(&["sshKnownHosts"], false, false),
        None,
        None,
        "t".into(),
        "v".into(),
    )
    .unwrap_err();
    assert!(matches!(err, VaultError::WeakPassphrase { .. }));

    let export::BuiltBackup {
        json,
        sections: written,
        ..
    } = export::build(
        src.path(),
        &options(&["macros", "connections"], false, false),
        None,
        None,
        "t".into(),
        "v".into(),
    )
    .unwrap();
    assert_eq!(written, vec!["macros", "connections"]);
    let header = restore::header(&json).unwrap();
    assert!(!header.encrypted && !header.needs_passphrase);
    assert!(restore::open(&json, None).is_ok());
}

#[test]
fn missing_store_files_are_skipped_on_export() {
    let src = tempfile::tempdir().unwrap();
    write_doc(src.path(), "macros.json", &macros_doc(&[("m1", "A")]));
    let written = export::build(
        src.path(),
        &options(&["macros", "tunnels"], true, false),
        Some(PASSPHRASE),
        None,
        "t".into(),
        "v".into(),
    )
    .unwrap()
    .sections;
    assert_eq!(written, vec!["macros"]);
    let infos = export::section_infos(src.path());
    let macros = infos.iter().find(|i| i.id == "macros").unwrap();
    assert!(macros.present && macros.item_count == 1);
    assert!(!infos.iter().find(|i| i.id == "tunnels").unwrap().present);
}

#[test]
fn connection_passwords_are_never_backed_up() {
    let src = tempfile::tempdir().unwrap();
    let mut doc = connections_doc();
    doc["children"][1]["config"]["config"]["password"] = json!("leaked-pw");
    doc["agents"][0]["config"]["password"] = json!("leaked-agent-pw");
    write_doc(src.path(), "connections.json", &doc);
    let json = export::build(
        src.path(),
        &options(&["connections"], false, false),
        None,
        None,
        "t".into(),
        "v".into(),
    )
    .unwrap()
    .json;
    assert!(!json.contains("leaked-pw") && !json.contains("leaked-agent-pw"));
}

// --- partial restore + conflict strategies ---

#[test]
fn partial_restore_only_touches_chosen_sections() {
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    let json = build(
        src.path(),
        &options(&["macros", "workflows"], true, false),
        None,
    );

    let dst = tempfile::tempdir().unwrap();
    write_doc(
        dst.path(),
        "workflows.json",
        &at_current("workflows.json", json!({"workflows": []})),
    );
    let result = restore_and_boot(
        &json,
        dst.path(),
        &request(vec![choice(
            "macros",
            RestoreMode::Merge,
            ConflictStrategy::Skip,
        )]),
    );
    assert_eq!(result.sections.len(), 1);
    assert_eq!(result.sections[0].resulting_count, 2);
    assert!(dst.path().join("macros.json").exists());
    assert_eq!(
        read_doc(dst.path(), "workflows.json")["workflows"],
        json!([])
    );
}

fn macro_names(dir: &Path) -> Vec<(String, String)> {
    read_doc(dir, "macros.json")["macros"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["id"].as_str().unwrap().to_string(),
                m["name"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn conflict_fixture() -> (tempfile::TempDir, String) {
    let src = tempfile::tempdir().unwrap();
    write_doc(
        src.path(),
        "macros.json",
        &macros_doc(&[("m1", "From backup"), ("m3", "New")]),
    );
    let json = build(src.path(), &options(&["macros"], true, false), None);
    let dst = tempfile::tempdir().unwrap();
    write_doc(
        dst.path(),
        "macros.json",
        &macros_doc(&[("m1", "Local"), ("m2", "Only local")]),
    );
    (dst, json)
}

fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}

#[test]
fn preview_counts_new_and_conflicting_items() {
    let (dst, json) = conflict_fixture();
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let preview = restore::plan(&opened, dst.path(), no_creds);
    let s = &preview.sections[0];
    assert_eq!(
        (
            s.item_count,
            s.current_count,
            s.new_count,
            s.conflict_count,
            s.unchanged_count
        ),
        (2, 2, 1, 1, 0)
    );
    assert!(s.supports_merge);
}

#[test]
fn merge_skip_keeps_existing_items() {
    let (dst, json) = conflict_fixture();
    let req = request(vec![choice(
        "macros",
        RestoreMode::Merge,
        ConflictStrategy::Skip,
    )]);
    restore_and_boot(&json, dst.path(), &req);
    assert_eq!(
        macro_names(dst.path()),
        pairs(&[("m1", "Local"), ("m2", "Only local"), ("m3", "New")])
    );
}

#[test]
fn merge_overwrite_replaces_conflicting_items() {
    let (dst, json) = conflict_fixture();
    let req = request(vec![choice(
        "macros",
        RestoreMode::Merge,
        ConflictStrategy::Overwrite,
    )]);
    restore_and_boot(&json, dst.path(), &req);
    assert_eq!(
        macro_names(dst.path()),
        pairs(&[("m1", "From backup"), ("m2", "Only local"), ("m3", "New")])
    );
}

#[test]
fn replace_discards_items_not_in_the_backup() {
    let (dst, json) = conflict_fixture();
    let req = request(vec![choice(
        "macros",
        RestoreMode::Replace,
        ConflictStrategy::Skip,
    )]);
    restore_and_boot(&json, dst.path(), &req);
    assert_eq!(
        macro_names(dst.path()),
        pairs(&[("m1", "From backup"), ("m3", "New")])
    );
}

#[test]
fn connections_merge_by_path_id_including_agents() {
    let src = tempfile::tempdir().unwrap();
    write_doc(src.path(), "connections.json", &connections_doc());
    let json = build(src.path(), &options(&["connections"], true, false), None);

    let dst = tempfile::tempdir().unwrap();
    write_doc(
        dst.path(),
        "connections.json",
        &at_current(
            "connections.json",
            json!({"children": [
                {"type": "connection", "name": "Mine",
                 "config": {"type": "local", "config": {"shell": "zsh"}}},
                {"type": "connection", "name": "Local",
                 "config": {"type": "local", "config": {"shell": "fish"}}}
            ], "agents": []}),
        ),
    );
    let req = request(vec![choice(
        "connections",
        RestoreMode::Merge,
        ConflictStrategy::Skip,
    )]);
    restore_and_boot(&json, dst.path(), &req);

    let doc = read_doc(dst.path(), "connections.json");
    let text = doc.to_string();
    assert!(text.contains("\"Mine\"") && text.contains("\"Prod\"") && text.contains("\"Work\""));
    // Skip kept the local "Local" connection's shell.
    assert!(text.contains("fish") && !text.contains("bash"));
    assert_eq!(doc["agents"].as_array().unwrap().len(), 1);
}

#[test]
fn settings_replace_preserves_local_credential_storage() {
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    let json = build(src.path(), &options(&["settings"], true, false), None);

    let dst = tempfile::tempdir().unwrap();
    write_doc(
        dst.path(),
        "settings.json",
        &at_current(
            "settings.json",
            json!({"theme": "light", "credentialStorageMode": "master_password",
                   "credentialAutoLockMinutes": 5}),
        ),
    );
    // Merge is not offered for settings.
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let merge = request(vec![choice(
        "settings",
        RestoreMode::Merge,
        ConflictStrategy::Skip,
    )]);
    assert!(restore::apply(&opened, dst.path(), &merge, None).is_err());
    assert!(!dst.path().join(PENDING_DIR).exists());

    let req = request(vec![choice(
        "settings",
        RestoreMode::Replace,
        ConflictStrategy::Skip,
    )]);
    restore_and_boot(&json, dst.path(), &req);
    let doc = read_doc(dst.path(), "settings.json");
    assert_eq!(doc["theme"], "dark");
    assert_eq!(doc["customThemes"][0]["name"], "Mine");
    assert_eq!(doc["credentialStorageMode"], "master_password");
    assert_eq!(doc["credentialAutoLockMinutes"], 5);
}

// --- versioning ---

/// Hand-build an unencrypted backup containing the given sections.
pub(super) fn raw_backup(sections: Vec<BackupSection>, format_version: u32) -> String {
    let contents = BackupContents {
        format: BACKUP_FORMAT_ID.into(),
        format_version,
        created_at: "t".into(),
        sections,
        credentials: None,
    };
    serde_json::to_string(&BackupFile {
        format: BACKUP_FORMAT_ID.into(),
        format_version,
        created_at: "t".into(),
        app_version: "v".into(),
        encrypted: false,
        envelope: None,
        contents: Some(contents),
    })
    .unwrap()
}

#[test]
fn older_section_versions_are_migrated() {
    let mut old = connections_doc();
    old["version"] = json!("3");
    old["children"][1]["config"]["config"]["resilientReconnect"] = json!(false);
    let json = raw_backup(
        vec![BackupSection {
            id: "connections".into(),
            schema_version: 3,
            data: old,
        }],
        BACKUP_FORMAT_VERSION,
    );
    let dst = tempfile::tempdir().unwrap();
    let opened = restore::open(&json, None).unwrap();
    let preview = restore::plan(&opened, dst.path(), no_creds);
    assert_eq!(preview.sections[0].status, SectionStatus::Migrated);

    let req = request(vec![choice(
        "connections",
        RestoreMode::Replace,
        ConflictStrategy::Skip,
    )]);
    restore_and_boot(&json, dst.path(), &req);
    let doc = read_doc(dst.path(), "connections.json");
    let current = sections::spec("connections").unwrap().current_version;
    assert_eq!(doc["version"], current.to_string());
    let text = doc.to_string();
    assert!(!text.contains("resilientReconnect") && text.contains("autoReconnect"));
}

#[test]
fn newer_section_versions_are_refused() {
    let mut newer = macros_doc(&[("m1", "A")]);
    newer["version"] = json!("99");
    let json = raw_backup(
        vec![
            BackupSection {
                id: "macros".into(),
                schema_version: 99,
                data: newer,
            },
            BackupSection {
                id: "fromTheFuture".into(),
                schema_version: 1,
                data: json!({}),
            },
        ],
        BACKUP_FORMAT_VERSION,
    );
    let dst = tempfile::tempdir().unwrap();
    let opened = restore::open(&json, None).unwrap();
    let preview = restore::plan(&opened, dst.path(), no_creds);
    assert_eq!(preview.sections[0].status, SectionStatus::Newer);
    assert_eq!(preview.sections[1].status, SectionStatus::Unknown);

    let req = request(vec![choice(
        "macros",
        RestoreMode::Replace,
        ConflictStrategy::Skip,
    )]);
    assert!(matches!(
        restore::apply(&opened, dst.path(), &req, None),
        Err(VaultError::UnsupportedVersion { .. })
    ));
    assert!(!dst.path().join(PENDING_DIR).exists());
    assert!(!dst.path().join("macros.json").exists());
}

#[test]
fn newer_container_format_is_refused() {
    let json = raw_backup(Vec::new(), BACKUP_FORMAT_VERSION + 1);
    assert!(matches!(
        restore::header(&json),
        Err(VaultError::UnsupportedVersion { .. })
    ));
}

#[test]
fn restoring_over_a_newer_current_store_is_refused() {
    let src = tempfile::tempdir().unwrap();
    write_doc(
        src.path(),
        "workspaces.json",
        &json!({"version": "1", "workspaces": []}),
    );
    let json = build(src.path(), &options(&["workspaces"], true, false), None);
    let dst = tempfile::tempdir().unwrap();
    write_doc(
        dst.path(),
        "workspaces.json",
        &json!({"version": newer_than_current("workspaces"), "workspaces": []}),
    );
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let req = request(vec![choice(
        "workspaces",
        RestoreMode::Replace,
        ConflictStrategy::Skip,
    )]);
    assert!(matches!(
        restore::apply(&opened, dst.path(), &req, None),
        Err(VaultError::UnsupportedVersion { .. })
    ));
}

// --- tampering / passphrase ---

fn encrypted_macros_backup() -> String {
    let src = tempfile::tempdir().unwrap();
    write_doc(src.path(), "macros.json", &macros_doc(&[("m1", "A")]));
    build(src.path(), &options(&["macros"], true, false), None)
}

#[test]
fn wrong_or_missing_passphrase_is_rejected() {
    let json = encrypted_macros_backup();
    assert!(matches!(
        restore::open(&json, Some("not the passphrase")),
        Err(VaultError::WrongPassphrase { .. })
    ));
    assert!(matches!(
        restore::open(&json, None),
        Err(VaultError::WrongPassphrase { .. })
    ));
}

#[test]
fn tampered_ciphertext_is_rejected() {
    let json = encrypted_macros_backup();
    let mut file: BackupFile = serde_json::from_str(&json).unwrap();
    let envelope = file.envelope.as_mut().unwrap();
    let mut data = envelope.data.clone().into_bytes();
    let i = data.len() / 2;
    data[i] = if data[i] == b'A' { b'B' } else { b'A' };
    envelope.data = String::from_utf8(data).unwrap();
    let tampered = serde_json::to_string(&file).unwrap();
    assert!(matches!(
        restore::open(&tampered, Some(PASSPHRASE)),
        Err(VaultError::WrongPassphrase { .. }) | Err(VaultError::InvalidFile { .. })
    ));
}

#[test]
fn tampered_header_is_rejected() {
    let json = encrypted_macros_backup();
    let mut file: BackupFile = serde_json::from_str(&json).unwrap();
    file.created_at = "1999-01-01T00:00:00+00:00".into();
    let tampered = serde_json::to_string(&file).unwrap();
    assert!(matches!(
        restore::open(&tampered, Some(PASSPHRASE)),
        Err(VaultError::InvalidFile { .. })
    ));
}

#[test]
fn not_a_backup_is_rejected() {
    assert!(matches!(
        restore::header("{\"hello\": 1}"),
        Err(VaultError::InvalidFile { .. })
    ));
    assert!(matches!(
        restore::header("not json"),
        Err(VaultError::InvalidFile { .. })
    ));
}

// --- credentials section ---

#[test]
fn credentials_round_trip_into_the_current_store() {
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    let vault_file = sealed_vault(&[("Local", CRED_SECRET)]);
    let json = build(
        src.path(),
        &options(&["macros"], false, true),
        Some(vault_file),
    );
    // Credentials are sealed even in an unencrypted backup.
    assert!(!json.contains(CRED_SECRET));
    assert!(restore::header(&json).unwrap().needs_passphrase);

    let dst = tempfile::tempdir().unwrap();
    let mgr = mp_manager(dst.path());
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let preview = restore::plan(&opened, dst.path(), |v| BackupCredentialsPreview {
        available: true,
        unavailable_reason: None,
        preview: vault::plan_import(v, &mgr, &StorageMode::MasterPassword, &Default::default())
            .ok(),
    });
    assert_eq!(preview.credentials.unwrap().preview.unwrap().new_count, 1);

    let req = BackupRestoreRequest {
        sections: vec![choice(
            "macros",
            RestoreMode::Replace,
            ConflictStrategy::Skip,
        )],
        credentials: Some(ConflictStrategy::Overwrite),
    };
    let result = restore::apply(&opened, dst.path(), &req, Some(&mgr)).unwrap();
    assert_eq!(result.credentials.unwrap().imported_count, 1);
    assert_eq!(
        mgr.get(&CredentialKey::new("Local", CredentialType::Password))
            .unwrap()
            .as_deref(),
        Some(CRED_SECRET)
    );
    assert!(apply_pending_restore(dst.path()).is_none());
    assert_not_on_disk(dst.path(), CRED_SECRET);
}

#[test]
fn keychain_mode_blocks_the_credentials_section_but_not_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    populate(dir.path());
    let mgr = CredentialManager::new(StorageMode::OsKeychain, dir.path().to_path_buf());
    let err = export::seal_credentials(&mgr, None, PASSPHRASE, &[], "t".into()).unwrap_err();
    assert_eq!(
        err,
        VaultError::ReauthUnavailable {
            message: vault::KEYCHAIN_EXPORT_BLOCKED_MESSAGE.to_string(),
        }
    );
    assert!(vault::KEYCHAIN_EXPORT_BLOCKED_MESSAGE.contains("#3433"));
    // Everything else still backs up.
    let json = build(
        dir.path(),
        &options(&["macros", "settings"], true, false),
        None,
    );
    assert!(restore::open(&json, Some(PASSPHRASE)).is_ok());
}

#[test]
fn master_password_mode_requires_reauth_for_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = mp_manager(dir.path());
    assert!(matches!(
        export::seal_credentials(&mgr, None, PASSPHRASE, &[], "t".into()),
        Err(VaultError::WrongMasterPassword { .. })
    ));
    assert!(export::seal_credentials(&mgr, Some("master-pw"), PASSPHRASE, &[], "t".into()).is_ok());
}

// --- rollback ---

/// A credential store whose batch write always fails.
struct FailingStore;

impl CredentialStore for FailingStore {
    fn get(&self, _: &CredentialKey) -> Result<Option<String>> {
        Ok(None)
    }
    fn set(&self, _: &CredentialKey, _: &str) -> Result<()> {
        anyhow::bail!("disk full")
    }
    fn remove(&self, _: &CredentialKey) -> Result<()> {
        Ok(())
    }
    fn remove_all_for_connection(&self, _: &str) -> Result<()> {
        Ok(())
    }
    fn list_keys(&self) -> Result<Vec<CredentialKey>> {
        Ok(Vec::new())
    }
    fn status(&self) -> CredentialStoreStatus {
        CredentialStoreStatus::Unlocked
    }
    fn set_many(&self, _: &[(CredentialKey, String)]) -> Result<()> {
        anyhow::bail!("disk full")
    }
}

#[test]
fn failed_credential_import_discards_staged_stores() {
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    let json = build(
        src.path(),
        &options(&["macros"], true, true),
        Some(sealed_vault(&[("Local", CRED_SECRET)])),
    );
    let dst = tempfile::tempdir().unwrap();
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let req = BackupRestoreRequest {
        sections: vec![choice(
            "macros",
            RestoreMode::Replace,
            ConflictStrategy::Skip,
        )],
        credentials: Some(ConflictStrategy::Overwrite),
    };
    assert!(restore::apply(&opened, dst.path(), &req, Some(&FailingStore)).is_err());
    assert!(!dst.path().join(STAGING_DIR).exists());
    assert!(!dst.path().join(PENDING_DIR).exists());
    assert!(apply_pending_restore(dst.path()).is_none());
    assert!(!dst.path().join("macros.json").exists());
}

#[test]
fn failed_commit_rolls_credentials_back() {
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    let json = build(
        src.path(),
        &options(&["macros"], true, true),
        Some(sealed_vault(&[
            ("Local", CRED_SECRET),
            ("Other", "new-value"),
        ])),
    );
    let dst = tempfile::tempdir().unwrap();
    let mgr = mp_manager(dst.path());
    let local = CredentialKey::new("Local", CredentialType::Password);
    mgr.set(&local, "previous").unwrap();
    // A file where the pending directory must go makes the commit fail.
    std::fs::write(dst.path().join(PENDING_DIR), "blocker").unwrap();

    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let req = BackupRestoreRequest {
        sections: vec![choice(
            "macros",
            RestoreMode::Replace,
            ConflictStrategy::Skip,
        )],
        credentials: Some(ConflictStrategy::Overwrite),
    };
    assert!(restore::apply(&opened, dst.path(), &req, Some(&mgr)).is_err());
    assert_eq!(mgr.get(&local).unwrap().as_deref(), Some("previous"));
    assert_eq!(
        mgr.get(&CredentialKey::new("Other", CredentialType::Password))
            .unwrap(),
        None
    );
    assert!(!dst.path().join(STAGING_DIR).exists());
}

#[test]
fn failed_startup_swap_rolls_every_file_back() {
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    let json = build(
        src.path(),
        &options(&["connections", "macros"], true, false),
        None,
    );

    let dst = tempfile::tempdir().unwrap();
    let original = at_current("connections.json", json!({"children": [], "agents": []}));
    write_doc(dst.path(), "connections.json", &original);
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let req = request(vec![
        choice("connections", RestoreMode::Replace, ConflictStrategy::Skip),
        choice("macros", RestoreMode::Replace, ConflictStrategy::Skip),
    ]);
    restore::apply(&opened, dst.path(), &req, None).unwrap();

    // macros.json cannot be written: a directory is in the way.
    std::fs::create_dir(dst.path().join("macros.json")).unwrap();
    let warning = apply_pending_restore(dst.path()).expect("the failure is reported");
    assert!(warning.message.contains("previous data was kept"));
    assert_eq!(read_doc(dst.path(), "connections.json"), original);
    assert!(!dst.path().join(PENDING_DIR).exists());
    assert!(!dst.path().join(ROLLBACK_DIR).exists());
}

#[test]
fn interrupted_startup_swap_resumes_from_the_original_snapshot() {
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    let json = build(src.path(), &options(&["macros"], true, false), None);
    let dst = tempfile::tempdir().unwrap();
    write_doc(dst.path(), "macros.json", &macros_doc(&[("old", "Old")]));
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let req = request(vec![choice(
        "macros",
        RestoreMode::Replace,
        ConflictStrategy::Skip,
    )]);
    restore::apply(&opened, dst.path(), &req, None).unwrap();

    // Simulate a crash after the snapshot, mid-swap: a half-written target.
    let rollback = dst.path().join(ROLLBACK_DIR);
    std::fs::create_dir_all(&rollback).unwrap();
    std::fs::copy(dst.path().join("macros.json"), rollback.join("macros.json")).unwrap();
    std::fs::write(
        rollback.join("rollback.json"),
        r#"{"entries":[{"file":"macros.json","existed":true}]}"#,
    )
    .unwrap();
    std::fs::write(dst.path().join("macros.json"), "{ half").unwrap();

    assert!(apply_pending_restore(dst.path()).is_none());
    assert_eq!(
        macro_names(dst.path()),
        pairs(&[("m1", "Deploy"), ("m2", "Logs")])
    );
    assert!(!rollback.exists());
}

#[test]
fn a_manifest_naming_an_unknown_file_is_discarded() {
    let dst = tempfile::tempdir().unwrap();
    let pending = dst.path().join(PENDING_DIR);
    std::fs::create_dir_all(&pending).unwrap();
    std::fs::write(pending.join("evil"), "x").unwrap();
    std::fs::write(
        pending.join(restore::MANIFEST_FILE),
        r#"{"formatVersion":1,"files":["../evil"]}"#,
    )
    .unwrap();
    assert!(apply_pending_restore(dst.path()).is_some());
    assert!(!pending.exists());
    assert!(!dst.path().parent().unwrap().join("evil").exists());
}

#[test]
fn abandoned_staging_is_cleaned_up_at_startup() {
    let dst = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dst.path().join(STAGING_DIR)).unwrap();
    assert!(apply_pending_restore(dst.path()).is_none());
    assert!(!dst.path().join(STAGING_DIR).exists());
}

#[test]
fn every_section_file_is_known_to_the_manifest_validator() {
    for spec in SECTIONS {
        assert_eq!(sections::spec_for_file(spec.file_name).unwrap().id, spec.id);
        assert!(spec.normalize(spec.default_doc()).is_ok(), "{}", spec.id);
    }
}

// --- schedules (PROD-043) ---

#[test]
fn schedules_are_a_backup_section_that_merges_by_id() {
    let src = tempfile::tempdir().unwrap();
    populate(src.path());
    let json = build(src.path(), &options(&["schedules"], true, false), None);

    let dst = tempfile::tempdir().unwrap();
    write_doc(
        dst.path(),
        "schedules.json",
        &json!({"version": "1", "paused": true, "schedules": [schedule_doc("mine", "Local")]}),
    );
    let result = restore_and_boot(
        &json,
        dst.path(),
        &request(vec![choice(
            "schedules",
            RestoreMode::Merge,
            ConflictStrategy::Skip,
        )]),
    );
    assert_eq!(result.sections.len(), 1);
    assert_eq!(result.sections[0].resulting_count, 2);
    let doc = read_doc(dst.path(), "schedules.json");
    // The machine's own pause switch survives a merge.
    assert_eq!(doc["paused"], json!(true));
    let ids: Vec<&str> = doc["schedules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["mine", "sch1"]);
}

#[test]
fn a_newer_schedules_backup_is_refused() {
    let spec = sections::spec("schedules").unwrap();
    let err = spec
        .normalize(json!({"version": "2", "schedules": []}))
        .unwrap_err();
    assert!(matches!(
        err,
        sections::NormalizeError::Newer { found: 2, .. }
    ));
}

// --- section schema versions follow the owning stores ---

/// Guard: every backup section's schema version is the owning store's own
/// `CURRENT_VERSION` and matches what the store's own writer (its default
/// document) stamps. Bumping a store without the backup following — e.g. a new
/// `Default` version string while the constant still says the old one — fails
/// here instead of turning every same-build backup into a "migrated" or
/// refused one.
#[test]
fn every_section_version_is_its_stores_current_version() {
    use crate::connection::config::ConnectionStore;
    use crate::connection::settings::AppSettings;
    use crate::embedded_servers::config::EmbeddedServerStore;
    use crate::macros::config::MacroStore;
    use crate::network::http_monitor_storage::HttpMonitorsFile;
    use crate::network::tool_history::NetworkToolHistoryStore;
    use crate::network::wol_storage::WolDevicesFile;
    use crate::schedules::config::ScheduleStore;
    use crate::tunnel::config::TunnelStore;
    use crate::utils::migrate::{read_version, VersionedStore};
    use crate::workflows::config::WorkflowStore;
    use crate::workspace::config::WorkspaceStore;

    // Each store-backed section reads its store's own constant.
    let store_versions: &[(&str, u32)] = &[
        (
            "connections",
            <ConnectionStore as VersionedStore>::CURRENT_VERSION,
        ),
        ("settings", <AppSettings as VersionedStore>::CURRENT_VERSION),
        (
            "workspaces",
            <WorkspaceStore as VersionedStore>::CURRENT_VERSION,
        ),
        ("macros", MacroStore::CURRENT_VERSION),
        (
            "workflows",
            <WorkflowStore as VersionedStore>::CURRENT_VERSION,
        ),
        (
            "schedules",
            <ScheduleStore as VersionedStore>::CURRENT_VERSION,
        ),
        ("tunnels", TunnelStore::CURRENT_VERSION),
        ("embeddedServers", EmbeddedServerStore::CURRENT_VERSION),
        ("wolDevices", WolDevicesFile::CURRENT_VERSION),
        ("httpMonitors", HttpMonitorsFile::CURRENT_VERSION),
        (
            "networkToolHistory",
            <NetworkToolHistoryStore as VersionedStore>::CURRENT_VERSION,
        ),
    ];
    for (id, store_version) in store_versions {
        let spec = sections::spec(id).unwrap();
        assert_eq!(spec.current_version, *store_version, "{id}");
    }

    // For every section: the store's own writer stamps the section's version,
    // a current document is accepted as-is, and one past it is refused.
    for spec in SECTIONS {
        let id = spec.id;
        let default_doc = spec.default_doc();
        let written = read_version(&default_doc).unwrap_or(1);
        assert_eq!(written, spec.current_version, "{id}: default document");

        let normalized = spec.normalize(default_doc.clone()).unwrap();
        assert_eq!(
            read_version(&normalized).unwrap_or(1),
            spec.current_version,
            "{id}: normalized"
        );

        if default_doc.get("version").is_none() {
            continue; // No in-file version to push past.
        }
        let mut newer = default_doc;
        newer
            .as_object_mut()
            .unwrap()
            .insert("version".into(), json!(newer_than_current(id)));
        assert!(
            matches!(
                spec.normalize(newer),
                Err(sections::NormalizeError::Newer { found, supported })
                    if found == spec.current_version + 1 && supported == spec.current_version
            ),
            "{id}: newer"
        );
    }
}

/// A backup this build writes from the stores' own current documents restores
/// on this build with every section reported as current (not "migrated").
#[test]
fn same_build_backup_of_default_stores_previews_ok() {
    let src = tempfile::tempdir().unwrap();
    for spec in SECTIONS {
        write_doc(src.path(), spec.file_name, &spec.default_doc());
    }
    let ids = all_ids();
    let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    let json = build(src.path(), &options(&ids, true, false), None);
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let dst = tempfile::tempdir().unwrap();
    let preview = restore::plan(&opened, dst.path(), no_creds);
    assert_eq!(preview.sections.len(), SECTIONS.len());
    for section in &preview.sections {
        let spec = sections::spec(&section.id).unwrap();
        assert_eq!(section.status, SectionStatus::Ok, "{}", section.id);
        assert_eq!(
            section.schema_version, spec.current_version,
            "{}",
            section.id
        );
    }
}

fn legacy_v1_workspaces() -> Value {
    json!({"version": "1", "workspaces": [{"id": "w1", "name": "Dev", "tabGroups": []}]})
}

/// A store file the app has not re-saved since an upgrade (still an older
/// schema on disk) is backed up already migrated, so this build restores its
/// own backup as current.
#[test]
fn stale_store_file_is_backed_up_at_the_current_version() {
    let src = tempfile::tempdir().unwrap();
    write_doc(src.path(), "workspaces.json", &legacy_v1_workspaces());
    let json = build(src.path(), &options(&["workspaces"], false, false), None);
    let opened = restore::open(&json, None).unwrap();
    let current = sections::spec("workspaces").unwrap().current_version;
    assert!(current > 1);

    let section = &opened.sections[0];
    assert_eq!(section.schema_version, current);
    assert_eq!(section.data["version"], current.to_string());
    assert_eq!(section.data["workspaces"][0]["name"], "Dev");

    let dst = tempfile::tempdir().unwrap();
    let preview = restore::plan(&opened, dst.path(), no_creds);
    assert_eq!(preview.sections[0].status, SectionStatus::Ok);
}

/// Migration path: a backup carrying a v1 workspace section (written by an
/// older build) still restores on this build, migrated forward.
#[test]
fn v1_workspace_section_restores_migrated() {
    let json = raw_backup(
        vec![BackupSection {
            id: "workspaces".into(),
            schema_version: 1,
            data: legacy_v1_workspaces(),
        }],
        BACKUP_FORMAT_VERSION,
    );
    let dst = tempfile::tempdir().unwrap();
    let opened = restore::open(&json, None).unwrap();
    let preview = restore::plan(&opened, dst.path(), no_creds);
    assert_eq!(preview.sections[0].status, SectionStatus::Migrated);
    assert_eq!(preview.sections[0].new_count, 1);

    let req = request(vec![choice(
        "workspaces",
        RestoreMode::Replace,
        ConflictStrategy::Skip,
    )]);
    restore_and_boot(&json, dst.path(), &req);
    let doc = read_doc(dst.path(), "workspaces.json");
    let current = sections::spec("workspaces").unwrap().current_version;
    assert_eq!(doc["version"], current.to_string());
    assert_eq!(doc["workspaces"][0]["id"], "w1");
    assert_eq!(doc["workspaces"][0]["name"], "Dev");
}

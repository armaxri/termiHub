//! Tests for the SSH / RDP trust-store backup sections (#3515).

use std::path::Path;

use serde_json::{json, Value};

use super::pending::apply_pending_restore;
use super::restore::{self, PENDING_DIR};
use super::*;
use crate::credential::vault::{ConflictStrategy, VaultError};
use crate::session::rdp_trust_store::RdpTrustStore;
use crate::session::ssh_trust_store::{SshTrustStore, TrustLookup};

const PASSPHRASE: &str = "correct horse battery staple";
const SSH_FILE: &str = "ssh_known_hosts.json";
const RDP_FILE: &str = "rdp_known_hosts.json";

fn write_doc(dir: &Path, file: &str, doc: &Value) {
    std::fs::write(dir.join(file), serde_json::to_string_pretty(doc).unwrap()).unwrap();
}

fn read_doc(dir: &Path, file: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir.join(file)).unwrap()).unwrap()
}

fn backup_of(dir: &Path, ids: &[&str], encrypt: bool) -> Result<String, VaultError> {
    export::build(
        dir,
        &BackupExportOptions {
            sections: ids.iter().map(|s| s.to_string()).collect(),
            include_credentials: false,
            encrypt,
        },
        encrypt.then_some(PASSPHRASE),
        None,
        "2026-09-26T00:00:00+00:00".into(),
        "0.0.0-test".into(),
    )
    .map(|b| b.json)
}

fn source_with_ssh(doc: Value) -> (tempfile::TempDir, String) {
    let src = tempfile::tempdir().unwrap();
    write_doc(src.path(), SSH_FILE, &doc);
    let json = backup_of(src.path(), &["sshKnownHosts"], true).unwrap();
    (src, json)
}

fn restore_one(
    json: &str,
    dir: &Path,
    id: &str,
    mode: RestoreMode,
    conflicts: ConflictStrategy,
) -> Result<BackupRestoreResult, VaultError> {
    let opened = restore::open(json, Some(PASSPHRASE))?;
    let request = BackupRestoreRequest {
        sections: vec![SectionRestoreChoice {
            id: id.into(),
            mode,
            conflicts,
        }],
        credentials: None,
    };
    let result = restore::apply(&opened, dir, &request, None)?;
    assert!(apply_pending_restore(dir).is_none());
    Ok(result)
}

fn preview_of(json: &str, dir: &Path, id: &str) -> BackupSectionPreview {
    let opened = restore::open(json, Some(PASSPHRASE)).unwrap();
    restore::plan(&opened, dir, |_| unreachable!("no credentials"))
        .sections
        .into_iter()
        .find(|s| s.id == id)
        .unwrap()
}

#[test]
fn trust_stores_round_trip_and_load_in_the_real_stores() {
    let src = tempfile::tempdir().unwrap();
    write_doc(
        src.path(),
        SSH_FILE,
        &json!({"a.example:22": ["SHA256:A1", "SHA256:A2"]}),
    );
    write_doc(src.path(), RDP_FILE, &json!({"b.example:3389": ["sha256:B1"]}));
    let json = backup_of(src.path(), &["sshKnownHosts", "rdpKnownHosts"], true).unwrap();
    assert!(!json.contains("a.example"), "host leaked into the ciphertext");

    let dst = tempfile::tempdir().unwrap();
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let request = BackupRestoreRequest {
        sections: ["sshKnownHosts", "rdpKnownHosts"]
            .iter()
            .map(|id| SectionRestoreChoice {
                id: (*id).into(),
                mode: RestoreMode::Replace,
                conflicts: ConflictStrategy::Skip,
            })
            .collect(),
        credentials: None,
    };
    restore::apply(&opened, dst.path(), &request, None).unwrap();
    assert!(apply_pending_restore(dst.path()).is_none());

    // The restored files are in the stores' own (unversioned) format.
    let ssh = SshTrustStore::open(dst.path().to_path_buf());
    assert_eq!(ssh.lookup("a.example:22", "SHA256:A2"), TrustLookup::Trusted);
    assert_eq!(ssh.lookup("a.example:22", "SHA256:XX"), TrustLookup::Changed);
    let rdp = RdpTrustStore::open(dst.path().to_path_buf());
    assert!(rdp.entries()["b.example:3389"] == vec!["sha256:B1".to_string()]);
    assert!(read_doc(dst.path(), SSH_FILE).get("version").is_none());
}

#[test]
fn merge_is_a_union_that_keeps_existing_keys_on_conflict() {
    let (_src, json) = source_with_ssh(json!({
        "new.example:22": ["SHA256:N1"],
        "same.example:22": ["SHA256:S1"],
        "changed.example:22": ["SHA256:EVIL"],
        "extra.example:22": ["SHA256:E1", "SHA256:E2"],
    }));
    let dst = tempfile::tempdir().unwrap();
    let current = json!({
        "same.example:22": ["SHA256:S1", "SHA256:S2"],
        "changed.example:22": ["SHA256:GOOD"],
        "extra.example:22": ["SHA256:E1"],
        "mine.example:22": ["SHA256:M1"],
    });
    write_doc(dst.path(), SSH_FILE, &current);

    let preview = preview_of(&json, dst.path(), "sshKnownHosts");
    assert_eq!(preview.status, SectionStatus::Ok);
    assert!(preview.conflicts_keep_existing);
    assert_eq!(
        (
            preview.new_count,
            preview.unchanged_count,
            preview.conflict_count
        ),
        (1, 1, 2)
    );
    let note = preview.notes.join(" ");
    assert!(note.contains("changed.example:22") && note.contains("extra.example:22"));

    // Even "use backup" keeps the keys trusted here: a backup never adds or
    // swaps a key for a known host.
    let result = restore_one(
        &json,
        dst.path(),
        "sshKnownHosts",
        RestoreMode::Merge,
        ConflictStrategy::Overwrite,
    )
    .unwrap();
    assert_eq!(result.sections[0].resulting_count, 5);
    let merged = read_doc(dst.path(), SSH_FILE);
    assert_eq!(merged["changed.example:22"], json!(["SHA256:GOOD"]));
    assert_eq!(merged["extra.example:22"], json!(["SHA256:E1"]));
    assert_eq!(merged["same.example:22"], json!(["SHA256:S1", "SHA256:S2"]));
    assert_eq!(merged["new.example:22"], json!(["SHA256:N1"]));
    assert_eq!(merged["mine.example:22"], json!(["SHA256:M1"]));
}

#[test]
fn replace_adopts_exactly_the_backup_keys() {
    let (_src, json) = source_with_ssh(json!({"changed.example:22": ["SHA256:NEW"]}));
    let dst = tempfile::tempdir().unwrap();
    write_doc(
        dst.path(),
        SSH_FILE,
        &json!({"changed.example:22": ["SHA256:OLD"], "gone.example:22": ["SHA256:G"]}),
    );
    restore_one(
        &json,
        dst.path(),
        "sshKnownHosts",
        RestoreMode::Replace,
        ConflictStrategy::Skip,
    )
    .unwrap();
    assert_eq!(
        read_doc(dst.path(), SSH_FILE),
        json!({"changed.example:22": ["SHA256:NEW"]})
    );
}

#[test]
fn trust_stores_are_never_exported_unencrypted() {
    let src = tempfile::tempdir().unwrap();
    write_doc(src.path(), SSH_FILE, &json!({"a:22": ["SHA256:A"]}));
    let err = backup_of(src.path(), &["sshKnownHosts"], false).unwrap_err();
    assert!(matches!(err, VaultError::WeakPassphrase { ref message } if message.contains("trust")));
    let infos = export::section_infos(src.path());
    let info = infos.iter().find(|i| i.id == "sshKnownHosts").unwrap();
    assert!(info.present && info.requires_encryption && !info.contains_secrets);
    assert_eq!(info.item_count, 1);
}

fn unencrypted_backup(sections: Vec<BackupSection>) -> String {
    let contents = BackupContents {
        format: BACKUP_FORMAT_ID.into(),
        format_version: BACKUP_FORMAT_VERSION,
        created_at: "t".into(),
        sections,
        credentials: None,
    };
    serde_json::to_string(&BackupFile {
        format: BACKUP_FORMAT_ID.into(),
        format_version: BACKUP_FORMAT_VERSION,
        created_at: "t".into(),
        app_version: "v".into(),
        encrypted: false,
        envelope: None,
        contents: Some(contents),
    })
    .unwrap()
}

#[test]
fn a_hand_made_unencrypted_backup_cannot_inject_host_keys() {
    let json = unencrypted_backup(vec![BackupSection {
        id: "sshKnownHosts".into(),
        schema_version: 1,
        data: json!({"bank.example:22": ["SHA256:ATTACKER"]}),
    }]);
    let dst = tempfile::tempdir().unwrap();
    let opened = restore::open(&json, None).unwrap();
    let preview = restore::plan(&opened, dst.path(), |_| unreachable!());
    assert_eq!(preview.sections[0].status, SectionStatus::Invalid);
    assert!(preview.sections[0]
        .message
        .as_deref()
        .unwrap()
        .contains("encrypted backup"));
    let request = BackupRestoreRequest {
        sections: vec![SectionRestoreChoice {
            id: "sshKnownHosts".into(),
            mode: RestoreMode::Merge,
            conflicts: ConflictStrategy::Skip,
        }],
        credentials: None,
    };
    assert!(restore::apply(&opened, dst.path(), &request, None).is_err());
    assert!(!dst.path().join(SSH_FILE).exists());
    assert!(!dst.path().join(PENDING_DIR).exists());
}

/// Wrap sections in an encrypted backup (the only kind trust stores restore from).
fn encrypted_backup(sections: Vec<BackupSection>) -> String {
    let contents = BackupContents {
        format: BACKUP_FORMAT_ID.into(),
        format_version: BACKUP_FORMAT_VERSION,
        created_at: "t".into(),
        sections,
        credentials: None,
    };
    let plaintext = serde_json::to_vec(&contents).unwrap();
    let envelope =
        crate::credential::crypto::encrypt_with_password(PASSPHRASE, &plaintext).unwrap();
    serde_json::to_string(&BackupFile {
        format: BACKUP_FORMAT_ID.into(),
        format_version: BACKUP_FORMAT_VERSION,
        created_at: "t".into(),
        app_version: "v".into(),
        encrypted: true,
        envelope: Some(envelope),
        contents: None,
    })
    .unwrap()
}

#[test]
fn newer_or_malformed_trust_sections_are_refused() {
    let json = encrypted_backup(vec![
        BackupSection {
            id: "sshKnownHosts".into(),
            schema_version: sections::TRUST_STORE_SCHEMA_VERSION + 1,
            data: json!({"a:22": ["SHA256:A"]}),
        },
        BackupSection {
            id: "rdpKnownHosts".into(),
            schema_version: 1,
            data: json!({"a:3389": "not-a-list"}),
        },
    ]);
    let dst = tempfile::tempdir().unwrap();
    assert_eq!(
        preview_of(&json, dst.path(), "sshKnownHosts").status,
        SectionStatus::Newer
    );
    assert_eq!(
        preview_of(&json, dst.path(), "rdpKnownHosts").status,
        SectionStatus::Invalid
    );
    assert!(matches!(
        restore_one(
            &json,
            dst.path(),
            "sshKnownHosts",
            RestoreMode::Replace,
            ConflictStrategy::Skip
        ),
        Err(VaultError::UnsupportedVersion { .. })
    ));
    assert!(restore_one(
        &json,
        dst.path(),
        "rdpKnownHosts",
        RestoreMode::Replace,
        ConflictStrategy::Skip
    )
    .is_err());
    assert!(!dst.path().join(SSH_FILE).exists());
}

#[test]
fn trust_store_section_is_exported_at_schema_version_1_verbatim() {
    let src = tempfile::tempdir().unwrap();
    let doc = json!({"a:22": ["SHA256:A"]});
    write_doc(src.path(), SSH_FILE, &doc);
    let json = backup_of(src.path(), &["sshKnownHosts"], true).unwrap();
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    assert_eq!(opened.sections[0].schema_version, 1);
    assert_eq!(opened.sections[0].data, doc);
}

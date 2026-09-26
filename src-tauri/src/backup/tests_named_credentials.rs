//! Backup and restore of shared named credentials (#3557): the metadata
//! travels in the `namedCredentials` section (no secrets), the secrets in the
//! sealed credentials section, and a restore brings both back so every
//! referencing connection resolves again.

use super::pending::apply_pending_restore;
use super::restore;
use super::tests::{assert_not_on_disk, choice, mp_manager, options, PASSPHRASE};
use super::*;
use crate::credential::named::{owner_id, NamedCredentialKind, NamedCredentialRegistry, FILE_NAME};
use crate::credential::types::{CredentialType, StorageMode};
use crate::credential::vault::ConflictStrategy;

const SHARED_SECRET: &str = "sentinel-shared-credential-8d41";

#[test]
fn named_credentials_round_trip_through_an_encrypted_backup() {
    // Source machine: one shared credential in a master-password store.
    let src = tempfile::tempdir().unwrap();
    let src_mgr = mp_manager(src.path());
    let (src_reg, _) = NamedCredentialRegistry::load(src.path());
    let cred = src_reg
        .create(
            &src_mgr,
            &StorageMode::MasterPassword,
            "Bastion",
            NamedCredentialKind::Password,
            SHARED_SECRET,
        )
        .unwrap();

    // The metadata section alone never needs encryption.
    let info = export::section_infos(src.path())
        .into_iter()
        .find(|i| i.id == "namedCredentials")
        .unwrap();
    assert!(
        info.present && info.item_count == 1 && !info.contains_secrets && !info.requires_encryption
    );

    let owner_ids: Vec<String> = src_reg
        .owner_labels()
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let (sealed, count) = export::seal_credentials(
        &src_mgr,
        Some("master-pw"),
        PASSPHRASE,
        &owner_ids,
        "t".into(),
    )
    .unwrap();
    assert_eq!(count, 1);
    let json = export::build(
        src.path(),
        &options(&["namedCredentials"], true, true),
        Some(PASSPHRASE),
        Some(sealed),
        "t".into(),
        "v".into(),
    )
    .unwrap()
    .json;
    assert!(!json.contains(SHARED_SECRET));

    // The preview labels the credential by its name.
    let opened = restore::open(&json, Some(PASSPHRASE)).unwrap();
    let owners = restore::backup_owner_names(&opened);
    assert_eq!(
        owners.get(&owner_id(&cred.id)).map(String::as_str),
        Some("Bastion (shared credential)")
    );

    // Destination machine: restore both, boot, and resolve.
    let dst = tempfile::tempdir().unwrap();
    let dst_mgr = mp_manager(dst.path());
    let req = BackupRestoreRequest {
        sections: vec![choice(
            "namedCredentials",
            RestoreMode::Replace,
            ConflictStrategy::Skip,
        )],
        credentials: Some(ConflictStrategy::Overwrite),
    };
    restore::apply(&opened, dst.path(), &req, Some(&dst_mgr)).unwrap();
    assert!(apply_pending_restore(dst.path()).is_none());

    let (dst_reg, warnings) = NamedCredentialRegistry::load(dst.path());
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(dst_reg.list(), vec![cred.clone()]);
    assert_eq!(
        dst_reg
            .resolve(&dst_mgr, &cred.id, &CredentialType::Password)
            .unwrap()
            .as_deref(),
        Some(SHARED_SECRET)
    );
    // The secret is only in the encrypted store, never in a plaintext file.
    assert!(dst.path().join(FILE_NAME).exists());
    assert_not_on_disk(dst.path(), SHARED_SECRET);
}

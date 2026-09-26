//! Carrying shared named credentials through the connection export / import
//! (#3564).
//!
//! The connection export (`export_connections_encrypted`) writes the
//! connections with their `credentialRef`s. Without the credentials those
//! references point at, an import on another machine yields connections whose
//! shared credential is missing — the editor shows "Missing shared credential"
//! and connecting prompts. This module adds, next to the existing export
//! document, two top-level fields that older builds simply ignore (unknown
//! fields are skipped by the importer):
//!
//! - [`METADATA_KEY`] — id, name and kind of every named credential the
//!   exported connections / agents reference. Never a secret. Credentials
//!   nothing in the export references are never included.
//! - [`SECRETS_KEY`] — only when an export password is given: the referenced
//!   credentials' secrets, sealed with the same password-based envelope as the
//!   per-connection `$encrypted` section (Argon2id + AES-256-GCM). An export
//!   without a password carries the references only.
//!
//! # Import rules
//!
//! For every credential in [`METADATA_KEY`] that the file references:
//!
//! 1. **Same id exists locally** (the same credential, e.g. re-importing on
//!    the machine that exported it) → the references are kept. The local
//!    secret is **never overwritten**; only a missing local secret is filled
//!    in from the file.
//! 2. **A local credential with the same name and kind holds the identical
//!    secret** → the references are re-pointed at it (no duplicate).
//! 3. Otherwise the credential is **created**, keeping its id (minting a new
//!    one if a different local credential of another kind uses it) and
//!    suffixing its name with `(imported)` on a clash — a local credential is
//!    never silently replaced. Without its secret in the file (no export
//!    password, or the import skipped credentials) it is created without one:
//!    connections using it prompt until the user sets the secret by rotating
//!    it in Settings.
//!
//! When credential storage is off (or no master password is set up), nothing
//! can be created: those references are **dropped** with a warning, so the
//! connections fall back to their own authentication and prompt. A locked
//! master-password store refuses the import instead (unlock and retry), since
//! dropping references there would lose data the user can still keep.
//!
//! Secrets are never logged; only ids, names and counts are.

use std::collections::{BTreeMap, HashMap};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, warn};
use zeroize::{Zeroize, Zeroizing};

use super::{
    ensure_writable, secret_key, NamedCredential, NamedCredentialError, NamedCredentialKind,
    NamedCredentialRegistry, SETTINGS_REF_KEY,
};
use crate::credential::crypto::{decrypt_with_password, encrypt_with_password, EncryptedEnvelope};
use crate::credential::types::StorageMode;
use crate::credential::CredentialStore;

/// Top-level export field listing the referenced credentials' metadata.
pub const METADATA_KEY: &str = "namedCredentials";
/// Top-level export field holding the sealed secrets of those credentials.
pub const SECRETS_KEY: &str = "$namedCredentialSecrets";

/// One referenced named credential in an export file. Contains no secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedNamedCredential {
    pub id: String,
    pub name: String,
    pub kind: NamedCredentialKind,
}

/// The plaintext sealed in [`SECRETS_KEY`]: credential id → secret.
/// Never written to disk in this form; zeroized on drop.
#[derive(Default, Serialize, Deserialize)]
struct SealedSecrets {
    secrets: BTreeMap<String, String>,
}

impl Drop for SealedSecrets {
    fn drop(&mut self) {
        for value in self.secrets.values_mut() {
            value.zeroize();
        }
    }
}

/// Every named-credential id referenced by the connections (at any folder
/// depth) and agents of an export document, in first-seen order.
pub fn referenced_ids(export: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    for_each_ref(export, &mut |r| {
        if let Some(id) = r.as_str().map(str::trim).filter(|s| !s.is_empty()) {
            if !ids.iter().any(|seen| seen == id) {
                ids.push(id.to_string());
            }
        }
    });
    ids
}

/// Visit the `credentialRef` value of every connection and agent in `export`.
fn for_each_ref(export: &Value, visit: &mut dyn FnMut(&Value)) {
    fn walk(nodes: &Value, visit: &mut dyn FnMut(&Value)) {
        for node in nodes.as_array().into_iter().flatten() {
            match node.get("type").and_then(Value::as_str) {
                Some("folder") => walk(&node["children"], visit),
                _ => {
                    if let Some(r) = node.pointer("/config/config/credentialRef") {
                        visit(r);
                    }
                }
            }
        }
    }
    walk(&export["children"], visit);
    for agent in export["agents"].as_array().into_iter().flatten() {
        if let Some(r) = agent.pointer("/config/credentialRef") {
            visit(r);
        }
    }
}

/// Re-point (or drop, for `None`) every reference in `mapping`; references
/// to ids not in `mapping` are left untouched.
fn rewrite_refs(export: &mut Value, mapping: &HashMap<String, Option<String>>) {
    fn rewrite_owner(owner: &mut Value, mapping: &HashMap<String, Option<String>>) {
        let Some(obj) = owner.as_object_mut() else {
            return;
        };
        let Some(id) = obj
            .get(SETTINGS_REF_KEY)
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
        else {
            return;
        };
        match mapping.get(&id) {
            Some(Some(new_id)) => {
                obj.insert(SETTINGS_REF_KEY.to_string(), Value::String(new_id.clone()));
            }
            Some(None) => {
                obj.remove(SETTINGS_REF_KEY);
            }
            None => {}
        }
    }
    fn walk(nodes: &mut Value, mapping: &HashMap<String, Option<String>>) {
        for node in nodes.as_array_mut().into_iter().flatten() {
            if node.get("type").and_then(Value::as_str) == Some("folder") {
                walk(&mut node["children"], mapping);
            } else if let Some(settings) = node.pointer_mut("/config/config") {
                rewrite_owner(settings, mapping);
            }
        }
    }
    walk(&mut export["children"], mapping);
    for agent in export["agents"].as_array_mut().into_iter().flatten() {
        if let Some(config) = agent.get_mut("config") {
            rewrite_owner(config, mapping);
        }
    }
}

/// Add the referenced named credentials to a connection export document.
///
/// `export_json` is the document produced by the connection export. When
/// nothing in it references a named credential, it is returned unchanged.
/// With `password`, the referenced credentials' secrets are sealed into
/// [`SECRETS_KEY`]; without one only their metadata is added.
pub fn add_to_export(
    export_json: &str,
    password: Option<&str>,
    registry: &NamedCredentialRegistry,
    store: &dyn CredentialStore,
) -> Result<String> {
    let mut export: Value =
        serde_json::from_str(export_json).context("Failed to read the connection export")?;
    let credentials: Vec<NamedCredential> = referenced_ids(&export)
        .iter()
        .filter_map(|id| registry.get(id))
        .collect();
    if credentials.is_empty() {
        return Ok(export_json.to_string());
    }

    let metadata: Vec<ExportedNamedCredential> = credentials
        .iter()
        .map(|c| ExportedNamedCredential {
            id: c.id.clone(),
            name: c.name.clone(),
            kind: c.kind,
        })
        .collect();

    let mut sealed_count = 0;
    if let Some(password) = password {
        let mut sealed = SealedSecrets::default();
        for credential in &credentials {
            let secret = store
                .get(&secret_key(&credential.id, credential.kind))
                .with_context(|| {
                    format!(
                        "Could not read the secret of shared credential \"{}\"",
                        credential.name
                    )
                })?;
            if let Some(secret) = secret {
                sealed.secrets.insert(credential.id.clone(), secret);
            }
        }
        if !sealed.secrets.is_empty() {
            sealed_count = sealed.secrets.len();
            let plaintext = Zeroizing::new(
                serde_json::to_vec(&sealed).context("Failed to serialize shared credentials")?,
            );
            let envelope = encrypt_with_password(password, &plaintext)
                .context("Failed to encrypt shared credentials")?;
            export[SECRETS_KEY] =
                serde_json::to_value(envelope).context("Failed to serialize shared credentials")?;
        }
    }
    export[METADATA_KEY] =
        serde_json::to_value(metadata).context("Failed to serialize shared credentials")?;

    info!(
        count = credentials.len(),
        with_secrets = sealed_count,
        "shared credentials added to the connection export"
    );
    serde_json::to_string_pretty(&export).context("Failed to serialize the connection export")
}

/// Whether an export document carries sealed shared-credential secrets.
pub fn has_sealed_secrets(json: &str) -> bool {
    serde_json::from_str::<Value>(json)
        .map(|v| v.get(SECRETS_KEY).is_some_and(|s| !s.is_null()))
        .unwrap_or(false)
}

/// What [`prepare_import`] did before the connections are imported.
#[derive(Debug, Default)]
pub struct PreparedImport {
    /// The import document with its references rewritten.
    pub json: String,
    /// Credentials created by this import (for [`rollback`]).
    pub created: Vec<NamedCredential>,
    /// Credentials created, plus missing local secrets filled in.
    pub imported_count: usize,
    /// Human-readable notes for the import result.
    pub warnings: Vec<String>,
}

/// The decision for one referenced credential of the file.
enum Plan {
    /// Re-point the file's references at a local credential with the same
    /// name, kind and secret.
    Reuse { file_id: String, local_id: String },
    /// Keep the local credential with this id and fill a missing secret.
    Fill(String),
    /// Create the file's credential locally.
    Create(ExportedNamedCredential),
}

/// Decide how one referenced credential of the file maps onto this machine.
fn plan_for(
    entry: ExportedNamedCredential,
    secrets: &BTreeMap<String, String>,
    registry: &NamedCredentialRegistry,
    store: &dyn CredentialStore,
) -> Plan {
    if registry
        .get(&entry.id)
        .is_some_and(|local| local.kind == entry.kind)
    {
        return Plan::Fill(entry.id);
    }
    if let Some(secret) = secrets.get(&entry.id) {
        let name = entry.name.trim().to_lowercase();
        let identical = registry.list().into_iter().find(|local| {
            local.kind == entry.kind
                && local.name.to_lowercase() == name
                && store
                    .get(&secret_key(&local.id, local.kind))
                    .ok()
                    .flatten()
                    .map(Zeroizing::new)
                    .is_some_and(|existing| existing.as_str() == secret)
        });
        if let Some(local) = identical {
            return Plan::Reuse {
                file_id: entry.id,
                local_id: local.id,
            };
        }
    }
    Plan::Create(entry)
}

/// Read the (tolerant) metadata list: malformed entries are skipped.
fn read_metadata(export: &Value) -> Vec<ExportedNamedCredential> {
    let mut list: Vec<ExportedNamedCredential> = Vec::new();
    for item in export[METADATA_KEY].as_array().into_iter().flatten() {
        match serde_json::from_value::<ExportedNamedCredential>(item.clone()) {
            Ok(entry) if !entry.id.trim().is_empty() => {
                if !list.iter().any(|e| e.id == entry.id) {
                    list.push(entry);
                }
            }
            _ => warn!("skipping a malformed shared credential entry in the import file"),
        }
    }
    list
}

/// Recreate or map the shared credentials an import file carries, and
/// rewrite its references accordingly — before the connections themselves
/// are imported. See the module docs for the rules.
///
/// A wrong `password` fails with a [`DecryptError`](crate::credential::crypto::DecryptError)
/// in the error chain before anything is changed.
pub fn prepare_import(
    json: &str,
    password: Option<&str>,
    registry: &NamedCredentialRegistry,
    store: &dyn CredentialStore,
    mode: &StorageMode,
) -> Result<PreparedImport> {
    let mut export: Value = serde_json::from_str(json).context("Failed to parse import data")?;
    let metadata = read_metadata(&export);
    if metadata.is_empty() {
        return Ok(PreparedImport {
            json: json.to_string(),
            ..PreparedImport::default()
        });
    }
    let sealed = open_sealed(&export, password)?;

    // Pass 1: decide, without changing anything.
    let referenced = referenced_ids(&export);
    let plans: Vec<Plan> = metadata
        .into_iter()
        .filter(|entry| referenced.contains(&entry.id))
        .map(|entry| plan_for(entry, &sealed.secrets, registry, store))
        .collect();
    let needs_write = plans.iter().any(|p| match p {
        Plan::Create(_) => true,
        Plan::Fill(id) => sealed.secrets.contains_key(id),
        Plan::Reuse { .. } => false,
    });
    let writable = if needs_write {
        check_writable(store, mode)?
    } else {
        Ok(())
    };

    // Pass 2: apply.
    let mut prepared = PreparedImport::default();
    let mut mapping: HashMap<String, Option<String>> = HashMap::new();
    let apply = Apply {
        registry,
        store,
        mode,
        secrets: &sealed.secrets,
        writable: writable.as_ref().err(),
    };
    for plan in plans {
        let (file_id, target) = apply.run(plan, &mut prepared);
        mapping.insert(file_id, target);
    }

    rewrite_refs(&mut export, &mapping);
    prepared.json = serde_json::to_string(&export).context("Failed to serialize import data")?;
    info!(
        created = prepared.created.len(),
        imported = prepared.imported_count,
        warnings = prepared.warnings.len(),
        "shared credentials prepared for a connection import"
    );
    Ok(prepared)
}

/// Decrypt the sealed secrets, if the file has them and a password is given.
fn open_sealed(export: &Value, password: Option<&str>) -> Result<SealedSecrets> {
    let (Some(envelope), Some(password)) =
        (export.get(SECRETS_KEY).filter(|v| !v.is_null()), password)
    else {
        return Ok(SealedSecrets::default());
    };
    let envelope: EncryptedEnvelope = serde_json::from_value(envelope.clone())
        .context("Invalid shared credential data format")?;
    let plaintext = Zeroizing::new(
        decrypt_with_password(password, &envelope)
            .map_err(anyhow::Error::from)
            .context("Failed to decrypt shared credentials — wrong password?")?,
    );
    serde_json::from_slice::<SealedSecrets>(&plaintext)
        .context("Invalid shared credential data format")
}

/// Whether credentials can be written now. A locked store fails the import
/// (the user can unlock and retry); storage that is off or not set up is
/// returned as the inner error, so the references are dropped instead.
fn check_writable(
    store: &dyn CredentialStore,
    mode: &StorageMode,
) -> Result<Result<(), NamedCredentialError>> {
    match ensure_writable(store, mode) {
        Err(NamedCredentialError::StoreLocked { .. }) => anyhow::bail!(
            "Unlock the credential store before importing connections that use shared \
             credentials."
        ),
        other => Ok(other),
    }
}

/// Executes the [`Plan`]s of one import.
struct Apply<'a> {
    registry: &'a NamedCredentialRegistry,
    store: &'a dyn CredentialStore,
    mode: &'a StorageMode,
    secrets: &'a BTreeMap<String, String>,
    /// Why nothing can be written, if so.
    writable: Option<&'a NamedCredentialError>,
}

impl Apply<'_> {
    /// Apply `plan`; returns the file's credential id and what its references
    /// become (`None` = dropped).
    fn run(&self, plan: Plan, prepared: &mut PreparedImport) -> (String, Option<String>) {
        match plan {
            Plan::Reuse { file_id, local_id } => (file_id, Some(local_id)),
            Plan::Fill(id) => {
                self.fill(&id, prepared);
                (id.clone(), Some(id))
            }
            Plan::Create(entry) => {
                let target = self.create(&entry, prepared);
                (entry.id, target)
            }
        }
    }

    fn fill(&self, id: &str, prepared: &mut PreparedImport) {
        let Some(secret) = self.secrets.get(id).filter(|_| self.writable.is_none()) else {
            return;
        };
        match self
            .registry
            .fill_missing_secret(self.store, self.mode, id, secret)
        {
            Ok(true) => prepared.imported_count += 1,
            Ok(false) => {}
            Err(e) => warn!(id = %id, error = %e, "could not fill a shared credential secret"),
        }
    }

    fn create(
        &self,
        entry: &ExportedNamedCredential,
        prepared: &mut PreparedImport,
    ) -> Option<String> {
        let not_imported = |e: &dyn std::fmt::Display| {
            format!(
                "Shared credential \"{}\" was not imported: {e} Connections that used it will \
                 ask for their secret.",
                entry.name
            )
        };
        if let Some(e) = self.writable {
            prepared.warnings.push(not_imported(e));
            return None;
        }
        let secret = self.secrets.get(&entry.id).map(String::as_str);
        let created = match self.registry.import_credential(
            self.store,
            self.mode,
            &entry.id,
            &entry.name,
            entry.kind,
            secret,
        ) {
            Ok(created) => created,
            Err(e) => {
                prepared.warnings.push(not_imported(&e));
                return None;
            }
        };
        if created.name != entry.name.trim() {
            prepared.warnings.push(format!(
                "Shared credential \"{}\" was imported as \"{}\" because a different credential \
                 already uses that name.",
                entry.name, created.name
            ));
        }
        if secret.is_none() {
            prepared.warnings.push(format!(
                "Shared credential \"{}\" was imported without its secret. Set it under Settings \
                 → Security → Shared credentials; until then, connections using it will ask for \
                 it.",
                created.name
            ));
        }
        prepared.imported_count += 1;
        let id = created.id.clone();
        prepared.created.push(created);
        Some(id)
    }
}

/// Remove the credentials a failed import created, so it leaves nothing
/// behind. Best effort: failures are logged.
pub fn rollback(
    created: &[NamedCredential],
    registry: &NamedCredentialRegistry,
    store: &dyn CredentialStore,
    mode: &StorageMode,
) {
    for credential in created {
        if let Err(e) = registry.delete(store, mode, &credential.id, Vec::new()) {
            warn!(id = %credential.id, error = %e, "failed to roll back an imported shared credential");
        }
    }
}

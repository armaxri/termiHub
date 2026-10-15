//! Saved-connection secrets classified by the settings schema (#4289).
//!
//! Which settings hold a secret is decided by
//! [`termihub_core::connection::secrets`]: a field the connection type's schema
//! declares as [`FieldType::Password`](termihub_core::connection::FieldType),
//! plus the built-in fallback keys and inline jump-host hop passwords. This
//! module looks the schema up for a connection type and keeps those secrets in
//! the credential store.
//!
//! `password` keeps its own credential entries ([`CredentialType::Password`] /
//! [`CredentialType::KeyPassphrase`], with the `savePassword` opt-in and the
//! connect-time prompt). **Every other secret** of a connection — the VNC
//! SSH-gateway `sshPassword`, a plugin's password field, an inline hop's
//! password — lives in one [`CredentialType::FieldSecrets`] entry per
//! connection, a JSON [`TakenSecrets`] object. Because it is an ordinary
//! credential type, it follows the connection through renames, moves between
//! files, deletion and vault export like the password does. It is put back
//! into the settings at connect time ([`restore_saved_field_secrets`]).

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result};
use serde_json::Value;
use termihub_core::connection::secrets::{self, TakenSecrets};
use termihub_core::connection::ConnectionTypeRegistry;
use zeroize::Zeroize;

use crate::credential::{CredentialKey, CredentialStore, CredentialType};

/// The settings key whose secret keeps its own credential entries.
pub(crate) const PASSWORD_KEY: &str = "password";

/// The live connection-type registry (built-in and plugin types), installed
/// at startup so plugin-declared secrets are classified too.
static TYPE_REGISTRY: OnceLock<Arc<Mutex<ConnectionTypeRegistry>>> = OnceLock::new();

/// Install the live connection-type registry used to classify secrets. Only
/// the first call takes effect.
pub fn install_type_registry(registry: Arc<Mutex<ConnectionTypeRegistry>>) {
    let _ = TYPE_REGISTRY.set(registry);
}

/// Schema secret keys of every built-in desktop connection type.
fn builtin_secret_keys() -> &'static HashMap<String, Vec<String>> {
    static KEYS: OnceLock<HashMap<String, Vec<String>>> = OnceLock::new();
    KEYS.get_or_init(|| {
        crate::session::registry::build_desktop_registry()
            .available_types()
            .into_iter()
            .map(|info| (info.type_id, secrets::schema_secret_keys(&info.schema)))
            .collect()
    })
}

/// The secret keys the schema of `type_id` declares, from `registry`.
pub(crate) fn schema_keys_in(
    registry: &ConnectionTypeRegistry,
    type_id: &str,
) -> Option<Vec<String>> {
    registry
        .type_info(type_id)
        .map(|info| secrets::schema_secret_keys(&info.schema))
}

/// Every secret settings key of a connection of type `type_id`: its schema's
/// secret fields (from the live registry, else the built-in types) plus the
/// fallback keys. An unknown type (e.g. an uninstalled plugin) gets only the
/// fallback keys.
pub fn secret_keys_for(type_id: &str) -> Vec<String> {
    with_fallback(schema_secret_keys_for(type_id))
}

/// The secret keys the schema of `type_id` declares (from the live registry,
/// else the built-in types), without the fallback keys. Empty for an unknown
/// type.
fn schema_secret_keys_for(type_id: &str) -> Vec<String> {
    let from_live = TYPE_REGISTRY.get().and_then(|registry| {
        let registry = registry.lock().unwrap_or_else(|e| e.into_inner());
        schema_keys_in(&registry, type_id)
    });
    from_live
        .or_else(|| builtin_secret_keys().get(type_id).cloned())
        .unwrap_or_default()
}

/// Whether a saved connection of type `type_id` with (stripped) `settings` may
/// own a field-secrets entry: its schema declares a secret other than
/// `password`, it has an inline jump-host hop, or it still carries a
/// fallback secret key. Lets callers skip the credential store (which may be
/// locked) for connections that cannot have one, e.g. a local shell.
pub(crate) fn may_have_field_secrets(type_id: &str, settings: &Value) -> bool {
    let schema_has_extra = schema_secret_keys_for(type_id)
        .iter()
        .any(|k| k != PASSWORD_KEY);
    let has_inline_hop = secrets::JUMP_HOST_LIST_KEYS
        .iter()
        .filter_map(|k| settings.get(*k).and_then(Value::as_array))
        .flatten()
        .any(|hop| secrets::hop_identity(hop).is_some());
    schema_has_extra
        || has_inline_hop
        || secrets::has_secrets(&field_secret_keys(&with_fallback(Vec::new())), settings)
}

/// `keys` plus the fallback keys, without duplicates.
pub(crate) fn with_fallback(mut keys: Vec<String>) -> Vec<String> {
    for key in secrets::FALLBACK_SECRET_KEYS {
        if !keys.iter().any(|k| k == key) {
            keys.push((*key).to_string());
        }
    }
    keys
}

/// The secret keys other than [`PASSWORD_KEY`], which has its own entries.
pub(crate) fn field_secret_keys(keys: &[String]) -> Vec<String> {
    keys.iter()
        .filter(|k| *k != PASSWORD_KEY)
        .cloned()
        .collect()
}

/// Whether `settings` of a connection of type `type_id` hold a plaintext
/// secret that belongs in a [`CredentialType::FieldSecrets`] entry.
pub(crate) fn has_plaintext_field_secrets(type_id: &str, settings: &Value) -> bool {
    secrets::has_secrets(&field_secret_keys(&secret_keys_for(type_id)), settings)
}

/// The key of the field-secrets entry of credential owner `owner`.
pub(crate) fn field_secrets_key(owner: &str) -> CredentialKey {
    CredentialKey::new(owner, CredentialType::FieldSecrets)
}

/// Read the field secrets stored for `owner` (empty when there are none).
pub(crate) fn read_field_secrets(store: &dyn CredentialStore, owner: &str) -> Result<TakenSecrets> {
    let key = field_secrets_key(owner);
    let Some(mut raw) = store
        .get(&key)
        .with_context(|| format!("Failed to read credential {key}"))?
    else {
        return Ok(TakenSecrets::default());
    };
    let parsed =
        serde_json::from_str(&raw).with_context(|| format!("Credential {key} is malformed"));
    raw.zeroize();
    parsed
}

/// The serialized entry for `owner` holding its stored field secrets with
/// `newer` merged over them — for a write the caller makes (alone or in a
/// batch). `newer` is zeroized.
///
/// With `keep_hops`, only the hop secrets whose identity is in it are kept:
/// a stored hop secret whose hop no longer exists is dropped (#4792).
pub(crate) fn merged_entry(
    store: &dyn CredentialStore,
    owner: &str,
    mut newer: TakenSecrets,
    keep_hops: Option<&BTreeSet<String>>,
) -> Result<(CredentialKey, String)> {
    let mut merged = read_field_secrets(store, owner)?;
    merged.merge(std::mem::take(&mut newer));
    if let Some(keep) = keep_hops {
        retain_hops(&mut merged, keep);
    }
    let value = serde_json::to_string(&merged).context("Failed to serialize field secrets");
    zeroize_secrets(&mut merged);
    Ok((field_secrets_key(owner), value?))
}

/// Store `newer` for `owner`, merged over the field secrets already stored.
pub(crate) fn store_field_secrets(
    store: &dyn CredentialStore,
    owner: &str,
    newer: TakenSecrets,
) -> Result<()> {
    let (key, mut value) = merged_entry(store, owner, newer, None)?;
    let written = store.set(&key, &value);
    value.zeroize();
    written.with_context(|| format!("Failed to store credential {key}"))
}

/// The names of the field secrets stored for a connection — never their
/// values — so the connection editor can show which are saved (#4431).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredFieldSecretKeys {
    /// Settings keys of the stored top-level secret fields, sorted.
    pub fields: Vec<String>,
    /// Identities (`user@host:port`) of the inline hops with a stored secret, sorted.
    pub hops: Vec<String>,
}

/// The names of the field secrets stored for `owner` (empty when there are
/// none). The values are read only to be zeroized.
pub(crate) fn stored_field_secret_keys(
    store: &dyn CredentialStore,
    owner: &str,
) -> Result<StoredFieldSecretKeys> {
    let mut stored = read_field_secrets(store, owner)?;
    let keys = StoredFieldSecretKeys {
        fields: stored.fields.keys().cloned().collect(),
        hops: stored.hops.keys().cloned().collect(),
    };
    zeroize_secrets(&mut stored);
    Ok(keys)
}

/// Remove exactly the named field and hop secrets from the entry of `owner`,
/// keeping every other one. The entry is deleted once it is empty; a name that
/// is not stored is ignored, and nothing is written when none of them is.
pub(crate) fn remove_field_secrets(
    store: &dyn CredentialStore,
    owner: &str,
    fields: &[String],
    hops: &[String],
) -> Result<()> {
    let mut stored = read_field_secrets(store, owner)?;
    let mut removed = false;
    for key in fields {
        if let Some(mut value) = stored.fields.remove(key) {
            value.zeroize();
            removed = true;
        }
    }
    for identity in hops {
        if let Some(mut value) = stored.hops.remove(identity) {
            value.zeroize();
            removed = true;
        }
    }
    if !removed {
        zeroize_secrets(&mut stored);
        return Ok(());
    }
    let key = field_secrets_key(owner);
    if stored.is_empty() {
        return store
            .remove(&key)
            .with_context(|| format!("Failed to remove credential {key}"));
    }
    let value = serde_json::to_string(&stored).context("Failed to serialize field secrets");
    zeroize_secrets(&mut stored);
    let mut value = value?;
    let written = store.set(&key, &value);
    value.zeroize();
    written.with_context(|| format!("Failed to store credential {key}"))
}

/// Drop (zeroized) every hop secret of `taken` whose identity is not in `keep`.
fn retain_hops(taken: &mut TakenSecrets, keep: &BTreeSet<String>) {
    taken.hops.retain(|identity, value| {
        let kept = keep.contains(identity);
        if !kept {
            value.zeroize();
        }
        kept
    });
}

/// Remove the hop secrets stored for `owner` whose identity matches no inline
/// jump-host hop of `settings` — the connection as saved (#4792). A removed
/// or re-addressed hop (host, username or port edited) leaves its secret under
/// an identity nothing reads again. Top-level field secrets are never touched,
/// and a hop that is still present (reordered or duplicated) keeps its secret.
/// Returns the identities removed (empty when nothing was orphaned, in which
/// case nothing is written).
pub(crate) fn prune_orphan_hop_secrets(
    store: &dyn CredentialStore,
    owner: &str,
    settings: &Value,
) -> Result<Vec<String>> {
    let keep = secrets::hop_identities(settings);
    let orphans: Vec<String> = stored_field_secret_keys(store, owner)?
        .hops
        .into_iter()
        .filter(|identity| !keep.contains(identity))
        .collect();
    if !orphans.is_empty() {
        remove_field_secrets(store, owner, &[], &orphans)?;
    }
    Ok(orphans)
}

/// Overwrite every secret in `taken` with zeros and empty it.
pub(crate) fn zeroize_secrets(taken: &mut TakenSecrets) {
    for value in taken.fields.values_mut().chain(taken.hops.values_mut()) {
        value.zeroize();
    }
    taken.fields.clear();
    taken.hops.clear();
}

/// Put the field secrets stored for `owner` back into `settings` for a
/// connect, where the settings do not carry them already.
pub(crate) fn restore_saved_field_secrets(
    store: &dyn CredentialStore,
    owner: &str,
    settings: &mut Value,
) -> Result<()> {
    let mut stored = read_field_secrets(store, owner)?;
    secrets::restore_secrets(settings, &stored);
    zeroize_secrets(&mut stored);
    Ok(())
}

/// Put the hop secrets stored for `owner` back into `hops` (a referenced
/// connection's own jump-host chain, being expanded for a connect).
pub(crate) fn restore_saved_hop_secrets(
    store: &dyn CredentialStore,
    owner: &str,
    hops: &mut Vec<Value>,
) -> Result<()> {
    if !hops.iter().any(|hop| secrets::hop_identity(hop).is_some()) {
        return Ok(());
    }
    let mut wrapper = serde_json::json!({ secrets::JUMP_HOST_LIST_KEYS[0]: std::mem::take(hops) });
    let restored = restore_saved_field_secrets(store, owner, &mut wrapper);
    if let Some(Value::Array(back)) = wrapper
        .as_object_mut()
        .and_then(|m| m.remove(secrets::JUMP_HOST_LIST_KEYS[0]))
    {
        *hops = back;
    }
    restored
}

/// A copy of `settings` of a connection of type `type_id` with every secret
/// removed, `password` included — for exports and backups.
pub fn without_secrets(type_id: &str, settings: &Value) -> Value {
    secrets::without_secrets(&secret_keys_for(type_id), settings)
}

#[cfg(test)]
#[path = "secret_fields_tests.rs"]
mod tests;

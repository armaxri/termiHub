//! Which connection settings hold a secret — classified from the schema (#4289).
//!
//! A connection type declares a secret by giving the field
//! [`FieldType::Password`] in its [`SettingsSchema`]; plugin connection types
//! get it from a `format: "password"` (or `writeOnly: true`) property. That
//! declaration is the **single source of truth** for every place that must keep
//! a secret out of plaintext: the desktop's save path (which routes secrets to
//! the credential store), connection exports, backups and log redaction.
//!
//! Callers without a schema (an unknown or uninstalled connection type, a raw
//! settings bag) fall back to [`FALLBACK_SECRET_KEYS`], which lists the keys
//! the built-in types use. Classification always includes the fallback keys,
//! so a schema can only add secrets, never remove one.
//!
//! Jump-host hops (`proxyJump`, or its legacy alias `jumpHosts`) are a
//! connection-editor structure rather than schema fields; each inline hop's
//! `password` (an SSH password or key passphrase) is a secret too, addressed by
//! the hop's identity (see [`hop_identity`]) so that reordering hops keeps each
//! secret with its hop.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::schema::{FieldType, SettingsField, SettingsSchema};

/// Secret settings keys used by the built-in connection types, for callers
/// that have no schema: the SSH/Telnet/FTP/VNC/RDP `password` (which also holds
/// an SSH key passphrase for key auth) and the VNC SSH-gateway `sshPassword`.
pub const FALLBACK_SECRET_KEYS: &[&str] = &["password", "sshPassword"];

/// Settings keys holding a jump-host chain, whose inline hops carry their own
/// [`HOP_SECRET_KEY`].
pub const JUMP_HOST_LIST_KEYS: &[&str] = &["proxyJump", "jumpHosts"];

/// The secret key of an inline jump-host hop.
pub const HOP_SECRET_KEY: &str = "password";

/// Whether `field` holds a secret.
pub fn is_secret_field(field: &SettingsField) -> bool {
    matches!(field.field_type, FieldType::Password)
}

/// The keys of every secret field `schema` declares, in schema order, without
/// duplicates. Only top-level settings keys are returned.
pub fn schema_secret_keys(schema: &SettingsSchema) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for field in schema.groups.iter().flat_map(|g| g.fields.iter()) {
        if is_secret_field(field) && !keys.contains(&field.key) {
            keys.push(field.key.clone());
        }
    }
    keys
}

/// The secret keys of a connection whose schema is `schema` (when known): the
/// schema's own secret keys plus [`FALLBACK_SECRET_KEYS`].
pub fn secret_keys(schema: Option<&SettingsSchema>) -> Vec<String> {
    let mut keys = schema.map(schema_secret_keys).unwrap_or_default();
    for key in FALLBACK_SECRET_KEYS {
        if !keys.iter().any(|k| k == key) {
            keys.push((*key).to_string());
        }
    }
    keys
}

/// The identity of an inline jump-host hop, `user@host:port` (port 22 when
/// unset), used to keep a hop's secret with that hop when hops are reordered.
/// `None` for a hop that references a saved connection (its secret lives with
/// that connection) or has no host.
pub fn hop_identity(hop: &Value) -> Option<String> {
    let has_reference = hop
        .get("connectionId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty());
    if has_reference {
        return None;
    }
    let host = hop
        .get("host")
        .and_then(Value::as_str)
        .filter(|h| !h.is_empty())?;
    let port = hop.get("port").and_then(Value::as_u64).unwrap_or(22);
    let user = hop.get("username").and_then(Value::as_str).unwrap_or("");
    Some(format!("{user}@{host}:{port}"))
}

/// Secrets taken out of a settings bag by [`take_secrets`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakenSecrets {
    /// Top-level secret fields, by settings key.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
    /// Inline jump-host hop secrets, by [`hop_identity`].
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub hops: BTreeMap<String, String>,
}

impl TakenSecrets {
    /// Whether no secret was taken.
    pub fn is_empty(&self) -> bool {
        self.fields.is_empty() && self.hops.is_empty()
    }

    /// Add every secret of `newer` to `self`, replacing a secret of the same
    /// field or hop.
    pub fn merge(&mut self, newer: TakenSecrets) {
        self.fields.extend(newer.fields);
        self.hops.extend(newer.hops);
    }
}

/// A non-empty string value, the only kind of secret worth keeping.
fn non_empty(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

/// The inline hops of the jump-host chains in `settings`.
fn hops_mut(settings: &mut Value) -> impl Iterator<Item = &mut Value> {
    let map = settings.as_object_mut();
    map.into_iter().flat_map(|map| {
        map.iter_mut()
            .filter(|(k, _)| JUMP_HOST_LIST_KEYS.contains(&k.as_str()))
            .filter_map(|(_, v)| v.as_array_mut())
            .flat_map(|hops| hops.iter_mut())
    })
}

/// Whether `settings` holds any secret under `keys` or on a jump-host hop — of
/// any value, so even an empty or `null` secret field counts.
pub fn has_secrets(keys: &[String], settings: &Value) -> bool {
    let Some(map) = settings.as_object() else {
        return false;
    };
    let in_fields = keys.iter().any(|k| map.contains_key(k));
    let in_hops = JUMP_HOST_LIST_KEYS
        .iter()
        .filter_map(|k| map.get(*k).and_then(Value::as_array))
        .flatten()
        .any(|hop| hop.get(HOP_SECRET_KEY).is_some());
    in_fields || in_hops
}

/// Remove every secret from `settings`: each key in `keys` and each jump-host
/// hop's [`HOP_SECRET_KEY`], whatever its value. Returns the non-empty string
/// secrets removed (an empty one means "unchanged" and is not returned).
pub fn take_secrets(keys: &[String], settings: &mut Value) -> TakenSecrets {
    let mut taken = TakenSecrets::default();
    if let Some(map) = settings.as_object_mut() {
        for key in keys {
            if let Some(value) = map.remove(key) {
                if let Some(secret) = non_empty(&value) {
                    taken.fields.insert(key.clone(), secret);
                }
            }
        }
    }
    for hop in hops_mut(settings) {
        let identity = hop_identity(hop);
        let Some(obj) = hop.as_object_mut() else {
            continue;
        };
        if let Some(value) = obj.remove(HOP_SECRET_KEY) {
            if let (Some(identity), Some(secret)) = (identity, non_empty(&value)) {
                taken.hops.insert(identity, secret);
            }
        }
    }
    taken
}

/// Put `secrets` back into `settings` for a connect: each field or hop secret
/// goes where it is missing or empty. A value the settings already carry (e.g.
/// typed for this connect) wins. Hops are matched by [`hop_identity`].
pub fn restore_secrets(settings: &mut Value, secrets: &TakenSecrets) {
    let missing = |v: Option<&Value>| v.and_then(non_empty).is_none();
    if let Some(map) = settings.as_object_mut() {
        for (key, secret) in &secrets.fields {
            if missing(map.get(key)) {
                map.insert(key.clone(), Value::String(secret.clone()));
            }
        }
    }
    for hop in hops_mut(settings) {
        let Some(secret) = hop_identity(hop).and_then(|id| secrets.hops.get(&id)) else {
            continue;
        };
        if let Some(obj) = hop.as_object_mut() {
            if missing(obj.get(HOP_SECRET_KEY)) {
                obj.insert(HOP_SECRET_KEY.to_string(), Value::String(secret.clone()));
            }
        }
    }
}

/// A copy of `settings` with every secret removed (see [`take_secrets`]), for
/// exports and logs.
pub fn without_secrets(keys: &[String], settings: &Value) -> Value {
    let mut copy = settings.clone();
    take_secrets(keys, &mut copy);
    copy
}

#[cfg(test)]
#[path = "secrets_tests.rs"]
mod tests;

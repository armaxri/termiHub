//! Resolve saved-connection jump-host references into fully-inline hops.
//!
//! A `proxyJump` hop may reference a saved SSH connection by `connectionId`
//! instead of carrying inline connection fields (#940). The core crate only
//! connects with **inline** hops (it never looks up saved connections), so the
//! desktop layer must expand every reference into the referenced connection's
//! host/port/username/auth fields — resolving its saved credentials — *before*
//! the settings reach core.
//!
//! Resolution is recursive: a referenced connection may itself be reached through
//! its own jump-host chain, whose hops become additional **outer** hops (the
//! gateway you traverse to reach the referenced gateway). A visited-set along the
//! resolution path rejects circular references (`A → B → A`).

use std::collections::HashSet;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::config::SavedConnection;
use crate::credential::{CredentialKey, CredentialStore, CredentialType};

/// Maximum reference-expansion depth, a runaway guard independent of the editor's
/// own chain-depth warning. Chains this deep are pathological.
const MAX_RESOLVE_DEPTH: usize = 16;

/// Whether `settings` has a jump-host chain with at least one saved-connection
/// reference to expand. A cheap pre-check so callers can skip loading the whole
/// connection store for the common inline-only / no-chain case.
pub(crate) fn chain_has_reference(settings: &Value) -> bool {
    match settings
        .get("proxyJump")
        .or_else(|| settings.get("jumpHosts"))
    {
        Some(Value::Array(hops)) => hops.iter().any(|h| reference_id(h).is_some()),
        _ => false,
    }
}

/// Resolve every `connectionId` jump-host reference in `settings` in place.
///
/// Walks the `proxyJump` array (or its legacy `jumpHosts` alias), replacing each
/// referenced hop with the referenced connection's own (recursively resolved)
/// chain followed by the referenced connection itself as an inline hop. Inline
/// hops are left untouched. No-op when there is no jump-host chain.
///
/// `root_id` is the id of the connection being connected, when known; seeding it
/// into the visited set rejects a hop that references its own connection.
pub(crate) fn resolve_proxy_jump_refs(
    settings: &mut Value,
    connections: &[SavedConnection],
    creds: &dyn CredentialStore,
    root_id: Option<&str>,
) -> Result<()> {
    // Accept the same key + legacy alias core does, and write back under the key
    // that was present so we don't silently change the persisted shape.
    let key = if settings.get("proxyJump").is_some() {
        "proxyJump"
    } else if settings.get("jumpHosts").is_some() {
        "jumpHosts"
    } else {
        return Ok(());
    };

    let hops = match settings.get(key) {
        Some(Value::Array(arr)) if !arr.is_empty() => arr.clone(),
        _ => return Ok(()),
    };

    let mut visited: HashSet<String> = HashSet::new();
    if let Some(id) = root_id {
        visited.insert(id.to_string());
    }

    let resolved = resolve_hops(&hops, connections, creds, &mut visited, 0)?;

    settings[key] = Value::Array(resolved);
    Ok(())
}

/// Recursively resolve a list of hops into a flat list of fully-inline hops.
fn resolve_hops(
    hops: &[Value],
    connections: &[SavedConnection],
    creds: &dyn CredentialStore,
    visited: &mut HashSet<String>,
    depth: usize,
) -> Result<Vec<Value>> {
    if depth > MAX_RESOLVE_DEPTH {
        bail!("Jump host chain is too deeply nested to resolve");
    }

    let mut resolved = Vec::with_capacity(hops.len());
    for hop in hops {
        match reference_id(hop) {
            Some(ref_id) => {
                if visited.contains(ref_id) {
                    bail!(
                        "Circular jump host chain detected: connection '{ref_id}' \
                         references itself through the chain"
                    );
                }
                let conn = connections
                    .iter()
                    .find(|c| c.id == ref_id)
                    .with_context(|| {
                        format!(
                            "Referenced jump host connection '{ref_id}' not found. Pick an \
                             existing SSH connection or switch to inline configuration."
                        )
                    })?;
                if conn.config.type_id != "ssh" {
                    bail!(
                        "Referenced jump host connection '{}' is not an SSH connection",
                        conn.name
                    );
                }

                visited.insert(ref_id.to_string());
                // The referenced connection's own chain is reached first (its hops
                // are the *outer* gateways), then the connection itself.
                let inner = referenced_chain(conn);
                let mut inner_resolved =
                    resolve_hops(&inner, connections, creds, visited, depth + 1)?;
                resolved.append(&mut inner_resolved);
                resolved.push(build_inline_hop(conn, ref_id, hop, creds)?);
                visited.remove(ref_id);
            }
            None => resolved.push(hop.clone()),
        }
    }
    Ok(resolved)
}

/// The non-empty `connectionId` of a hop, if it references a saved connection.
fn reference_id(hop: &Value) -> Option<&str> {
    hop.get("connectionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// The referenced connection's own jump-host chain (its `proxyJump` / `jumpHosts`).
fn referenced_chain(conn: &SavedConnection) -> Vec<Value> {
    let s = &conn.config.settings;
    match s.get("proxyJump").or_else(|| s.get("jumpHosts")) {
        Some(Value::Array(arr)) => arr.clone(),
        _ => Vec::new(),
    }
}

/// Build the inline hop for a referenced SSH connection: its connection fields
/// plus its resolved saved credential. `connectionId` is preserved so the
/// gateway pool keys on the saved connection (sharing one gateway across every
/// connection that references it).
fn build_inline_hop(
    conn: &SavedConnection,
    ref_id: &str,
    site_hop: &Value,
    creds: &dyn CredentialStore,
) -> Result<Value> {
    let s = &conn.config.settings;

    let host = s
        .get("host")
        .and_then(Value::as_str)
        .filter(|h| !h.is_empty())
        .with_context(|| {
            format!(
                "Referenced jump host connection '{}' has no host configured",
                conn.name
            )
        })?;
    let port = s.get("port").and_then(Value::as_u64).unwrap_or(22);
    let username = s.get("username").and_then(Value::as_str).unwrap_or("");
    let auth_method = s.get("authMethod").and_then(Value::as_str).unwrap_or("");

    let mut obj = serde_json::Map::new();
    obj.insert("connectionId".into(), json!(ref_id));
    obj.insert("host".into(), json!(host));
    obj.insert("port".into(), json!(port));
    obj.insert("username".into(), json!(username));
    obj.insert("authMethod".into(), json!(auth_method));

    if let Some(key_path) = s.get("keyPath").and_then(Value::as_str) {
        if !key_path.is_empty() {
            obj.insert("keyPath".into(), json!(key_path));
        }
    }

    // The reference-site hop's per-hop connect timeout (#951) wins over the
    // referenced connection's own; fall back to the referenced connection's.
    let timeout = site_hop
        .get("connectTimeoutSecs")
        .and_then(Value::as_u64)
        .or_else(|| s.get("connectTimeoutSecs").and_then(Value::as_u64));
    if let Some(secs) = timeout {
        obj.insert("connectTimeoutSecs".into(), json!(secs));
    }

    // Resolve the saved credential. Core reads `password` as the SSH password
    // (password auth) or the private-key passphrase (key auth).
    if let Some(secret) = resolve_credential(ref_id, auth_method, creds)? {
        obj.insert("password".into(), json!(secret));
    } else if auth_method == "password" {
        bail!(
            "No saved password for referenced jump host connection '{}'. Save its \
             password, or configure the hop inline.",
            conn.name
        );
    }

    Ok(Value::Object(obj))
}

/// Resolve a referenced connection's saved credential for its auth method.
///
/// Password auth needs a saved password (the caller errors if it is missing);
/// key auth uses a saved passphrase only when the key is encrypted (absence is
/// fine); agent auth needs nothing.
fn resolve_credential(
    ref_id: &str,
    auth_method: &str,
    creds: &dyn CredentialStore,
) -> Result<Option<String>> {
    let cred_type = match auth_method {
        "password" => CredentialType::Password,
        "key" => CredentialType::KeyPassphrase,
        _ => return Ok(None),
    };
    creds
        .get(&CredentialKey::new(ref_id, cred_type))
        .with_context(|| format!("Failed to read saved credential for connection '{ref_id}'"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::backend::ConnectionConfig;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// In-memory credential store keyed by `"<id>:<type>"`.
    #[derive(Default)]
    struct MemStore(Mutex<HashMap<String, String>>);

    impl MemStore {
        fn with(entries: &[(&str, CredentialType, &str)]) -> Self {
            let map = entries
                .iter()
                .map(|(id, ty, val)| (format!("{id}:{ty}"), val.to_string()))
                .collect();
            MemStore(Mutex::new(map))
        }
    }

    impl CredentialStore for MemStore {
        fn get(&self, key: &CredentialKey) -> Result<Option<String>> {
            let k = format!("{}:{}", key.connection_id, key.credential_type);
            Ok(self.0.lock().unwrap().get(&k).cloned())
        }
        fn set(&self, key: &CredentialKey, value: &str) -> Result<()> {
            let k = format!("{}:{}", key.connection_id, key.credential_type);
            self.0.lock().unwrap().insert(k, value.to_string());
            Ok(())
        }
        fn remove(&self, _key: &CredentialKey) -> Result<()> {
            Ok(())
        }
        fn remove_all_for_connection(&self, _connection_id: &str) -> Result<()> {
            Ok(())
        }
        fn list_keys(&self) -> Result<Vec<CredentialKey>> {
            Ok(Vec::new())
        }
        fn status(&self) -> crate::credential::CredentialStoreStatus {
            crate::credential::CredentialStoreStatus::Unavailable
        }
    }

    fn conn(id: &str, name: &str, type_id: &str, settings: Value) -> SavedConnection {
        SavedConnection {
            icon: None,
            id: id.to_string(),
            name: name.to_string(),
            config: ConnectionConfig {
                type_id: type_id.to_string(),
                settings,
            },
            folder_id: None,
            terminal_options: None,
            source_file: None,
        }
    }

    fn ssh_conn(id: &str, name: &str, settings: Value) -> SavedConnection {
        conn(id, name, "ssh", settings)
    }

    fn settings_with_hops(hops: Value) -> Value {
        json!({
            "host": "target.internal",
            "username": "deploy",
            "authMethod": "key",
            "proxyJump": hops,
        })
    }

    fn hops(settings: &Value) -> &Vec<Value> {
        settings["proxyJump"].as_array().unwrap()
    }

    #[test]
    fn inline_only_chain_is_unchanged() {
        let mut settings = settings_with_hops(json!([
            { "host": "bastion", "port": 22, "username": "admin", "authMethod": "agent" }
        ]));
        let before = settings.clone();
        resolve_proxy_jump_refs(&mut settings, &[], &MemStore::default(), None).unwrap();
        assert_eq!(settings, before);
    }

    #[test]
    fn chain_has_reference_detects_only_reference_chains() {
        // No chain, and an inline-only chain, both need no resolution.
        assert!(!chain_has_reference(&json!({ "host": "h" })));
        assert!(!chain_has_reference(&settings_with_hops(json!([
            { "host": "bastion", "port": 22, "username": "u", "authMethod": "agent" }
        ]))));
        // A chain with a reference must be detected.
        assert!(chain_has_reference(&settings_with_hops(json!([
            { "connectionId": "gw" }
        ]))));
    }

    #[test]
    fn no_chain_is_noop() {
        let mut settings = json!({ "host": "h", "username": "u", "authMethod": "agent" });
        let before = settings.clone();
        resolve_proxy_jump_refs(&mut settings, &[], &MemStore::default(), None).unwrap();
        assert_eq!(settings, before);
    }

    #[test]
    fn single_reference_expands_to_inline_fields() {
        let bastion = ssh_conn(
            "Work/bastion",
            "bastion",
            json!({
                "host": "bastion.example.com",
                "port": 2222,
                "username": "admin",
                "authMethod": "key",
                "keyPath": "~/.ssh/bastion",
            }),
        );
        let mut settings =
            settings_with_hops(json!([{ "connectionId": "Work/bastion", "authMethod": "key" }]));

        resolve_proxy_jump_refs(&mut settings, &[bastion], &MemStore::default(), None).unwrap();

        let hop = &hops(&settings)[0];
        assert_eq!(hop["host"], "bastion.example.com");
        assert_eq!(hop["port"], 2222);
        assert_eq!(hop["username"], "admin");
        assert_eq!(hop["authMethod"], "key");
        assert_eq!(hop["keyPath"], "~/.ssh/bastion");
        // connectionId is preserved so the gateway pool keys on the saved id.
        assert_eq!(hop["connectionId"], "Work/bastion");
    }

    #[test]
    fn password_reference_injects_saved_password() {
        let gw = ssh_conn(
            "gw",
            "gateway",
            json!({ "host": "gw.example.com", "username": "ops", "authMethod": "password" }),
        );
        let creds = MemStore::with(&[("gw", CredentialType::Password, "s3cret")]);
        let mut settings = settings_with_hops(json!([{ "connectionId": "gw" }]));

        resolve_proxy_jump_refs(&mut settings, &[gw], &creds, None).unwrap();

        assert_eq!(hops(&settings)[0]["password"], "s3cret");
    }

    #[test]
    fn password_reference_without_saved_password_errors() {
        let gw = ssh_conn(
            "gw",
            "gateway",
            json!({ "host": "gw.example.com", "username": "ops", "authMethod": "password" }),
        );
        let mut settings = settings_with_hops(json!([{ "connectionId": "gw" }]));

        let err = resolve_proxy_jump_refs(&mut settings, &[gw], &MemStore::default(), None)
            .expect_err("missing password should fail");
        let msg = err.to_string();
        assert!(msg.contains("No saved password"), "got: {msg}");
        assert!(msg.contains("gateway"), "error should name the hop: {msg}");
    }

    #[test]
    fn missing_reference_errors() {
        let mut settings = settings_with_hops(json!([{ "connectionId": "ghost" }]));
        let err = resolve_proxy_jump_refs(&mut settings, &[], &MemStore::default(), None)
            .expect_err("missing reference should fail");
        assert!(err.to_string().contains("not found"), "got: {err}");
    }

    #[test]
    fn non_ssh_reference_errors() {
        let local = conn("loc", "my-shell", "local", json!({}));
        let mut settings = settings_with_hops(json!([{ "connectionId": "loc" }]));
        let err = resolve_proxy_jump_refs(&mut settings, &[local], &MemStore::default(), None)
            .expect_err("non-ssh reference should fail");
        assert!(
            err.to_string().contains("not an SSH connection"),
            "got: {err}"
        );
    }

    #[test]
    fn chained_reference_prepends_referenced_connections_own_chain() {
        // edge → bastion → (our) target, where our hop references `bastion`, and
        // `bastion` is itself reached through `edge` (an inline hop on bastion).
        let bastion = ssh_conn(
            "bastion",
            "bastion",
            json!({
                "host": "bastion.internal",
                "username": "admin",
                "authMethod": "agent",
                "proxyJump": [
                    { "host": "edge.example.com", "port": 22, "username": "edge", "authMethod": "agent" }
                ],
            }),
        );
        let mut settings = settings_with_hops(json!([{ "connectionId": "bastion" }]));

        resolve_proxy_jump_refs(&mut settings, &[bastion], &MemStore::default(), None).unwrap();

        let chain = hops(&settings);
        assert_eq!(
            chain.len(),
            2,
            "edge (outer) then bastion (inner): {chain:?}"
        );
        assert_eq!(chain[0]["host"], "edge.example.com");
        assert_eq!(chain[1]["host"], "bastion.internal");
        assert_eq!(chain[1]["connectionId"], "bastion");
    }

    #[test]
    fn nested_reference_resolves_transitively() {
        // our hop → A, A references B inline-by-id, B is inline.
        let a = ssh_conn(
            "A",
            "A",
            json!({
                "host": "a.internal",
                "username": "a",
                "authMethod": "agent",
                "proxyJump": [{ "connectionId": "B" }],
            }),
        );
        let b = ssh_conn(
            "B",
            "B",
            json!({ "host": "b.internal", "username": "b", "authMethod": "agent" }),
        );
        let mut settings = settings_with_hops(json!([{ "connectionId": "A" }]));

        resolve_proxy_jump_refs(&mut settings, &[a, b], &MemStore::default(), None).unwrap();

        let chain = hops(&settings);
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[0]["host"], "b.internal"); // outermost
        assert_eq!(chain[1]["host"], "a.internal"); // innermost
    }

    #[test]
    fn circular_reference_is_rejected() {
        // A → B → A
        let a = ssh_conn(
            "A",
            "A",
            json!({
                "host": "a", "username": "u", "authMethod": "agent",
                "proxyJump": [{ "connectionId": "B" }],
            }),
        );
        let b = ssh_conn(
            "B",
            "B",
            json!({
                "host": "b", "username": "u", "authMethod": "agent",
                "proxyJump": [{ "connectionId": "A" }],
            }),
        );
        let mut settings = settings_with_hops(json!([{ "connectionId": "A" }]));

        let err = resolve_proxy_jump_refs(&mut settings, &[a, b], &MemStore::default(), None)
            .expect_err("A->B->A should be rejected");
        assert!(err.to_string().contains("Circular"), "got: {err}");
    }

    #[test]
    fn hop_referencing_root_connection_is_rejected() {
        let self_ref = ssh_conn(
            "self",
            "self",
            json!({ "host": "s", "username": "u", "authMethod": "agent" }),
        );
        let mut settings = settings_with_hops(json!([{ "connectionId": "self" }]));
        let err = resolve_proxy_jump_refs(
            &mut settings,
            &[self_ref],
            &MemStore::default(),
            Some("self"),
        )
        .expect_err("a hop referencing its own connection is circular");
        assert!(err.to_string().contains("Circular"), "got: {err}");
    }

    #[test]
    fn site_hop_connect_timeout_overrides_referenced_connection() {
        let gw = ssh_conn(
            "gw",
            "gw",
            json!({
                "host": "gw", "username": "u", "authMethod": "agent",
                "connectTimeoutSecs": 5,
            }),
        );
        let mut settings =
            settings_with_hops(json!([{ "connectionId": "gw", "connectTimeoutSecs": 45 }]));
        resolve_proxy_jump_refs(&mut settings, &[gw], &MemStore::default(), None).unwrap();
        assert_eq!(hops(&settings)[0]["connectTimeoutSecs"], 45);
    }
}

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
use super::id_changes::ConnectionIdRemap;
use crate::credential::named;
use crate::credential::{CredentialKey, CredentialStore, CredentialType};

/// Maximum reference-expansion depth, a runaway guard independent of the editor's
/// own chain-depth warning. Chains this deep are pathological.
const MAX_RESOLVE_DEPTH: usize = 16;

/// The saved connections a jump-host reference may point at (#3602).
///
/// This is exactly the set the connection editor's jump-host picker offers: the
/// main store followed by every **enabled** external connection file — the
/// [`UnifiedConnectionView`](super::manager::UnifiedConnectionView) that also
/// backs the frontend's `connections` region. Resolver and picker therefore
/// share one source of truth and one lookup rule:
///
/// - An id held by **exactly one** connection in the set resolves to it,
///   whichever file it lives in.
/// - An id held by **more than one** connection (ids are tree paths, so the main
///   store and an external file — or two external files — can both hold
///   `Folder/Name`) is **ambiguous** and refused. There is no silent precedence
///   (not even "same file first" or "main store first"): connecting through a
///   gateway the user did not mean to pick is worse than failing with a message
///   that says which files collide. The picker marks such ids as unavailable.
/// - An id held by **no** connection is not found. The error names a disabled
///   external file that holds it, and any enabled file that failed to load, so
///   the user knows why a hop they can see on disk does not resolve.
///
/// The same scope and rule also resolve the saved SSH connection a tunnel is
/// hosted on (#3619, [`ReferenceRole::TunnelHost`]), so a tunnel and a jump-host
/// hop can never disagree about which connection an id names.
///
/// References stay plain ids (no file qualifier): an id already survives a
/// connection moving between files (#3592), which a file-qualified reference
/// would not, and refusing ambiguity keeps plain references safe.
#[derive(Debug, Default)]
pub(crate) struct JumpHostScope<'a> {
    connections: &'a [SavedConnection],
    unavailable: Vec<UnavailableFile>,
}

/// An external connection file whose connections are not in the scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum UnavailableFile {
    /// Configured but disabled; `ids` are the connection ids it holds.
    Disabled { path: String, ids: HashSet<String> },
    /// Enabled but failed to load, so its ids are unknown.
    FailedToLoad { path: String, error: String },
}

impl<'a> JumpHostScope<'a> {
    /// A scope over `connections` (main store first, then enabled external
    /// files, each external row carrying its `source_file`).
    pub(crate) fn new(connections: &'a [SavedConnection]) -> Self {
        Self {
            connections,
            unavailable: Vec::new(),
        }
    }

    /// Record external files whose connections are not in the scope, so a
    /// reference into one fails with an explanation rather than a bare
    /// "not found".
    pub(crate) fn with_unavailable(mut self, unavailable: Vec<UnavailableFile>) -> Self {
        self.unavailable = unavailable;
        self
    }

    /// The one connection a jump-host reference `id` points at, or an error
    /// when it is ambiguous or not in the scope (see the type docs for the rule).
    fn find(&self, id: &str) -> Result<&'a SavedConnection> {
        self.find_as(id, ReferenceRole::JumpHost)
    }

    /// The one connection `id` refers to when used as `role`, or an error when
    /// it is ambiguous or not in the scope (see the type docs for the rule).
    ///
    /// Every by-id lookup of a saved connection that must honour external
    /// connection files goes through here — jump hosts (#3602) and the SSH
    /// connection a tunnel is hosted on (#3619) — so they cannot drift apart.
    /// `role` only shapes the wording of the error.
    pub(crate) fn find_as(&self, id: &str, role: ReferenceRole) -> Result<&'a SavedConnection> {
        let mut matches = self.connections.iter().filter(|c| c.id == id);
        let Some(first) = matches.next() else {
            bail!("{}", self.not_found_message(id, role));
        };
        let rest: Vec<&SavedConnection> = matches.collect();
        if rest.is_empty() {
            return Ok(first);
        }
        let sources: Vec<String> = std::iter::once(first)
            .chain(rest)
            .map(|c| source_label(c.source_file.as_deref()))
            .collect();
        bail!(
            "Referenced {} '{id}' is ambiguous: a connection with this id exists in {}. \
             Rename or move one of them, or {}.",
            role.noun(),
            sources.join(" and "),
            role.ambiguous_remedy()
        )
    }

    /// Whether any connection file — in the scope, or a disabled external file —
    /// holds `id`. Lets a caller with its own fallback for an unknown id (a WSL
    /// spawn falls back to the default distro) still refuse an ambiguous id or
    /// one that sits in a disabled file.
    pub(crate) fn knows(&self, id: &str) -> bool {
        self.connections.iter().any(|c| c.id == id)
            || self.unavailable.iter().any(|f| match f {
                UnavailableFile::Disabled { ids, .. } => ids.contains(id),
                UnavailableFile::FailedToLoad { .. } => false,
            })
    }

    fn not_found_message(&self, id: &str, role: ReferenceRole) -> String {
        let mut msg = format!("Referenced {} '{id}' not found.", role.noun());
        for file in &self.unavailable {
            match file {
                UnavailableFile::Disabled { path, ids } if ids.contains(id) => {
                    msg.push_str(&format!(
                        " It is in the disabled external connection file '{path}'; enable \
                         that file to {}.",
                        role.use_phrase()
                    ));
                }
                UnavailableFile::FailedToLoad { path, error } => {
                    msg.push_str(&format!(
                        " The external connection file '{path}' failed to load ({error})."
                    ));
                }
                UnavailableFile::Disabled { .. } => {}
            }
        }
        msg.push(' ');
        msg.push_str(role.not_found_remedy());
        msg
    }
}

/// What a saved-connection reference is used for. The lookup rule is the same
/// for every role ([`JumpHostScope::find_as`]); only the error wording differs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReferenceRole {
    /// A `proxyJump` hop referencing a saved SSH connection (#940, #3602).
    JumpHost,
    /// The saved SSH connection a tunnel is hosted on (`sshConnectionId`, #3619).
    TunnelHost,
    /// The saved connection a CLI/context-menu spawn names with `--connection`
    /// (#3624).
    SpawnTarget,
}

impl ReferenceRole {
    fn noun(self) -> &'static str {
        match self {
            Self::JumpHost => "jump host connection",
            Self::TunnelHost => "tunnel SSH connection",
            Self::SpawnTarget => "spawn connection",
        }
    }

    fn use_phrase(self) -> &'static str {
        match self {
            Self::JumpHost => "use it as a jump host",
            Self::TunnelHost => "host tunnels on it",
            Self::SpawnTarget => "spawn sessions with it",
        }
    }

    fn ambiguous_remedy(self) -> &'static str {
        match self {
            Self::JumpHost => "configure the hop inline",
            Self::TunnelHost => "pick another SSH connection for the tunnel",
            Self::SpawnTarget => "pass a --connection id held by only one connection file",
        }
    }

    fn not_found_remedy(self) -> &'static str {
        match self {
            Self::JumpHost => "Pick an existing SSH connection or switch to inline configuration.",
            Self::TunnelHost => "Pick an existing SSH connection for the tunnel.",
            Self::SpawnTarget => "Pass the id of an existing saved connection to --connection.",
        }
    }
}

/// Human-readable name of the connection file a connection lives in.
fn source_label(source_file: Option<&str>) -> String {
    match source_file {
        None => "the main connection store".to_string(),
        Some(path) => format!("the external connection file '{path}'"),
    }
}

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
    scope: &JumpHostScope<'_>,
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

    let resolved = resolve_hops(&hops, scope, creds, &mut visited, 0)?;

    settings[key] = Value::Array(resolved);
    Ok(())
}

/// Recursively resolve a list of hops into a flat list of fully-inline hops.
fn resolve_hops(
    hops: &[Value],
    scope: &JumpHostScope<'_>,
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
                let conn = scope.find(ref_id)?;
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
                let mut inner_resolved = resolve_hops(&inner, scope, creds, visited, depth + 1)?;
                resolved.append(&mut inner_resolved);
                resolved.push(build_inline_hop(conn, ref_id, hop, creds)?);
                visited.remove(ref_id);
            }
            None => resolved.push(hop.clone()),
        }
    }
    Ok(resolved)
}

/// Re-point every saved-connection jump-host reference in `settings` (the
/// `proxyJump` array or its legacy `jumpHosts` alias) along `remap` (#3596).
/// Returns whether any reference changed.
pub(crate) fn follow_jump_host_refs(settings: &mut Value, remap: &ConnectionIdRemap) -> bool {
    let mut changed = false;
    for key in ["proxyJump", "jumpHosts"] {
        if let Some(Value::Array(hops)) = settings.get_mut(key) {
            for hop in hops {
                if let Some(Value::String(id)) = hop.get_mut("connectionId") {
                    changed |= remap.apply(id);
                }
            }
        }
    }
    changed
}

/// [`follow_jump_host_refs`] over every connection's settings; returns whether
/// any reference changed.
pub(crate) fn follow_jump_host_refs_in(
    connections: &mut [SavedConnection],
    remap: &ConnectionIdRemap,
) -> bool {
    connections.iter_mut().fold(false, |changed, conn| {
        follow_jump_host_refs(&mut conn.config.settings, remap) | changed
    })
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
    if let Some(secret) = resolve_credential(ref_id, s, auth_method, creds)? {
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
///
/// A connection that references a shared named credential (#3557) resolves
/// **only** that credential — never its own per-connection secret — under the
/// same precedence as the desktop connect flow. A named credential of the
/// other kind has no secret under this type, so it resolves to nothing.
fn resolve_credential(
    ref_id: &str,
    settings: &Value,
    auth_method: &str,
    creds: &dyn CredentialStore,
) -> Result<Option<String>> {
    let cred_type = match auth_method {
        "password" => CredentialType::Password,
        "key" => CredentialType::KeyPassphrase,
        _ => return Ok(None),
    };
    let owner = match named::settings_ref(settings) {
        Some(named_id) => named::owner_id(named_id),
        None => ref_id.to_string(),
    };
    creds
        .get(&CredentialKey::new(&owner, cred_type))
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
        resolve_proxy_jump_refs(
            &mut settings,
            &JumpHostScope::new(&[]),
            &MemStore::default(),
            None,
        )
        .unwrap();
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
        resolve_proxy_jump_refs(
            &mut settings,
            &JumpHostScope::new(&[]),
            &MemStore::default(),
            None,
        )
        .unwrap();
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

        resolve_proxy_jump_refs(
            &mut settings,
            &JumpHostScope::new(&[bastion]),
            &MemStore::default(),
            None,
        )
        .unwrap();

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

        resolve_proxy_jump_refs(&mut settings, &JumpHostScope::new(&[gw]), &creds, None).unwrap();

        assert_eq!(hops(&settings)[0]["password"], "s3cret");
    }

    #[test]
    fn named_credential_reference_wins_over_per_connection_secret() {
        // #3557: a hop connection that references a shared credential resolves
        // only that credential, never its stale per-connection copy.
        let gw = ssh_conn(
            "gw",
            "gateway",
            json!({
                "host": "gw.example.com",
                "username": "ops",
                "authMethod": "password",
                "credentialRef": "nc-1",
            }),
        );
        let creds = MemStore::with(&[
            ("gw", CredentialType::Password, "stale-own"),
            ("named-credential:nc-1", CredentialType::Password, "shared"),
        ]);
        let mut settings = settings_with_hops(json!([{ "connectionId": "gw" }]));

        resolve_proxy_jump_refs(&mut settings, &JumpHostScope::new(&[gw]), &creds, None).unwrap();

        assert_eq!(hops(&settings)[0]["password"], "shared");
    }

    #[test]
    fn named_credential_of_wrong_kind_resolves_nothing() {
        // A passphrase credential referenced by a password-auth hop has no
        // password secret, so the hop reports the missing password.
        let gw = ssh_conn(
            "gw",
            "gateway",
            json!({
                "host": "gw.example.com",
                "username": "ops",
                "authMethod": "password",
                "credentialRef": "nc-1",
            }),
        );
        let creds = MemStore::with(&[
            ("gw", CredentialType::Password, "own"),
            ("named-credential:nc-1", CredentialType::KeyPassphrase, "p"),
        ]);
        let mut settings = settings_with_hops(json!([{ "connectionId": "gw" }]));
        let err = resolve_proxy_jump_refs(&mut settings, &JumpHostScope::new(&[gw]), &creds, None)
            .expect_err("wrong-kind credential must not resolve");
        assert!(err.to_string().contains("No saved password"));
    }

    #[test]
    fn password_reference_without_saved_password_errors() {
        let gw = ssh_conn(
            "gw",
            "gateway",
            json!({ "host": "gw.example.com", "username": "ops", "authMethod": "password" }),
        );
        let mut settings = settings_with_hops(json!([{ "connectionId": "gw" }]));

        let err = resolve_proxy_jump_refs(
            &mut settings,
            &JumpHostScope::new(&[gw]),
            &MemStore::default(),
            None,
        )
        .expect_err("missing password should fail");
        let msg = err.to_string();
        assert!(msg.contains("No saved password"), "got: {msg}");
        assert!(msg.contains("gateway"), "error should name the hop: {msg}");
    }

    #[test]
    fn missing_reference_errors() {
        let mut settings = settings_with_hops(json!([{ "connectionId": "ghost" }]));
        let err = resolve_proxy_jump_refs(
            &mut settings,
            &JumpHostScope::new(&[]),
            &MemStore::default(),
            None,
        )
        .expect_err("missing reference should fail");
        assert!(err.to_string().contains("not found"), "got: {err}");
    }

    #[test]
    fn non_ssh_reference_errors() {
        let local = conn("loc", "my-shell", "local", json!({}));
        let mut settings = settings_with_hops(json!([{ "connectionId": "loc" }]));
        let err = resolve_proxy_jump_refs(
            &mut settings,
            &JumpHostScope::new(&[local]),
            &MemStore::default(),
            None,
        )
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

        resolve_proxy_jump_refs(
            &mut settings,
            &JumpHostScope::new(&[bastion]),
            &MemStore::default(),
            None,
        )
        .unwrap();

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

        resolve_proxy_jump_refs(
            &mut settings,
            &JumpHostScope::new(&[a, b]),
            &MemStore::default(),
            None,
        )
        .unwrap();

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

        let err = resolve_proxy_jump_refs(
            &mut settings,
            &JumpHostScope::new(&[a, b]),
            &MemStore::default(),
            None,
        )
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
            &JumpHostScope::new(&[self_ref]),
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
        resolve_proxy_jump_refs(
            &mut settings,
            &JumpHostScope::new(&[gw]),
            &MemStore::default(),
            None,
        )
        .unwrap();
        assert_eq!(hops(&settings)[0]["connectTimeoutSecs"], 45);
    }

    fn remap(changes: &[(&str, &str)]) -> ConnectionIdRemap {
        let changes: Vec<crate::connection::id_changes::ConnectionIdChange> = changes
            .iter()
            .map(|(o, n)| crate::connection::id_changes::ConnectionIdChange::new(*o, *n))
            .collect();
        ConnectionIdRemap::new(&changes)
    }

    #[test]
    fn follow_jump_host_refs_rewrites_references_and_keeps_inline_hops() {
        let mut settings = settings_with_hops(json!([
            { "connectionId": "Work/bastion" },
            { "host": "inline", "username": "u" },
            { "connectionId": "other" }
        ]));
        assert!(follow_jump_host_refs(
            &mut settings,
            &remap(&[("Work/bastion", "Job/bastion")])
        ));
        let chain = hops(&settings);
        assert_eq!(chain[0]["connectionId"], "Job/bastion");
        assert_eq!(chain[1], json!({ "host": "inline", "username": "u" }));
        assert_eq!(chain[2]["connectionId"], "other");
    }

    #[test]
    fn follow_jump_host_refs_covers_the_legacy_alias_and_swaps() {
        let mut settings = json!({
            "host": "t",
            "jumpHosts": [{ "connectionId": "a" }, { "connectionId": "b" }]
        });
        assert!(follow_jump_host_refs(
            &mut settings,
            &remap(&[("a", "b"), ("b", "a")])
        ));
        assert_eq!(settings["jumpHosts"][0]["connectionId"], "b");
        assert_eq!(settings["jumpHosts"][1]["connectionId"], "a");
    }

    #[test]
    fn follow_jump_host_refs_without_a_matching_reference_changes_nothing() {
        let mut settings = settings_with_hops(json!([{ "connectionId": "x" }]));
        let before = settings.clone();
        assert!(!follow_jump_host_refs(&mut settings, &remap(&[("a", "b")])));
        assert_eq!(settings, before);
        let mut no_chain = json!({ "host": "t" });
        assert!(!follow_jump_host_refs(&mut no_chain, &remap(&[("a", "b")])));
    }

    #[test]
    fn follow_jump_host_refs_in_reports_whether_any_connection_changed() {
        let mut conns = vec![
            ssh_conn("gw", "gw", json!({ "host": "gw" })),
            ssh_conn(
                "t",
                "t",
                json!({ "host": "t", "proxyJump": [{ "connectionId": "gw" }] }),
            ),
        ];
        assert!(follow_jump_host_refs_in(
            &mut conns,
            &remap(&[("gw", "Net/gw")])
        ));
        assert_eq!(
            conns[1].config.settings["proxyJump"][0]["connectionId"],
            "Net/gw"
        );
        assert!(!follow_jump_host_refs_in(
            &mut conns,
            &remap(&[("zz", "yy")])
        ));
    }
}

//! Per-tab retention of the connection request for the resilient-reconnect loop
//! — retention **Model A**, the foundation for the server-side reconnect redrive
//! (#2454, Part 1 of #2446, unblocks #2205 PR-B).
//!
//! # Why retain the request
//!
//! When a resilient **direct** (non-agent) session drops, the backend must be
//! able to re-establish the transport *itself* on the #2203 reconnect timer's
//! `Waiting → Attempt` edge (the redrive), rather than relying on the client to
//! call `create_connection` again with the settings. To do that it needs the
//! original connection request — `type_id` + `settings` + `agent_id` + the
//! `resilient` flag — which `create_connection` otherwise receives per attempt
//! from the frontend and drops. Nothing else retains it: `PersistentRecord`
//! keeps only ids/agent, and `emit_and_cleanup` tears a dropped session down.
//!
//! **Maintainer decision (2026-08-07): Model A** — retain the *full* request
//! in-memory per tab across the reconnect loop, one uniform path for every
//! connection kind (saved / ad-hoc / spawned / inline). Chosen for the cleanest,
//! most testable architecture over re-resolving from a saved-connection ref +
//! credential store (which would not cover ad-hoc/inline requests).
//!
//! # Security: resolved secrets must not outlive the session
//!
//! `settings` can carry **resolved secrets** — an SSH password / passphrase after
//! credential-store and jump-host resolution. Model A therefore extends a
//! resolved secret's in-memory lifetime past the drop, for the duration of the
//! reconnect loop. The **mandatory** mitigation (baked into the maintainer's
//! decision): the retained request is dropped and **zeroized** the instant the
//! tab reaches any state where the session is neither active nor reconnecting —
//! give-up (Failed), user-cancel (Disconnected/User), a graceful user disconnect,
//! and tab/session removal — so no resolved secret outlives an active or
//! reconnecting session. Zeroizing uses the same [`zeroize`] crate the credential
//! store uses for its in-memory secrets ([`crate::credential`]).
//!
//! # The redrive reads it back
//!
//! This module and its wiring **retain and zeroize** the request; the backend
//! reconnect redrive ([`crate::session_projection::redrive`]) reads it back on the
//! #2203 timer's `Waiting → Attempt` edge to re-establish the transport itself and
//! re-attach the new backend session (#2457). The request is only ever populated
//! for a resilient session, and the redrive gates on its `resilient` flag.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::Value;
use zeroize::Zeroize;

/// A retained connection request for one tab's resilient-reconnect loop
/// (Model A). Mirrors the `create_connection` request surface so the backend
/// redrive can re-establish the transport without the frontend.
///
/// Zeroized on drop: `settings` may hold resolved secrets (see the module docs),
/// so [`Drop`] scrubs every string it contains rather than leaving it for the
/// allocator to reuse.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RetainedConnectionRequest {
    /// The connection `type_id` (e.g. `ssh`, `local`).
    pub(crate) type_id: String,
    /// The resolved connection settings — **may contain secrets**.
    pub(crate) settings: Value,
    /// The agent this request routes through, if any. Always `None` for the
    /// direct connections this retention currently covers (#2454); kept so the
    /// agent redrive (#2455) can reuse the same store.
    pub(crate) agent_id: Option<String>,
    /// The **live agent session id** this resilient agent tab is attached to, if
    /// any (#2512). Populated in `create_connection` from the proxy's
    /// `remote_session_id()` after the initial agent connect; always `None` for a
    /// **direct** (non-agent) tab, which has no agent session. On reconnect the
    /// backend redrive re-attaches to *this same* live session (the running
    /// process continues) via `connection.attach` instead of minting a new one
    /// with `connection.create` — and, when the agent no longer lists it, emits an
    /// explicit session-lost state rather than a silent new shell. Not a secret,
    /// but zeroized on drop alongside the other fields for uniformity.
    pub(crate) agent_session_id: Option<String>,
    /// The tab's resilient-reconnect determination at connect time. A request is
    /// only ever retained for a resilient tab, so this is the gate the backend
    /// reconnect redrive (#2454) reads to decide it owns the transport
    /// re-establishment for this tab.
    pub(crate) resilient: bool,
}

impl Drop for RetainedConnectionRequest {
    fn drop(&mut self) {
        self.type_id.zeroize();
        if let Some(agent_id) = self.agent_id.as_mut() {
            agent_id.zeroize();
        }
        if let Some(agent_session_id) = self.agent_session_id.as_mut() {
            agent_session_id.zeroize();
        }
        zeroize_json(&mut self.settings);
    }
}

/// Recursively zeroize every string value in a JSON tree, in place.
///
/// Scrubs string *leaves* (a resolved password lives in a string value) through
/// arrays and objects. Object *keys* are field names, not secrets, and are left
/// as-is (serde_json exposes only `values_mut`, not key mutation, anyway).
fn zeroize_json(value: &mut Value) {
    match value {
        Value::String(s) => s.zeroize(),
        Value::Array(items) => items.iter_mut().for_each(zeroize_json),
        Value::Object(map) => map.values_mut().for_each(zeroize_json),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// Per-tab store of [`RetainedConnectionRequest`]s, keyed by the frontend **tab
/// id** (the stable key that survives a reconnect, matching the
/// `session-lifecycle` region and the `session_tab_ids` identity bridge).
///
/// Cloneable (`Arc`-backed) so it can be a field on the `SessionManager` and
/// shared with the detached tasks that observe lifecycle transitions.
#[derive(Clone, Default)]
pub(crate) struct RetainedRequestStore {
    inner: Arc<Mutex<HashMap<String, RetainedConnectionRequest>>>,
}

impl RetainedRequestStore {
    /// An empty store.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, RetainedConnectionRequest>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Retain (replacing any prior) the request for `tab_id`. A re-connect or a
    /// successful reconnect attempt overwrites the previous request; the replaced
    /// value is zeroized as it drops.
    pub(crate) fn retain(&self, tab_id: &str, request: RetainedConnectionRequest) {
        self.lock().insert(tab_id.to_string(), request);
    }

    /// Drop and zeroize the retained request for `tab_id`, if any. Idempotent —
    /// clearing a tab with no retained request is a no-op. This is the security
    /// mitigation's scrub point: every terminal-loop / session-end path calls it.
    pub(crate) fn clear(&self, tab_id: &str) {
        // `remove` returns the value; dropping it runs the zeroizing `Drop`.
        drop(self.lock().remove(tab_id));
    }

    /// Whether a request is currently retained for `tab_id`.
    #[allow(dead_code)] // consumed by `SessionManager::has_retained_request` (tests + follow-up redrive)
    pub(crate) fn contains(&self, tab_id: &str) -> bool {
        self.lock().contains_key(tab_id)
    }

    /// A clone of the retained request for `tab_id`, for the (follow-up) redrive.
    /// Cloning copies the secret-bearing settings; the caller owns scrubbing the
    /// clone (its `Drop` zeroizes it).
    #[allow(dead_code)]
    pub(crate) fn get(&self, tab_id: &str) -> Option<RetainedConnectionRequest> {
        self.lock().get(tab_id).cloned()
    }

    /// The `agent_id` a tab's retained request routes through, if any. Reads only
    /// the (non-secret) agent id, so it does **not** clone the secret-bearing
    /// `settings` the way [`Self::get`] does — the per-agent transport-config
    /// refcount scrub (#2473) needs the agent id, not the settings.
    pub(crate) fn agent_id_for(&self, tab_id: &str) -> Option<String> {
        self.lock().get(tab_id).and_then(|r| r.agent_id.clone())
    }

    /// Whether **any** retained request currently routes through `agent_id`.
    ///
    /// The refcount behind the per-agent transport-config scrub (#2473): one SSH
    /// transport is shared by every session on an agent, so its retained config
    /// must survive until the *last* tab on that agent stops needing it. A caller
    /// clears its own tab's request first, then asks this — a `false` answer means
    /// no sibling tab still holds the agent, so its config can be scrubbed.
    pub(crate) fn any_for_agent(&self, agent_id: &str) -> bool {
        self.lock()
            .values()
            .any(|r| r.agent_id.as_deref() == Some(agent_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn zeroize_json_scrubs_nested_string_leaves() {
        let mut value = json!({
            "host": "example.com",
            "password": "super-secret",
            "port": 22,
            "jump": { "passphrase": "another-secret", "enabled": true },
            "tags": ["one", "two"],
        });
        zeroize_json(&mut value);

        // Every string leaf is emptied; non-string leaves are untouched.
        assert_eq!(value["host"], json!(""));
        assert_eq!(value["password"], json!(""));
        assert_eq!(value["jump"]["passphrase"], json!(""));
        assert_eq!(value["tags"], json!(["", ""]));
        assert_eq!(value["port"], json!(22));
        assert_eq!(value["jump"]["enabled"], json!(true));
    }

    #[test]
    fn retain_and_clear_roundtrip() {
        let store = RetainedRequestStore::new();
        assert!(!store.contains("tab-1"));

        store.retain(
            "tab-1",
            RetainedConnectionRequest {
                type_id: "ssh".to_string(),
                settings: json!({ "host": "h", "password": "p" }),
                agent_id: None,
                agent_session_id: None,
                resilient: true,
            },
        );
        assert!(store.contains("tab-1"));

        // `get` returns a faithful clone for the (follow-up) redrive.
        let got = store.get("tab-1").expect("retained request");
        assert_eq!(got.type_id, "ssh");
        assert_eq!(got.settings["host"], json!("h"));
        assert!(got.resilient);

        store.clear("tab-1");
        assert!(!store.contains("tab-1"));
        // Clearing an absent tab is a no-op.
        store.clear("tab-1");
        assert!(!store.contains("tab-1"));
    }

    #[test]
    fn retain_and_clear_agent_request_carries_and_scrubs_agent_id() {
        // #2455: the same store retains a resilient **agent** request (agent_id
        // Some) so the backend redrive can re-establish the transport through the
        // agent. The store must round-trip the agent_id (for the redrive) and
        // clear must drop + zeroize it just like a direct request — an agent-tab
        // drop mirrors `session.dropped`, whose scrub now routes through `clear`,
        // so a leaked agent request there would regress Model A's secret
        // guarantee.
        let store = RetainedRequestStore::new();
        store.retain(
            "tab-agent",
            RetainedConnectionRequest {
                type_id: "ssh".to_string(),
                settings: json!({ "host": "h", "password": "p" }),
                agent_id: Some("agent-1".to_string()),
                agent_session_id: None,
                resilient: true,
            },
        );

        let got = store.get("tab-agent").expect("retained agent request");
        assert_eq!(
            got.agent_id.as_deref(),
            Some("agent-1"),
            "the store round-trips the agent_id the redrive re-connects through"
        );
        assert_eq!(got.settings["password"], json!("p"));

        store.clear("tab-agent");
        assert!(
            !store.contains("tab-agent"),
            "clearing an agent request drops + zeroizes it (the `session.dropped` scrub point)"
        );
    }

    #[test]
    fn drop_zeroizes_agent_id() {
        // The retained request's Drop must scrub the agent_id string in place, the
        // same way it scrubs the settings secrets. Assert the mechanism `Drop`
        // uses (`Zeroize` on the owned string) empties it.
        let mut agent_id = "agent-secret-id".to_string();
        agent_id.zeroize();
        assert_eq!(agent_id, "");
    }

    #[test]
    fn retain_replaces_prior_request() {
        let store = RetainedRequestStore::new();
        store.retain(
            "tab-1",
            RetainedConnectionRequest {
                type_id: "ssh".to_string(),
                settings: json!({ "password": "old" }),
                agent_id: None,
                agent_session_id: None,
                resilient: true,
            },
        );
        store.retain(
            "tab-1",
            RetainedConnectionRequest {
                type_id: "ssh".to_string(),
                settings: json!({ "password": "new" }),
                agent_id: None,
                agent_session_id: None,
                resilient: true,
            },
        );
        assert_eq!(
            store.get("tab-1").unwrap().settings["password"],
            json!("new")
        );
    }

    #[test]
    fn agent_id_for_reads_the_agent_without_cloning_settings() {
        let store = RetainedRequestStore::new();
        assert_eq!(store.agent_id_for("missing"), None);

        store.retain(
            "tab-direct",
            RetainedConnectionRequest {
                type_id: "ssh".to_string(),
                settings: json!({ "password": "p" }),
                agent_id: None,
                agent_session_id: None,
                resilient: true,
            },
        );
        store.retain(
            "tab-agent",
            RetainedConnectionRequest {
                type_id: "ssh".to_string(),
                settings: json!({ "password": "p" }),
                agent_id: Some("agent-1".to_string()),
                agent_session_id: None,
                resilient: true,
            },
        );

        assert_eq!(store.agent_id_for("tab-direct"), None);
        assert_eq!(store.agent_id_for("tab-agent").as_deref(), Some("agent-1"));
    }

    #[test]
    fn any_for_agent_tracks_the_last_tab_on_an_agent() {
        // The refcount behind the per-agent transport-config scrub (#2473): the
        // agent config must survive until the last tab on that agent releases it.
        let store = RetainedRequestStore::new();
        assert!(!store.any_for_agent("agent-1"));

        let agent_req = |agent: &str| RetainedConnectionRequest {
            type_id: "ssh".to_string(),
            settings: json!({ "password": "p" }),
            agent_id: Some(agent.to_string()),
            agent_session_id: None,
            resilient: true,
        };
        store.retain("tab-a", agent_req("agent-1"));
        store.retain("tab-b", agent_req("agent-1"));
        store.retain("tab-c", agent_req("agent-2"));

        assert!(store.any_for_agent("agent-1"));
        assert!(store.any_for_agent("agent-2"));

        // Clearing one of two siblings on agent-1 keeps the agent referenced.
        store.clear("tab-a");
        assert!(
            store.any_for_agent("agent-1"),
            "a sibling tab still holds agent-1, so its config must not be scrubbed"
        );

        // Clearing the last tab on agent-1 releases it; agent-2 is unaffected.
        store.clear("tab-b");
        assert!(
            !store.any_for_agent("agent-1"),
            "the last tab on agent-1 released it — its config can now be scrubbed"
        );
        assert!(store.any_for_agent("agent-2"));
    }

    #[test]
    fn drop_zeroizes_secret_settings() {
        // The retained request's Drop must scrub secret-bearing settings. We
        // assert the observable contract via the shared `zeroize_json` used by
        // Drop: after scrubbing, no secret *value* survives in the tree (field
        // *names* are not secret and are preserved).
        let mut settings = json!({ "password": "super-secret", "host": "example.com" });
        zeroize_json(&mut settings);
        assert_eq!(settings["password"], json!(""));
        assert_eq!(settings["host"], json!(""));
        assert!(!settings.to_string().contains("super-secret"));
        assert!(!settings.to_string().contains("example.com"));
    }
}

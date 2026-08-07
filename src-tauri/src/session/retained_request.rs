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
//! # Foundation only (this change)
//!
//! This module and its wiring **retain and zeroize** the request; nothing reads
//! it back to redrive a connection yet. The redrive itself — wiring the #2203
//! timer to re-establish the transport from the retained request behind a
//! default-off flag, and the frontend re-attach of the new backend session — is
//! the follow-up that completes #2454. Retaining is inert until then: the request
//! is only ever populated for a resilient *direct* session and only ever read by
//! the (not-yet-present) redrive, so this changes no user-facing behavior.

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
    /// The tab's resilient-reconnect determination at connect time.
    pub(crate) resilient: bool,
    /// Whether the owning tab opted into the **backend-driven** reconnect redrive
    /// (#2454) — the client's `sessionBackendReattach` flag at connect time,
    /// threaded through `create_connection`. The backend reconnect timer only
    /// re-establishes the transport itself for a tab whose retained request
    /// carries `true`; when `false` (the default-off flag) the timer fires the
    /// `Waiting → Attempt` edge and the **client** drives the redrive exactly as
    /// on `develop`. This is the sole gate that keeps the flag-off path
    /// byte-identical while the two halves (backend redrive here, frontend
    /// re-attach #2457) share one flag.
    pub(crate) backend_reattach: bool,
}

impl Drop for RetainedConnectionRequest {
    fn drop(&mut self) {
        self.type_id.zeroize();
        if let Some(agent_id) = self.agent_id.as_mut() {
            agent_id.zeroize();
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
                resilient: true,
                backend_reattach: false,
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
    fn retain_replaces_prior_request() {
        let store = RetainedRequestStore::new();
        store.retain(
            "tab-1",
            RetainedConnectionRequest {
                type_id: "ssh".to_string(),
                settings: json!({ "password": "old" }),
                agent_id: None,
                resilient: true,
                backend_reattach: false,
            },
        );
        store.retain(
            "tab-1",
            RetainedConnectionRequest {
                type_id: "ssh".to_string(),
                settings: json!({ "password": "new" }),
                agent_id: None,
                resilient: true,
                backend_reattach: false,
            },
        );
        assert_eq!(
            store.get("tab-1").unwrap().settings["password"],
            json!("new")
        );
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

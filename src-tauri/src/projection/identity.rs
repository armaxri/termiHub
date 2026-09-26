//! Client identity binding for the projection substrate (TAURI-012, #3444).
//!
//! Every [`Intent`](super::Intent) and every subscription carries a `client_id`
//! — the fan-out / audit identity and the key of client-scoped regions such as
//! `layout@<clientId>`. That field is **asserted by the caller**, so on its own
//! it proves nothing: with multi-window (#1900) each window is a separate JS
//! context, and nothing in the wire payload stops window B from dispatching an
//! intent as window A's client, or subscribing to (or detaching) A's private
//! `layout@<clientA>` region.
//!
//! [`ClientIdentities`] closes that gap by binding each `client_id` to the
//! **principal** that first used it. The principal is derived by the transport,
//! never read from the payload:
//!
//! * on desktop it is the invoking `WebviewWindow`'s label (`main`, `win-N`),
//!   which Tauri supplies server-side and a webview cannot forge;
//! * in a future remote-client transport it is the authenticated connection
//!   (session) id.
//!
//! The binding is trust-on-first-use: the frontend mints fresh `client-<ulid>`
//! ids per bridge (they are unguessable and window-local), so the first
//! principal to use an id owns it; any *other* principal presenting the same id
//! is rejected with a typed [`ClientIdentityError`]. A principal may mint as many
//! ids as it likes — it can only ever act as itself. Bindings are released when
//! the principal goes away (window destroyed), see
//! [`ClientIdentities::release_principal`].
//!
//! This module is transport-neutral (no Tauri dependency) so the same check
//! guards the desktop IPC commands and any later WebSocket transport.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Why a caller was refused the identity it asserted.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ClientIdentityError {
    /// The asserted `client_id` (or a client-scoped region's `@<clientId>`
    /// suffix) was empty.
    #[error("client id must not be empty")]
    EmptyClientId,
    /// The asserted `client_id` is bound to a different principal.
    #[error("principal '{caller}' may not act as client '{client_id}' (owned by another window)")]
    NotOwner {
        /// The client id the caller asserted.
        client_id: String,
        /// The principal (window label) that made the call.
        caller: String,
    },
}

impl ClientIdentityError {
    /// Stable machine-readable code, used as the rejected ack's `error.code`.
    pub fn code(&self) -> &'static str {
        match self {
            Self::EmptyClientId => "invalid_client_id",
            Self::NotOwner { .. } => "client_identity_mismatch",
        }
    }
}

/// Serialized as `{ code, message }` so a rejected Tauri command surfaces a
/// typed, inspectable error to the frontend.
impl Serialize for ClientIdentityError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("ClientIdentityError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

/// The client id a region is scoped to, if any.
///
/// Region ids are `"<domain>"` for shared regions and `"<domain>@<clientId>"`
/// for client-scoped ones (see [`ProjectedStore::region_id`]); the `@` suffix
/// is the only thing that distinguishes the two.
///
/// [`ProjectedStore::region_id`]: super::ProjectedStore::region_id
pub fn region_client(region: &str) -> Option<&str> {
    region.split_once('@').map(|(_, client)| client)
}

/// `client_id → owning principal` bindings (see the module docs).
#[derive(Default)]
pub struct ClientIdentities {
    owners: Mutex<HashMap<String, String>>,
}

impl ClientIdentities {
    pub fn new() -> Self {
        Self::default()
    }

    /// Authorize `caller` to act as `client_id`, binding the id to `caller` if
    /// it is not yet bound. Rejects an empty id or one owned by another
    /// principal.
    pub fn authorize(&self, caller: &str, client_id: &str) -> Result<(), ClientIdentityError> {
        if client_id.is_empty() {
            return Err(ClientIdentityError::EmptyClientId);
        }
        let mut owners = self.lock();
        match owners.get(client_id) {
            Some(owner) if owner == caller => Ok(()),
            Some(_) => Err(ClientIdentityError::NotOwner {
                client_id: client_id.to_string(),
                caller: caller.to_string(),
            }),
            None => {
                owners.insert(client_id.to_string(), caller.to_string());
                Ok(())
            }
        }
    }

    /// Authorize `caller` to touch `region`. Shared regions (no `@` suffix) are
    /// open to every principal; a client-scoped region `<domain>@<clientId>` is
    /// open only to the principal that owns `<clientId>` (binding it on first
    /// use, like [`authorize`](Self::authorize)).
    pub fn authorize_region(&self, caller: &str, region: &str) -> Result<(), ClientIdentityError> {
        match region_client(region) {
            Some(client_id) => self.authorize(caller, client_id),
            None => Ok(()),
        }
    }

    /// Whether `client_id` is currently bound to `caller`. Never binds.
    pub fn is_owned_by(&self, caller: &str, client_id: &str) -> bool {
        self.lock()
            .get(client_id)
            .is_some_and(|owner| owner == caller)
    }

    /// The principal `client_id` is bound to, if any (diagnostics / tests).
    pub fn owner_of(&self, client_id: &str) -> Option<String> {
        self.lock().get(client_id).cloned()
    }

    /// Drop every binding held by `principal` (e.g. its window was destroyed)
    /// and return the released client ids, so the caller can also detach their
    /// subscriptions.
    pub fn release_principal(&self, principal: &str) -> Vec<String> {
        let mut owners = self.lock();
        let released: Vec<String> = owners
            .iter()
            .filter(|(_, owner)| owner.as_str() == principal)
            .map(|(client, _)| client.clone())
            .collect();
        for client in &released {
            owners.remove(client);
        }
        released
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        // Short, non-reentrant critical sections; recover a poisoned lock
        // rather than cascade another thread's panic.
        self.owners.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_use_binds_and_owner_may_reuse() {
        let ids = ClientIdentities::new();
        assert_eq!(ids.authorize("main", "client-A"), Ok(()));
        assert_eq!(ids.owner_of("client-A").as_deref(), Some("main"));
        assert_eq!(ids.authorize("main", "client-A"), Ok(()));
    }

    #[test]
    fn other_principal_is_rejected() {
        let ids = ClientIdentities::new();
        ids.authorize("main", "client-A").unwrap();
        let err = ids.authorize("win-1", "client-A").unwrap_err();
        assert_eq!(err.code(), "client_identity_mismatch");
        assert_eq!(
            err,
            ClientIdentityError::NotOwner {
                client_id: "client-A".into(),
                caller: "win-1".into(),
            }
        );
        // The binding is unchanged by the rejected attempt.
        assert_eq!(ids.owner_of("client-A").as_deref(), Some("main"));
    }

    #[test]
    fn empty_client_id_is_rejected() {
        let ids = ClientIdentities::new();
        assert_eq!(
            ids.authorize("main", ""),
            Err(ClientIdentityError::EmptyClientId)
        );
        assert_eq!(
            ids.authorize_region("main", "layout@"),
            Err(ClientIdentityError::EmptyClientId)
        );
    }

    #[test]
    fn shared_regions_are_open_scoped_regions_are_owner_only() {
        let ids = ClientIdentities::new();
        assert_eq!(ids.authorize_region("main", "connections"), Ok(()));
        assert_eq!(ids.authorize_region("win-1", "connections"), Ok(()));

        assert_eq!(ids.authorize_region("main", "layout@client-A"), Ok(()));
        assert!(ids.authorize_region("win-1", "layout@client-A").is_err());
        // Any region scoped to the same client shares the binding.
        assert!(ids.authorize_region("win-1", "broadcast@client-A").is_err());
    }

    #[test]
    fn release_principal_frees_only_its_ids() {
        let ids = ClientIdentities::new();
        ids.authorize("main", "client-A").unwrap();
        ids.authorize("win-1", "client-B").unwrap();
        ids.authorize("win-1", "client-C").unwrap();

        let mut released = ids.release_principal("win-1");
        released.sort();
        assert_eq!(released, vec!["client-B".to_string(), "client-C".into()]);
        assert_eq!(ids.owner_of("client-B"), None);
        assert_eq!(ids.owner_of("client-A").as_deref(), Some("main"));
    }

    #[test]
    fn is_owned_by_never_binds() {
        let ids = ClientIdentities::new();
        assert!(!ids.is_owned_by("main", "client-A"));
        assert_eq!(ids.owner_of("client-A"), None);
    }

    #[test]
    fn region_client_parses_suffix() {
        assert_eq!(region_client("layout@client-7"), Some("client-7"));
        assert_eq!(region_client("tunnels"), None);
    }

    #[test]
    fn error_serializes_as_code_and_message() {
        let err = ClientIdentityError::NotOwner {
            client_id: "client-A".into(),
            caller: "win-1".into(),
        };
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["code"], "client_identity_mismatch");
        assert!(v["message"].as_str().unwrap().contains("client-A"));
    }
}

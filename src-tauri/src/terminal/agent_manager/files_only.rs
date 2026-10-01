//! Files-only agent sessions (#4081).
//!
//! An agent-hosted SSH session whose host refused the shell but serves SFTP
//! stays up for files, and the agent says so with a `connection.filesOnly`
//! notification. The I/O task routes it to the session's [`RemoteProxy`]
//! through a watch channel the proxy registered, which drives its
//! `files_only_watch` — the same hook a direct SSH session reports through, so
//! the session manager folds `filesOnly` onto the tab for both.
//!
//! The verdict can beat the registration: the agent decides right after
//! `connection.create` answers, while the proxy registers its route only once
//! that answer is in. So a notification for a session with no route yet is
//! remembered and delivered when the route arrives.
//!
//! [`RemoteProxy`]: crate::session::remote_proxy::RemoteProxy

use std::collections::{HashMap, HashSet};

use serde_json::Value;
use tokio::sync::watch;
use tracing::{info, warn};

use termihub_core::protocol::methods::{ConnectionFilesOnlyNotification, CONNECTION_FILES_ONLY};

/// Bound on remembered verdicts for sessions with no route (yet), so a
/// misbehaving agent can never grow the set without limit. Far above the
/// agent's own session cap.
const MAX_EARLY_VERDICTS: usize = 256;

/// Per-agent routes from a remote session id to its proxy's files-only watch.
#[derive(Default)]
pub(crate) struct FilesOnlyRoutes {
    routes: HashMap<String, watch::Sender<bool>>,
    /// Sessions reported files-only before their proxy registered a route.
    early: HashSet<String>,
}

impl FilesOnlyRoutes {
    /// Register the proxy's watch sender for `session_id`, delivering a verdict
    /// that arrived first.
    pub(crate) fn register(&mut self, session_id: String, tx: watch::Sender<bool>) {
        if self.early.remove(&session_id) {
            tx.send_replace(true);
        }
        self.routes.insert(session_id, tx);
    }

    /// Drop the route (and any remembered verdict) of a session that is gone.
    pub(crate) fn remove(&mut self, session_id: &str) {
        self.routes.remove(session_id);
        self.early.remove(session_id);
    }

    /// Keep only the sessions in `live_ids` (reconnect reconciliation).
    pub(crate) fn retain(&mut self, live_ids: &HashSet<String>) {
        self.routes.retain(|id, _| live_ids.contains(id));
        self.early.retain(|id| live_ids.contains(id));
    }

    /// Record that `session_id` is files-only.
    fn mark(&mut self, session_id: String) {
        if let Some(tx) = self.routes.get(&session_id) {
            tx.send_replace(true);
        } else if self.early.len() < MAX_EARLY_VERDICTS {
            self.early.insert(session_id);
        } else {
            warn!(
                session_id,
                "dropping a files-only verdict: too many unrouted"
            );
        }
    }
}

/// Route a `connection.filesOnly` notification, returning `true` if it was one.
/// A malformed payload is dropped (and still counts as handled).
pub(crate) fn route_files_only_notification(
    routes: &mut FilesOnlyRoutes,
    agent_id: &str,
    method: &str,
    params: &Value,
) -> bool {
    if method != CONNECTION_FILES_ONLY {
        return false;
    }
    match serde_json::from_value::<ConnectionFilesOnlyNotification>(params.clone()) {
        Ok(n) => {
            info!(
                agent_id,
                remote_session_id = %n.session_id,
                "agent session is files-only: the host refused the shell"
            );
            routes.mark(n.session_id);
        }
        Err(e) => warn!(agent_id, "malformed connection.filesOnly dropped: {e}"),
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn notify(routes: &mut FilesOnlyRoutes, session_id: &str) -> bool {
        route_files_only_notification(
            routes,
            "agent-1",
            CONNECTION_FILES_ONLY,
            &json!({ "session_id": session_id }),
        )
    }

    #[test]
    fn a_verdict_reaches_the_registered_route() {
        let mut routes = FilesOnlyRoutes::default();
        let (tx, rx) = watch::channel(false);
        routes.register("s-1".into(), tx);
        assert!(notify(&mut routes, "s-1"));
        assert!(*rx.borrow(), "the proxy's watch flips to files-only");
    }

    #[test]
    fn a_verdict_before_registration_is_delivered_on_register() {
        let mut routes = FilesOnlyRoutes::default();
        assert!(notify(&mut routes, "s-1"));
        let (tx, rx) = watch::channel(false);
        routes.register("s-1".into(), tx);
        assert!(*rx.borrow(), "an early verdict is not lost");
    }

    #[test]
    fn a_verdict_for_one_session_leaves_others_alone() {
        let mut routes = FilesOnlyRoutes::default();
        let (tx, rx) = watch::channel(false);
        routes.register("s-2".into(), tx);
        notify(&mut routes, "s-1");
        assert!(!*rx.borrow());
    }

    #[test]
    fn removing_a_session_forgets_its_early_verdict() {
        let mut routes = FilesOnlyRoutes::default();
        notify(&mut routes, "s-1");
        routes.remove("s-1");
        let (tx, rx) = watch::channel(false);
        routes.register("s-1".into(), tx);
        assert!(!*rx.borrow(), "a removed session's verdict must not leak");
    }

    #[test]
    fn retain_drops_sessions_that_did_not_survive() {
        let mut routes = FilesOnlyRoutes::default();
        notify(&mut routes, "gone");
        let (tx, rx) = watch::channel(false);
        routes.register("gone-route".into(), tx);
        routes.retain(&HashSet::from(["live".to_string()]));
        notify(&mut routes, "gone-route");
        assert!(
            !*rx.borrow(),
            "the pruned route no longer receives verdicts"
        );
        let (tx, rx) = watch::channel(false);
        routes.register("gone".into(), tx);
        assert!(!*rx.borrow(), "the pruned early verdict is gone");
    }

    #[test]
    fn other_methods_and_malformed_payloads() {
        let mut routes = FilesOnlyRoutes::default();
        assert!(!route_files_only_notification(
            &mut routes,
            "agent-1",
            "connection.output",
            &json!({ "session_id": "s-1", "data": "" }),
        ));
        assert!(route_files_only_notification(
            &mut routes,
            "agent-1",
            CONNECTION_FILES_ONLY,
            &json!({ "nope": 1 }),
        ));
        assert!(routes.early.is_empty());
    }

    #[test]
    fn unrouted_verdicts_are_bounded() {
        let mut routes = FilesOnlyRoutes::default();
        for i in 0..MAX_EARLY_VERDICTS + 10 {
            notify(&mut routes, &format!("s-{i}"));
        }
        assert_eq!(routes.early.len(), MAX_EARLY_VERDICTS);
    }
}

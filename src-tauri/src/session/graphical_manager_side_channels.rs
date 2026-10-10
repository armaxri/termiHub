//! The file side channel's place in a graphical session's lifecycle (#4384).
//!
//! "Browse remote files" registers the session's side channel with the
//! session layer ([`SideChannelBrowsers`]). That registration belongs to the
//! graphical session's backend lifecycle, not to the window whose tab opened
//! it (ADR-14: the backend is the authority, the UI renders it):
//!
//! - an **automatic reconnect** builds a new tunnel / agent link, so once the
//!   reconnected session is `Active` again its open side channel is re-opened
//!   on the current backend ([`SideChannelOpener`]), keeping the folder;
//! - the session **ending** — a disconnect, or resting for good in a terminal
//!   or manual-reconnect state — drops it.
//!
//! A tab moving to another window, a window reloading, or a stale (taken-over)
//! window closing its tab therefore never touches it.

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use tokio::sync::Mutex;
use tracing::debug;

use super::{GraphicalSession, GraphicalSessionManager};
use crate::session::graphical_browse::{SideChannelBrowsers, SideChannelOpener};

/// The open side channels and how to re-open one after a reconnect.
#[derive(Clone)]
pub(super) struct SideChannelLifecycle {
    browsers: SideChannelBrowsers,
    opener: Arc<dyn SideChannelOpener>,
}

/// A handle on the manager that does not keep its session map alive — held
/// by a session's supervisor task.
#[derive(Clone)]
pub(super) struct WeakManager {
    sessions: Weak<Mutex<HashMap<String, GraphicalSession>>>,
    /// The manager's other (cheap, shared) fields, over an empty map.
    shell: GraphicalSessionManager,
}

impl WeakManager {
    pub(super) fn new(manager: &GraphicalSessionManager) -> Self {
        Self {
            sessions: Arc::downgrade(&manager.sessions),
            shell: GraphicalSessionManager {
                sessions: Arc::default(),
                ..manager.clone()
            },
        }
    }

    /// The manager, while its session map is alive.
    pub(super) fn upgrade(&self) -> Option<GraphicalSessionManager> {
        Some(GraphicalSessionManager {
            sessions: self.sessions.upgrade()?,
            ..self.shell.clone()
        })
    }
}

impl GraphicalSessionManager {
    /// Tie the file side channels open for browsing (`browsers`, the session
    /// layer's registry) to the sessions' own lifecycle (#4384): `opener`
    /// re-opens one after an automatic reconnect, and a session ending drops
    /// its registration.
    pub(crate) fn with_side_channels(
        mut self,
        browsers: SideChannelBrowsers,
        opener: Arc<dyn SideChannelOpener>,
    ) -> Self {
        self.side_channels = Some(SideChannelLifecycle { browsers, opener });
        self
    }

    /// Drop the side channel open for `session_id`, if any (its session
    /// ended).
    pub(super) fn drop_side_channel(&self, session_id: &str) {
        if let Some(lifecycle) = &self.side_channels {
            if lifecycle.browsers.remove(session_id) {
                debug!(session_id, "graphical session ended; side channel closed");
            }
        }
    }

    /// The callback a session's supervisor task runs once the session has
    /// ended for good: drops its open side channel.
    pub(super) fn on_session_ended(&self, session_id: &str) -> impl FnOnce() + Send + 'static {
        let browsers = self.side_channels.as_ref().map(|l| l.browsers.clone());
        let session_id = session_id.to_string();
        move || {
            if let Some(browsers) = browsers {
                if browsers.remove(&session_id) {
                    debug!(session_id, "graphical session rests; side channel closed");
                }
            }
        }
    }

    /// Re-open the side channel of `session_id` on its current backend after
    /// an automatic reconnect (#4384). Nothing happens when none is open. A
    /// route that is not available now keeps the old registration (the File
    /// Browser shows the route's error on its next listing); a session closed
    /// meanwhile, or a registration closed meanwhile, is not re-registered.
    pub(super) async fn reopen_side_channel(&self, session_id: &str) {
        let Some(lifecycle) = self.side_channels.clone() else {
            return;
        };
        if !lifecycle.browsers.contains(session_id) {
            return;
        }
        match lifecycle.opener.reopen(self, session_id).await {
            Ok(reopened) => {
                // Under the session map's lock: a disconnect removes the
                // session first and drops the registration after, so it can
                // never be left behind by this re-open.
                let sessions = self.sessions.lock().await;
                if sessions.contains_key(session_id)
                    && lifecycle.browsers.replace_if_open(session_id, reopened)
                {
                    debug!(session_id, "side channel re-opened after reconnect");
                }
            }
            Err(e) => {
                debug!(session_id, error = %e, "side channel re-open after reconnect failed");
            }
        }
    }
}

//! Cancellation plumbing for in-flight agent deploy/setup (G10, #1242).
//!
//! Deploy and setup run a sequence of blocking network steps (resolve binary,
//! SFTP upload, install/inject, verify). Without a way to abort them, the
//! dialog's Cancel button could only close the dialog while the background SFTP
//! upload and script injection kept running to completion.
//!
//! This module mirrors the connect-cancellation pattern (`ProbeRegistry`,
//! `AgentConnectionManager` connecting registry): a [`CancellationToken`] is
//! registered per `agent_id` when a deploy/setup starts, checked between each
//! network step via [`bail_if_cancelled`], and fired by the `cancel_agent_setup`
//! Tauri command when the user clicks Cancel. On cancel the deploy path rolls
//! back the partially uploaded binary so no half-written file lingers.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

use crate::utils::errors::TerminalError;

/// Registry of cancellation tokens for in-flight agent deploy/setup runs, keyed
/// by `agent_id`. Managed Tauri state so the `cancel_agent_setup` command can
/// fire the token while the blocking deploy/setup runs on the blocking pool.
///
/// The inner map is `Arc`-shared so the spawned deploy/setup task can hold its
/// own handle and clear its entry on completion (identity-matched) without a
/// reference to the Tauri state.
#[derive(Default, Clone)]
pub struct AgentDeployCancellation {
    active: Arc<Mutex<HashMap<String, Arc<CancellationToken>>>>,
}

impl AgentDeployCancellation {
    /// Register a deploy/setup run and return its cancellation token, replacing
    /// (and cancelling) any prior run under the same `agent_id`. The returned
    /// `Arc` is the stored instance, so [`complete`](Self::complete) can
    /// identity-match it.
    pub fn register(&self, agent_id: &str) -> Arc<CancellationToken> {
        let token = Arc::new(CancellationToken::new());
        if let Ok(mut map) = self.active.lock() {
            if let Some(prev) = map.insert(agent_id.to_string(), token.clone()) {
                prev.cancel();
            }
        }
        token
    }

    /// Fire the cancellation token for an in-flight deploy/setup, if one is
    /// registered. Returns `true` when a matching run was in flight.
    pub fn cancel(&self, agent_id: &str) -> bool {
        let token = self
            .active
            .lock()
            .ok()
            .and_then(|map| map.get(agent_id).cloned());
        match token {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Drop a run's entry once it finishes — but only when the registry still
    /// holds *this* token instance, so a run re-registered under the same id is
    /// left untouched.
    pub fn complete(&self, agent_id: &str, token: &Arc<CancellationToken>) {
        if let Ok(mut map) = self.active.lock() {
            if map
                .get(agent_id)
                .is_some_and(|stored| Arc::ptr_eq(stored, token))
            {
                map.remove(agent_id);
            }
        }
    }
}

/// Guard placed before each network step of a deploy/setup: if the token has
/// fired, return a `Cancelled` error so the caller aborts before starting the
/// next blocking step (resolve/upload/install/verify).
///
/// `token` is optional so deploy/setup remain callable without a registry (e.g.
/// the `update_agent` re-deploy path and existing tests).
pub fn bail_if_cancelled(token: Option<&CancellationToken>) -> Result<(), TerminalError> {
    match token {
        Some(t) if t.is_cancelled() => Err(TerminalError::Cancelled),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bail_if_cancelled_ok_when_none() {
        assert!(bail_if_cancelled(None).is_ok());
    }

    #[test]
    fn bail_if_cancelled_ok_before_cancel() {
        let token = CancellationToken::new();
        assert!(bail_if_cancelled(Some(&token)).is_ok());
    }

    #[test]
    fn bail_if_cancelled_errors_after_cancel() {
        // Firing the token aborts before the next network step.
        let token = CancellationToken::new();
        token.cancel();
        let err = bail_if_cancelled(Some(&token)).expect_err("must bail after cancel");
        assert!(matches!(err, TerminalError::Cancelled));
    }

    #[test]
    fn registry_cancel_fires_registered_token() {
        let registry = AgentDeployCancellation::default();
        let token = registry.register("agent-1");
        assert!(!token.is_cancelled());

        // Cancel fires the token that the deploy/setup loop is checking.
        assert!(registry.cancel("agent-1"));
        assert!(token.is_cancelled());
        // A subsequent step-guard on this token bails.
        assert!(bail_if_cancelled(Some(&token)).is_err());
    }

    #[test]
    fn registry_cancel_unknown_agent_is_noop() {
        let registry = AgentDeployCancellation::default();
        assert!(!registry.cancel("nope"));
    }

    #[test]
    fn registry_reregister_cancels_previous_run() {
        let registry = AgentDeployCancellation::default();
        let first = registry.register("agent-1");
        let second = registry.register("agent-1");
        // The superseded run is cancelled so its loop aborts.
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
    }

    #[test]
    fn registry_complete_only_clears_matching_token() {
        let registry = AgentDeployCancellation::default();
        let first = registry.register("agent-1");
        // A newer run replaced `first`; completing `first` must not evict the new one.
        let second = registry.register("agent-1");
        registry.complete("agent-1", &first);
        // `second` is still registered, so cancel finds it.
        assert!(registry.cancel("agent-1"));
        assert!(second.is_cancelled());
    }

    #[test]
    fn registry_complete_clears_current_token() {
        let registry = AgentDeployCancellation::default();
        let token = registry.register("agent-1");
        registry.complete("agent-1", &token);
        // Entry removed — a later cancel finds nothing.
        assert!(!registry.cancel("agent-1"));
    }
}

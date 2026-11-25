//! The agent-hosted tunnels, as [`HostedServices`] sees them (#2185, #6028).
//!
//! The desktop holds only *control* and *reported* state: the data path (listen
//! socket, SSH session, forwarder) lives on the agent. The endpoint details come
//! from the agent's `tunnel.start` reply, the counters from `tunnel.status`
//! (#2199).
//!
//! [`HostedServices`]: crate::agent_service::hosted::HostedServices

use serde_json::Value;
use termihub_core::protocol::methods::{
    TunnelStartResult, TunnelStatusParams, TunnelStatusResult, TunnelStopParams, TUNNEL_STATUS,
    TUNNEL_STOP,
};

use super::config::{ReachableFrom, TunnelConfig, TunnelState, TunnelStats, TunnelStatus};
use crate::agent_service::hosted::{Away, HostedKind, Reading, View, WaitFor};

pub(super) struct HostedTunnels;

/// What an agent reports about a tunnel it forwards.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct HostedTunnel {
    /// The `host:port` the listen socket bound on the tunnel host (the agent for
    /// `-L`/`-D`, the SSH server for `-R`).
    pub bound_address: String,
    /// Who can reach the listen socket, as the agent classified its bind.
    pub reachable_from: ReachableFrom,
    /// Last live traffic counters.
    pub stats: TunnelStats,
}

impl Default for HostedTunnel {
    /// What is known about one whose start got no answer. The loopback-safe
    /// reach, so the UI never over-promises (#2199).
    fn default() -> Self {
        Self {
            bound_address: String::new(),
            reachable_from: ReachableFrom::AgentOnly,
            stats: TunnelStats::default(),
        }
    }
}

impl HostedTunnel {
    /// Read a `tunnel.start` reply; an unreadable one falls back to the default.
    pub fn from_start_reply(reply: Value) -> Self {
        match serde_json::from_value::<TunnelStartResult>(reply) {
            Ok(reply) => Self {
                bound_address: reply.bound_address,
                reachable_from: reply.reachable_from,
                stats: TunnelStats::default(),
            },
            Err(_) => Self::default(),
        }
    }
}

impl HostedKind for HostedTunnels {
    type State = HostedTunnel;

    fn stop_request(id: &str) -> (&'static str, Value) {
        let params = TunnelStopParams {
            tunnel_id: id.to_string(),
        };
        (
            TUNNEL_STOP,
            serde_json::to_value(params).unwrap_or_default(),
        )
    }

    fn status_request(id: &str) -> (&'static str, Value) {
        let params = TunnelStatusParams {
            tunnel_id: id.to_string(),
        };
        (
            TUNNEL_STATUS,
            serde_json::to_value(params).unwrap_or_default(),
        )
    }

    fn read_status(_id: &str, reply: &Value, last: &HostedTunnel) -> Reading<HostedTunnel> {
        let Ok(status) = serde_json::from_value::<TunnelStatusResult>(reply.clone()) else {
            return Reading::Unreadable;
        };
        if !status.running {
            return Reading::NotRunning;
        }
        // What the answer leaves out stays as it was known.
        Reading::Running(HostedTunnel {
            bound_address: status
                .bound_address
                .unwrap_or_else(|| last.bound_address.clone()),
            reachable_from: status.reachable_from.unwrap_or(last.reachable_from),
            stats: status.stats.unwrap_or_else(|| last.stats.clone()),
        })
    }

    fn is_news(before: &HostedTunnel, after: &HostedTunnel) -> bool {
        before.bound_address != after.bound_address || before.reachable_from != after.reachable_from
    }
}

/// The sentences a row shows; they name the agent, so they need the app.
pub(super) trait Reasons {
    fn waiting(&self, on: &WaitFor) -> String;
    fn stopping(&self, agent_id: &str) -> String;
    fn not_reachable(&self, agent_id: &str, why: Away) -> String;
}

/// The row of a tunnel whose state [`HostedServices`] decides. Pure, so every
/// state is unit-testable without an app.
///
/// [`HostedServices`]: crate::agent_service::hosted::HostedServices
pub(super) fn tunnel_state(
    config: &TunnelConfig,
    view: View<HostedTunnel>,
    reasons: &impl Reasons,
) -> TunnelState {
    let row = |status, error| {
        TunnelState::desktop(config.id.clone(), status, error, TunnelStats::default())
    };
    match view {
        View::Starting => row(TunnelStatus::Connecting, None),
        View::Waiting(on) => row(TunnelStatus::Waiting, Some(reasons.waiting(&on))),
        View::Stopping { agent_id } => {
            row(TunnelStatus::Stopping, Some(reasons.stopping(&agent_id)))
        }
        // It may still run there, but nothing about it is known now: no address,
        // no reach, no counters.
        View::NotReachable { agent_id, why, .. } => TunnelState {
            bound_on: Some(agent_id.clone()),
            ..row(
                TunnelStatus::NotReachable,
                Some(reasons.not_reachable(&agent_id, why)),
            )
        },
        // The agent-reported vantage: which agent, where it bound, who can reach
        // it, and the last sampled counters (#2199).
        View::Running { agent_id, state } => TunnelState {
            bound_on: Some(agent_id),
            bound_address: Some(state.bound_address),
            reachable_from: Some(state.reachable_from),
            stats: state.stats,
            ..row(TunnelStatus::Connected, None)
        },
    }
}

#[cfg(test)]
#[path = "hosted_tests.rs"]
mod tests;

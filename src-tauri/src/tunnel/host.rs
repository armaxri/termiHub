//! Which machine a tunnel may open its port on (#6028).

use termihub_core::util::service_host::{HostChoice, ServiceHost};

use crate::agent_service::HOST_UNREADABLE;
use crate::run_location::ResolvedLocation;
use crate::utils::errors::TerminalError;

/// Decide where a tunnel runs from its stored host (S3, #2155, #6028).
///
/// This computer resolves to [`ResolvedLocation::Local`] (the desktop forwarder
/// path), an agent to [`ResolvedLocation::Agent`] (the agent RPC, #2185). A host
/// this build cannot read is an error, never this computer: the caller records
/// and emits it as the tunnel's resting `Error`. Pure (no locking, no IO, no
/// `AppHandle`) so the routing decision is unit-testable directly.
pub(super) fn resolve_tunnel_host(host: &ServiceHost) -> Result<ResolvedLocation, String> {
    match host.choice() {
        HostChoice::ThisComputer => Ok(ResolvedLocation::Local),
        HostChoice::Agent(id) => Ok(ResolvedLocation::Agent(id.to_string())),
        HostChoice::Unreadable => Err(HOST_UNREADABLE.to_string()),
    }
}

/// Proof that a tunnel belongs on this computer, from [`ensure_runs_here`]. The
/// forwarder builder takes one, so no path can open a port here without it.
#[derive(Debug, Clone, Copy)]
pub(super) struct RunsHere(());

/// The last gate before a forwarder opens its port on this computer (#6028): a
/// tunnel that does not belong here is refused on every path to it, a reconnect
/// of a tunnel that was moved meanwhile included.
pub(super) fn ensure_runs_here(host: &ServiceHost) -> Result<RunsHere, TerminalError> {
    match resolve_tunnel_host(host) {
        Ok(ResolvedLocation::Local) => Ok(RunsHere(())),
        Ok(ResolvedLocation::Agent(_)) => Err(TerminalError::TunnelError(
            "Not started: this tunnel runs on an agent now. Start it again.".to_string(),
        )),
        Err(reason) => Err(TerminalError::TunnelError(reason)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(json: serde_json::Value) -> ServiceHost {
        serde_json::from_value(json).unwrap()
    }

    /// S3 (#2155): a desktop-hosted tunnel routes to the local forwarder path.
    #[test]
    fn this_computer_host_routes_local() {
        for here in [ServiceHost::default(), ServiceHost::this_computer()] {
            assert_eq!(resolve_tunnel_host(&here), Ok(ResolvedLocation::Local));
            assert!(ensure_runs_here(&here).is_ok());
        }
    }

    /// S3 (#2185): an agent-hosted tunnel resolves to its agent, so `start_tunnel`
    /// routes hosting to that agent over the agent RPC rather than the desktop.
    /// #6028: no path may open it here instead, a reconnect included.
    #[test]
    fn agent_host_routes_to_the_agent_and_never_here() {
        let agent = ServiceHost::agent("build-box");
        assert_eq!(
            resolve_tunnel_host(&agent),
            Ok(ResolvedLocation::Agent("build-box".to_string()))
        );
        let err = ensure_runs_here(&agent).expect_err("not here");
        assert!(err.to_string().contains("runs on an agent"), "{err}");
    }

    /// #6028: a host this build cannot read is refused with a reason, not run here.
    #[test]
    fn an_unreadable_host_is_refused_everywhere() {
        for unreadable in [
            serde_json::Value::Null,
            serde_json::json!("build-box"),
            serde_json::json!({"kind": "agent"}),
            serde_json::json!({"kind": "cluster", "clusterId": "a"}),
            serde_json::json!({"kind": "thisComputer", "jail": "/srv"}),
        ] {
            let host = host(unreadable);
            let reason = resolve_tunnel_host(&host).expect_err("unreadable");
            assert!(reason.contains("cannot read where it runs"), "{reason}");
            assert!(ensure_runs_here(&host).is_err());
        }
    }
}

//! Run-location resolver: route a service/tool invocation to the local
//! registry or a remote agent proxy.
//!
//! Part of the stateless-UI / agent-empowerment S-track (S1, part of #2139).
//! The [`Service`](termihub_core::service::Service) /
//! [`Tool`](termihub_core::tool::Tool) traits let a service or network tool run
//! on the desktop **or** a remote agent behind one uniform abstraction. This
//! module is the desktop-side piece that decides *where*:
//!
//! * `run here` → the local `ServiceRegistry` / `ToolRegistry`;
//! * `run there` → the agent, driven through the same JSON-RPC proxy sessions
//!   already use (extended with the `service.*` / `tool.*` namespaces).
//!
//! # S1 behaviour — local by default
//!
//! For S1 there is **no behaviour change for users**: every invocation resolves
//! to [`ResolvedLocation::Local`] unless the caller explicitly asks for an
//! agent, and the run-location *selector UI* that would let them do so is S2.
//! So in practice everything runs locally today, exactly as before.
//!
//! # The desktop-only boundary
//!
//! Some capabilities are permanently desktop-host and must never be offered an
//! agent (concept Open Design Decision #4): credentials / keychain, spawn
//! rendezvous, local file watch, and OS-window management. The resolver refuses
//! an agent run-location for anything marked [`Locality::DesktopOnly`], and
//! [`available_locations`](RunLocationResolver::available_locations) omits the
//! agent options for it, so the selector cannot present a choice that must not
//! exist.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Where the user asked a service/tool to run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "agentId")]
pub enum RunLocation {
    /// The desktop host — "This computer". The default.
    #[default]
    ThisComputer,
    /// A named remote agent.
    Agent(String),
}

/// Whether a capability may run remotely, or is permanently desktop-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Locality {
    /// Can run on the desktop or any reachable agent.
    LocalOrAgent,
    /// Must run on the desktop host (credentials, spawn rendezvous, local file
    /// watch, OS-window management). Never offered an agent.
    DesktopOnly,
}

/// The resolved execution target for an invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "target", content = "agentId")]
pub enum ResolvedLocation {
    /// Run against the local (desktop) registry.
    Local,
    /// Run against the named agent via the JSON-RPC proxy.
    Agent(String),
}

/// Why a requested run-location could not be honoured.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RunLocationError {
    /// An agent was requested for a capability that is permanently desktop-only.
    #[error("'{capability}' is desktop-only and cannot run on an agent")]
    AgentNotAllowed {
        /// The service/tool id that was requested on an agent.
        capability: String,
    },
}

/// Routes service/tool invocations to the local registry or an agent proxy.
///
/// Stateless in S1: the agent inventory and the persisted per-capability
/// preference arrive with the selector UI in S2. Today it encodes the two
/// rules that hold regardless of UI — default-local, and the desktop-only
/// boundary.
#[derive(Debug, Default, Clone, Copy)]
pub struct RunLocationResolver;

impl RunLocationResolver {
    /// Create a resolver.
    pub fn new() -> Self {
        Self
    }

    /// Resolve an explicit run-location request for a capability.
    ///
    /// * [`RunLocation::ThisComputer`] always resolves to
    ///   [`ResolvedLocation::Local`].
    /// * [`RunLocation::Agent`] resolves to [`ResolvedLocation::Agent`] **only**
    ///   when the capability is [`Locality::LocalOrAgent`]; a
    ///   [`Locality::DesktopOnly`] capability yields
    ///   [`RunLocationError::AgentNotAllowed`].
    pub fn resolve(
        &self,
        capability: &str,
        locality: Locality,
        requested: &RunLocation,
    ) -> Result<ResolvedLocation, RunLocationError> {
        match requested {
            RunLocation::ThisComputer => Ok(ResolvedLocation::Local),
            RunLocation::Agent(agent_id) => match locality {
                Locality::LocalOrAgent => Ok(ResolvedLocation::Agent(agent_id.clone())),
                Locality::DesktopOnly => Err(RunLocationError::AgentNotAllowed {
                    capability: capability.to_string(),
                }),
            },
        }
    }

    /// Resolve using the S1 default when no explicit choice is made.
    ///
    /// Always [`ResolvedLocation::Local`] — the honest S1 behaviour, since the
    /// selector that would record a non-default choice is S2. Provided so call
    /// sites can adopt the resolver now and get today's local execution without
    /// special-casing "no preference".
    pub fn resolve_default(&self) -> ResolvedLocation {
        ResolvedLocation::Local
    }

    /// The run-locations the selector may offer for a capability.
    ///
    /// Always includes [`RunLocation::ThisComputer`]. For a
    /// [`Locality::LocalOrAgent`] capability each reachable agent is appended;
    /// for a [`Locality::DesktopOnly`] capability the agents are omitted, so the
    /// UI never presents a forbidden choice.
    pub fn available_locations(&self, locality: Locality, agents: &[String]) -> Vec<RunLocation> {
        let mut locations = vec![RunLocation::ThisComputer];
        if locality == Locality::LocalOrAgent {
            locations.extend(agents.iter().cloned().map(RunLocation::Agent));
        }
        locations
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_computer_resolves_local() {
        let r = RunLocationResolver::new();
        assert_eq!(
            r.resolve("ping", Locality::LocalOrAgent, &RunLocation::ThisComputer),
            Ok(ResolvedLocation::Local)
        );
        // Desktop-only on "this computer" is fine too.
        assert_eq!(
            r.resolve(
                "credentials",
                Locality::DesktopOnly,
                &RunLocation::ThisComputer
            ),
            Ok(ResolvedLocation::Local)
        );
    }

    #[test]
    fn default_is_local() {
        // S1: no explicit choice → local, so users see no behaviour change.
        assert_eq!(
            RunLocationResolver::new().resolve_default(),
            ResolvedLocation::Local
        );
        // And the default RunLocation is This computer.
        assert_eq!(RunLocation::default(), RunLocation::ThisComputer);
    }

    #[test]
    fn remotable_capability_resolves_to_agent() {
        let r = RunLocationResolver::new();
        let requested = RunLocation::Agent("build-server".to_string());
        assert_eq!(
            r.resolve("port_scan", Locality::LocalOrAgent, &requested),
            Ok(ResolvedLocation::Agent("build-server".to_string()))
        );
    }

    #[test]
    fn desktop_only_capability_refuses_agent() {
        let r = RunLocationResolver::new();
        let requested = RunLocation::Agent("build-server".to_string());
        assert_eq!(
            r.resolve("credentials", Locality::DesktopOnly, &requested),
            Err(RunLocationError::AgentNotAllowed {
                capability: "credentials".to_string()
            })
        );
    }

    #[test]
    fn available_locations_includes_agents_only_when_remotable() {
        let r = RunLocationResolver::new();
        let agents = vec!["a1".to_string(), "a2".to_string()];

        let remotable = r.available_locations(Locality::LocalOrAgent, &agents);
        assert_eq!(
            remotable,
            vec![
                RunLocation::ThisComputer,
                RunLocation::Agent("a1".to_string()),
                RunLocation::Agent("a2".to_string()),
            ]
        );

        // Desktop-only: only "This computer", never an agent.
        let desktop_only = r.available_locations(Locality::DesktopOnly, &agents);
        assert_eq!(desktop_only, vec![RunLocation::ThisComputer]);
    }

    #[test]
    fn run_location_serde_is_tagged() {
        let json = serde_json::to_value(RunLocation::Agent("x".to_string())).unwrap();
        assert_eq!(json["kind"], "agent");
        assert_eq!(json["agentId"], "x");
        let back: RunLocation = serde_json::from_value(json).unwrap();
        assert_eq!(back, RunLocation::Agent("x".to_string()));
    }
}

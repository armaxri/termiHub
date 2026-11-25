//! What the row of an agent-hosted tunnel says (#6028).

use serde_json::json;
use termihub_core::util::service_cause::ServiceCause;

use super::*;
use crate::tunnel::config::{LocalForwardConfig, TunnelType};

struct Words;

impl Reasons for Words {
    fn waiting(&self, on: &WaitFor, until: DateTime<Local>) -> Reason {
        Reason::new(
            format!("waiting {on:?} {}", until.timestamp()),
            Some(ServiceCause::StoreLocked),
        )
    }
    fn stopping(&self, agent_id: &str) -> Reason {
        format!("stopping {agent_id}").into()
    }
    fn not_reachable(&self, agent_id: &str, why: Away) -> Reason {
        Reason::new(
            format!("away {agent_id} {why:?}"),
            Some(ServiceCause::AgentOffline),
        )
    }
}

fn config() -> TunnelConfig {
    TunnelConfig {
        id: "t".into(),
        name: "Tunnel".into(),
        description: None,
        ssh_connection_id: "c".into(),
        tunnel_type: TunnelType::Local(LocalForwardConfig {
            local_host: "127.0.0.1".into(),
            local_port: 5432,
            remote_host: "db".into(),
            remote_port: 5432,
        }),
        host: termihub_core::util::service_host::ServiceHost::agent("edge"),
        auto_start: false,
        start_with_connection: false,
        reconnect_on_disconnect: false,
        companion_of: None,
        extra: Default::default(),
    }
}

fn busy() -> HostedTunnel {
    HostedTunnel {
        bound_address: "127.0.0.1:5432".into(),
        reachable_from: ReachableFrom::AgentOnly,
        stats: TunnelStats {
            bytes_sent: 9,
            ..TunnelStats::default()
        },
    }
}

fn row(view: View<HostedTunnel>) -> TunnelState {
    tunnel_state(&config(), view, &Words)
}

#[test]
fn a_running_tunnel_says_where_it_is_bound() {
    let state = row(View::Running {
        agent_id: "edge".into(),
        state: busy(),
    });
    assert_eq!(state.status, TunnelStatus::Connected);
    assert_eq!(state.bound_on.as_deref(), Some("edge"));
    assert_eq!(state.bound_address.as_deref(), Some("127.0.0.1:5432"));
    assert_eq!(state.reachable_from, Some(ReachableFrom::AgentOnly));
    assert_eq!(state.stats.bytes_sent, 9);
    assert_eq!(state.error, None);
}

#[test]
fn a_tunnel_that_is_not_reachable_claims_no_address_and_no_traffic() {
    for why in [Away::Offline, Away::Silent, Away::StartUnanswered] {
        let state = row(View::NotReachable {
            agent_id: "edge".into(),
            state: busy(),
            why,
        });
        assert_eq!(state.status, TunnelStatus::NotReachable);
        assert_eq!(state.error, Some(format!("away edge {why:?}")));
        assert_eq!(state.bound_on.as_deref(), Some("edge"));
        assert_eq!(state.bound_address, None);
        assert_eq!(state.reachable_from, None);
        assert_eq!(state.stats.bytes_sent, 0);
    }
}

#[test]
fn the_other_states_say_what_they_wait_for() {
    let state = row(View::Waiting {
        on: WaitFor::CredentialStore,
        until: DateTime::from_timestamp(1700, 0).unwrap().into(),
    });
    assert_eq!(state.status, TunnelStatus::Waiting);
    assert_eq!(state.error.as_deref(), Some("waiting CredentialStore 1700"));
    assert_eq!(state.cause, Some(ServiceCause::StoreLocked));
    let state = row(View::Stopping {
        agent_id: "edge".into(),
    });
    assert_eq!(state.status, TunnelStatus::Stopping);
    assert_eq!(state.error.as_deref(), Some("stopping edge"));
    assert_eq!(state.cause, None);
    let state = row(View::Starting);
    assert_eq!(state.status, TunnelStatus::Connecting);
    assert_eq!(state.error, None);
}

/// The wire form the frontend reads, for every status.
#[test]
fn every_status_has_its_wire_name() {
    for (status, wire) in [
        (TunnelStatus::Disconnected, "disconnected"),
        (TunnelStatus::Waiting, "waiting"),
        (TunnelStatus::Connecting, "connecting"),
        (TunnelStatus::Connected, "connected"),
        (TunnelStatus::Reconnecting, "reconnecting"),
        (TunnelStatus::Stopping, "stopping"),
        (TunnelStatus::Error, "error"),
        (TunnelStatus::NotReachable, "notReachable"),
        (TunnelStatus::MissingConnection, "missingConnection"),
    ] {
        assert_eq!(serde_json::to_value(status).unwrap(), json!(wire));
    }
}

#[test]
fn a_status_reply_is_read_over_what_was_known() {
    let last = busy();
    let full = json!({
        "running": true,
        "stats": {"bytesSent": 2048, "bytesReceived": 4096, "activeConnections": 3, "totalConnections": 7},
        "boundAddress": "0.0.0.0:1",
        "reachableFrom": "agentOnly"
    });
    let Reading::Running(read) = HostedTunnels::read_status("t", &full, &last) else {
        panic!("running");
    };
    assert_eq!(read.stats.bytes_sent, 2048);
    assert_eq!(read.stats.bytes_received, 4096);
    assert_eq!(read.stats.active_connections, 3);
    assert_eq!(read.stats.total_connections, 7);
    assert_eq!(read.bound_address, "0.0.0.0:1");
    assert!(HostedTunnels::is_news(&last, &read));
    // What an answer leaves out stays as it was, rather than flickering to zero.
    assert_eq!(
        HostedTunnels::read_status("t", &json!({"running": true}), &last),
        Reading::Running(last.clone())
    );
    assert_eq!(
        HostedTunnels::read_status("t", &json!({"running": false}), &last),
        Reading::NotRunning
    );
    assert_eq!(
        HostedTunnels::read_status("t", &json!(null), &last),
        Reading::Unreadable
    );
}

#[test]
fn a_start_reply_without_an_address_never_over_promises() {
    assert_eq!(
        HostedTunnel::from_start_reply(json!(null)),
        HostedTunnel::default()
    );
    let read = HostedTunnel::from_start_reply(
        json!({"boundAddress": "127.0.0.1:1", "reachableFrom": "agentOnly"}),
    );
    assert_eq!(read.bound_address, "127.0.0.1:1");
}

//! Tests for the tunnel cascade on SSH-connection delete (#2850).
//!
//! The production [`TunnelManager`](crate::tunnel::tunnel_manager::TunnelManager)
//! needs a live `Wry` app handle, so — like the rest of the tunnel tests — the
//! cascade is driven through the runtime-independent [`ConnectionRefs`] against
//! an in-memory [`TunnelControl`] that records every stop. The projection half
//! publishes through the real [`Projector`] with the production view shape.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::*;
use crate::projection::{
    apply_ops, DiffFrame, ProjectionError, ProjectionFrame, ProjectionSink, Projector,
};
use crate::tunnel::config::{
    LocalForwardConfig, TunnelConfig, TunnelState, TunnelStats, TunnelStatus, TunnelType,
};
use crate::tunnel::projection::{tunnel_view_from, TUNNELS_REGION};

// ── Fixtures ─────────────────────────────────────────────────────────────────

fn tunnel(id: &str, ssh_connection_id: &str) -> TunnelConfig {
    TunnelConfig {
        id: id.to_string(),
        name: format!("Tunnel {id}"),
        ssh_connection_id: ssh_connection_id.to_string(),
        tunnel_type: TunnelType::Local(LocalForwardConfig {
            local_host: "127.0.0.1".to_string(),
            local_port: 5432,
            remote_host: "db.internal".to_string(),
            remote_port: 5432,
        }),
        host: crate::run_location::RunLocation::ThisComputer,
        auto_start: false,
        start_with_connection: false,
        reconnect_on_disconnect: false,
        companion_of: None,
    }
}

fn ids(list: &[&str]) -> HashSet<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// An in-memory tunnel authority: saved configs plus the set of running ids.
/// `stop` records the call and drops the tunnel from the running set, the way
/// the real manager's `stop_tunnel` does.
struct FakeControl {
    configs: Mutex<Vec<TunnelConfig>>,
    running: Mutex<HashSet<String>>,
    stopped: Mutex<Vec<String>>,
}

impl FakeControl {
    fn new(configs: Vec<TunnelConfig>, running: &[&str]) -> Self {
        Self {
            configs: Mutex::new(configs),
            running: Mutex::new(ids(running)),
            stopped: Mutex::new(Vec::new()),
        }
    }

    fn stopped(&self) -> Vec<String> {
        self.stopped.lock().unwrap().clone()
    }

    /// Re-point a saved tunnel at another SSH connection (the editor's save).
    fn repoint(&self, tunnel_id: &str, ssh_connection_id: &str) {
        for t in self.configs.lock().unwrap().iter_mut() {
            if t.id == tunnel_id {
                t.ssh_connection_id = ssh_connection_id.to_string();
            }
        }
    }

    fn config(&self, tunnel_id: &str) -> TunnelConfig {
        self.configs
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.id == tunnel_id)
            .cloned()
            .unwrap()
    }

    /// The production view shape: a running tunnel reports `Connected`, a
    /// resting one whatever [`ConnectionRefs::resting_status`] derives.
    fn view(&self, refs: &ConnectionRefs) -> Value {
        let configs = self.configs.lock().unwrap().clone();
        let running = self.running.lock().unwrap().clone();
        let states = configs
            .iter()
            .map(|c| {
                let status = if running.contains(&c.id) {
                    TunnelStatus::Connected
                } else {
                    refs.resting_status(c).unwrap_or(TunnelStatus::Disconnected)
                };
                TunnelState::desktop(c.id.clone(), status, None, TunnelStats::default())
            })
            .collect();
        tunnel_view_from(configs, states)
    }
}

impl TunnelControl for FakeControl {
    fn tunnel_configs(&self) -> Vec<TunnelConfig> {
        self.configs.lock().unwrap().clone()
    }

    fn is_running(&self, tunnel_id: &str) -> bool {
        self.running.lock().unwrap().contains(tunnel_id)
    }

    fn stop(&self, tunnel_id: &str) {
        self.running.lock().unwrap().remove(tunnel_id);
        self.stopped.lock().unwrap().push(tunnel_id.to_string());
    }
}

// ── The cascade ──────────────────────────────────────────────────────────────

#[test]
fn nothing_is_unresolved_before_the_connections_are_known() {
    // Startup safety: until the first reconcile the manager has not seen the
    // connection list, so no tunnel may be flagged (or refused) on a guess.
    let refs = ConnectionRefs::default();
    let t = tunnel("t1", "gone");
    assert!(!refs.is_unresolved(&t.ssh_connection_id));
    assert!(refs.ensure_resolved(&t).is_ok());
    assert_eq!(refs.resting_status(&t), None);
}

#[test]
fn deleting_the_referenced_connection_stops_a_running_tunnel_and_marks_it_unresolved() {
    let refs = ConnectionRefs::default();
    let control = FakeControl::new(vec![tunnel("t1", "ssh-a")], &["t1"]);
    assert!(refs
        .reconcile(ids(&["ssh-a", "ssh-b"]), &control)
        .is_empty());

    // `ssh-a` is deleted.
    let stopped = refs.reconcile(ids(&["ssh-b"]), &control);

    assert_eq!(stopped, vec!["t1".to_string()]);
    assert_eq!(control.stopped(), vec!["t1".to_string()]);
    assert!(!control.is_running("t1"));
    // The config is kept, marked unresolved.
    assert_eq!(control.tunnel_configs().len(), 1);
    let t = control.config("t1");
    assert!(refs.is_unresolved(&t.ssh_connection_id));
    assert_eq!(
        refs.resting_status(&t),
        Some(TunnelStatus::MissingConnection)
    );
}

#[test]
fn a_resting_tunnel_is_marked_unresolved_without_a_stop() {
    let refs = ConnectionRefs::default();
    let control = FakeControl::new(vec![tunnel("t1", "ssh-a")], &[]);
    refs.reconcile(ids(&["ssh-a"]), &control);

    refs.reconcile(ids(&[]), &control);

    assert!(control.stopped().is_empty(), "nothing was running");
    assert_eq!(
        refs.resting_status(&control.config("t1")),
        Some(TunnelStatus::MissingConnection)
    );
}

#[test]
fn a_bulk_delete_cascades_to_every_referencing_tunnel() {
    let refs = ConnectionRefs::default();
    let control = FakeControl::new(
        vec![
            tunnel("t1", "ssh-a"),
            tunnel("t2", "ssh-b"),
            tunnel("t3", "ssh-b"),
            tunnel("t4", "ssh-c"),
        ],
        &["t1", "t2", "t4"],
    );
    refs.reconcile(ids(&["ssh-a", "ssh-b", "ssh-c"]), &control);

    // `ssh-a` and `ssh-b` are deleted in one bulk operation.
    let mut stopped = refs.reconcile(ids(&["ssh-c"]), &control);
    stopped.sort();

    assert_eq!(stopped, vec!["t1".to_string(), "t2".to_string()]);
    for id in ["t1", "t2", "t3"] {
        assert_eq!(
            refs.resting_status(&control.config(id)),
            Some(TunnelStatus::MissingConnection),
            "{id} references a deleted connection"
        );
    }
    assert!(control.is_running("t4"), "the unrelated tunnel keeps running");
    assert_eq!(refs.resting_status(&control.config("t4")), None);
}

#[test]
fn an_unrelated_delete_leaves_tunnels_untouched() {
    let refs = ConnectionRefs::default();
    let control = FakeControl::new(vec![tunnel("t1", "ssh-a"), tunnel("t2", "ssh-a")], &["t1"]);
    refs.reconcile(ids(&["ssh-a", "ssh-b"]), &control);

    let stopped = refs.reconcile(ids(&["ssh-a"]), &control);

    assert!(stopped.is_empty());
    assert!(control.stopped().is_empty());
    assert!(control.is_running("t1"));
    assert_eq!(refs.resting_status(&control.config("t2")), None);
}

#[test]
fn starting_an_unresolved_tunnel_is_refused() {
    let refs = ConnectionRefs::default();
    let control = FakeControl::new(vec![tunnel("t1", "ssh-a")], &[]);
    refs.reconcile(ids(&[]), &control);

    let err = refs
        .ensure_resolved(&control.config("t1"))
        .expect_err("an unresolved tunnel must not start");
    let message = err.to_string();
    assert!(message.contains("ssh-a"), "{message}");
    assert!(message.contains("deleted"), "{message}");
}

#[test]
fn repointing_at_an_existing_connection_resolves_the_tunnel() {
    let refs = ConnectionRefs::default();
    let control = FakeControl::new(vec![tunnel("t1", "ssh-a")], &[]);
    refs.reconcile(ids(&["ssh-b"]), &control);
    assert!(refs.ensure_resolved(&control.config("t1")).is_err());

    control.repoint("t1", "ssh-b");

    let t = control.config("t1");
    assert!(refs.ensure_resolved(&t).is_ok());
    assert_eq!(refs.resting_status(&t), None);
}

#[test]
fn a_connection_that_comes_back_resolves_the_tunnel() {
    // An external connection file that is disabled and re-enabled drops and
    // restores its connections; the tunnel follows without a repoint.
    let refs = ConnectionRefs::default();
    let control = FakeControl::new(vec![tunnel("t1", "ext-ssh")], &[]);
    refs.reconcile(ids(&[]), &control);
    assert!(refs.is_unresolved("ext-ssh"));

    refs.reconcile(ids(&["ext-ssh"]), &control);

    assert!(!refs.is_unresolved("ext-ssh"));
}

// ── The `tunnels` projection ─────────────────────────────────────────────────

struct VecSink {
    frames: Mutex<Vec<ProjectionFrame>>,
}

impl VecSink {
    fn new() -> Self {
        Self {
            frames: Mutex::new(Vec::new()),
        }
    }

    fn diffs(&self) -> Vec<DiffFrame> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter_map(|f| match f {
                ProjectionFrame::Diff(d) => Some(d.clone()),
                ProjectionFrame::Snapshot(_) => None,
            })
            .collect()
    }
}

impl ProjectionSink for VecSink {
    fn deliver(&self, frame: &ProjectionFrame) -> Result<(), ProjectionError> {
        self.frames.lock().unwrap().push(frame.clone());
        Ok(())
    }
}

#[test]
fn a_second_subscriber_sees_the_unresolved_state_and_its_repair() {
    let refs = ConnectionRefs::default();
    let control = FakeControl::new(vec![tunnel("t1", "ssh-a")], &["t1"]);
    refs.reconcile(ids(&["ssh-a", "ssh-b"]), &control);

    let projector = Arc::new(Projector::new());
    projector.register_region(TUNNELS_REGION, control.view(&refs));
    let deleting_client = Arc::new(VecSink::new());
    let other_client = Arc::new(VecSink::new());
    projector.subscribe(TUNNELS_REGION, "sub-a", "A", deleting_client);
    let snap = projector.subscribe(TUNNELS_REGION, "sub-b", "B", other_client.clone());
    assert_eq!(snap.view["states"]["t1"]["status"], json!("connected"));
    let mut view = snap.view.clone();

    // The connection is deleted (by client A); the cascade publishes once.
    refs.reconcile(ids(&["ssh-b"]), &control);
    projector.publish_with(TUNNELS_REGION, || control.view(&refs));

    let diffs = other_client.diffs();
    assert_eq!(diffs.len(), 1);
    apply_ops(&mut view, &diffs[0].ops).unwrap();
    assert_eq!(view["states"]["t1"]["status"], json!("missingConnection"));
    // The config is kept, still pointing at the deleted id.
    assert_eq!(view["tunnels"][0]["sshConnectionId"], json!("ssh-a"));

    // Repointing resolves it for the other client too.
    control.repoint("t1", "ssh-b");
    projector.publish_with(TUNNELS_REGION, || control.view(&refs));
    let diffs = other_client.diffs();
    assert_eq!(diffs.len(), 2);
    apply_ops(&mut view, &diffs[1].ops).unwrap();
    assert_eq!(view["states"]["t1"]["status"], json!("disconnected"));
    assert_eq!(view["tunnels"][0]["sshConnectionId"], json!("ssh-b"));
}

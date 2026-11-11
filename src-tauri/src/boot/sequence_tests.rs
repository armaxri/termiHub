//! Ordering invariants of [`run_setup_phases`], asserted through a recorded
//! trace (#5311). No app is built: a recording [`BootPhases`] stands in for the
//! real phases.

use std::path::{Path, PathBuf};

use super::*;

/// A [`BootPhases`] that records each call (and what it was handed) in order.
/// Each warnings-taking phase pushes one warning named after itself, so the
/// accumulator's threading shows up in what `finalize` receives.
#[derive(Default)]
struct Recorder {
    trace: Vec<String>,
    finalized_with: Option<(Vec<String>, PathBuf)>,
}

fn warn(warnings: &mut Vec<RecoveryWarning>, phase: &str) {
    warnings.push(RecoveryWarning {
        file_name: phase.to_string(),
        message: format!("from {phase}"),
        details: None,
    });
}

const CONFIG_DIR: &str = "/boot-trace/config";

impl BootPhases for Recorder {
    type Registry = &'static str;

    fn platform_and_capture(&mut self) {
        self.trace.push("platform_and_capture".into());
    }

    fn config_dir(&mut self, warnings: &mut Vec<RecoveryWarning>) -> PathBuf {
        self.trace.push("config_dir".into());
        warn(warnings, "config_dir");
        PathBuf::from(CONFIG_DIR)
    }

    fn plugin_host(&mut self, config_dir: &Path) -> Self::Registry {
        self.trace
            .push(format!("plugin_host({})", config_dir.display()));
        "registry"
    }

    fn network(&mut self, config_dir: PathBuf, warnings: &mut Vec<RecoveryWarning>) {
        self.trace
            .push(format!("network({})", config_dir.display()));
        warn(warnings, "network");
    }

    fn credentials_and_connections(
        &mut self,
        config_dir: PathBuf,
        warnings: &mut Vec<RecoveryWarning>,
    ) {
        self.trace.push(format!(
            "credentials_and_connections({})",
            config_dir.display()
        ));
        warn(warnings, "credentials_and_connections");
    }

    fn session_managers(&mut self, registry: Self::Registry, warnings: &mut Vec<RecoveryWarning>) {
        self.trace.push(format!("session_managers({registry})"));
        warn(warnings, "session_managers");
    }

    fn tunnels(&mut self, warnings: &mut Vec<RecoveryWarning>) {
        self.trace.push("tunnels".into());
        warn(warnings, "tunnels");
    }

    fn projection(&mut self) {
        self.trace.push("projection".into());
    }

    fn secondary_managers(&mut self, warnings: &mut Vec<RecoveryWarning>) {
        self.trace.push("secondary_managers".into());
        warn(warnings, "secondary_managers");
    }

    fn spawn_ipc(&mut self) {
        self.trace.push("spawn_ipc".into());
    }

    fn finalize(&mut self, warnings: Vec<RecoveryWarning>, connections_file: PathBuf) {
        self.trace.push("finalize".into());
        self.finalized_with = Some((
            warnings.into_iter().map(|w| w.file_name).collect(),
            connections_file,
        ));
    }
}

fn run() -> Recorder {
    let mut recorder = Recorder::default();
    run_setup_phases(&mut recorder);
    recorder
}

#[test]
fn phases_run_in_the_documented_order() {
    let config = Path::new(CONFIG_DIR).display().to_string();
    assert_eq!(
        run().trace,
        vec![
            "platform_and_capture".to_string(),
            "config_dir".to_string(),
            format!("plugin_host({config})"),
            format!("network({config})"),
            format!("credentials_and_connections({config})"),
            "session_managers(registry)".to_string(),
            "tunnels".to_string(),
            "projection".to_string(),
            "secondary_managers".to_string(),
            "spawn_ipc".to_string(),
            "finalize".to_string(),
        ]
    );
}

#[test]
fn every_phase_storing_state_sees_the_resolved_config_dir() {
    // The ConfigDirOverride is resolved first; every later storage phase is
    // handed that same directory (not a re-resolved one).
    let trace = run().trace;
    let config_pos = trace.iter().position(|p| p == "config_dir").unwrap();
    for phase in ["plugin_host", "network", "credentials_and_connections"] {
        let pos = trace
            .iter()
            .position(|p| p.starts_with(phase))
            .unwrap_or_else(|| panic!("{phase} never ran"));
        assert!(pos > config_pos, "{phase} ran before the config dir");
        assert!(trace[pos].contains(CONFIG_DIR), "{phase}: {}", trace[pos]);
    }
}

#[test]
fn the_registry_from_the_plugin_host_reaches_the_session_managers() {
    let trace = run().trace;
    let host = trace
        .iter()
        .position(|p| p.starts_with("plugin_host"))
        .unwrap();
    let sessions = trace
        .iter()
        .position(|p| p == "session_managers(registry)")
        .unwrap();
    assert!(host < sessions);
}

#[test]
fn tunnels_and_connections_exist_before_the_projection_seeds_them() {
    let trace = run().trace;
    let pos = |name: &str| trace.iter().position(|p| p.starts_with(name)).unwrap();
    assert!(pos("credentials_and_connections") < pos("projection"));
    assert!(pos("tunnels") < pos("projection"));
}

#[test]
fn finalize_runs_last_with_every_accumulated_warning() {
    let recorder = run();
    assert_eq!(recorder.trace.last().map(String::as_str), Some("finalize"));
    let (warnings, connections_file) = recorder.finalized_with.unwrap();
    assert_eq!(
        warnings,
        vec![
            "config_dir",
            "network",
            "credentials_and_connections",
            "session_managers",
            "tunnels",
            "secondary_managers",
        ]
    );
    assert_eq!(
        connections_file,
        Path::new(CONFIG_DIR).join("connections.json")
    );
}

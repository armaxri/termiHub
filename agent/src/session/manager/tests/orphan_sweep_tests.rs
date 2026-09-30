//! One-time sweep of pre-existing orphan session files (#2807, AGT-019
//! follow-up).
//!
//! Every test injects its **own** private sweep directory, so the sweep never
//! scans the shared per-user socket dir or probes a sibling test's live socket.
//! Live daemons are bound inside that private dir; "dead" sockets are regular
//! files at the socket path (a connect fails deterministically, unlike a
//! just-closed in-process socket, which stays transiently connectable on
//! macOS).

use super::*;
use crate::daemon::process::tests::recovery_guard::spawn_daemon;
use crate::session::orphan_sweep::OrphanSweepConfig;
use std::path::Path;
use std::time::{Duration, SystemTime};

struct NoopApplier;
impl UpdateApplier for NoopApplier {
    fn apply(&self, _pending: &PendingUpdate) -> anyhow::Result<()> {
        Ok(())
    }
}

/// A private sweep dir under `/tmp` — short enough for the unix socket path
/// limit (macOS' per-user `$TMPDIR` is not) and `0o700`, as the daemon
/// listener requires.
fn sweep_dir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("th2807-")
        // Canonical: the listener refuses a dir under a symlinked parent, and
        // macOS' `/tmp` is a symlink to `/private/tmp`.
        .tempdir_in(std::fs::canonicalize("/tmp").expect("resolve /tmp"))
        .expect("create private sweep dir")
}

fn unique(tag: &str) -> String {
    format!("o2807-{tag}-{}", uuid::Uuid::new_v4().simple())
}

fn file(dir: &Path, name: String) -> std::path::PathBuf {
    dir.join(name)
}

fn sock(dir: &Path, id: &str) -> std::path::PathBuf {
    file(dir, format!("session-{id}.sock"))
}

fn log(dir: &Path, id: &str) -> std::path::PathBuf {
    file(dir, format!("session-{id}.log"))
}

fn relay(dir: &Path, id: &str) -> std::path::PathBuf {
    file(dir, format!("session-{id}-agent.sock"))
}

fn ki(dir: &Path, id: &str) -> std::path::PathBuf {
    file(dir, format!("session-{id}-ki.sock"))
}

/// Create a regular file, back-dated by `age` so it clears the sweep's
/// minimum-age guard.
fn touch_aged(path: &Path, age: Duration) {
    let f = std::fs::File::create(path).expect("create session file");
    f.set_modified(SystemTime::now() - age)
        .expect("back-date session file");
}

/// A manager over an isolated `state.json` (seeded with `persisted` ids) whose
/// orphan sweep is scoped to `dir` with the given minimum age.
fn manager(state_dir: &Path, dir: &Path, min_age: Duration, persisted: &[&str]) -> SessionManager {
    let state_path = state_dir.join("state.json");
    let mut seeded = AgentState::default();
    for id in persisted {
        seeded.sessions.insert(
            id.to_string(),
            PersistedSession {
                type_id: "local".to_string(),
                title: "t".to_string(),
                created_at: Utc::now().to_rfc3339(),
                daemon_socket: Some(sock(dir, id).to_string_lossy().into_owned()),
                settings: serde_json::json!({}),
                definition_id: None,
            },
        );
    }
    seeded.save_to(&state_path);
    SessionManager::with_test_deps(
        test_notification_tx(),
        test_registry(),
        Arc::new(SystemDaemonLauncher),
        state_path,
        Arc::new(NoopApplier),
    )
    .with_orphan_sweep(Some(OrphanSweepConfig {
        dir: dir.to_path_buf(),
        min_age,
    }))
}

const OLD: Duration = Duration::from_secs(3600);

#[tokio::test]
async fn dead_orphan_files_are_removed() {
    let dir = sweep_dir();
    let state = tempfile::tempdir().unwrap();
    let id = unique("dead");
    // Exactly what a SIGKILLed daemon whose state entry was also lost leaves.
    for p in [
        sock(dir.path(), &id),
        relay(dir.path(), &id),
        ki(dir.path(), &id),
        log(dir.path(), &id),
    ] {
        touch_aged(&p, OLD);
    }

    let mgr = manager(state.path(), dir.path(), Duration::from_secs(60), &[]);
    let report = mgr.sweep_orphan_session_files().await;

    assert_eq!(report.removed, vec![id.clone()]);
    assert!(report.kept_live.is_empty());
    for p in [
        sock(dir.path(), &id),
        relay(dir.path(), &id),
        ki(dir.path(), &id),
        log(dir.path(), &id),
    ] {
        assert!(!p.exists(), "{} must be reclaimed", p.display());
    }
}

#[tokio::test]
async fn socketless_orphan_log_is_removed_without_probing() {
    let dir = sweep_dir();
    let state = tempfile::tempdir().unwrap();
    let id = unique("logonly");
    touch_aged(&log(dir.path(), &id), OLD);

    let mgr = manager(state.path(), dir.path(), Duration::from_secs(60), &[]);
    let report = mgr.sweep_orphan_session_files().await;

    assert_eq!(report.removed, vec![id.clone()]);
    assert!(!log(dir.path(), &id).exists());
}

/// A live daemon nobody holds is kept — files untouched — and the probe
/// leaves it running unattached (a second probe still finds it free).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_free_daemon_is_never_removed() {
    let dir = sweep_dir();
    let state = tempfile::tempdir().unwrap();
    let id = unique("livefree");
    let endpoint = sock(dir.path(), &id).to_string_lossy().into_owned();
    let _daemon = spawn_daemon(&endpoint).await;
    touch_aged(&log(dir.path(), &id), OLD);

    let mgr = manager(state.path(), dir.path(), Duration::ZERO, &[]);
    let report = mgr.sweep_orphan_session_files().await;

    assert_eq!(report.kept_live, vec![id.clone()]);
    assert!(report.removed.is_empty());
    assert!(Path::new(&endpoint).exists(), "live socket must survive");
    assert!(log(dir.path(), &id).exists(), "live log must survive");
    assert_eq!(
        DaemonClient::probe_holder(&id, &endpoint).await.unwrap(),
        ProbeOutcome::Free,
        "the sweep's probe must leave the daemon running unattached"
    );
}

/// A live daemon held by another worker is kept, and its holder is never
/// evicted: the sweep probes with recovery intent, which the daemon refuses
/// (`HeldByPeer`) instead of handing the session over.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_held_daemon_is_never_removed_or_evicted() {
    let dir = sweep_dir();
    let state = tempfile::tempdir().unwrap();
    let id = unique("liveheld");
    let endpoint = sock(dir.path(), &id).to_string_lossy().into_owned();
    let _daemon = spawn_daemon(&endpoint).await;
    let holder = DaemonClient::connect(id.clone(), endpoint.clone(), test_notification_tx())
        .await
        .expect("peer attaches");

    let mgr = manager(state.path(), dir.path(), Duration::ZERO, &[]);
    let report = mgr.sweep_orphan_session_files().await;

    assert_eq!(report.kept_live, vec![id.clone()]);
    assert!(report.removed.is_empty());
    assert!(Path::new(&endpoint).exists(), "live socket must survive");
    // Give any (wrongly) triggered eviction time to land before checking.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!holder.is_evicted(), "the holder must never be evicted");
    assert_eq!(
        DaemonClient::probe_holder(&id, &endpoint).await.unwrap(),
        ProbeOutcome::HeldByPeer,
        "the original holder must still own the session"
    );
}

/// Files of a session still listed in `state.json` belong to recovery, never
/// to the sweep — even when they look dead.
#[tokio::test]
async fn sessions_in_state_are_left_to_recovery() {
    let dir = sweep_dir();
    let state = tempfile::tempdir().unwrap();
    let id = unique("known");
    touch_aged(&sock(dir.path(), &id), OLD);
    touch_aged(&log(dir.path(), &id), OLD);

    let mgr = manager(state.path(), dir.path(), Duration::from_secs(60), &[&id]);
    let report = mgr.sweep_orphan_session_files().await;

    assert!(report.removed.is_empty() && report.kept_live.is_empty());
    assert!(sock(dir.path(), &id).exists());
    assert!(log(dir.path(), &id).exists());
}

/// Recently written files may belong to a create in flight (the daemon has
/// bound its socket but the worker has not persisted its state entry yet), so
/// they are neither probed nor removed.
#[tokio::test]
async fn recent_files_are_left_alone() {
    let dir = sweep_dir();
    let state = tempfile::tempdir().unwrap();
    let id = unique("fresh");
    touch_aged(&sock(dir.path(), &id), Duration::ZERO);
    touch_aged(&log(dir.path(), &id), OLD);

    let mgr = manager(state.path(), dir.path(), Duration::from_secs(60), &[]);
    let report = mgr.sweep_orphan_session_files().await;

    assert!(report.removed.is_empty() && report.kept_live.is_empty());
    assert!(sock(dir.path(), &id).exists());
    assert!(log(dir.path(), &id).exists());
}

/// Non-session files in the dir (the registry's socket and log, strays) are
/// never touched.
#[tokio::test]
async fn non_session_files_are_ignored() {
    let dir = sweep_dir();
    let state = tempfile::tempdir().unwrap();
    for name in [
        "registry.sock",
        "registry.log",
        "session-.sock",
        "notes.txt",
    ] {
        touch_aged(&dir.path().join(name), OLD);
    }

    let mgr = manager(state.path(), dir.path(), Duration::from_secs(60), &[]);
    let report = mgr.sweep_orphan_session_files().await;

    assert!(report.removed.is_empty() && report.kept_live.is_empty());
    for name in [
        "registry.sock",
        "registry.log",
        "session-.sock",
        "notes.txt",
    ] {
        assert!(dir.path().join(name).exists(), "{name} must be untouched");
    }
}

/// A test-built manager has no sweep dir: the sweep is a no-op and never
/// reads the shared per-user socket dir.
#[tokio::test]
async fn sweep_is_disabled_unless_a_dir_is_injected() {
    let state = tempfile::tempdir().unwrap();
    let mgr = SessionManager::with_test_deps(
        test_notification_tx(),
        test_registry(),
        Arc::new(SystemDaemonLauncher),
        state.path().join("state.json"),
        Arc::new(NoopApplier),
    );
    let report = mgr.sweep_orphan_session_files().await;
    assert!(report.removed.is_empty() && report.kept_live.is_empty());
}

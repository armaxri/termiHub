//! Optional agent-side GitHub self-update (#1355, Approach 1 of the remote-agent
//! update strategy).
//!
//! When enabled via `allow_self_update` (off by default), the agent runs a
//! background 24-hour timer that polls GitHub `releases/latest`, compares the
//! published version against its own `CARGO_PKG_VERSION`, and — when a newer
//! release exists — notifies connected desktops via an
//! [`agent.update_available`](crate::protocol::methods::AGENT_UPDATE_AVAILABLE)
//! notification. When no sessions are active it also downloads and
//! SHA-256-verifies the new binary and stages it for a later apply.
//!
//! The whole feature is gated behind `allow_self_update`: with the flag off the
//! background task is never spawned, so there is zero outbound network activity.
//! Every failure path (no internet, GitHub error, bad checksum) logs a warning
//! and skips the cycle — the agent never crashes because of a self-update check.
//!
//! # Auto-apply on idle (#1401)
//!
//! Once a verified binary is staged, this timer hands it to the shared
//! deferred-apply mechanism (SI-6, #1352) via
//! [`SessionManager::request_deferred_update`]. Because staging only happens
//! when the agent is already idle, the update is applied immediately
//! (exec-replace via the daemon survive-restart model) — but strictly gated on
//! the connection's [`UpdateStrategy`]: `immediate`/`deferred` auto-apply on
//! idle, whereas `coordinated` stages only and waits for an explicit
//! coordinated apply. Active sessions are never interrupted: if a session
//! opened between the idle check and the apply, `request_deferred_update`
//! re-checks and defers to the last-disconnect hook. A failed apply keeps the
//! pending update so a later cycle can retry.
//!
//! # Test-only hook (#1546)
//!
//! [`TestPendingUpdate`] lets a system test arm a live agent with a
//! `pending_update` and have it announce that update whenever a client attaches,
//! making the desktop banner's deferred (busy) path reachable without the 24h
//! timer or a real GitHub release. Env-gated and inert in production — see
//! [`test_hook`] for the gate, the safety argument, and how it stays clear of
//! the #1551 startup prune.

mod apply;
mod checksum;
mod download;
mod github;
mod test_hook;
mod version;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::{UpdateAvailableNotification, AGENT_UPDATE_AVAILABLE};
use crate::session::manager::SessionManager;
use crate::state::persistence::AgentState;

pub use apply::{
    prune_applied_pending_update, should_apply_deferred_update, SystemUpdateApplier, UpdateApplier,
};
pub use github::{current_asset_suffix, DEFAULT_REPO};
pub use test_hook::TestPendingUpdate;

/// Default interval between self-update checks (24 hours).
pub const DEFAULT_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// Timeout for a single GitHub API / download request.
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// How a staged agent self-update is applied once the agent goes idle (#1401).
///
/// Mirrors the desktop-side `RemoteAgentConfig.update_strategy` (#1354). The
/// agent receives its configured value via the `--update-strategy` CLI flag and
/// uses it purely to gate whether a *self-downloaded* update may auto-apply when
/// the last session disconnects. It does not affect desktop-driven redeploys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UpdateStrategy {
    /// Apply as soon as the agent is idle (the default).
    #[default]
    Immediate,
    /// Broadcast to connected hosts and wait for an explicit coordinated apply
    /// (SI-5). A staged self-update is recorded but never auto-applied on idle.
    Coordinated,
    /// Apply when the last session disconnects.
    Deferred,
}

impl UpdateStrategy {
    /// Parse the value passed on the `--update-strategy` CLI flag. Unknown or
    /// missing values fall back to [`UpdateStrategy::Immediate`].
    pub fn from_cli(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "coordinated" => Self::Coordinated,
            "deferred" => Self::Deferred,
            _ => Self::Immediate,
        }
    }

    /// Whether a staged self-update may be auto-applied once the agent is idle.
    ///
    /// `immediate` and `deferred` both converge to "apply when no sessions are
    /// active"; `coordinated` waits for an explicit coordinated apply (SI-5) and
    /// must never auto-apply.
    pub fn auto_applies_when_idle(self) -> bool {
        matches!(self, Self::Immediate | Self::Deferred)
    }
}

/// Configuration for the self-update background task.
///
/// Field-level overrides (`api_url`, `asset_suffix`, `staging_dir`) exist so
/// the check cycle can be unit tested against a mock HTTP server and a
/// temporary staging dir. All persisted `update` state (last-check time, staged
/// pending update) is owned by the [`SessionManager`] so the self-update timer
/// and the #1352 deferred-apply path share a single source of truth. Production
/// callers build defaults via [`UpdateConfig::from_env`].
#[derive(Debug, Clone)]
pub struct UpdateConfig {
    /// Master gate — when `false` the background task is never spawned.
    pub allow_self_update: bool,
    /// Delay before the *first* check runs. Zero in production (the first check
    /// fires immediately on spawn); the live-agent integration test
    /// (`agent/tests/self_update_integration.rs`) uses a non-zero value so it can
    /// establish a session before the poll fires. See [`UpdateConfig::from_env`].
    pub initial_delay: Duration,
    /// Interval between checks.
    pub check_interval: Duration,
    /// GitHub `releases/latest` API URL.
    pub api_url: String,
    /// The agent's own version (`CARGO_PKG_VERSION`).
    pub current_version: String,
    /// Published asset suffix for this platform (e.g. `"linux-x64"`), or `None`
    /// on a platform with no published agent binary.
    pub asset_suffix: Option<String>,
    /// Directory a verified update binary is staged into.
    pub staging_dir: PathBuf,
    /// `User-Agent` header sent to the GitHub API (GitHub requires one).
    pub user_agent: String,
    /// Configured update strategy — gates whether a staged self-update
    /// auto-applies on idle (#1401).
    pub update_strategy: UpdateStrategy,
}

impl UpdateConfig {
    /// Build the production configuration for the current agent process.
    ///
    /// Three optional environment variables let an integration test point a
    /// **live** agent at a mock GitHub server without any real network or a
    /// host-arch-specific asset; all three are unset in production, where the
    /// defaults below reproduce the shipping behaviour exactly:
    ///
    /// - `TERMIHUB_AGENT_UPDATE_API_URL` — override the `releases/latest` URL.
    /// - `TERMIHUB_AGENT_UPDATE_ASSET_SUFFIX` — force the published asset suffix
    ///   (e.g. `linux-x64`) regardless of the host architecture, so the mock can
    ///   advertise a downloadable asset the running test binary matches.
    /// - `TERMIHUB_AGENT_UPDATE_INITIAL_DELAY_MS` — delay the first poll so the
    ///   test can open a session first (see [`UpdateConfig::initial_delay`]).
    ///
    /// See `agent/tests/self_update_integration.rs`.
    pub fn from_env(
        allow_self_update: bool,
        update_strategy: UpdateStrategy,
        current_version: &str,
    ) -> Self {
        let api_url = std::env::var("TERMIHUB_AGENT_UPDATE_API_URL")
            .unwrap_or_else(|_| github::releases_latest_url(DEFAULT_REPO));
        let asset_suffix = std::env::var("TERMIHUB_AGENT_UPDATE_ASSET_SUFFIX")
            .ok()
            .or_else(|| current_asset_suffix().map(str::to_string));
        let initial_delay = std::env::var("TERMIHUB_AGENT_UPDATE_INITIAL_DELAY_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(Duration::from_millis)
            .unwrap_or(Duration::ZERO);
        Self {
            allow_self_update,
            initial_delay,
            check_interval: DEFAULT_CHECK_INTERVAL,
            api_url,
            current_version: current_version.to_string(),
            asset_suffix,
            staging_dir: AgentState::config_dir().join("updates"),
            user_agent: format!("termihub-agent/{current_version}"),
            update_strategy,
        }
    }

    /// Path a staged binary for `arch_suffix` would be written to.
    fn staged_binary_path(&self, arch_suffix: &str) -> PathBuf {
        self.staging_dir
            .join(format!("termihub-agent-{arch_suffix}"))
    }
}

/// Spawn the background self-update task when enabled.
///
/// A no-op when `allow_self_update` is `false` — nothing is spawned and there is
/// no outbound network activity. Otherwise a Tokio task runs the check
/// immediately and then every [`UpdateConfig::check_interval`] until `shutdown`
/// is triggered.
pub fn spawn_self_update_task(
    config: UpdateConfig,
    session_manager: Arc<SessionManager>,
    notification_tx: NotificationSender,
    shutdown: CancellationToken,
) {
    if !config.allow_self_update {
        debug!("Agent self-update disabled (allow_self_update = false)");
        return;
    }

    info!(
        "Agent self-update enabled — checking GitHub for a newer agent every {}h",
        config.check_interval.as_secs() / 3600
    );

    tokio::spawn(async move {
        let client = match reqwest::Client::builder()
            .user_agent(config.user_agent.clone())
            .timeout(HTTP_TIMEOUT)
            .build()
        {
            Ok(client) => client,
            Err(e) => {
                warn!("Could not build HTTP client for self-update; disabling: {e}");
                return;
            }
        };

        // First tick fires after `initial_delay` (zero in production → immediate),
        // then every `check_interval`. The delay lets the integration test open a
        // session before the poll runs, so the never-interrupt guarantee can be
        // exercised deterministically.
        let start = tokio::time::Instant::now() + config.initial_delay;
        let mut interval = tokio::time::interval_at(start, config.check_interval);
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => {
                    debug!("Shutdown signal received, stopping self-update task");
                    break;
                }
                _ = interval.tick() => {
                    if let Err(e) = run_check_once(&config, &client, &session_manager, &notification_tx).await {
                        // run_check_once already logs its own warnings; this is a
                        // defensive backstop so an unexpected error never leaks.
                        warn!("Self-update check failed: {e}");
                    }
                }
            }
        }
    });
}

/// Run a single self-update check cycle.
///
/// Resilient by design: unreachable network, GitHub errors, unparsable
/// versions, unsupported platforms and checksum failures all log a warning and
/// return `Ok(())` so the caller's timer simply retries next cycle. The last
/// poll time is always persisted, even when the poll itself failed.
async fn run_check_once(
    config: &UpdateConfig,
    client: &reqwest::Client,
    session_manager: &Arc<SessionManager>,
    notification_tx: &NotificationSender,
) -> anyhow::Result<()> {
    // Record the attempt up-front so `last_check_time` reflects reality even if
    // the network call below fails. Routed through the SessionManager so the
    // agent's persisted `update` state has a single owner shared with the #1352
    // deferred-apply path (a direct write here would be clobbered by the next
    // session-close persist).
    session_manager
        .record_update_check_time(now_rfc3339())
        .await;

    let release = match github::fetch_latest_release(client, &config.api_url).await {
        Ok(release) => release,
        Err(e) => {
            // Offline / firewalled / GitHub down — the whole point is to skip
            // cleanly and try again next cycle.
            warn!("Self-update: could not reach GitHub, skipping this cycle: {e:#}");
            return Ok(());
        }
    };

    let newer = match version::is_newer(&release.tag_name, &config.current_version) {
        Ok(newer) => newer,
        Err(e) => {
            warn!("Self-update: could not compare versions, skipping: {e:#}");
            return Ok(());
        }
    };
    if !newer {
        info!(
            "Self-update: agent is up to date (running {}, latest {})",
            config.current_version, release.tag_name
        );
        return Ok(());
    }

    let available_version = version::parse_version(&release.tag_name)
        .map(|v| v.to_string())
        .unwrap_or_else(|_| release.tag_name.clone());
    info!(
        "Self-update: newer agent {} available (running {})",
        available_version, config.current_version
    );

    // Resolve the download for this platform, if one is published.
    let asset_urls = config
        .asset_suffix
        .as_deref()
        .and_then(|suffix| release.asset_urls_for(suffix));

    // When idle and we have a downloadable asset, stage a verified binary.
    let active_sessions = session_manager.active_count().await;
    let mut staged_binary: Option<String> = None;
    if active_sessions == 0 {
        if let (Some(suffix), Some(urls)) = (config.asset_suffix.as_deref(), asset_urls.as_ref()) {
            let dest = config.staged_binary_path(suffix);
            match download::download_and_verify(client, urls, &dest).await {
                Ok(()) => {
                    staged_binary = Some(dest.to_string_lossy().into_owned());
                    info!(
                        "Self-update: staged verified agent {} at {}",
                        available_version,
                        dest.display()
                    );
                }
                Err(e) => {
                    warn!("Self-update: download/verify failed, skipping: {e:#}");
                }
            }
        } else {
            warn!(
                "Self-update: no published agent binary for this platform ({:?}); \
                 notifying only",
                config.asset_suffix
            );
        }
    } else {
        debug!(
            "Self-update: {active_sessions} active session(s) — notifying connected hosts \
             instead of self-applying"
        );
    }

    // Notify BEFORE applying: a successful Unix apply re-execs the process and
    // never returns, so connected desktops must be told about the update
    // lifecycle first.
    notify_update_available(
        notification_tx,
        &config.current_version,
        &available_version,
        asset_urls.map(|u| u.binary_url),
        staged_binary.is_some(),
    );

    // Hand a freshly staged binary to the shared #1352 deferred-apply mechanism
    // (#1401). `allow_self_update` is already implied — this task is never
    // spawned when it is off. The update strategy decides whether to auto-apply
    // on idle now, or merely record the staged update for a later coordinated
    // apply. Because we are idle, an eligible strategy applies immediately via
    // exec-replace; if a session raced in, `request_deferred_update` re-checks
    // and defers to the last-disconnect hook so active sessions are never cut.
    if let Some(binary_path) = staged_binary {
        if config.update_strategy.auto_applies_when_idle() {
            match session_manager
                .request_deferred_update(Some(binary_path), Some(available_version.clone()))
                .await
            {
                Ok(outcome) => info!(
                    "Self-update: staged agent {} handed to deferred-apply ({outcome:?})",
                    available_version
                ),
                // The pending update is retained on failure (see
                // `SessionManager::apply_pending_update`) so a later idle cycle
                // can retry.
                Err(e) => warn!(
                    "Self-update: applying staged agent {} failed, keeping it staged for \
                     retry: {e}",
                    available_version
                ),
            }
        } else {
            session_manager
                .stage_pending_update(binary_path, available_version.clone())
                .await;
            info!(
                "Self-update: staged agent {} recorded; awaiting coordinated apply \
                 (update_strategy = coordinated)",
                available_version
            );
        }
    }

    Ok(())
}

/// Emit an `agent.update_available` notification to connected desktops.
///
/// Best-effort: a closed channel (no client currently attached) is logged at
/// debug and ignored — the persisted state and the next cycle cover that case.
fn notify_update_available(
    notification_tx: &NotificationSender,
    current_version: &str,
    available_version: &str,
    download_url: Option<String>,
    staged: bool,
) {
    let payload = UpdateAvailableNotification {
        current_version: current_version.to_string(),
        available_version: available_version.to_string(),
        download_url,
        staged,
    };
    let params = match serde_json::to_value(&payload) {
        Ok(params) => params,
        Err(e) => {
            warn!("Self-update: failed to serialize update notification: {e}");
            return;
        }
    };
    let notification = JsonRpcNotification::new(AGENT_UPDATE_AVAILABLE, params);
    if let Err(e) = notification_tx.send(notification) {
        debug!("Self-update: no client attached to receive update notification ({e})");
    }
}

/// Current UTC time as an RFC 3339 string.
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::messages::JsonRpcNotification;
    use crate::session::manager::{SessionManager, SystemDaemonLauncher};
    use crate::state::persistence::PendingUpdate;
    use std::sync::Mutex as StdMutex;
    use tokio::sync::mpsc;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const SHA256_OF_ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    /// [`UpdateApplier`] that records apply calls (returning success) instead of
    /// swapping the binary + re-execing, so the auto-apply path can be tested
    /// without replacing the test process.
    struct RecordingApplier {
        applied: Arc<StdMutex<Vec<PendingUpdate>>>,
    }

    impl UpdateApplier for RecordingApplier {
        fn apply(&self, pending: &PendingUpdate) -> anyhow::Result<()> {
            self.applied
                .lock()
                .expect("recording lock")
                .push(pending.clone());
            Ok(())
        }
    }

    /// [`UpdateApplier`] that always fails, to exercise the retain-on-failure
    /// path (the pending update must survive so a later cycle can retry).
    struct FailingApplier {
        attempts: Arc<StdMutex<Vec<PendingUpdate>>>,
    }

    impl UpdateApplier for FailingApplier {
        fn apply(&self, pending: &PendingUpdate) -> anyhow::Result<()> {
            self.attempts
                .lock()
                .expect("attempts lock")
                .push(pending.clone());
            anyhow::bail!("simulated apply failure")
        }
    }

    fn test_config(
        api_url: String,
        staging_dir: PathBuf,
        update_strategy: UpdateStrategy,
    ) -> UpdateConfig {
        UpdateConfig {
            allow_self_update: true,
            initial_delay: Duration::ZERO,
            check_interval: DEFAULT_CHECK_INTERVAL,
            api_url,
            current_version: "0.2.1".to_string(),
            asset_suffix: Some("linux-x64".to_string()),
            staging_dir,
            user_agent: "termihub-agent/test".to_string(),
            update_strategy,
        }
    }

    /// Build a session manager over an isolated `state.json` and injected
    /// [`UpdateApplier`], so the self-update timer's state writes and apply calls
    /// are observable without touching the real state or re-execing.
    fn test_session_manager(
        state_path: PathBuf,
        applier: Arc<dyn UpdateApplier>,
    ) -> Arc<SessionManager> {
        let (tx, _rx) = mpsc::unbounded_channel();
        let registry = Arc::new(crate::registry::build_registry());
        Arc::new(SessionManager::with_test_deps(
            tx,
            registry,
            Arc::new(SystemDaemonLauncher),
            state_path,
            applier,
        ))
    }

    fn recording_manager(
        state_path: PathBuf,
    ) -> (Arc<SessionManager>, Arc<StdMutex<Vec<PendingUpdate>>>) {
        let applied = Arc::new(StdMutex::new(Vec::new()));
        let mgr = test_session_manager(
            state_path,
            Arc::new(RecordingApplier {
                applied: applied.clone(),
            }),
        );
        (mgr, applied)
    }

    fn try_recv(
        rx: &mut mpsc::UnboundedReceiver<JsonRpcNotification>,
    ) -> Option<JsonRpcNotification> {
        rx.try_recv().ok()
    }

    /// Mount a `releases/latest` response advertising v0.3.0 with a binary +
    /// checksum asset served by the same mock server (SHA-256 of `b"abc"`).
    async fn mount_update_release(server: &MockServer) {
        let body = format!(
            r#"{{"tag_name":"v0.3.0","assets":[
                {{"name":"termihub-agent-linux-x64","browser_download_url":"{base}/bin"}},
                {{"name":"termihub-agent-linux-x64.sha256","browser_download_url":"{base}/bin.sha256"}}
            ]}}"#,
            base = server.uri()
        );
        Mock::given(method("GET"))
            .and(path("/releases/latest"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/bin"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"abc".to_vec()))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/bin.sha256"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(format!("{SHA256_OF_ABC}  termihub-agent-linux-x64\n")),
            )
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn offline_skips_cleanly_and_records_last_check() {
        // An unreachable API URL simulates no internet / firewall.
        let tmp = tempfile::tempdir().unwrap();
        let state_path = tmp.path().join("state.json");
        let config = test_config(
            "http://127.0.0.1:1/repos/x/y/releases/latest".to_string(),
            tmp.path().join("updates"),
            UpdateStrategy::Immediate,
        );
        let (mgr, applied) = recording_manager(state_path.clone());
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(500))
            .build()
            .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();

        // Must not error despite the network being unreachable.
        run_check_once(&config, &client, &mgr, &tx).await.unwrap();

        // No notification emitted, but the attempt was recorded and nothing applied.
        assert!(try_recv(&mut rx).is_none());
        assert!(applied.lock().unwrap().is_empty());
        let state = AgentState::load_from(&state_path);
        assert!(state.update.last_check_time.is_some());
        assert!(state.update.pending_update.is_none());
    }

    #[tokio::test]
    async fn up_to_date_does_not_notify() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/releases/latest"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(r#"{"tag_name":"v0.2.1","assets":[]}"#),
            )
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let config = test_config(
            format!("{}/releases/latest", server.uri()),
            tmp.path().join("updates"),
            UpdateStrategy::Immediate,
        );
        let (mgr, _applied) = recording_manager(tmp.path().join("state.json"));
        let (tx, mut rx) = mpsc::unbounded_channel();

        run_check_once(&config, &reqwest::Client::new(), &mgr, &tx)
            .await
            .unwrap();

        assert!(try_recv(&mut rx).is_none(), "no update -> no notification");
    }

    #[tokio::test]
    async fn newer_with_active_sessions_notifies_without_staging() {
        let server = MockServer::start().await;
        let body = r#"{"tag_name":"v0.3.0","assets":[
            {"name":"termihub-agent-linux-x64","browser_download_url":"https://example.test/bin"},
            {"name":"termihub-agent-linux-x64.sha256","browser_download_url":"https://example.test/bin.sha256"}
        ]}"#;
        Mock::given(method("GET"))
            .and(path("/releases/latest"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let state_path = tmp.path().join("state.json");
        let config = test_config(
            format!("{}/releases/latest", server.uri()),
            tmp.path().join("updates"),
            UpdateStrategy::Immediate,
        );
        let (mgr, applied) = recording_manager(state_path.clone());
        // Two active sessions -> notify only, never download or apply.
        mgr.create_stub_session("stub", "A".to_string(), serde_json::json!({}))
            .await
            .unwrap();
        mgr.create_stub_session("stub", "B".to_string(), serde_json::json!({}))
            .await
            .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();

        run_check_once(&config, &reqwest::Client::new(), &mgr, &tx)
            .await
            .unwrap();

        let notif = try_recv(&mut rx).expect("update notification emitted");
        assert_eq!(notif.method, AGENT_UPDATE_AVAILABLE);
        assert_eq!(notif.params["availableVersion"], "0.3.0");
        assert_eq!(notif.params["staged"], false);
        // Nothing staged or applied with sessions active.
        assert!(applied.lock().unwrap().is_empty());
        let state = AgentState::load_from(&state_path);
        assert!(state.update.pending_update.is_none());
    }

    #[tokio::test]
    async fn newer_when_idle_stages_and_auto_applies() {
        // apply-on-idle transition: idle + eligible strategy -> the staged,
        // verified binary is applied and the pending update is cleared (#1401).
        let server = MockServer::start().await;
        mount_update_release(&server).await;

        let tmp = tempfile::tempdir().unwrap();
        let state_path = tmp.path().join("state.json");
        let staging_dir = tmp.path().join("updates");
        let config = test_config(
            format!("{}/releases/latest", server.uri()),
            staging_dir.clone(),
            UpdateStrategy::Deferred,
        );
        let (mgr, applied) = recording_manager(state_path.clone());
        let (tx, mut rx) = mpsc::unbounded_channel();

        run_check_once(&config, &reqwest::Client::new(), &mgr, &tx)
            .await
            .unwrap();

        let staged_path = staging_dir.join("termihub-agent-linux-x64");
        assert_eq!(std::fs::read(&staged_path).unwrap(), b"abc");

        // Notification emitted before the apply so desktops see the lifecycle.
        let notif = try_recv(&mut rx).expect("update notification emitted");
        assert_eq!(notif.params["availableVersion"], "0.3.0");
        assert_eq!(notif.params["staged"], true);

        // The staged binary was applied (idle) and the pending update cleared.
        {
            let log = applied.lock().unwrap();
            assert_eq!(log.len(), 1, "staged self-update applied exactly once");
            assert_eq!(log[0].version, "0.3.0");
            assert_eq!(log[0].binary_path, staged_path.to_string_lossy());
        }
        assert!(
            mgr.pending_update_for_test().await.is_none(),
            "successful apply clears pending_update"
        );
    }

    #[tokio::test]
    async fn newer_when_idle_coordinated_stages_without_applying() {
        // A coordinated strategy stages + notifies but must NOT auto-apply; the
        // pending update is recorded for a later coordinated apply (#1401).
        let server = MockServer::start().await;
        mount_update_release(&server).await;

        let tmp = tempfile::tempdir().unwrap();
        let state_path = tmp.path().join("state.json");
        let staging_dir = tmp.path().join("updates");
        let config = test_config(
            format!("{}/releases/latest", server.uri()),
            staging_dir.clone(),
            UpdateStrategy::Coordinated,
        );
        let (mgr, applied) = recording_manager(state_path.clone());
        let (tx, mut rx) = mpsc::unbounded_channel();

        run_check_once(&config, &reqwest::Client::new(), &mgr, &tx)
            .await
            .unwrap();

        let notif = try_recv(&mut rx).expect("update notification emitted");
        assert_eq!(notif.params["staged"], true);
        // Never applied under a coordinated strategy...
        assert!(
            applied.lock().unwrap().is_empty(),
            "coordinated strategy must not auto-apply on idle"
        );
        // ...but the staged update is recorded for a later coordinated apply.
        let pending = mgr
            .pending_update_for_test()
            .await
            .expect("coordinated strategy records the staged update");
        assert_eq!(pending.version, "0.3.0");
        assert_eq!(
            pending.binary_path,
            staging_dir
                .join("termihub-agent-linux-x64")
                .to_string_lossy()
        );
    }

    #[tokio::test]
    async fn newer_when_idle_failed_apply_keeps_pending() {
        // state-clearing: a FAILED apply must KEEP the pending update so a later
        // cycle can retry (#1401).
        let server = MockServer::start().await;
        mount_update_release(&server).await;

        let tmp = tempfile::tempdir().unwrap();
        let state_path = tmp.path().join("state.json");
        let staging_dir = tmp.path().join("updates");
        let config = test_config(
            format!("{}/releases/latest", server.uri()),
            staging_dir.clone(),
            UpdateStrategy::Immediate,
        );
        let attempts = Arc::new(StdMutex::new(Vec::new()));
        let mgr = test_session_manager(
            state_path.clone(),
            Arc::new(FailingApplier {
                attempts: attempts.clone(),
            }),
        );
        let (tx, _rx) = mpsc::unbounded_channel();

        run_check_once(&config, &reqwest::Client::new(), &mgr, &tx)
            .await
            .unwrap();

        assert_eq!(attempts.lock().unwrap().len(), 1, "apply was attempted");
        let pending = mgr
            .pending_update_for_test()
            .await
            .expect("failed apply keeps pending_update for retry");
        assert_eq!(pending.version, "0.3.0");
        // Persisted too, so a later agent run still sees it.
        assert!(AgentState::load_from(&state_path)
            .update
            .pending_update
            .is_some());
    }

    #[test]
    fn spawn_is_noop_when_disabled() {
        // With the gate off, spawn returns without creating a task or client.
        // (Smoke test: it must not panic and must not require a runtime.)
        let tmp = tempfile::tempdir().unwrap();
        let mut config = test_config(
            "http://127.0.0.1:1/".to_string(),
            tmp.path().join("updates"),
            UpdateStrategy::Immediate,
        );
        config.allow_self_update = false;
        // Build the pieces spawn needs without a running check.
        let (tx, _rx) = mpsc::unbounded_channel();
        let registry = std::sync::Arc::new(crate::registry::build_registry());
        let session_manager = std::sync::Arc::new(SessionManager::new(tx.clone(), registry));
        spawn_self_update_task(config, session_manager, tx, CancellationToken::new());
    }
}

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
//! # Partial implementation (#1355)
//!
//! This lands the poll → semver → verified-download → notify/stage pipeline. The
//! deferred-apply mechanism itself now exists (SI-6, #1352 — see the `apply`
//! submodule and [`crate::session::manager::SessionManager`]), but the
//! *background self-update timer* still stops after staging the verified binary
//! and recording it in `state.json`; auto-triggering the apply from this timer
//! on idle is tracked as a follow-up.

mod apply;
mod checksum;
mod download;
mod github;
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
use crate::state::persistence::{AgentState, PendingUpdate};

pub use apply::{should_apply_deferred_update, SystemUpdateApplier, UpdateApplier};
pub use github::{current_asset_suffix, DEFAULT_REPO};

/// Default interval between self-update checks (24 hours).
pub const DEFAULT_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// Timeout for a single GitHub API / download request.
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Configuration for the self-update background task.
///
/// Field-level overrides (`api_url`, `asset_suffix`, `staging_dir`,
/// `state_path`) exist so the check cycle can be unit tested against a mock HTTP
/// server and a temporary state file. Production callers build defaults via
/// [`UpdateConfig::from_env`].
#[derive(Debug, Clone)]
pub struct UpdateConfig {
    /// Master gate — when `false` the background task is never spawned.
    pub allow_self_update: bool,
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
    /// Path to the agent's `state.json`.
    pub state_path: PathBuf,
    /// `User-Agent` header sent to the GitHub API (GitHub requires one).
    pub user_agent: String,
}

impl UpdateConfig {
    /// Build the production configuration for the current agent process.
    pub fn from_env(allow_self_update: bool, current_version: &str) -> Self {
        Self {
            allow_self_update,
            check_interval: DEFAULT_CHECK_INTERVAL,
            api_url: github::releases_latest_url(DEFAULT_REPO),
            current_version: current_version.to_string(),
            asset_suffix: current_asset_suffix().map(str::to_string),
            staging_dir: AgentState::config_dir().join("updates"),
            state_path: AgentState::default_path(),
            user_agent: format!("termihub-agent/{current_version}"),
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

        let mut interval = tokio::time::interval(config.check_interval);
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => {
                    debug!("Shutdown signal received, stopping self-update task");
                    break;
                }
                _ = interval.tick() => {
                    let active = session_manager.active_count().await;
                    if let Err(e) = run_check_once(&config, &client, active, &notification_tx).await {
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
    active_sessions: u32,
    notification_tx: &NotificationSender,
) -> anyhow::Result<()> {
    // Record the attempt up-front so `last_check_time` reflects reality even if
    // the network call below fails.
    let mut state = AgentState::load_from(&config.state_path);
    state.update.last_check_time = Some(now_rfc3339());
    state.save_to(&config.state_path);

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
    let mut staged = false;
    if active_sessions == 0 {
        if let (Some(suffix), Some(urls)) = (config.asset_suffix.as_deref(), asset_urls.as_ref()) {
            let dest = config.staged_binary_path(suffix);
            match download::download_and_verify(client, urls, &dest).await {
                Ok(()) => {
                    state.update.pending_update = Some(PendingUpdate {
                        version: available_version.clone(),
                        binary_path: dest.to_string_lossy().into_owned(),
                        staged_at: now_rfc3339(),
                    });
                    state.save_to(&config.state_path);
                    staged = true;
                    info!(
                        "Self-update: staged verified agent {} at {}",
                        available_version,
                        dest.display()
                    );
                    // The deferred-apply mechanism (SI-6 / #1352) now exists, but
                    // this background timer intentionally stops after staging —
                    // auto-triggering the apply from the timer on idle is a
                    // separate follow-up. The staged update will still be applied
                    // when the last session disconnects or via
                    // `agent.request_deferred_update`.
                    debug!(
                        "Self-update: binary staged and recorded in state.json; \
                         apply happens on last disconnect or via request_deferred_update"
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

    notify_update_available(
        notification_tx,
        &config.current_version,
        &available_version,
        asset_urls.map(|u| u.binary_url),
        staged,
    );

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
    use tokio::sync::mpsc;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const SHA256_OF_ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn test_config(api_url: String, state_path: PathBuf, staging_dir: PathBuf) -> UpdateConfig {
        UpdateConfig {
            allow_self_update: true,
            check_interval: DEFAULT_CHECK_INTERVAL,
            api_url,
            current_version: "0.2.1".to_string(),
            asset_suffix: Some("linux-x64".to_string()),
            staging_dir,
            state_path,
            user_agent: "termihub-agent/test".to_string(),
        }
    }

    fn try_recv(
        rx: &mut mpsc::UnboundedReceiver<JsonRpcNotification>,
    ) -> Option<JsonRpcNotification> {
        rx.try_recv().ok()
    }

    #[tokio::test]
    async fn offline_skips_cleanly_and_records_last_check() {
        // An unreachable API URL simulates no internet / firewall.
        let tmp = tempfile::tempdir().unwrap();
        let state_path = tmp.path().join("state.json");
        let config = test_config(
            "http://127.0.0.1:1/repos/x/y/releases/latest".to_string(),
            state_path.clone(),
            tmp.path().join("updates"),
        );
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(500))
            .build()
            .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();

        // Must not error despite the network being unreachable.
        run_check_once(&config, &client, 0, &tx).await.unwrap();

        // No notification emitted, but the attempt was recorded.
        assert!(try_recv(&mut rx).is_none());
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
            tmp.path().join("state.json"),
            tmp.path().join("updates"),
        );
        let (tx, mut rx) = mpsc::unbounded_channel();

        run_check_once(&config, &reqwest::Client::new(), 0, &tx)
            .await
            .unwrap();

        assert!(try_recv(&mut rx).is_none(), "no update → no notification");
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
            state_path.clone(),
            tmp.path().join("updates"),
        );
        let (tx, mut rx) = mpsc::unbounded_channel();

        // 2 active sessions → notify only, never download.
        run_check_once(&config, &reqwest::Client::new(), 2, &tx)
            .await
            .unwrap();

        let notif = try_recv(&mut rx).expect("update notification emitted");
        assert_eq!(notif.method, AGENT_UPDATE_AVAILABLE);
        assert_eq!(notif.params["availableVersion"], "0.3.0");
        assert_eq!(notif.params["staged"], false);
        // Nothing staged with sessions active.
        let state = AgentState::load_from(&state_path);
        assert!(state.update.pending_update.is_none());
    }

    #[tokio::test]
    async fn newer_when_idle_downloads_verifies_and_stages() {
        let server = MockServer::start().await;
        // Release JSON points binary + checksum assets back at this mock server.
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
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/bin"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"abc".to_vec()))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/bin.sha256"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(format!("{SHA256_OF_ABC}  termihub-agent-linux-x64\n")),
            )
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let state_path = tmp.path().join("state.json");
        let staging_dir = tmp.path().join("updates");
        let config = test_config(
            format!("{}/releases/latest", server.uri()),
            state_path.clone(),
            staging_dir.clone(),
        );
        let (tx, mut rx) = mpsc::unbounded_channel();

        // 0 active sessions → download + verify + stage.
        run_check_once(&config, &reqwest::Client::new(), 0, &tx)
            .await
            .unwrap();

        let staged_path = staging_dir.join("termihub-agent-linux-x64");
        assert_eq!(std::fs::read(&staged_path).unwrap(), b"abc");

        let notif = try_recv(&mut rx).expect("update notification emitted");
        assert_eq!(notif.params["availableVersion"], "0.3.0");
        assert_eq!(notif.params["staged"], true);

        let state = AgentState::load_from(&state_path);
        let pending = state
            .update
            .pending_update
            .expect("pending update recorded");
        assert_eq!(pending.version, "0.3.0");
        assert_eq!(pending.binary_path, staged_path.to_string_lossy());
    }

    #[test]
    fn spawn_is_noop_when_disabled() {
        // With the gate off, spawn returns without creating a task or client.
        // (Smoke test: it must not panic and must not require a runtime.)
        let tmp = tempfile::tempdir().unwrap();
        let mut config = test_config(
            "http://127.0.0.1:1/".to_string(),
            tmp.path().join("state.json"),
            tmp.path().join("updates"),
        );
        config.allow_self_update = false;
        // Build the pieces spawn needs without a running check.
        let (tx, _rx) = mpsc::unbounded_channel();
        let registry = std::sync::Arc::new(crate::registry::build_registry());
        let session_manager = std::sync::Arc::new(SessionManager::new(tx.clone(), registry));
        spawn_self_update_task(config, session_manager, tx, CancellationToken::new());
    }
}

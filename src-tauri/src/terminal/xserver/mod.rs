//! Local X server provisioning for SSH X11 forwarding (epic #1047).
//!
//! Makes a usable local X server available and manages its lifecycle so remote
//! GUI apps can render as native windows. See the concept document
//! `docs/concepts/backlog/x-server-provisioning.html`.
//!
//! - [`acquire`] (#1048, Windows-only) resolves a known-good VcXsrv install on
//!   disk via `cache → bundled → download → verify → extract`.
//! - [`manager`] (#1049) owns the lifecycle of a single shared X server: adopt,
//!   spawn/supervise, reuse across sessions, idle shutdown.
//! - This module (#1052) adds the cross-platform [`ensure_x_server`]
//!   orchestrator, the [`XServerProvisionerImpl`] that bridges core's SSH connect
//!   path (which cannot depend on the desktop app layer) to it, and the Tauri
//!   command surface in [`crate::commands::xserver`].

#[cfg(windows)]
pub mod acquire;
pub mod auth;
mod consent;
mod linux_gap;
pub(crate) mod macos;
pub mod manager;
mod orchestrator;
mod types;

use std::sync::Arc;

use async_trait::async_trait;
use tauri::{AppHandle, Emitter, Manager};
use termihub_core::backends::ssh::x11::{XServerLease, XServerProvisioner};
use tokio_util::sync::CancellationToken;

use crate::connection::manager::ConnectionManager;

use consent::{await_consent, connect_consent_required, ConsentOutcome};

pub use consent::{ConnectConsentRegistry, ConsentDecision};
pub use manager::XServerManager;
pub use orchestrator::{
    current_status, ensure_x_server, ensure_x_server_for_session, EnsureOutcome,
};
pub use types::{
    XServerConsentRequest, XServerError, XServerPlatform, XServerProgress, XServerState,
    XServerStatusReport, X_SERVER_CONSENT_NEEDED_EVENT, X_SERVER_PROGRESS_EVENT,
};

/// Emit an X server provisioning progress event (best-effort).
///
/// Shared by the `x_server_*` commands and the connect-time provisioner so
/// progress is reported identically whether setup was invoked manually from the
/// Open Connections "X Servers" section or triggered automatically on connect
/// (#1116).
pub(crate) fn emit_progress(app: &AppHandle, step: &str, message: &str, progress: f64) {
    let _ = app.emit(
        X_SERVER_PROGRESS_EVENT,
        XServerProgress {
            step: step.to_string(),
            message: message.to_string(),
            progress,
        },
    );
}

/// Whether `name` resolves to an executable on `PATH` (best-effort).
///
/// Shared by the orchestrator's dependency probe and the Linux gap detector.
/// Uses the `which` crate so `PATH` parsing and platform executable rules
/// (Windows `PATHEXT`, etc.) are handled by a maintained library rather than a
/// hand-rolled split.
pub(super) fn binary_on_path(name: &str) -> bool {
    which::which(name).is_ok()
}

/// Resolve whether automatic X server provisioning is enabled.
///
/// Reads the global `provideXServerAutomatically` setting; when unset it
/// defaults to `true` on Windows (the platform where the "app provides the
/// server" model applies) and `false` elsewhere.
pub fn resolve_provide_automatically(app: &AppHandle) -> bool {
    let default = cfg!(target_os = "windows");
    app.try_state::<ConnectionManager>()
        .map(|manager| {
            manager
                .get_settings()
                .provide_x_server_automatically
                .unwrap_or(default)
        })
        .unwrap_or(default)
}

/// The desktop-side [`XServerProvisioner`] registered into core at startup.
///
/// Core's SSH connect path calls [`ensure`](XServerProvisioner::ensure) before
/// starting X11 forwarding; this runs the orchestrator (off the async reactor,
/// since detection briefly blocks), claims a dependent session (#1107), and
/// returns an [`XServerLease`] with the server to forward to plus a
/// session-lifetime guard — or an actionable `Err`.
pub struct XServerProvisionerImpl {
    app: AppHandle,
    manager: Arc<XServerManager>,
    consent_registry: Arc<ConnectConsentRegistry>,
}

/// The result of the connect-time consent gate (#1116).
enum ConsentGate {
    /// Proceed with provisioning (no prompt needed, or consent granted).
    Proceed,
    /// The user declined for now — skip X forwarding gracefully.
    Skip,
    /// The connect was aborted while the prompt was up — fail the ensure so the
    /// connect stops rather than provisioning behind a Stop.
    Cancelled,
}

impl XServerProvisionerImpl {
    /// Create a provisioner bound to the app handle, shared manager, and the
    /// connect-time consent registry the reply command resolves against.
    pub fn new(
        app: AppHandle,
        manager: Arc<XServerManager>,
        consent_registry: Arc<ConnectConsentRegistry>,
    ) -> Self {
        Self {
            app,
            manager,
            consent_registry,
        }
    }

    /// Pause for first-time download consent when required (#1116).
    ///
    /// Returns [`ConsentGate::Proceed`] immediately when no prompt is needed
    /// (already-decided, a server already reachable, or a non-download platform).
    /// Otherwise emits [`X_SERVER_CONSENT_NEEDED_EVENT`] and awaits the frontend
    /// reply — abortable via the connect's `cancel` token (#1260) — persisting
    /// the "enable" decision so later connects do not re-prompt.
    async fn request_consent_if_needed(&self, cancel: Option<&CancellationToken>) -> ConsentGate {
        let platform = XServerPlatform::current();
        let provide_setting = self
            .app
            .try_state::<ConnectionManager>()
            .and_then(|m| m.get_settings().provide_x_server_automatically);
        // Side-effect-free probe: a server already reachable means adoption with
        // no download, so no consent is needed.
        let server_present = matches!(
            current_status(&self.manager).state,
            XServerState::Running | XServerState::Adopted
        );

        if !connect_consent_required(platform, provide_setting, server_present) {
            return ConsentGate::Proceed;
        }

        let (id, receiver) = self.consent_registry.register();
        let _ = self.app.emit(
            X_SERVER_CONSENT_NEEDED_EVENT,
            XServerConsentRequest {
                id: id.clone(),
                platform,
            },
        );
        emit_progress(
            &self.app,
            "consent",
            "Waiting for X server download consent…",
            -1.0,
        );
        let outcome = await_consent(receiver, cancel).await;
        // Drop any lingering prompt if we aborted before a reply arrived.
        self.consent_registry.forget(&id);

        match outcome {
            ConsentOutcome::Proceed => {
                self.persist_consent();
                ConsentGate::Proceed
            }
            ConsentOutcome::Skip => ConsentGate::Skip,
            ConsentOutcome::Cancelled => ConsentGate::Cancelled,
        }
    }

    /// Persist that the user consented to automatic provisioning, so subsequent
    /// connects provision silently without re-prompting.
    fn persist_consent(&self) {
        if let Some(manager) = self.app.try_state::<ConnectionManager>() {
            let mut settings = manager.get_settings();
            settings.provide_x_server_automatically = Some(true);
            if let Err(e) = manager.save_settings(settings) {
                tracing::warn!("Failed to persist X server consent: {e}");
            }
        }
    }
}

#[async_trait]
impl XServerProvisioner for XServerProvisionerImpl {
    async fn ensure(&self, cancel: Option<CancellationToken>) -> Result<XServerLease, String> {
        // Surface the same connect-time provisioning progress the manual
        // `x_server_ensure` command emits so the frontend can show live feedback
        // (#1116). Best-effort; no listener during a plain connect is harmless.
        emit_progress(&self.app, "detect", "Checking for a local X server…", -1.0);

        // Gate a first-time, download-backed provision on user consent (#1116).
        match self.request_consent_if_needed(cancel.as_ref()).await {
            ConsentGate::Proceed => {}
            ConsentGate::Skip => {
                // Declined for now: skip forwarding gracefully. Returning an
                // empty lease lets the connect continue (falling back to any
                // user-run server) without failing the SSH connect.
                emit_progress(&self.app, "skipped", "X server setup skipped.", 1.0);
                return Ok(XServerLease::default());
            }
            ConsentGate::Cancelled => {
                let message = "X server setup was cancelled.".to_string();
                emit_progress(&self.app, "failed", &message, 1.0);
                return Err(message);
            }
        }

        // Run the orchestrator (adopt / spawn / launch XQuartz / typed error),
        // claiming a dependent session against the manager (#1107). The connect
        // path gets the resolved server — managed or adopted, with its cookie, so
        // the forwarder performs no second probe — plus an opaque
        // [`SessionGuard`] it holds for the session lifetime; dropping the guard
        // releases the session (respecting idle-shutdown). `cancel` is the SSH
        // connect-abort token so aborting the connect short-cuts the macOS
        // XQuartz readiness wait (#1260). `Ok` always carries a resolved server;
        // the "nothing usable" case is an `Err`, and the "no provisioner
        // registered" case is handled in core.
        match ensure_session_off_reactor(&self.app, self.manager.clone(), cancel).await {
            Ok((outcome, guard)) => {
                emit_progress(
                    &self.app,
                    "ready",
                    outcome
                        .report
                        .message
                        .as_deref()
                        .unwrap_or("X server ready."),
                    1.0,
                );
                Ok(XServerLease {
                    resolved: Some(outcome.resolved),
                    guard: Some(Box::new(guard)),
                })
            }
            Err(e) => {
                let message = e.to_string();
                emit_progress(&self.app, "failed", &message, 1.0);
                Err(message)
            }
        }
    }
}

/// Run [`ensure_x_server`] off the async reactor — detection does a brief
/// blocking TCP probe / filesystem scan. Shared by the provisioner and the
/// `x_server_ensure` command so the blocking-offload and settings resolution
/// live in one place.
pub(crate) async fn ensure_off_reactor(
    app: &AppHandle,
    manager: Arc<XServerManager>,
) -> Result<EnsureOutcome, XServerError> {
    let provide = resolve_provide_automatically(app);
    tokio::task::spawn_blocking(move || ensure_x_server(&manager, provide))
        .await
        .map_err(|e| XServerError::LaunchFailed {
            message: format!("X server provisioning task failed: {e}"),
        })?
}

/// Like [`ensure_off_reactor`] but claims a dependent session against the manager
/// (#1107), returning the outcome plus a [`SessionGuard`](manager::SessionGuard)
/// whose drop releases the session. Used by the SSH connect provisioner so the
/// refcount tracks live X11-forwarding sessions.
pub(crate) async fn ensure_session_off_reactor(
    app: &AppHandle,
    manager: Arc<XServerManager>,
    cancel: Option<CancellationToken>,
) -> Result<(EnsureOutcome, manager::SessionGuard), XServerError> {
    let provide = resolve_provide_automatically(app);
    tokio::task::spawn_blocking(move || {
        ensure_x_server_for_session(&manager, provide, cancel.as_ref())
    })
    .await
    .map_err(|e| XServerError::LaunchFailed {
        message: format!("X server provisioning task failed: {e}"),
    })?
}

/// Install the X server provisioner into core so the SSH connect path can reach
/// it. Call once at startup, after the manager is created.
///
/// `consent_registry` is the shared registry the `x_server_connect_consent_reply`
/// command resolves against, so a connect paused for download consent (#1116) is
/// woken by the frontend's reply.
pub fn init(
    app: &AppHandle,
    manager: Arc<XServerManager>,
    consent_registry: Arc<ConnectConsentRegistry>,
) {
    let provisioner = Arc::new(XServerProvisionerImpl::new(
        app.clone(),
        manager,
        consent_registry,
    ));
    termihub_core::backends::ssh::x11::set_x_server_provisioner(provisioner);
}

//! Frontend-facing types for the X server provisioning command surface (#1052).
//!
//! The lifecycle logic lives in [`super::manager`] (#1049); these types are the
//! serializable shapes the `x_server_*` Tauri commands and progress events hand
//! to the UI (#1053): a status report, a typed/actionable error, and a progress
//! payload.

use serde::{Deserialize, Serialize};

/// The host platform, as it matters for X server provisioning.
///
/// Each platform has a different strategy: Windows provisions VcXsrv, macOS
/// guides an XQuartz install, Linux detects-and-guides only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum XServerPlatform {
    Windows,
    MacOs,
    Linux,
}

impl XServerPlatform {
    /// The platform this binary was compiled for.
    pub fn current() -> Self {
        #[cfg(target_os = "windows")]
        {
            XServerPlatform::Windows
        }
        #[cfg(target_os = "macos")]
        {
            XServerPlatform::MacOs
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            XServerPlatform::Linux
        }
    }
}

/// Coarse lifecycle state of the local X server, as reported to the UI.
///
/// Maps from [`super::manager::XServerStatus`] plus cross-platform detection of
/// an adopted (user-run) server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum XServerState {
    /// No server present or detected.
    Absent,
    /// An externally-run server (user-installed) was detected and adopted.
    Adopted,
    /// A termiHub-managed server is running.
    Running,
    /// The last provisioning/launch attempt failed.
    Failed,
}

/// A coherent snapshot of the local X server situation, returned by
/// `x_server_status` / `x_server_ensure`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XServerStatusReport {
    /// Current lifecycle state.
    pub state: XServerState,
    /// Host platform (drives which provisioning strategy applies).
    pub platform: XServerPlatform,
    /// Display number (`:N`) of the active server, when one is running/adopted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_number: Option<u32>,
    /// Whether the active server was started by termiHub (vs. adopted external).
    pub managed: bool,
    /// Whether the platform's X dependency is installed (XQuartz / Xorg / VcXsrv).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependency_available: Option<bool>,
    /// Number of live X11 sessions currently depending on this server (#1107).
    ///
    /// Drives the Open Connections "X Servers" row's "· N sessions" detail. Zero
    /// when the server is idle, adopted-but-unused, or absent.
    pub session_count: usize,
    /// Human-readable detail (adoption source, or why the server is absent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// A typed, actionable provisioning failure surfaced to the UI.
///
/// Serializes to `{ "kind": "...", "message": "...", ... }` so the frontend can
/// branch on `kind` (e.g. offer an install button for `dependencyMissing`) while
/// always having a display-ready `message`.
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum XServerError {
    /// Automatic provisioning is enabled but not yet implemented in this build
    /// (Windows VcXsrv download consent flow — remaining epic #1047 work).
    #[error("{message}")]
    ProvisioningUnavailable { message: String },

    /// No local X server is running and automatic provisioning is disabled.
    #[error("{message}")]
    NoLocalServer { message: String },

    /// A required platform dependency (XQuartz, Xorg/XWayland) is missing.
    #[error("{message}")]
    #[serde(rename_all = "camelCase")]
    DependencyMissing {
        message: String,
        /// Dependency name (e.g. `XQuartz`).
        dependency: String,
        /// Free-text guidance (e.g. a download URL or manual step).
        #[serde(skip_serializing_if = "Option::is_none")]
        install_hint: Option<String>,
        /// A suggested one-line install command (e.g. `brew install --cask xquartz`).
        #[serde(skip_serializing_if = "Option::is_none")]
        install_command: Option<String>,
    },

    /// The dependency is installed but no server is reachable.
    #[error("{message}")]
    ServerUnreachable { message: String },

    /// Launching or managing the server process failed.
    #[error("{message}")]
    LaunchFailed { message: String },

    /// The requested operation is not supported on this platform.
    #[error("{message}")]
    Unsupported { message: String },
}

impl XServerError {
    /// Windows: automatic VcXsrv provisioning is enabled but not yet wired
    /// (awaiting the download-consent flow). Shared by the orchestrator and the
    /// install command so the guidance text has a single source.
    pub fn windows_provisioning_unavailable() -> Self {
        XServerError::ProvisioningUnavailable {
            message: "Automatic VcXsrv provisioning is not yet available in this build. Install \
                VcXsrv and start it on display :0, then retry."
                .to_string(),
        }
    }

    /// Windows: no server running and automatic provisioning is disabled.
    pub fn windows_no_local_server() -> Self {
        XServerError::NoLocalServer {
            message: "No local X server is running. Enable \"Provide X server automatically\" in \
                Settings, or install and start VcXsrv on display :0."
                .to_string(),
        }
    }

    /// macOS: XQuartz is not installed. Shared by the orchestrator and the
    /// install command.
    pub fn xquartz_missing() -> Self {
        XServerError::DependencyMissing {
            message: "XQuartz is not installed. Install it to use X11 forwarding.".to_string(),
            dependency: "XQuartz".to_string(),
            install_hint: Some(
                "Download XQuartz from https://www.xquartz.org, then log out and back in so \
                DISPLAY is set."
                    .to_string(),
            ),
            install_command: Some("brew install --cask xquartz".to_string()),
        }
    }

    /// macOS: XQuartz isn't installed and Homebrew — the automatic installer —
    /// is absent, so the user asked to install XQuartz but there is no `brew` to
    /// run it with (#1117).
    ///
    /// Rather than hosting/redistributing a notarized `.pkg`, the UI guides the
    /// user through installing Homebrew first: it opens a local terminal tab
    /// pre-loaded with `install_command` (the official installer), then a retry
    /// re-detects `brew` and installs the cask. `dependency: "Homebrew"` is the
    /// stable discriminator the frontend branches on; if the user declines, the
    /// hint still points at the manual xquartz.org download (help ends there).
    pub fn homebrew_required() -> Self {
        todo!("homebrew_required — implemented in the follow-up commit")
    }

    /// macOS: XQuartz is installed but no server is running.
    pub fn macos_server_unreachable() -> Self {
        XServerError::ServerUnreachable {
            message: "XQuartz is installed but no X server is running. Launch XQuartz and retry \
                (termiHub attempts this automatically on connect)."
                .to_string(),
        }
    }

    /// Linux: no Xorg/XWayland found.
    pub fn linux_x_missing() -> Self {
        XServerError::DependencyMissing {
            message: "No X server (Xorg/XWayland) was found.".to_string(),
            dependency: "Xorg/XWayland".to_string(),
            install_hint: Some(
                "Install your distribution's Xorg or XWayland package, or run termiHub inside a \
                graphical session."
                    .to_string(),
            ),
            install_command: None,
        }
    }

    /// Linux: an X server appears present but no display was detected.
    pub fn linux_server_unreachable() -> Self {
        XServerError::ServerUnreachable {
            message: "An X server appears installed but no display was detected. On Wayland, \
                ensure XWayland is running and DISPLAY is set."
                .to_string(),
        }
    }

    /// Linux: a Wayland session without XWayland, so X11 forwarding has no X
    /// server to render into. The one Linux case that needs a package install.
    pub fn linux_xwayland_missing() -> Self {
        XServerError::DependencyMissing {
            message: "This is a Wayland session without XWayland, so there is no X server for \
                X11 forwarding to use."
                .to_string(),
            dependency: "XWayland".to_string(),
            install_hint: Some(
                "Install your distribution's XWayland package (e.g. `xwayland`, `xorg-xwayland`, \
                or `xwayland` via your package manager), then reconnect."
                    .to_string(),
            ),
            install_command: None,
        }
    }

    /// Linux: termiHub is confined by a Flatpak/Snap sandbox that is not exposing
    /// the host X socket.
    pub fn linux_sandbox_socket_hidden() -> Self {
        XServerError::ServerUnreachable {
            message: "termiHub is running in a Flatpak/Snap sandbox that is not exposing the host \
                X socket. Grant X access to the sandbox (e.g. `--socket=x11`, or \
                `--socket=fallback-x11` on Wayland) and reconnect."
                .to_string(),
        }
    }

    /// Linux: no local display at all (headless system).
    pub fn linux_headless() -> Self {
        XServerError::NoLocalServer {
            message: "No local display was found — this looks like a headless system. X11 \
                forwarding renders remote apps on a local X server, so run termiHub in a graphical \
                session, or start a virtual framebuffer (e.g. Xvfb) and set DISPLAY."
                .to_string(),
        }
    }

    /// Linux: termiHub never installs an X server here.
    pub fn linux_install_unsupported() -> Self {
        XServerError::Unsupported {
            message: "termiHub never installs an X server on Linux. Install your distribution's \
                Xorg or XWayland package via your package manager."
                .to_string(),
        }
    }
}

/// Progress event emitted during X server provisioning / dependency install.
///
/// Deliberately mirrors [`AgentDeployProgress`](crate::terminal::agent_deploy::AgentDeployProgress)
/// so the frontend can reuse the same progress-rendering shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XServerProgress {
    /// Short machine-readable step id (e.g. `detect`, `download`, `launch`).
    pub step: String,
    /// Human-readable status line.
    pub message: String,
    /// Progress fraction (0.0–1.0), or `-1.0` for indeterminate.
    pub progress: f64,
}

/// The Tauri event name for X server provisioning progress.
pub const X_SERVER_PROGRESS_EVENT: &str = "x-server-progress";

/// Emitted when opening an X11-forwarding SSH connection needs the user to
/// consent to downloading the X dependency before provisioning proceeds (#1116).
///
/// The connect pauses after this event until the frontend replies via the
/// `x_server_connect_consent_reply` command with the matching [`id`](Self::id).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XServerConsentRequest {
    /// Opaque id correlating this prompt with the reply command that resolves it.
    pub id: String,
    /// Host platform, so the UI can tailor the consent copy (download size, name).
    pub platform: XServerPlatform,
}

/// The Tauri event name for a connect-time X server download-consent prompt.
pub const X_SERVER_CONSENT_NEEDED_EVENT: &str = "x-server-consent-needed";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_current_is_one_of_the_variants() {
        let p = XServerPlatform::current();
        assert!(matches!(
            p,
            XServerPlatform::Windows | XServerPlatform::MacOs | XServerPlatform::Linux
        ));
    }

    #[test]
    fn status_serializes_camel_case_and_omits_none() {
        let status = XServerStatusReport {
            state: XServerState::Adopted,
            platform: XServerPlatform::Linux,
            display_number: Some(0),
            managed: false,
            dependency_available: Some(true),
            session_count: 2,
            message: None,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"state\":\"adopted\""));
        assert!(json.contains("\"displayNumber\":0"));
        assert!(json.contains("\"dependencyAvailable\":true"));
        assert!(json.contains("\"sessionCount\":2"));
        assert!(!json.contains("message"));
    }

    #[test]
    fn homebrew_required_carries_the_installer_command_and_manual_fallback() {
        // Brew-absent post-click response: `dependency: "Homebrew"` (the frontend
        // discriminator), `install_command` = the official Homebrew installer the
        // guided terminal runs, and a hint that still points at the manual
        // xquartz.org download for a user who declines Homebrew.
        match XServerError::homebrew_required() {
            XServerError::DependencyMissing {
                dependency,
                install_hint,
                install_command,
                ..
            } => {
                assert_eq!(dependency, "Homebrew");
                let cmd = install_command.expect("Homebrew installer command must be present");
                assert!(
                    cmd.contains("curl"),
                    "installer command should curl the script: {cmd}"
                );
                assert!(
                    cmd.contains("Homebrew/install"),
                    "installer command should fetch the official Homebrew installer: {cmd}"
                );
                assert!(install_hint.unwrap_or_default().contains("xquartz.org"));
            }
            other => panic!("expected DependencyMissing, got {other:?}"),
        }
    }

    #[test]
    fn error_serializes_with_kind_tag() {
        let err = XServerError::xquartz_missing();
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"kind\":\"dependencyMissing\""));
        assert!(json.contains("\"dependency\":\"XQuartz\""));
        assert!(json.contains("\"installCommand\":\"brew install --cask xquartz\""));
        assert_eq!(
            err.to_string(),
            "XQuartz is not installed. Install it to use X11 forwarding."
        );
    }
}

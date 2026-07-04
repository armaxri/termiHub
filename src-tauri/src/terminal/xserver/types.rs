//! Shared types for the X server provisioning subsystem (epic #1047, #1052).
//!
//! These describe, in a frontend-friendly shape, *what state a local X server is
//! in* and *why provisioning could not complete*. They are returned by the
//! `x_server_*` Tauri commands and carried by progress events.

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

/// Lifecycle state of the local X server, mirroring the state machine in
/// concept #1044. Only a subset is reachable until the Windows provisioning
/// internals (#1048–#1050) land; the download/verify/extract states are wired
/// here so the command/event surface is stable for the UI (#1053).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum XServerState {
    /// No server present or detected.
    Absent,
    /// An externally-run server (user-installed) was detected and adopted.
    Adopted,
    /// A termiHub-managed server is running.
    Running,
    /// Downloading the pinned VcXsrv archive (Windows, #1048).
    Downloading,
    /// Verifying the downloaded archive checksum (Windows, #1048).
    Verifying,
    /// Extracting the archive into the data dir (Windows, #1048).
    Extracting,
    /// Launching the managed server process (#1049).
    Starting,
    /// Provisioning or launch failed.
    Failed,
    /// The managed server was stopped.
    Stopped,
}

/// A coherent snapshot of the local X server situation, returned by
/// `x_server_status` / `x_server_ensure`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XServerStatus {
    /// Current lifecycle state.
    pub state: XServerState,
    /// Host platform (drives which provisioning strategy applies).
    pub platform: XServerPlatform,
    /// Display number (`:N`) of the active server, when one is running/adopted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_number: Option<u32>,
    /// Whether the active server was started by termiHub (vs. adopted external).
    pub managed: bool,
    /// Number of X11 sessions currently using the server (idle-shutdown refcount).
    pub session_count: u32,
    /// Whether the platform's X dependency is installed (XQuartz / Xorg / VcXsrv).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependency_available: Option<bool>,
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
    /// (Windows VcXsrv acquire/lifecycle/auth — issues #1048–#1050).
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
    /// Windows: automatic VcXsrv provisioning is enabled but not yet implemented
    /// (#1048–#1050). Shared by the orchestrator and the install command so the
    /// guidance text has a single source.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_current_is_one_of_the_variants() {
        // Compiles and returns a value on every CI platform.
        let p = XServerPlatform::current();
        assert!(matches!(
            p,
            XServerPlatform::Windows | XServerPlatform::MacOs | XServerPlatform::Linux
        ));
    }

    #[test]
    fn status_serializes_camel_case_and_omits_none() {
        let status = XServerStatus {
            state: XServerState::Adopted,
            platform: XServerPlatform::Linux,
            display_number: Some(0),
            managed: false,
            session_count: 1,
            dependency_available: Some(true),
            message: None,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"state\":\"adopted\""));
        assert!(json.contains("\"displayNumber\":0"));
        assert!(json.contains("\"sessionCount\":1"));
        assert!(json.contains("\"dependencyAvailable\":true"));
        // None message is omitted.
        assert!(!json.contains("message"));
    }

    #[test]
    fn error_serializes_with_kind_tag() {
        let err = XServerError::DependencyMissing {
            message: "XQuartz is not installed.".to_string(),
            dependency: "XQuartz".to_string(),
            install_hint: None,
            install_command: Some("brew install --cask xquartz".to_string()),
        };
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"kind\":\"dependencyMissing\""));
        assert!(json.contains("\"dependency\":\"XQuartz\""));
        assert!(json.contains("\"installCommand\":\"brew install --cask xquartz\""));
        // Skipped None field must be absent.
        assert!(!json.contains("installHint"));
        // thiserror Display surfaces the message.
        assert_eq!(err.to_string(), "XQuartz is not installed.");
    }
}

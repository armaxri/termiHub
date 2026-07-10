//! Frontend-facing types for the X server provisioning command surface (#1052).
//!
//! The lifecycle logic lives in [`super::manager`] (#1049); these types are the
//! serializable shapes the `x_server_*` Tauri commands and progress events hand
//! to the UI (#1053): a status report, a typed/actionable error, and a progress
//! payload.

use serde::{Deserialize, Serialize};

/// The official Homebrew installer one-liner (brew.sh). The macOS brew-absent
/// path hands this back as an [`XServerError::DependencyMissing`] `install_command`
/// so the UI can open a local terminal tab that runs it, guiding the user through
/// the real `sudo` / RETURN prompts (#1117). Single source of truth for the
/// command the frontend types into that terminal.
pub(crate) const HOMEBREW_INSTALL_COMMAND: &str =
    "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"";

/// The winget invocation that installs VcXsrv on Windows (#1318) — the analog of
/// macOS's `brew install --cask xquartz`. Shown as the `install_command` for the
/// VcXsrv-missing error; the backend runs it when winget is present. The agreement
/// flags plus `-h` (silent) keep it non-interactive, and `-e --id marha.VcXsrv`
/// pins the exact winget package. Single source of truth for the command.
pub(crate) const WINGET_INSTALL_VCXSRV_COMMAND: &str =
    "winget install -e --id marha.VcXsrv --accept-package-agreements --accept-source-agreements -h";

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

/// How the frontend should carry out the install action a [`DependencyMissing`]
/// error offers (#1309).
///
/// This is the *typed* discriminator that used to be inferred from the
/// human-facing `dependency` name (the retired `HOMEBREW_DEPENDENCY` magic
/// string): it decides whether `install_command` is display-only or executed,
/// so the `dependency` field can stay purely presentational. Adding a second
/// guided-install dependency needs no new string-match — just this variant.
///
/// [`DependencyMissing`]: XServerError::DependencyMissing
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallMode {
    /// termiHub installs the dependency itself via `x_server_install_dependency`
    /// (e.g. `brew install --cask xquartz`). Any `install_command` is shown for
    /// information only; the install button drives the backend command.
    Backend,
    /// The user must run `install_command` themselves in a terminal termiHub
    /// opens for them — the install has interactive prompts termiHub can't drive
    /// (e.g. the official Homebrew installer's `sudo` / RETURN steps, #1117).
    GuidedTerminal,
    /// termiHub can't install the dependency because a prerequisite package
    /// manager is missing, and that prerequisite isn't a terminal command either
    /// — the UI opens an external page/store for the user to get it, then Retry
    /// (e.g. Windows winget-absent: open the Microsoft Store for App Installer,
    /// with a manual VcXsrv download fallback, #1318).
    GuidedExternal,
}

/// A typed, actionable provisioning failure surfaced to the UI.
///
/// Serializes to `{ "kind": "...", "message": "...", ... }` so the frontend can
/// branch on `kind` (e.g. offer an install button for `dependencyMissing`) while
/// always having a display-ready `message`.
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum XServerError {
    /// No local X server is running and automatic provisioning is disabled.
    #[error("{message}")]
    NoLocalServer { message: String },

    /// A required platform dependency (XQuartz, Xorg/XWayland) is missing.
    #[error("{message}")]
    #[serde(rename_all = "camelCase")]
    DependencyMissing {
        message: String,
        /// Dependency name (e.g. `XQuartz`). Purely presentational — the UI shows
        /// it in the message and the install button label, never branches on it.
        dependency: String,
        /// How the frontend should run the install action (#1309): `backend`
        /// drives `x_server_install_dependency`; `guidedTerminal` opens a terminal
        /// running `install_command`.
        install_mode: InstallMode,
        /// Free-text guidance (e.g. a download URL or manual step).
        #[serde(skip_serializing_if = "Option::is_none")]
        install_hint: Option<String>,
        /// A suggested one-line install command (e.g. `brew install --cask xquartz`).
        #[serde(skip_serializing_if = "Option::is_none")]
        install_command: Option<String>,
        /// A manual-download page the user can use *instead of* the offered install
        /// action (#1312), e.g. xquartz.org when the guided Homebrew install is
        /// declined. Presentational URL the UI turns into an "Open <host>" button,
        /// rendered only when present — so the fallback stays payload-driven rather
        /// than hardcoded per dependency.
        #[serde(skip_serializing_if = "Option::is_none")]
        install_fallback_url: Option<String>,
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
    /// Windows: VcXsrv isn't installed. Install it via winget (#1318) — the
    /// analog of macOS's [`xquartz_missing`](Self::xquartz_missing). `Backend`
    /// mode: the install button drives `x_server_install_dependency`, which runs
    /// `winget install ... marha.VcXsrv`. Shared by the orchestrator and the
    /// install command so the guidance has a single source.
    pub fn vcxsrv_missing() -> Self {
        XServerError::DependencyMissing {
            message: "VcXsrv is not installed. Install it to use X11 forwarding.".to_string(),
            dependency: "VcXsrv".to_string(),
            install_mode: InstallMode::Backend,
            install_hint: Some(
                "termiHub can install VcXsrv for you with winget, or download it from \
                https://sourceforge.net/projects/vcxsrv/."
                    .to_string(),
            ),
            install_command: Some(WINGET_INSTALL_VCXSRV_COMMAND.to_string()),
            // Backend install (winget) — no manual-fallback button, mirroring
            // `xquartz_missing`; the download URL stays in the hint text.
            install_fallback_url: None,
        }
    }

    /// Windows: VcXsrv isn't installed and winget — the automatic installer — is
    /// absent, so there is no package manager to install it with (#1318).
    ///
    /// The analog of macOS's [`homebrew_required`](Self::homebrew_required), but
    /// winget (App Installer) isn't a terminal command, so this is an
    /// [`InstallMode::GuidedExternal`]: the UI opens the Microsoft Store for App
    /// Installer, then a retry re-detects winget and installs VcXsrv. If the user
    /// declines, the hint points at the manual VcXsrv download (help ends there).
    pub fn winget_required() -> Self {
        XServerError::DependencyMissing {
            message: "VcXsrv can't be installed automatically because winget (App Installer) is \
                not available. Install App Installer, then retry — or install VcXsrv manually from \
                https://sourceforge.net/projects/vcxsrv/."
                .to_string(),
            dependency: "winget".to_string(),
            install_mode: InstallMode::GuidedExternal,
            install_hint: Some(
                "Installing VcXsrv automatically needs winget. \"Install App Installer\" opens the \
                Microsoft Store; once it's installed, retry to install VcXsrv. Prefer not to? \
                Install VcXsrv manually from https://sourceforge.net/projects/vcxsrv/."
                    .to_string(),
            ),
            install_command: Some(WINGET_INSTALL_VCXSRV_COMMAND.to_string()),
            // The manual VcXsrv download is the payload-driven fallback the UI
            // turns into an "Open …" button when the user declines App Installer.
            install_fallback_url: Some("https://sourceforge.net/projects/vcxsrv/".to_string()),
        }
    }

    /// Windows: VcXsrv is installed but no server is running on `:0`.
    pub fn windows_server_unreachable() -> Self {
        XServerError::ServerUnreachable {
            message: "VcXsrv is installed but no X server is running. termiHub starts one \
                automatically on connect; if this persists, launch VcXsrv on display :0 and retry."
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
            install_mode: InstallMode::Backend,
            install_hint: Some(
                "Download XQuartz from https://www.xquartz.org, then log out and back in so \
                DISPLAY is set."
                    .to_string(),
            ),
            install_command: Some("brew install --cask xquartz".to_string()),
            install_fallback_url: None,
        }
    }

    /// macOS: XQuartz isn't installed and Homebrew — the automatic installer —
    /// is absent, so the user asked to install XQuartz but there is no `brew` to
    /// run it with (#1117).
    ///
    /// Rather than hosting/redistributing a notarized `.pkg`, the UI guides the
    /// user through installing Homebrew first: it opens a local terminal tab
    /// pre-loaded with `install_command` (the official installer), then a retry
    /// re-detects `brew` and installs the cask. `install_mode: GuidedTerminal`
    /// is the typed signal the frontend branches on (#1309); if the user declines,
    /// the hint still points at the manual xquartz.org download (help ends there).
    pub fn homebrew_required() -> Self {
        XServerError::DependencyMissing {
            message: "XQuartz can't be installed automatically because Homebrew is not installed. \
                Install Homebrew, then retry — or install XQuartz manually from \
                https://www.xquartz.org."
                .to_string(),
            dependency: "Homebrew".to_string(),
            install_mode: InstallMode::GuidedTerminal,
            install_hint: Some(
                "Installing XQuartz automatically needs Homebrew. \"Install Homebrew\" opens a \
                terminal with the official installer; once it finishes, retry to install XQuartz. \
                Prefer not to? Install XQuartz manually from https://www.xquartz.org."
                    .to_string(),
            ),
            install_command: Some(HOMEBREW_INSTALL_COMMAND.to_string()),
            install_fallback_url: Some("https://www.xquartz.org".to_string()),
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
            install_mode: InstallMode::Backend,
            install_hint: Some(
                "Install your distribution's Xorg or XWayland package, or run termiHub inside a \
                graphical session."
                    .to_string(),
            ),
            install_command: None,
            install_fallback_url: None,
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
            install_mode: InstallMode::Backend,
            install_hint: Some(
                "Install your distribution's XWayland package (e.g. `xwayland`, `xorg-xwayland`, \
                or `xwayland` via your package manager), then reconnect."
                    .to_string(),
            ),
            install_command: None,
            install_fallback_url: None,
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
    /// Host platform, so the UI can tailor the consent copy (installer name, etc.).
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
    fn homebrew_required_uses_guided_terminal_install_mode() {
        // Brew-absent post-click response: the typed `install_mode` (not the
        // `dependency` name) is what the frontend branches on to open a guided
        // terminal (#1309); `install_command` = the official Homebrew installer
        // that terminal runs, and a hint that still points at the manual
        // xquartz.org download for a user who declines Homebrew.
        match XServerError::homebrew_required() {
            XServerError::DependencyMissing {
                dependency,
                install_mode,
                install_hint,
                install_command,
                install_fallback_url,
                ..
            } => {
                assert_eq!(install_mode, InstallMode::GuidedTerminal);
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
                // The manual fallback (#1312) is a typed payload field, not a
                // frontend-hardcoded URL: xquartz.org for the declined-Homebrew case.
                assert_eq!(
                    install_fallback_url.as_deref(),
                    Some("https://www.xquartz.org")
                );
            }
            other => panic!("expected DependencyMissing, got {other:?}"),
        }
    }

    #[test]
    fn vcxsrv_missing_uses_backend_install_mode_with_winget_command() {
        // VcXsrv-missing (winget present): a Backend install the button drives via
        // `x_server_install_dependency`, carrying the winget command (#1318).
        match XServerError::vcxsrv_missing() {
            XServerError::DependencyMissing {
                dependency,
                install_mode,
                install_command,
                ..
            } => {
                assert_eq!(dependency, "VcXsrv");
                assert_eq!(install_mode, InstallMode::Backend);
                let cmd = install_command.expect("winget command must be present");
                assert!(
                    cmd.contains("winget install"),
                    "should winget-install: {cmd}"
                );
                assert!(
                    cmd.contains("marha.VcXsrv"),
                    "should pin the package: {cmd}"
                );
            }
            other => panic!("expected DependencyMissing, got {other:?}"),
        }
    }

    #[test]
    fn winget_required_uses_guided_external_install_mode() {
        // winget-absent post-click response: the typed `install_mode` is
        // `GuidedExternal` (open the Store / a URL, not a terminal), and the manual
        // VcXsrv download is carried as the payload-driven fallback URL (#1312/#1318).
        match XServerError::winget_required() {
            XServerError::DependencyMissing {
                dependency,
                install_mode,
                install_fallback_url,
                ..
            } => {
                assert_eq!(dependency, "winget");
                assert_eq!(install_mode, InstallMode::GuidedExternal);
                assert!(install_fallback_url.unwrap_or_default().contains("vcxsrv"));
            }
            other => panic!("expected DependencyMissing, got {other:?}"),
        }
    }

    #[test]
    fn backend_install_carries_no_manual_fallback_url() {
        // The manual-fallback button is payload-driven (#1312): the backend-install
        // XQuartz case offers no fallback URL, so the field is omitted from the wire.
        match XServerError::xquartz_missing() {
            XServerError::DependencyMissing {
                install_fallback_url,
                ..
            } => assert_eq!(install_fallback_url, None),
            other => panic!("expected DependencyMissing, got {other:?}"),
        }
        let json = serde_json::to_string(&XServerError::xquartz_missing()).unwrap();
        assert!(!json.contains("installFallbackUrl"));

        let guided = serde_json::to_string(&XServerError::homebrew_required()).unwrap();
        assert!(guided.contains("\"installFallbackUrl\":\"https://www.xquartz.org\""));
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

    #[test]
    fn install_mode_serializes_camel_case_per_variant() {
        // The typed discriminator crosses the IPC boundary as `installMode`
        // (camelCase), mirroring the TS `XServerInstallMode` union (#1309): the
        // backend-driven XQuartz install vs. the guided-terminal Homebrew install.
        let backend = serde_json::to_string(&XServerError::xquartz_missing()).unwrap();
        assert!(backend.contains("\"installMode\":\"backend\""));

        let guided = serde_json::to_string(&XServerError::homebrew_required()).unwrap();
        assert!(guided.contains("\"installMode\":\"guidedTerminal\""));

        let external = serde_json::to_string(&XServerError::winget_required()).unwrap();
        assert!(external.contains("\"installMode\":\"guidedExternal\""));
    }
}

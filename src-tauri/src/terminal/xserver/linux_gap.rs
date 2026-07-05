//! Linux X-server gap classification (#1055).
//!
//! On Linux termiHub never bundles or installs an X server: Xorg/XWayland is
//! essentially always present and the orchestrator adopts it. This module
//! handles only the *edge cases* where forwarding can't reach a local server,
//! turning a generic "no display" failure into a targeted, actionable hint:
//!
//! - **Wayland-only without XWayland** — a Wayland session with no XWayland and
//!   no X socket: forwarding needs an X server, so guide the `xwayland` install.
//! - **Headless** — no local display at all: X11 forwarding has nowhere to
//!   render; suggest a graphical session or a virtual framebuffer.
//! - **Sandboxed socket** — running inside Flatpak/Snap that isn't exposing the
//!   host X socket: guide the `--socket=x11` / `--socket=fallback-x11` grant.
//!
//! Classification is a pure function over an injected [`LinuxXEnv`] snapshot, so
//! every case is unit-testable from fixtures on any CI host; only
//! [`LinuxXEnv::detect`] touches the real environment.

use super::types::XServerError;

/// Sandbox runtime termiHub might be executing inside, which can hide the host
/// X socket from the process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxKind {
    /// Not sandboxed (normal host process).
    None,
    /// Flatpak sandbox (`FLATPAK_ID` / `/.flatpak-info`).
    Flatpak,
    /// Snap confinement (`SNAP` environment).
    Snap,
}

/// An injected snapshot of the Linux X situation, so classification stays pure.
///
/// Built from the real environment by [`LinuxXEnv::detect`]; constructed
/// directly in tests to exercise each gap.
#[derive(Debug, Clone)]
pub struct LinuxXEnv {
    /// `DISPLAY` value, if set and non-empty.
    pub display: Option<String>,
    /// `WAYLAND_DISPLAY` value, if set and non-empty.
    pub wayland_display: Option<String>,
    /// `XDG_SESSION_TYPE` (`wayland` / `x11` / `tty`), if set and non-empty.
    pub xdg_session_type: Option<String>,
    /// Whether `/tmp/.X11-unix` holds at least one `X<N>` server socket.
    pub x11_socket_present: bool,
    /// Whether an `Xwayland` binary is on `PATH`.
    pub xwayland_on_path: bool,
    /// Whether an `Xorg` binary is on `PATH`.
    pub xorg_on_path: bool,
    /// The sandbox termiHub is running under, if any.
    pub sandbox: SandboxKind,
}

impl LinuxXEnv {
    /// True if this looks like a Wayland session.
    fn is_wayland(&self) -> bool {
        self.wayland_display.is_some() || self.xdg_session_type.as_deref() == Some("wayland")
    }

    /// True if `XDG_SESSION_TYPE` explicitly claims an X11 session.
    fn is_x11_session(&self) -> bool {
        self.xdg_session_type.as_deref() == Some("x11")
    }

    /// True if any local X-server binary is installed.
    fn has_x_server_binary(&self) -> bool {
        self.xorg_on_path || self.xwayland_on_path
    }
}

/// A specific, actionable reason SSH X11 forwarding can't reach a local X server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxXGap {
    /// A sandbox (Flatpak/Snap) is hiding the host X socket.
    SandboxSocketHidden,
    /// A Wayland session with no XWayland and no X socket.
    WaylandWithoutXwayland,
    /// No local display at all (headless box).
    Headless,
    /// No X server (Xorg/XWayland) is installed.
    MissingXServer,
    /// A server appears present but no display was reachable.
    ServerUnreachable,
}

/// Classify why no local X server was reachable, given an environment snapshot.
///
/// Pure and side-effect-free. Only called on the failure path, after the
/// orchestrator's adopt/reuse/spawn and cross-platform detection have all come
/// up empty — so a "normal desktop" never reaches here.
pub fn classify(env: &LinuxXEnv) -> LinuxXGap {
    let _ = env;
    todo!("gap classification implemented in the follow-up commit (#1055)")
}

impl LinuxXGap {
    /// Map the gap to a typed, actionable [`XServerError`] for the UI.
    pub fn to_error(self) -> XServerError {
        todo!("gap-to-error mapping implemented in the follow-up commit (#1055)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A base snapshot representing an unremarkable, fully-present desktop; each
    /// test overrides only the fields that define its gap.
    fn base() -> LinuxXEnv {
        LinuxXEnv {
            display: Some(":0".to_string()),
            wayland_display: None,
            xdg_session_type: Some("x11".to_string()),
            x11_socket_present: true,
            xwayland_on_path: true,
            xorg_on_path: true,
            sandbox: SandboxKind::None,
        }
    }

    // ----- classify: one fixture per gap ------------------------------------

    #[test]
    fn wayland_session_without_xwayland_or_socket_is_wayland_gap() {
        let env = LinuxXEnv {
            display: None,
            wayland_display: Some("wayland-0".to_string()),
            xdg_session_type: Some("wayland".to_string()),
            x11_socket_present: false,
            xwayland_on_path: false,
            xorg_on_path: false,
            ..base()
        };
        assert_eq!(classify(&env), LinuxXGap::WaylandWithoutXwayland);
    }

    #[test]
    fn flatpak_hiding_socket_in_wayland_session_is_sandbox_gap() {
        // Sandbox takes precedence: a compositor is clearly up (Wayland) but the
        // X socket isn't visible to the confined process.
        let env = LinuxXEnv {
            display: None,
            wayland_display: Some("wayland-0".to_string()),
            xdg_session_type: Some("wayland".to_string()),
            x11_socket_present: false,
            xwayland_on_path: true,
            xorg_on_path: false,
            sandbox: SandboxKind::Flatpak,
        };
        assert_eq!(classify(&env), LinuxXGap::SandboxSocketHidden);
    }

    #[test]
    fn snap_hiding_socket_in_x11_session_is_sandbox_gap() {
        let env = LinuxXEnv {
            display: Some(":0".to_string()),
            wayland_display: None,
            xdg_session_type: Some("x11".to_string()),
            x11_socket_present: false,
            xwayland_on_path: false,
            xorg_on_path: true,
            sandbox: SandboxKind::Snap,
        };
        assert_eq!(classify(&env), LinuxXGap::SandboxSocketHidden);
    }

    #[test]
    fn no_display_no_session_no_binaries_is_headless() {
        let env = LinuxXEnv {
            display: None,
            wayland_display: None,
            xdg_session_type: Some("tty".to_string()),
            x11_socket_present: false,
            xwayland_on_path: false,
            xorg_on_path: false,
            sandbox: SandboxKind::None,
        };
        assert_eq!(classify(&env), LinuxXGap::Headless);
    }

    #[test]
    fn unset_session_with_nothing_present_is_headless() {
        let env = LinuxXEnv {
            display: None,
            wayland_display: None,
            xdg_session_type: None,
            x11_socket_present: false,
            xwayland_on_path: false,
            xorg_on_path: false,
            sandbox: SandboxKind::None,
        };
        assert_eq!(classify(&env), LinuxXGap::Headless);
    }

    #[test]
    fn x11_session_without_any_server_binary_or_socket_is_missing() {
        let env = LinuxXEnv {
            display: Some(":0".to_string()),
            wayland_display: None,
            xdg_session_type: Some("x11".to_string()),
            x11_socket_present: false,
            xwayland_on_path: false,
            xorg_on_path: false,
            sandbox: SandboxKind::None,
        };
        assert_eq!(classify(&env), LinuxXGap::MissingXServer);
    }

    #[test]
    fn live_socket_present_is_unreachable() {
        // A socket exists but earlier probes failed to connect → unreachable.
        let env = LinuxXEnv {
            x11_socket_present: true,
            ..base()
        };
        assert_eq!(classify(&env), LinuxXGap::ServerUnreachable);
    }

    #[test]
    fn xwayland_installed_but_no_socket_is_unreachable_not_wayland_gap() {
        // XWayland is present, so the gap is "not started/reachable", not "missing".
        let env = LinuxXEnv {
            display: Some(":0".to_string()),
            wayland_display: Some("wayland-0".to_string()),
            xdg_session_type: Some("wayland".to_string()),
            x11_socket_present: false,
            xwayland_on_path: true,
            xorg_on_path: false,
            sandbox: SandboxKind::None,
        };
        assert_eq!(classify(&env), LinuxXGap::ServerUnreachable);
    }

    #[test]
    fn normal_desktop_never_misclassifies_as_a_missing_dependency() {
        // Defensive: the fully-present base must not surface as missing/headless.
        let gap = classify(&base());
        assert!(matches!(gap, LinuxXGap::ServerUnreachable));
    }

    // ----- to_error: targeted, actionable mapping ---------------------------

    #[test]
    fn wayland_gap_maps_to_xwayland_dependency_missing() {
        match LinuxXGap::WaylandWithoutXwayland.to_error() {
            XServerError::DependencyMissing {
                dependency,
                install_hint,
                ..
            } => {
                assert_eq!(dependency, "XWayland");
                assert!(install_hint
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains("xwayland"));
            }
            other => panic!("expected DependencyMissing(XWayland), got {other:?}"),
        }
    }

    #[test]
    fn sandbox_gap_hint_mentions_the_socket_grant() {
        let msg = LinuxXGap::SandboxSocketHidden.to_error().to_string();
        assert!(
            msg.contains("--socket=x11") || msg.contains("fallback-x11"),
            "sandbox hint must name the socket grant, got: {msg}"
        );
    }

    #[test]
    fn headless_gap_hint_mentions_headless_or_virtual_framebuffer() {
        let msg = LinuxXGap::Headless.to_error().to_string().to_lowercase();
        assert!(
            msg.contains("headless") || msg.contains("xvfb") || msg.contains("virtual"),
            "headless hint must explain the no-display case, got: {msg}"
        );
    }

    #[test]
    fn missing_gap_maps_to_xorg_dependency_missing() {
        match LinuxXGap::MissingXServer.to_error() {
            XServerError::DependencyMissing { dependency, .. } => {
                assert_eq!(dependency, "Xorg/XWayland");
            }
            other => panic!("expected DependencyMissing(Xorg/XWayland), got {other:?}"),
        }
    }

    #[test]
    fn unreachable_gap_maps_to_server_unreachable() {
        assert!(matches!(
            LinuxXGap::ServerUnreachable.to_error(),
            XServerError::ServerUnreachable { .. }
        ));
    }
}

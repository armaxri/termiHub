//! Desktop-side [`ConnectionTypeRegistry`] setup.
//!
//! Registers all available [`ConnectionType`](termihub_core::connection::ConnectionType)
//! backends from `termihub_core` so the desktop can create local connections
//! generically by `type_id`.

use termihub_core::connection::ConnectionTypeRegistry;

/// Build a [`ConnectionTypeRegistry`] with all backends available on this
/// platform.
///
/// All non-platform-gated backends are registered unconditionally.
/// WSL is gated to Windows only.
pub fn build_desktop_registry() -> ConnectionTypeRegistry {
    let mut registry = ConnectionTypeRegistry::new();

    // Local shell (PTY-based)
    registry.register(
        "local",
        "Local Shell",
        "terminal",
        Box::new(|| Box::new(termihub_core::backends::local_shell::LocalShell::new())),
    );

    // Serial port
    registry.register(
        "serial",
        "Serial Port",
        "serial",
        Box::new(|| Box::new(termihub_core::backends::serial::Serial::new())),
    );

    // SSH
    registry.register(
        "ssh",
        "SSH",
        "ssh",
        Box::new(|| Box::new(termihub_core::backends::ssh::Ssh::new())),
    );

    // Telnet
    registry.register(
        "telnet",
        "Telnet",
        "telnet",
        Box::new(|| Box::new(termihub_core::backends::telnet::Telnet::new())),
    );

    // Docker
    registry.register(
        "docker",
        "Docker",
        "docker",
        Box::new(|| Box::new(termihub_core::backends::docker::Docker::new())),
    );

    // WSL (Windows only)
    #[cfg(windows)]
    registry.register(
        "wsl",
        "WSL",
        "wsl",
        Box::new(|| Box::new(termihub_core::backends::wsl::Wsl::new())),
    );

    // FTP / FTPS (gated behind the `ftp` feature; enabled by default)
    #[cfg(feature = "ftp")]
    registry.register(
        "ftp",
        "FTP",
        "network",
        Box::new(|| Box::new(termihub_core::backends::ftp::Ftp::new())),
    );

    // Mock remote desktop — a protocol-less graphical backend so the shared
    // remote-desktop layer works with no real VNC/RDP server (gated behind the
    // `mock-remote-desktop` feature; enabled by default). It reports
    // `graphical: true`, so it routes through the GraphicalSessionManager into a
    // remote-desktop canvas tab. Real backends (VNC #1681, RDP #1682) register
    // here identically — this is the additive, data-driven seam.
    #[cfg(feature = "mock-remote-desktop")]
    registry.register(
        "mock-remote-desktop",
        "Mock Remote Desktop",
        "monitor",
        Box::new(|| {
            Box::new(termihub_core::backends::mock_remote_desktop::MockRemoteDesktop::new())
        }),
    );

    // VNC (RFB) graphical remote-desktop backend (gated behind the `vnc`
    // feature; enabled by default). Reports `graphical: true`, so it routes
    // through the GraphicalSessionManager into a remote-desktop canvas tab and
    // is experimental-gated (#1705) with no per-protocol wiring. Additive, like
    // every other backend — this is the whole desktop-side registration.
    #[cfg(feature = "vnc")]
    registry.register(
        "vnc",
        "VNC",
        "monitor",
        Box::new(|| Box::new(termihub_core::backends::vnc::Vnc::new())),
    );

    // RDP (IronRDP) graphical remote-desktop backend (#1682) would register here,
    // identically to VNC above. It is parked pending the russh/IronRDP RustCrypto
    // dependency conflict — see the blocker note in `core/Cargo.toml`. Restore the
    // `#[cfg(feature = "rdp")]` registration (and the `rdp` feature) when cleared.

    registry
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_registry_returns_expected_types() {
        let registry = build_desktop_registry();
        let types = registry.available_types();

        assert!(registry.has_type("local"));
        assert!(registry.has_type("serial"));
        assert!(registry.has_type("ssh"));
        assert!(registry.has_type("telnet"));
        assert!(registry.has_type("docker"));

        #[cfg(windows)]
        assert!(registry.has_type("wsl"));
        #[cfg(not(windows))]
        assert!(!registry.has_type("wsl"));

        #[cfg(feature = "ftp")]
        assert!(registry.has_type("ftp"));
        #[cfg(not(feature = "ftp"))]
        assert!(!registry.has_type("ftp"));

        #[cfg(feature = "mock-remote-desktop")]
        assert!(registry.has_type("mock-remote-desktop"));

        #[cfg(feature = "vnc")]
        assert!(registry.has_type("vnc"));

        // 5 always-on backends (local/serial/ssh/telnet/docker), plus WSL on
        // Windows, FTP when the `ftp` feature is enabled, the mock
        // remote-desktop backend when `mock-remote-desktop` is enabled, and the
        // VNC backend when `vnc` is enabled. (RDP #1682 is parked — see below.)
        let expected = 5
            + cfg!(windows) as usize
            + cfg!(feature = "ftp") as usize
            + cfg!(feature = "mock-remote-desktop") as usize
            + cfg!(feature = "vnc") as usize;
        assert_eq!(types.len(), expected);
    }

    #[cfg(feature = "ftp")]
    #[test]
    fn registry_registers_ftp_backend() {
        let registry = build_desktop_registry();
        assert!(registry.has_type("ftp"));
        let conn = registry
            .create("ftp")
            .expect("ftp backend should be registered");
        assert_eq!(conn.type_id(), "ftp");
    }

    #[test]
    fn registry_type_ids_match_backends() {
        let registry = build_desktop_registry();

        let conn = registry.create("local").unwrap();
        assert_eq!(conn.type_id(), "local");

        let conn = registry.create("serial").unwrap();
        assert_eq!(conn.type_id(), "serial");

        let conn = registry.create("ssh").unwrap();
        assert_eq!(conn.type_id(), "ssh");

        let conn = registry.create("telnet").unwrap();
        assert_eq!(conn.type_id(), "telnet");

        let conn = registry.create("docker").unwrap();
        assert_eq!(conn.type_id(), "docker");
    }
}

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

        // 5 always-on backends (local/serial/ssh/telnet/docker), plus WSL on
        // Windows and FTP when the `ftp` feature is enabled.
        let expected = 5 + cfg!(windows) as usize + cfg!(feature = "ftp") as usize;
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

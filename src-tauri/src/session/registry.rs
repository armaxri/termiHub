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

        #[cfg(windows)]
        assert_eq!(types.len(), 6);
        #[cfg(not(windows))]
        assert_eq!(types.len(), 5);
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

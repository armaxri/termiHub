//! Agent-side [`ConnectionTypeRegistry`] setup.
//!
//! Registers all available [`ConnectionType`](termihub_core::connection::ConnectionType)
//! backends from `termihub_core` so the agent can create connections
//! generically by `type_id`.

use termihub_core::connection::ConnectionTypeRegistry;

/// Build a [`ConnectionTypeRegistry`] with all backends available on this
/// platform.
///
/// All core backends are registered unconditionally (the agent enables all
/// core features). WSL is additionally gated to Windows.
pub fn build_registry() -> ConnectionTypeRegistry {
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

    // SSH.
    //
    // The agent reuses the core SSH backend verbatim, so SSH **agent
    // forwarding** (`forwardAgent`, #1699) is honored on the agent's SSH leg by
    // the same connector/handler as the desktop path (#1719). The forwarded
    // agent channel is bridged to the ssh-agent **local to the agent host**
    // (`$SSH_AUTH_SOCK` / the Windows OpenSSH pipe); the session daemon inherits
    // the agent's environment, so when the desktop→agent SSH leg itself forwards
    // the agent, that host-local socket transparently chains back to the
    // operator's own agent end to end — no bespoke JSON-RPC relay. Absence of a
    // host-local agent is a graceful no-op. See `docs/testing.md` → "SSH agent
    // forwarding through the remote agent".
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
        let registry = build_registry();
        let types = registry.available_types();

        // All non-platform-gated backends should be registered.
        assert!(registry.has_type("local"));
        assert!(registry.has_type("serial"));
        assert!(registry.has_type("ssh"));
        assert!(registry.has_type("telnet"));
        assert!(registry.has_type("docker"));

        // WSL only on Windows.
        #[cfg(windows)]
        assert!(registry.has_type("wsl"));
        #[cfg(not(windows))]
        assert!(!registry.has_type("wsl"));

        // Verify total count.
        #[cfg(windows)]
        assert_eq!(types.len(), 6);
        #[cfg(not(windows))]
        assert_eq!(types.len(), 5);
    }

    #[test]
    fn registry_type_ids_match_backends() {
        let registry = build_registry();

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

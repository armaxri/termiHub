//! Agent-side [`ConnectionTypeRegistry`] setup.
//!
//! Registers all available [`ConnectionType`](termihub_core::connection::ConnectionType)
//! backends from `termihub_core` so the agent can create connections
//! generically by `type_id`.

use termihub_core::connection::{register_core_backends, ConnectionTypeRegistry};

/// Build a [`ConnectionTypeRegistry`] with all backends available on this
/// platform.
///
/// The agent registers exactly the shared core backends (local shell, serial,
/// SSH, telnet, Docker, plus WSL on Windows) via
/// [`register_core_backends`](termihub_core::connection::register_core_backends),
/// the single source it and the desktop both draw from (DUP-013). The agent
/// adds no host-specific types of its own — the SSH backend it registers is the
/// same core one the desktop uses, so SSH agent forwarding (`forwardAgent`,
/// #1699) is honored on the agent's SSH leg exactly as on the desktop (#1719).
pub fn build_registry() -> ConnectionTypeRegistry {
    let mut registry = ConnectionTypeRegistry::new();
    register_core_backends(&mut registry);
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

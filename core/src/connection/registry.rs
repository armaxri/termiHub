//! Runtime connection type registry.
//!
//! Since concrete connection type implementations live in the desktop
//! and agent crates (not in core), the registry is populated at startup
//! by each consumer crate.
//!
//! # Example
//!
//! ```ignore
//! let mut registry = ConnectionTypeRegistry::new();
//! registry.register("ssh", "SSH", "ssh", Box::new(|| Box::new(SshConnection::new())));
//!
//! let info = registry.available_types(); // list all registered types
//! let conn = registry.create("ssh")?;    // create a new instance
//! ```

use super::schema::SettingsSchema;
use super::Capabilities;
use super::ConnectionType;
use crate::errors::CoreError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Factory function that creates a new, unconnected connection type instance.
pub type ConnectionFactory = Box<dyn Fn() -> Box<dyn ConnectionType> + Send + Sync>;

/// Metadata about a registered connection type for UI discovery.
///
/// Serializable so it can be sent to the frontend via JSON-RPC
/// or Tauri commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTypeInfo {
    /// Machine-readable identifier (e.g., `"ssh"`).
    pub type_id: String,
    /// Human-readable display name (e.g., `"SSH"`).
    pub display_name: String,
    /// Icon identifier for the UI (e.g., `"terminal"`, `"ssh"`, `"serial"`).
    pub icon: String,
    /// Settings schema for form generation.
    pub schema: SettingsSchema,
    /// Capabilities of this connection type.
    pub capabilities: Capabilities,
}

/// Runtime registry of available connection types.
///
/// Desktop and agent crates register their connection type factories
/// at startup. The registry provides discovery (listing all types with
/// their schemas) and creation (instantiating a connection by type ID).
pub struct ConnectionTypeRegistry {
    factories: HashMap<String, RegistryEntry>,
    /// Insertion order for deterministic iteration.
    order: Vec<String>,
}

struct RegistryEntry {
    info: ConnectionTypeInfo,
    factory: ConnectionFactory,
}

impl ConnectionTypeRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self {
            factories: HashMap::new(),
            order: Vec::new(),
        }
    }

    /// Register a connection type with the given metadata and factory.
    ///
    /// The `factory` is called each time [`create()`](Self::create) is
    /// invoked for this `type_id`. It must return a fresh, unconnected
    /// instance.
    ///
    /// # Arguments
    ///
    /// * `type_id` - Machine-readable identifier
    /// * `display_name` - Human-readable name
    /// * `icon` - Icon identifier for the UI
    /// * `factory` - Factory closure that creates instances
    pub fn register(
        &mut self,
        type_id: &str,
        display_name: &str,
        icon: &str,
        factory: ConnectionFactory,
    ) {
        // Create a temporary instance to extract schema and capabilities.
        let instance = factory();
        let info = ConnectionTypeInfo {
            type_id: type_id.to_string(),
            display_name: display_name.to_string(),
            icon: icon.to_string(),
            schema: instance.settings_schema(),
            capabilities: instance.capabilities(),
        };
        if !self.factories.contains_key(type_id) {
            self.order.push(type_id.to_string());
        }
        self.factories
            .insert(type_id.to_string(), RegistryEntry { info, factory });
    }

    /// List all registered connection types with their metadata.
    ///
    /// Returns types in registration order, suitable for sending to the
    /// frontend for UI discovery.
    pub fn available_types(&self) -> Vec<ConnectionTypeInfo> {
        self.order
            .iter()
            .filter_map(|id| self.factories.get(id).map(|e| e.info.clone()))
            .collect()
    }

    /// Create a new connection instance by type ID.
    ///
    /// Returns an unconnected instance. Call
    /// [`ConnectionType::connect()`] with settings JSON to establish the
    /// connection.
    pub fn create(&self, type_id: &str) -> Result<Box<dyn ConnectionType>, CoreError> {
        self.factories
            .get(type_id)
            .map(|entry| (entry.factory)())
            .ok_or_else(|| CoreError::Config(format!("Unknown connection type: {type_id}")))
    }

    /// Check whether a connection type is registered.
    pub fn has_type(&self, type_id: &str) -> bool {
        self.factories.contains_key(type_id)
    }
}

impl Default for ConnectionTypeRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::schema::*;
    use crate::errors::SessionError;
    use crate::files::FileBrowser;
    use crate::monitoring::MonitoringProvider;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Minimal mock connection type for testing.
    struct MockConnection {
        id: &'static str,
    }

    #[async_trait::async_trait]
    impl ConnectionType for MockConnection {
        fn type_id(&self) -> &str {
            self.id
        }
        fn display_name(&self) -> &str {
            "Mock"
        }
        fn settings_schema(&self) -> SettingsSchema {
            SettingsSchema {
                groups: vec![SettingsGroup {
                    key: "test".to_string(),
                    label: "Test".to_string(),
                    fields: vec![SettingsField {
                        key: "host".to_string(),
                        label: "Host".to_string(),
                        description: None,
                        field_type: FieldType::Text,
                        required: true,
                        default: None,
                        placeholder: None,
                        supports_env_expansion: false,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    }],
                }],
            }
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                monitoring: false,
                file_browser: false,
                resize: true,
                persistent: false,
            }
        }
        async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
            Ok(())
        }
        async fn disconnect(&mut self) -> Result<(), SessionError> {
            Ok(())
        }
        fn is_connected(&self) -> bool {
            false
        }
        fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
            Ok(())
        }
        fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
            Ok(())
        }
        fn subscribe_output(&self) -> crate::connection::OutputReceiver {
            let (_tx, rx) = tokio::sync::mpsc::channel(1);
            rx
        }
        fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
            None
        }
        fn file_browser(&self) -> Option<&dyn FileBrowser> {
            None
        }
    }

    fn mock_factory(id: &'static str) -> ConnectionFactory {
        Box::new(move || Box::new(MockConnection { id }))
    }

    #[test]
    fn register_and_create() {
        let mut registry = ConnectionTypeRegistry::new();
        registry.register("mock", "Mock", "terminal", mock_factory("mock"));

        let conn = registry.create("mock").unwrap();
        assert_eq!(conn.type_id(), "mock");
        assert_eq!(conn.display_name(), "Mock");
    }

    #[test]
    fn unknown_type_returns_error() {
        let registry = ConnectionTypeRegistry::new();
        let result = registry.create("nonexistent");
        match result {
            Err(err) => {
                let msg = err.to_string();
                assert!(msg.contains("Unknown connection type"));
                assert!(msg.contains("nonexistent"));
            }
            Ok(_) => panic!("expected error for unknown type"),
        }
    }

    #[test]
    fn available_types_lists_registered() {
        let mut registry = ConnectionTypeRegistry::new();
        registry.register("ssh", "SSH", "ssh-icon", mock_factory("ssh"));
        registry.register("serial", "Serial", "serial-icon", mock_factory("serial"));

        let types = registry.available_types();
        assert_eq!(types.len(), 2);
        assert_eq!(types[0].type_id, "ssh");
        assert_eq!(types[0].display_name, "SSH");
        assert_eq!(types[0].icon, "ssh-icon");
        assert_eq!(types[1].type_id, "serial");
    }

    #[test]
    fn available_types_preserves_registration_order() {
        let mut registry = ConnectionTypeRegistry::new();
        registry.register("c", "C", "c", mock_factory("c"));
        registry.register("a", "A", "a", mock_factory("a"));
        registry.register("b", "B", "b", mock_factory("b"));

        let types = registry.available_types();
        let ids: Vec<&str> = types.iter().map(|t| t.type_id.as_str()).collect();
        assert_eq!(ids, vec!["c", "a", "b"]);
    }

    #[test]
    fn has_type_returns_correct_results() {
        let mut registry = ConnectionTypeRegistry::new();
        registry.register("ssh", "SSH", "ssh", mock_factory("ssh"));

        assert!(registry.has_type("ssh"));
        assert!(!registry.has_type("telnet"));
    }

    #[test]
    fn empty_registry_returns_empty_list() {
        let registry = ConnectionTypeRegistry::new();
        assert!(registry.available_types().is_empty());
    }

    #[test]
    fn factory_produces_fresh_instances() {
        let counter = Arc::new(AtomicUsize::new(0));
        let counter_clone = counter.clone();
        let factory: ConnectionFactory = Box::new(move || {
            counter_clone.fetch_add(1, Ordering::SeqCst);
            Box::new(MockConnection { id: "mock" })
        });

        let mut registry = ConnectionTypeRegistry::new();
        // Register calls factory once to extract schema/capabilities.
        registry.register("mock", "Mock", "terminal", factory);
        assert_eq!(counter.load(Ordering::SeqCst), 1);

        // Each create call invokes the factory again.
        let _c1 = registry.create("mock").unwrap();
        assert_eq!(counter.load(Ordering::SeqCst), 2);

        let _c2 = registry.create("mock").unwrap();
        assert_eq!(counter.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn connection_type_info_serde_roundtrip() {
        let info = ConnectionTypeInfo {
            type_id: "ssh".to_string(),
            display_name: "SSH".to_string(),
            icon: "ssh".to_string(),
            schema: SettingsSchema { groups: vec![] },
            capabilities: Capabilities {
                monitoring: true,
                file_browser: true,
                resize: true,
                persistent: false,
            },
        };
        let json = serde_json::to_string(&info).unwrap();
        let deserialized: ConnectionTypeInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.type_id, "ssh");
        assert_eq!(deserialized.display_name, "SSH");
        assert!(deserialized.capabilities.monitoring);
    }

    #[test]
    fn default_creates_empty_registry() {
        let registry = ConnectionTypeRegistry::default();
        assert!(registry.available_types().is_empty());
    }
}

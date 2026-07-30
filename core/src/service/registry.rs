//! Runtime registry of available service types.
//!
//! Twin of [`ConnectionTypeRegistry`](crate::connection::ConnectionTypeRegistry):
//! desktop and agent crates register service factories at startup, and the
//! registry provides discovery (listing services with their schemas) and
//! creation (instantiating a service by id). Because a service is stateful and
//! created fresh per run, the registry stores a **factory** per id (unlike the
//! stateless [`ToolRegistry`](crate::tool::ToolRegistry), which stores shared
//! instances).
//!
//! # Example
//!
//! ```ignore
//! let mut registry = ServiceRegistry::new();
//! registry.register("http_server", "HTTP Server", "server",
//!     Box::new(|| Box::new(HttpServerService::new())));
//! let svc = registry.create("http_server")?;
//! ```

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{Service, ServiceCapabilities, ServiceError};
use crate::connection::SettingsSchema;

/// Factory that creates a new, stopped service instance.
pub type ServiceFactory = Box<dyn Fn() -> Box<dyn Service> + Send + Sync>;

/// Metadata about a registered service type for UI discovery.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    /// Machine-readable identifier (e.g. `"http_server"`).
    pub service_id: String,
    /// Human-readable display name (e.g. `"HTTP Server"`).
    pub display_name: String,
    /// Icon identifier for the UI.
    pub icon: String,
    /// Settings schema for form generation.
    pub schema: SettingsSchema,
    /// Capabilities of this service type.
    pub capabilities: ServiceCapabilities,
}

struct RegistryEntry {
    info: ServiceInfo,
    factory: ServiceFactory,
}

/// Runtime registry of available service types.
#[derive(Default)]
pub struct ServiceRegistry {
    factories: HashMap<String, RegistryEntry>,
    /// Insertion order for deterministic listing.
    order: Vec<String>,
}

impl ServiceRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a service type with the given metadata and factory.
    ///
    /// The factory is invoked once here to extract the schema and capabilities,
    /// then again on each [`create`](Self::create).
    pub fn register(
        &mut self,
        service_id: &str,
        display_name: &str,
        icon: &str,
        factory: ServiceFactory,
    ) {
        let instance = factory();
        let info = ServiceInfo {
            service_id: service_id.to_string(),
            display_name: display_name.to_string(),
            icon: icon.to_string(),
            schema: instance.settings_schema(),
            capabilities: instance.capabilities(),
        };
        if !self.factories.contains_key(service_id) {
            self.order.push(service_id.to_string());
        }
        self.factories
            .insert(service_id.to_string(), RegistryEntry { info, factory });
    }

    /// List all registered service types, in registration order.
    pub fn available_services(&self) -> Vec<ServiceInfo> {
        self.order
            .iter()
            .filter_map(|id| self.factories.get(id).map(|e| e.info.clone()))
            .collect()
    }

    /// Create a fresh (stopped) service instance by id.
    pub fn create(&self, service_id: &str) -> Result<Box<dyn Service>, ServiceError> {
        self.factories
            .get(service_id)
            .map(|entry| (entry.factory)())
            .ok_or_else(|| ServiceError::Unknown(service_id.to_string()))
    }

    /// Whether a service type with the given id is registered.
    pub fn has_service(&self, service_id: &str) -> bool {
        self.factories.contains_key(service_id)
    }

    /// Remove a previously-registered service type. Returns `true` if removed.
    pub fn unregister(&mut self, service_id: &str) -> bool {
        if self.factories.remove(service_id).is_some() {
            self.order.retain(|id| id != service_id);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::{EventChannel, ServiceEventReceiver, ServiceStatus};
    use async_trait::async_trait;
    use serde_json::Value;

    /// Minimal mock service: tracks status and emits a `status` event on each
    /// lifecycle transition. Exercises the trait + registry without any real
    /// server.
    struct MockService {
        id: &'static str,
        desktop_only: bool,
        status: ServiceStatus,
        events: EventChannel,
    }

    impl MockService {
        fn new(id: &'static str, desktop_only: bool) -> Self {
            Self {
                id,
                desktop_only,
                status: ServiceStatus::Stopped,
                events: EventChannel::new(),
            }
        }
    }

    #[async_trait]
    impl Service for MockService {
        fn service_id(&self) -> &str {
            self.id
        }
        fn display_name(&self) -> &str {
            "Mock Service"
        }
        fn settings_schema(&self) -> SettingsSchema {
            SettingsSchema { groups: vec![] }
        }
        fn capabilities(&self) -> ServiceCapabilities {
            ServiceCapabilities {
                configurable: false,
                emits_events: true,
                desktop_only: self.desktop_only,
            }
        }
        async fn start(&mut self, _config: Value) -> Result<(), ServiceError> {
            self.status = ServiceStatus::Running;
            self.events
                .emit(crate::service::ServiceEvent::new("status", "running"));
            Ok(())
        }
        async fn stop(&mut self) -> Result<(), ServiceError> {
            self.status = ServiceStatus::Stopped;
            self.events
                .emit(crate::service::ServiceEvent::new("status", "stopped"));
            Ok(())
        }
        fn status(&self) -> ServiceStatus {
            self.status.clone()
        }
        fn subscribe_events(&self) -> ServiceEventReceiver {
            self.events.subscribe()
        }
    }

    fn mock_factory(id: &'static str, desktop_only: bool) -> ServiceFactory {
        Box::new(move || Box::new(MockService::new(id, desktop_only)))
    }

    #[test]
    fn register_create_and_list() {
        let mut registry = ServiceRegistry::new();
        registry.register("http", "HTTP Server", "server", mock_factory("http", false));
        registry.register("cred", "Credentials", "key", mock_factory("cred", true));

        let services = registry.available_services();
        assert_eq!(services.len(), 2);
        assert_eq!(services[0].service_id, "http");
        assert!(!services[0].capabilities.desktop_only);
        assert!(services[1].capabilities.desktop_only);

        let svc = registry.create("http").expect("create must succeed");
        assert_eq!(svc.service_id(), "http");
        assert_eq!(svc.status(), ServiceStatus::Stopped);
    }

    #[test]
    fn unknown_service_returns_error() {
        let registry = ServiceRegistry::new();
        // `Box<dyn Service>` is not `Debug`, so match rather than `expect_err`.
        match registry.create("ghost") {
            Err(ServiceError::Unknown(id)) => assert_eq!(id, "ghost"),
            Err(other) => panic!("wrong error: {other}"),
            Ok(_) => panic!("expected error for unknown service"),
        }
    }

    #[test]
    fn unregister_removes_service_and_order() {
        let mut registry = ServiceRegistry::new();
        registry.register("a", "A", "i", mock_factory("a", false));
        registry.register("b", "B", "i", mock_factory("b", false));
        assert!(registry.unregister("a"));
        assert!(!registry.has_service("a"));
        assert!(!registry.unregister("a"));
        let ids: Vec<String> = registry
            .available_services()
            .into_iter()
            .map(|s| s.service_id)
            .collect();
        assert_eq!(ids, vec!["b".to_string()]);
    }

    #[tokio::test]
    async fn lifecycle_transitions_and_emits_events() {
        let registry = {
            let mut r = ServiceRegistry::new();
            r.register("http", "HTTP Server", "server", mock_factory("http", false));
            r
        };
        let mut svc = registry.create("http").unwrap();
        let mut events = svc.subscribe_events();

        assert_eq!(svc.status(), ServiceStatus::Stopped);
        svc.start(Value::Null).await.unwrap();
        assert_eq!(svc.status(), ServiceStatus::Running);
        let started = events.recv().await.unwrap();
        assert_eq!(started.payload, "running");

        svc.stop().await.unwrap();
        assert_eq!(svc.status(), ServiceStatus::Stopped);
        let stopped = events.recv().await.unwrap();
        assert_eq!(stopped.payload, "stopped");
    }
}

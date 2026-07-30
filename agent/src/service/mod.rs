//! Agent-side hosting of embedded HTTP/FTP/TFTP servers (#2192).
//!
//! Mirrors [`AgentTunnelRegistry`](crate::tunnel::AgentTunnelRegistry): the agent
//! owns the running server instances, the desktop keeps only control
//! (start/stop/status over the `service.*` RPC). Each server is a
//! [`termihub_core`] [`Service`]; the agent creates one from the shared factory
//! [`ServiceRegistry`], starts it, and keeps it in an id-keyed map so it can be
//! stopped or queried later. A background task drains the service's core
//! [`EventChannel`](termihub_core::service::EventChannel) into a latest-status
//! slot so `service.status` can report the streamed [`ServerState`] without the
//! desktop having to subscribe.
//!
//! [`ServerState`]: termihub_core::embedded_servers::config::ServerState

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use termihub_core::service::{
    Service, ServiceError, ServiceEvent, ServiceInfo, ServiceRegistry, ServiceStatus,
};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// A running embedded-server instance on the agent.
struct RunningService {
    service: Box<dyn Service>,
    /// Latest status payload emitted on the service's `EventChannel` (the
    /// `ServerState` JSON), captured by `bridge`.
    latest: Arc<StdMutex<Option<Value>>>,
    /// Task draining the `EventChannel` into `latest`; aborted on stop.
    bridge: JoinHandle<()>,
}

/// A snapshot of a running service's state, returned by `service.status`.
pub struct ServiceStatusSnapshot {
    /// The service's current lifecycle status.
    pub status: ServiceStatus,
    /// The latest status payload streamed on its event channel, if any.
    pub state: Option<Value>,
}

/// Registry of embedded-server *types* (factories) plus the live instances the
/// agent is currently hosting.
pub struct AgentServiceRegistry {
    factories: ServiceRegistry,
    running: Mutex<HashMap<String, RunningService>>,
}

impl AgentServiceRegistry {
    /// Build the registry from a populated factory [`ServiceRegistry`] — the
    /// shared [`termihub_core::embedded_servers::build_service_registry`].
    pub fn new(factories: ServiceRegistry) -> Self {
        Self {
            factories,
            running: Mutex::new(HashMap::new()),
        }
    }

    /// The server types available to host, for `service.list`.
    pub fn available_services(&self) -> Vec<ServiceInfo> {
        self.factories.available_services()
    }

    /// Start service type `service_id` as instance `instance_id` with `config`.
    ///
    /// Rejects a duplicate `instance_id` and an unknown `service_id`. Returns the
    /// service's status once started, plus the latest status payload seen so far.
    pub async fn start(
        &self,
        instance_id: &str,
        service_id: &str,
        config: Value,
    ) -> Result<ServiceStatusSnapshot, ServiceError> {
        let mut running = self.running.lock().await;
        if running.contains_key(instance_id) {
            return Err(ServiceError::StartFailed(format!(
                "service instance '{instance_id}' is already running"
            )));
        }

        let mut service = self.factories.create(service_id)?;

        // Subscribe before starting so the bridge cannot miss the first
        // Starting/Running transitions.
        let latest = Arc::new(StdMutex::new(None));
        let mut rx = service.subscribe_events();
        let latest_for_task = Arc::clone(&latest);
        let bridge = tokio::spawn(async move {
            use tokio::sync::broadcast::error::RecvError;
            loop {
                match rx.recv().await {
                    Ok(ServiceEvent { payload, .. }) => {
                        if let Ok(mut slot) = latest_for_task.lock() {
                            *slot = Some(payload);
                        }
                    }
                    // Advisory events: a lagging drain drops the oldest and keeps going.
                    Err(RecvError::Lagged(_)) => continue,
                    // The service was dropped — nothing more to capture.
                    Err(RecvError::Closed) => break,
                }
            }
        });

        if let Err(e) = service.start(config).await {
            bridge.abort();
            return Err(e);
        }

        let status = service.status();
        let state = latest.lock().ok().and_then(|s| s.clone());
        running.insert(
            instance_id.to_string(),
            RunningService {
                service,
                latest,
                bridge,
            },
        );
        Ok(ServiceStatusSnapshot { status, state })
    }

    /// Stop and remove instance `instance_id`. Returns whether it was running.
    pub async fn stop(&self, instance_id: &str) -> bool {
        let mut running = self.running.lock().await;
        if let Some(mut rs) = running.remove(instance_id) {
            let _ = rs.service.stop().await;
            rs.bridge.abort();
            true
        } else {
            false
        }
    }

    /// Current status of instance `instance_id`, or `None` if it is not running.
    pub async fn status(&self, instance_id: &str) -> Option<ServiceStatusSnapshot> {
        let running = self.running.lock().await;
        running.get(instance_id).map(|rs| ServiceStatusSnapshot {
            status: rs.service.status(),
            state: rs.latest.lock().ok().and_then(|s| s.clone()),
        })
    }

    /// Number of currently-hosted instances.
    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn active_count(&self) -> usize {
        self.running.lock().await.len()
    }

    /// Stop every hosted instance (called on `agent.shutdown`) so no server
    /// listener outlives the agent.
    pub async fn stop_all(&self) {
        let mut running = self.running.lock().await;
        for (_id, mut rs) in running.drain() {
            let _ = rs.service.stop().await;
            rs.bridge.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termihub_core::embedded_servers::build_service_registry;
    use termihub_core::embedded_servers::service::SERVICE_ID_HTTP;

    fn registry() -> AgentServiceRegistry {
        AgentServiceRegistry::new(build_service_registry())
    }

    /// Bind an ephemeral loopback TCP port, then free it, returning the number so
    /// the HTTP server can take it without a fixed-port collision.
    fn free_port() -> u16 {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("bind probe");
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        port
    }

    fn http_config(port: u16) -> Value {
        serde_json::json!({
            "id": "srv-http",
            "name": "Agent HTTP",
            "serverType": "http",
            "rootDirectory": ".",
            "bindHost": "127.0.0.1",
            "port": port,
            "readOnly": true,
            "directoryListing": true,
        })
    }

    #[tokio::test]
    async fn start_hosts_http_server_and_reports_running() {
        let reg = registry();
        let port = free_port();
        let snap = reg
            .start("inst-1", SERVICE_ID_HTTP, http_config(port))
            .await
            .expect("http server starts on the agent");
        assert_eq!(snap.status, ServiceStatus::Running);
        assert_eq!(reg.active_count().await, 1);

        // The server actually serves: a plain TCP connect to the bound port
        // succeeds while it is running.
        let conn = std::net::TcpStream::connect(("127.0.0.1", port));
        assert!(conn.is_ok(), "hosted HTTP server must accept connections");

        assert!(reg.stop("inst-1").await);
        assert_eq!(reg.active_count().await, 0);
    }

    #[tokio::test]
    async fn status_reports_running_then_none_after_stop() {
        let reg = registry();
        let port = free_port();
        reg.start("inst-1", SERVICE_ID_HTTP, http_config(port))
            .await
            .expect("start");

        let status = reg.status("inst-1").await.expect("running instance");
        assert_eq!(status.status, ServiceStatus::Running);

        assert!(reg.stop("inst-1").await);
        assert!(reg.status("inst-1").await.is_none());
    }

    #[tokio::test]
    async fn duplicate_instance_id_is_rejected() {
        let reg = registry();
        let port = free_port();
        reg.start("inst-1", SERVICE_ID_HTTP, http_config(port))
            .await
            .expect("first start");
        let err = reg
            .start("inst-1", SERVICE_ID_HTTP, http_config(free_port()))
            .await;
        assert!(matches!(err, Err(ServiceError::StartFailed(_))));
        reg.stop("inst-1").await;
    }

    #[tokio::test]
    async fn unknown_service_id_is_rejected() {
        let reg = registry();
        let err = reg
            .start("inst-1", "not_a_server", serde_json::json!({}))
            .await;
        assert!(matches!(err, Err(ServiceError::Unknown(_))));
    }

    #[tokio::test]
    async fn stop_unknown_instance_returns_false() {
        let reg = registry();
        assert!(!reg.stop("ghost").await);
    }

    #[tokio::test]
    async fn stop_all_tears_down_every_instance() {
        let reg = registry();
        reg.start("a", SERVICE_ID_HTTP, http_config(free_port()))
            .await
            .expect("start a");
        reg.start("b", SERVICE_ID_HTTP, http_config(free_port()))
            .await
            .expect("start b");
        assert_eq!(reg.active_count().await, 2);
        reg.stop_all().await;
        assert_eq!(reg.active_count().await, 0);
    }

    #[test]
    fn available_services_lists_the_three_server_types() {
        let reg = registry();
        assert_eq!(reg.available_services().len(), 3);
    }
}

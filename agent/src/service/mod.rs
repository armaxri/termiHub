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
//! # Idle while no desktop is attached (#3896)
//!
//! That drain task is itself a subscriber, and the HTTP monitor's poll loop only
//! checks while something subscribes to its events (the core observer gate,
//! PERF-008). A permanent drain would keep an agent-hosted monitor checking
//! while no desktop is connected, with every result but the last discarded. So
//! the registry counts the attached clients:
//! [`detach_client`](AgentServiceRegistry::detach_client) of the last one drops the
//! drain of every service that idles when unobserved, which idles its poll loop
//! while keeping the last result for `service.status`;
//! [`attach_client`](AgentServiceRegistry::attach_client) re-subscribes, and the
//! loop checks again within one interval. Embedded servers keep their drain:
//! they serve clients whether or not a desktop watches.
//!
//! # Shared across a listener's connections (#3910)
//!
//! A `--listen` agent builds one handler per connection but passes all of them
//! the same registry, like its `SessionManager`. A service one connection
//! started is therefore still hosted, and reachable, from the next: it can be
//! queried, stopped, or started again. A start for an instance id that is
//! already hosted with the same config is idempotent, since a restarted desktop
//! re-sends the starts it remembers; with a changed config it replaces the
//! instance. Several clients can be attached at once, so "attached" means at
//! least one.
//!
//! [`ServerState`]: termihub_core::embedded_servers::config::ServerState

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use termihub_core::embedded_servers::activity::ActivitySnapshot;
use termihub_core::monitoring::http_monitor::SERVICE_ID as HTTP_MONITOR_SERVICE_ID;
use termihub_core::service::{
    drain_broadcast, Service, ServiceError, ServiceEvent, ServiceInfo, ServiceRegistry,
    ServiceStatus,
};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// A running embedded-server instance on the agent.
struct RunningService {
    service: Box<dyn Service>,
    /// Service type and config it was started with, so a repeated identical
    /// start is recognised as idempotent (#3910).
    service_id: String,
    config: Value,
    /// Latest status payload emitted on the service's `EventChannel` (the
    /// `ServerState` JSON), captured by `bridge`.
    latest: Arc<StdMutex<Option<Value>>>,
    /// Task draining the `EventChannel` into `latest`; aborted on stop. `None`
    /// while the service is idled because no client is attached (#3896).
    bridge: Option<JoinHandle<()>>,
    /// Whether the service does no work while nothing subscribes to its events,
    /// so its drain is dropped while no client is attached (#3896).
    idles_when_unobserved: bool,
}

impl RunningService {
    /// Abort the drain task and wait for it to end, so its subscription is gone
    /// by the time this returns.
    async fn drop_bridge(&mut self) {
        if let Some(bridge) = self.bridge.take() {
            bridge.abort();
            // An aborted task resolves to a cancellation error; nothing to report.
            let _ = bridge.await;
        }
    }
}

/// Whether service type `service_id` does no work while nothing subscribes to
/// its events. Only the HTTP monitor: its poll loop is gated on a subscriber
/// (PERF-008), while an embedded server serves its clients regardless.
fn idles_when_unobserved(service_id: &str) -> bool {
    service_id == HTTP_MONITOR_SERVICE_ID
}

/// Spawn the task that drains `service`'s event channel into `latest`.
fn spawn_bridge(service: &dyn Service, latest: &Arc<StdMutex<Option<Value>>>) -> JoinHandle<()> {
    let rx = service.subscribe_events();
    let latest = Arc::clone(latest);
    tokio::spawn(async move {
        drain_broadcast(rx, move |ServiceEvent { payload, .. }| {
            if let Ok(mut slot) = latest.lock() {
                *slot = Some(payload);
            }
        })
        .await;
    })
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
    /// Clients currently attached (#3896, #3910). Only changed while holding
    /// `running`, so it always agrees with which drains are live.
    attached_clients: AtomicUsize,
}

impl AgentServiceRegistry {
    /// Build the registry from a populated factory [`ServiceRegistry`] — the
    /// shared [`termihub_core::embedded_servers::build_service_registry`].
    pub fn new(factories: ServiceRegistry) -> Self {
        Self {
            factories,
            running: Mutex::new(HashMap::new()),
            attached_clients: AtomicUsize::new(0),
        }
    }

    /// Build the registry with every service type the agent can host: the
    /// embedded HTTP/FTP/TFTP servers (#2192) and the HTTP monitor (#2592).
    pub fn with_builtin_services() -> Self {
        let mut factories = termihub_core::embedded_servers::build_service_registry();
        termihub_core::monitoring::http_monitor::register_http_monitor(&mut factories);
        Self::new(factories)
    }

    /// The server types available to host, for `service.list`.
    pub fn available_services(&self) -> Vec<ServiceInfo> {
        self.factories.available_services()
    }

    /// Start service type `service_id` as instance `instance_id` with `config`.
    ///
    /// If `instance_id` is already hosted and running with the same
    /// `service_id` and `config`, this is idempotent (#3910): the instance keeps
    /// running (a paused monitor resumes) and its status is returned. Otherwise
    /// a hosted instance with that id is stopped and replaced. Rejects an
    /// unknown `service_id`. Returns the service's status once started, plus the
    /// latest status payload seen so far.
    pub async fn start(
        &self,
        instance_id: &str,
        service_id: &str,
        config: Value,
    ) -> Result<ServiceStatusSnapshot, ServiceError> {
        let mut running = self.running.lock().await;
        if let Some(rs) = running.get_mut(instance_id) {
            if rs.service_id == service_id
                && rs.config == config
                && rs.service.status() == ServiceStatus::Running
            {
                // A start means "running": undo an in-place pause (#2607).
                rs.service.resume().await?;
                if rs.bridge.is_none() {
                    rs.bridge = Some(spawn_bridge(rs.service.as_ref(), &rs.latest));
                }
                return Ok(ServiceStatusSnapshot {
                    status: rs.service.status(),
                    state: rs.latest.lock().ok().and_then(|s| s.clone()),
                });
            }
        }
        if let Some(mut stale) = running.remove(instance_id) {
            let _ = stale.service.stop().await;
            stale.drop_bridge().await;
        }

        let mut service = self.factories.create(service_id)?;

        // Subscribe before starting so the bridge cannot miss the first
        // Starting/Running transitions. A start always comes from a client's
        // RPC, so that client is attached and the service is observed.
        let latest = Arc::new(StdMutex::new(None));
        let bridge = spawn_bridge(service.as_ref(), &latest);

        if let Err(e) = service.start(config.clone()).await {
            bridge.abort();
            return Err(e);
        }

        let status = service.status();
        let state = latest.lock().ok().and_then(|s| s.clone());
        running.insert(
            instance_id.to_string(),
            RunningService {
                service,
                service_id: service_id.to_string(),
                config,
                latest,
                bridge: Some(bridge),
                idles_when_unobserved: idles_when_unobserved(service_id),
            },
        );
        Ok(ServiceStatusSnapshot { status, state })
    }

    /// Stop and remove instance `instance_id`. Returns whether it was running.
    pub async fn stop(&self, instance_id: &str) -> bool {
        let mut running = self.running.lock().await;
        if let Some(mut rs) = running.remove(instance_id) {
            let _ = rs.service.stop().await;
            rs.drop_bridge().await;
            true
        } else {
            false
        }
    }

    /// Pause instance `instance_id` **in place**, keeping it hosted (#2607).
    ///
    /// Unlike [`stop`](Self::stop), the instance stays in the running map — its
    /// work is suspended but its identity, event bridge and streamed state are
    /// preserved, so [`resume`](Self::resume) is instant with no re-listing. A
    /// service with no pause concept (the embedded servers) treats this as a
    /// no-op. Returns whether a running instance with that id was found.
    pub async fn pause(&self, instance_id: &str) -> Result<bool, ServiceError> {
        let mut running = self.running.lock().await;
        match running.get_mut(instance_id) {
            Some(rs) => {
                rs.service.pause().await?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Resume instance `instance_id` paused with [`pause`](Self::pause), in place
    /// (#2607). Returns whether a running instance with that id was found.
    pub async fn resume(&self, instance_id: &str) -> Result<bool, ServiceError> {
        let mut running = self.running.lock().await;
        match running.get_mut(instance_id) {
            Some(rs) => {
                rs.service.resume().await?;
                Ok(true)
            }
            None => Ok(false),
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

    /// Access log (entries newer than `since`) + detailed stats of instance
    /// `instance_id` (#3453). `None` when no such instance is hosted, or it is a
    /// service that keeps no access log (e.g. the HTTP monitor).
    pub async fn activity(
        &self,
        instance_id: &str,
        since: Option<u64>,
    ) -> Option<ActivitySnapshot> {
        let running = self.running.lock().await;
        running
            .get(instance_id)
            .and_then(|rs| rs.service.access_activity(since))
    }

    /// Clear the access log + counters of instance `instance_id` (#3453).
    /// Returns whether a hosted instance that keeps a log was found.
    pub async fn clear_activity(&self, instance_id: &str) -> bool {
        let running = self.running.lock().await;
        running
            .get(instance_id)
            .is_some_and(|rs| rs.service.clear_access_activity())
    }

    /// The address instance `instance_id`'s listener actually bound, or `None`
    /// when it is not hosted or cannot report it. Lets a test start a server on
    /// port `0` and learn the OS-assigned port, instead of reserving one by
    /// binding and dropping it first (#3533).
    #[cfg(test)]
    pub async fn local_addr(&self, instance_id: &str) -> Option<std::net::SocketAddr> {
        let running = self.running.lock().await;
        running
            .get(instance_id)
            .and_then(|rs| rs.service.local_addr())
    }

    /// Whether instance `instance_id`'s events are currently drained (so a
    /// monitor is observed and checking), or `None` when it is not hosted.
    #[cfg(test)]
    pub async fn is_observed(&self, instance_id: &str) -> Option<bool> {
        let running = self.running.lock().await;
        running.get(instance_id).map(|rs| rs.bridge.is_some())
    }

    /// Number of currently-hosted instances.
    #[cfg(test)]
    pub async fn active_count(&self) -> usize {
        self.running.lock().await.len()
    }

    /// Stop every hosted instance (called on `agent.shutdown`) so no server
    /// listener outlives the agent.
    pub async fn stop_all(&self) {
        let mut running = self.running.lock().await;
        for (_id, mut rs) in running.drain() {
            let _ = rs.service.stop().await;
            rs.drop_bridge().await;
        }
    }

    /// A client has gone (#3896). Once no client is attached any more (#3910),
    /// idle every hosted service that does no work while unobserved, by dropping
    /// its event drain.
    ///
    /// Its poll loop then makes no checks, while `status` keeps reporting the
    /// last result drained before the detach. Services that serve regardless (the
    /// embedded servers) are untouched. Call once per
    /// [`attach_client`](Self::attach_client); extra calls do not underflow the
    /// count.
    pub async fn detach_client(&self) {
        let mut running = self.running.lock().await;
        let remaining = self
            .attached_clients
            .load(Ordering::SeqCst)
            .saturating_sub(1);
        self.attached_clients.store(remaining, Ordering::SeqCst);
        if remaining > 0 {
            return;
        }
        for rs in running.values_mut() {
            if rs.idles_when_unobserved {
                rs.drop_bridge().await;
            }
        }
    }

    /// A client has attached (#3896): count it (#3910) and re-subscribe every
    /// service idled by [`detach_client`](Self::detach_client).
    ///
    /// The core poll loop re-evaluates its observer gate every interval, so an
    /// idled monitor checks again within one interval; until then `status`
    /// reports the last cached result.
    pub async fn attach_client(&self) {
        let mut running = self.running.lock().await;
        self.attached_clients.fetch_add(1, Ordering::SeqCst);
        for rs in running.values_mut() {
            if rs.bridge.is_none() {
                rs.bridge = Some(spawn_bridge(rs.service.as_ref(), &rs.latest));
            }
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

    /// A config for the embedded HTTP server. Tests pass port `0` so the OS
    /// assigns a free ephemeral port at bind time; the server keeps the socket it
    /// binds, so there is no fixed-port collision on a busy CI runner (#2223).
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
        let snap = reg
            .start("inst-1", SERVICE_ID_HTTP, http_config(0))
            .await
            .expect("http server starts on the agent");
        // The core service only emits `Running` after its listener thread has
        // confirmed a real socket bind (GAP G3, #1145), so a `Running` snapshot
        // proves the agent is hosting a live, bound server without the test
        // needing to know the ephemeral port.
        assert_eq!(snap.status, ServiceStatus::Running);
        assert_eq!(reg.active_count().await, 1);

        assert!(reg.stop("inst-1").await);
        assert_eq!(reg.active_count().await, 0);
    }

    #[tokio::test]
    async fn status_reports_running_then_none_after_stop() {
        let reg = registry();
        reg.start("inst-1", SERVICE_ID_HTTP, http_config(0))
            .await
            .expect("start");

        let status = reg.status("inst-1").await.expect("running instance");
        assert_eq!(status.status, ServiceStatus::Running);

        assert!(reg.stop("inst-1").await);
        assert!(reg.status("inst-1").await.is_none());
    }

    /// #3910: a desktop that restarts re-sends `service.start` for an instance
    /// the (shared) registry still hosts. The same start again is idempotent: no
    /// error, and the running instance is kept rather than torn down.
    #[tokio::test]
    async fn restarting_a_hosted_instance_with_the_same_config_is_idempotent() {
        let reg = registry();
        reg.start("inst-1", SERVICE_ID_HTTP, http_config(0))
            .await
            .expect("first start");
        let bound = reg.local_addr("inst-1").await.expect("bound");

        let again = reg
            .start("inst-1", SERVICE_ID_HTTP, http_config(0))
            .await
            .expect("re-sending the same start must not error");
        assert_eq!(again.status, ServiceStatus::Running);
        assert_eq!(reg.active_count().await, 1);
        assert_eq!(
            reg.local_addr("inst-1").await,
            Some(bound),
            "the same instance keeps running, it is not replaced"
        );
        reg.stop("inst-1").await;
    }

    /// #3910: a start for a hosted instance id with a changed config replaces
    /// the instance (the desktop's config is authoritative), without an error.
    #[tokio::test]
    async fn restarting_a_hosted_instance_with_a_changed_config_replaces_it() {
        let reg = registry();
        reg.start("inst-1", SERVICE_ID_HTTP, http_config(0))
            .await
            .expect("first start");
        let mut changed = http_config(0);
        changed["readOnly"] = serde_json::json!(false);
        let snap = reg
            .start("inst-1", SERVICE_ID_HTTP, changed)
            .await
            .expect("a changed start replaces the instance");
        assert_eq!(snap.status, ServiceStatus::Running);
        assert_eq!(reg.active_count().await, 1);
        reg.stop("inst-1").await;
    }

    /// #3910: with one registry shared by a listener's connections, "attached"
    /// means at least one client. One client leaving must not idle a monitor
    /// another client still watches.
    #[tokio::test]
    async fn attach_is_counted_so_one_client_leaving_does_not_idle_another() {
        let reg = monitor_registry();
        reg.attach_client().await;
        reg.start("mon-1", "http_monitor", monitor_config())
            .await
            .expect("monitor hosts on the agent");
        reg.attach_client().await;

        reg.detach_client().await;
        assert_eq!(
            reg.is_observed("mon-1").await,
            Some(true),
            "a second client is still attached"
        );

        reg.detach_client().await;
        assert_eq!(
            reg.is_observed("mon-1").await,
            Some(false),
            "the last client left"
        );

        // More detaches than attaches never underflow the count.
        reg.detach_client().await;
        reg.attach_client().await;
        assert_eq!(reg.is_observed("mon-1").await, Some(true));
        reg.stop("mon-1").await;
    }

    #[tokio::test]
    async fn start_on_a_busy_port_is_rejected() {
        // Hold a real listener so its port is deterministically occupied, then a
        // start against that exact port must fail the pre-flight bind check and
        // report `StartFailed` — a race-free regression for the bind-failure path
        // (unlike an ephemeral port that just happens to be free).
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind probe");
        let busy = listener.local_addr().unwrap().port();

        let reg = registry();
        let err = reg
            .start("inst-1", SERVICE_ID_HTTP, http_config(busy))
            .await;
        assert!(matches!(err, Err(ServiceError::StartFailed(_))));
        assert_eq!(reg.active_count().await, 0);
        drop(listener);
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

    /// A registry that can also host the HTTP monitor, for the in-place
    /// pause/resume path (#2607).
    fn monitor_registry() -> AgentServiceRegistry {
        let mut factories = build_service_registry();
        termihub_core::monitoring::http_monitor::register_http_monitor(&mut factories);
        AgentServiceRegistry::new(factories)
    }

    /// A monitor config pointing at an unreachable loopback port: it hosts fine
    /// (the loop's checks just fail), which is all the lifecycle test needs.
    fn monitor_config() -> Value {
        serde_json::json!({
            "id": "mon-1",
            "url": "http://127.0.0.1:1/",
            "intervalMs": 1_000,
            "method": "GET",
            "expectedStatus": 200,
            "timeoutMs": 500,
        })
    }

    #[tokio::test]
    async fn pause_keeps_the_instance_hosted_then_resume() {
        // In-place pause (#2607): unlike `stop`, the instance stays in the running
        // map — it is not torn down and re-listed — so `status` still reports it
        // hosted and `resume` brings it back without a fresh `start`.
        let reg = monitor_registry();
        reg.start("mon-1", "http_monitor", monitor_config())
            .await
            .expect("monitor hosts on the agent");
        assert_eq!(reg.active_count().await, 1);

        assert!(reg.pause("mon-1").await.expect("pause"));
        assert_eq!(
            reg.active_count().await,
            1,
            "pause must keep the instance hosted, not tear it down"
        );
        assert!(
            reg.status("mon-1").await.is_some(),
            "a paused instance is still hosted"
        );

        assert!(reg.resume("mon-1").await.expect("resume"));
        assert_eq!(reg.active_count().await, 1);

        reg.stop("mon-1").await;
    }

    /// A hosted service that keeps no access log (the HTTP monitor) reads as
    /// `None` and is not "cleared" (#3453) — only the embedded servers log.
    #[tokio::test]
    async fn activity_is_none_for_a_service_without_an_access_log() {
        let reg = monitor_registry();
        reg.start("mon-1", "http_monitor", monitor_config())
            .await
            .expect("monitor hosts on the agent");
        assert!(reg.activity("mon-1", None).await.is_none());
        assert!(!reg.clear_activity("mon-1").await);
        assert!(reg.activity("ghost", None).await.is_none());
        reg.stop("mon-1").await;
    }

    /// A mock HTTP target for the monitor that counts the checks it receives.
    async fn counting_target() -> wiremock::MockServer {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::any())
            .respond_with(wiremock::ResponseTemplate::new(200))
            .mount(&server)
            .await;
        server
    }

    /// Checks the monitor has made against `server` so far.
    async fn check_count(server: &wiremock::MockServer) -> usize {
        server.received_requests().await.map_or(0, |r| r.len())
    }

    /// Poll `cond` every 50 ms for up to `within`, returning whether it held.
    async fn eventually<F, Fut>(within: std::time::Duration, mut cond: F) -> bool
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        let deadline = tokio::time::Instant::now() + within;
        while tokio::time::Instant::now() < deadline {
            if cond().await {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        cond().await
    }

    /// The `timestampMs` of the check `service.status` currently reports.
    async fn reported_timestamp(reg: &AgentServiceRegistry, id: &str) -> Option<u64> {
        let snap = reg.status(id).await?;
        snap.state?.get("timestampMs")?.as_u64()
    }

    /// #3896: while no desktop is attached the agent-hosted monitor makes no
    /// checks, `service.status` still reports the last result, and on re-attach
    /// it checks again within one interval.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn monitor_idles_while_no_client_is_attached_and_resumes_on_attach() {
        use std::time::Duration;

        let target = counting_target().await;
        let reg = monitor_registry();
        reg.start(
            "mon-1",
            "http_monitor",
            serde_json::json!({
                "id": "mon-1",
                "url": format!("{}/health", target.uri()),
                "intervalMs": 1_000,
                "method": "GET",
                "expectedStatus": 200,
                "timeoutMs": 500,
                "allowPrivateNetwork": true,
            }),
        )
        .await
        .expect("monitor hosts on the agent");

        // Attached (the default): it checks, and the result reaches the status.
        assert!(
            eventually(Duration::from_secs(3), || async {
                reported_timestamp(&reg, "mon-1").await.is_some()
            })
            .await,
            "an attached monitor checks and reports its result"
        );

        reg.detach_client().await;
        // Let a check that was already in flight at detach land.
        tokio::time::sleep(Duration::from_millis(600)).await;
        let idle_from = check_count(&target).await;
        let last = reported_timestamp(&reg, "mon-1").await;
        assert!(last.is_some(), "the last result survives the detach");

        tokio::time::sleep(Duration::from_millis(2_500)).await;
        assert_eq!(
            check_count(&target).await,
            idle_from,
            "no checks while no desktop is attached"
        );
        assert_eq!(
            reported_timestamp(&reg, "mon-1").await,
            last,
            "status keeps reporting the last cached result while detached"
        );
        assert_eq!(
            reg.status("mon-1").await.expect("still hosted").status,
            ServiceStatus::Running,
            "an idle monitor stays hosted"
        );

        reg.attach_client().await;
        assert!(
            eventually(Duration::from_millis(1_800), || async {
                check_count(&target).await > idle_from
                    && reported_timestamp(&reg, "mon-1").await > last
            })
            .await,
            "re-attach resumes checking within one interval, with a fresh result"
        );

        reg.stop("mon-1").await;
    }

    /// #3896: the attach gate only idles services that idle when unobserved (the
    /// HTTP monitor). An embedded server keeps serving and streaming its state.
    #[tokio::test]
    async fn detach_leaves_embedded_servers_running() {
        let reg = registry();
        reg.start("inst-1", SERVICE_ID_HTTP, http_config(0))
            .await
            .expect("start");
        reg.detach_client().await;
        let snap = reg.status("inst-1").await.expect("still hosted");
        assert_eq!(snap.status, ServiceStatus::Running);
        assert!(reg.local_addr("inst-1").await.is_some(), "still listening");
        reg.attach_client().await;
        reg.stop("inst-1").await;
    }

    /// Attach/detach are idempotent and survive stopping an idle monitor.
    #[tokio::test]
    async fn repeated_attach_detach_and_stop_while_detached() {
        let reg = monitor_registry();
        reg.start("mon-1", "http_monitor", monitor_config())
            .await
            .expect("monitor hosts on the agent");
        reg.detach_client().await;
        reg.detach_client().await;
        reg.attach_client().await;
        reg.attach_client().await;
        reg.detach_client().await;
        assert!(
            reg.stop("mon-1").await,
            "an idle monitor can still be stopped"
        );
        assert_eq!(reg.active_count().await, 0);
        reg.attach_client().await;
    }

    #[tokio::test]
    async fn pause_and_resume_unknown_instance_return_false() {
        let reg = monitor_registry();
        assert!(!reg
            .pause("ghost")
            .await
            .expect("pause unknown is not an error"));
        assert!(!reg
            .resume("ghost")
            .await
            .expect("resume unknown is not an error"));
    }

    #[tokio::test]
    async fn stop_all_tears_down_every_instance() {
        let reg = registry();
        reg.start("a", SERVICE_ID_HTTP, http_config(0))
            .await
            .expect("start a");
        reg.start("b", SERVICE_ID_HTTP, http_config(0))
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

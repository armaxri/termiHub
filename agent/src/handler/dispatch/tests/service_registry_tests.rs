//! Agent-hosted services shared across a `--listen` agent's connections (#3910).
//!
//! In `--listen` mode a handler is built per connection. The listener passes
//! every handler the same [`AgentServiceRegistry`], so a service one connection
//! started stays reachable from the next, the way sessions do.

use super::*;

/// A handler for one connection, hosting services in `services`.
fn connection_handler(services: &Arc<AgentServiceRegistry>) -> AgentHandler {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let tmp = std::env::temp_dir().join(format!("termihub-svc-{}.json", uuid::Uuid::new_v4()));
    let conn_store = Arc::new(crate::session::definitions::ConnectionStore::new_temp(tmp));
    let registry = Arc::new(crate::registry::build_registry());
    let session_manager = Arc::new(SessionManager::new(tx.clone(), registry));
    let monitoring = Arc::new(crate::monitoring::MonitoringManager::new(
        tx,
        conn_store.clone(),
    ));
    AgentHandler::with_service_registry(
        session_manager as Arc<dyn SessionManagerApi>,
        conn_store as Arc<dyn ConnectionStoreApi>,
        monitoring as Arc<dyn MonitoringManagerApi>,
        services.clone(),
    )
    .expect("build handler")
}

fn monitor_start_params() -> Value {
    json!({
        "instanceId": "mon-1",
        "serviceId": "http_monitor",
        "config": {
            "id": "mon-1",
            "url": "http://127.0.0.1:1/",
            "intervalMs": 60_000,
            "method": "GET",
            "expectedStatus": 200,
            "timeoutMs": 500
        }
    })
}

fn server_start_params() -> Value {
    json!({
        "instanceId": "srv-1",
        "serviceId": "http_server",
        "config": {
            "id": "srv-1",
            "name": "Agent HTTP",
            "serverType": "http",
            "rootDirectory": ".",
            "bindHost": "127.0.0.1",
            "port": 0,
            "readOnly": true,
            "directoryListing": true
        }
    })
}

/// The issue's test: after one connection ends, every service it started is
/// still reachable from the next connection — queryable, re-startable (the
/// desktop re-sends the start after a restart) and stoppable.
#[tokio::test]
async fn hosted_services_stay_reachable_from_the_next_connection() {
    let services = Arc::new(AgentServiceRegistry::with_builtin_services());

    let first = connection_handler(&services);
    init_handler(&first).await;
    for (i, params) in [monitor_start_params(), server_start_params()]
        .into_iter()
        .enumerate()
    {
        let reply = dispatch(&first, "service.start", params, 10 + i as u64).await;
        assert_eq!(reply["result"]["status"]["state"], "running", "{reply}");
    }
    first.deregister_client().await;
    drop(first);

    let second = connection_handler(&services);
    init_handler(&second).await;
    for (i, id) in ["mon-1", "srv-1"].into_iter().enumerate() {
        let status = dispatch(
            &second,
            "service.status",
            json!({ "instanceId": id }),
            20 + i as u64,
        )
        .await;
        assert_eq!(
            status["result"]["status"]["state"], "running",
            "{id} must be queryable from the next connection: {status}"
        );
    }
    assert_eq!(
        services.is_observed("mon-1").await,
        Some(true),
        "the next client's initialize resumes the monitor"
    );

    // A desktop that restarted re-sends the start for the id the agent hosts.
    let again = dispatch(&second, "service.start", monitor_start_params(), 30).await;
    assert_eq!(
        again["result"]["status"]["state"], "running",
        "re-sending the start must not error: {again}"
    );

    for (i, id) in ["mon-1", "srv-1"].into_iter().enumerate() {
        let stop = dispatch(
            &second,
            "service.stop",
            json!({ "instanceId": id }),
            40 + i as u64,
        )
        .await;
        assert_eq!(stop["result"]["stopped"], true, "{id}: {stop}");
    }
    assert_eq!(services.active_count().await, 0);
}

/// Concurrent clients: the monitor idles only once the last attached client
/// has gone, and a client that never initialized does not count.
#[tokio::test]
async fn monitor_idles_only_when_the_last_attached_client_leaves() {
    let services = Arc::new(AgentServiceRegistry::with_builtin_services());
    let a = connection_handler(&services);
    let b = connection_handler(&services);
    let never_initialized = connection_handler(&services);
    init_handler(&a).await;
    init_handler(&b).await;
    let reply = dispatch(&a, "service.start", monitor_start_params(), 10).await;
    assert_eq!(reply["result"]["status"]["state"], "running", "{reply}");

    never_initialized.deregister_client().await;
    a.deregister_client().await;
    assert_eq!(
        services.is_observed("mon-1").await,
        Some(true),
        "client b is still attached"
    );

    // Deregistering twice must not count as a second client leaving.
    a.deregister_client().await;
    assert_eq!(services.is_observed("mon-1").await, Some(true));

    b.deregister_client().await;
    assert_eq!(
        services.is_observed("mon-1").await,
        Some(false),
        "the last attached client left"
    );
    services.stop_all().await;
}

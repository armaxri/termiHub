//! `connections.*` mutations over a definitions store written by a newer agent
//! (#3920): each is refused with a clear error and the file is left intact.

use super::*;

/// A handler whose connection store was loaded from `path`.
fn handler_over(path: std::path::PathBuf) -> AgentHandler {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let conn_store = Arc::new(crate::session::definitions::ConnectionStore::new(path));
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
        Arc::new(AgentServiceRegistry::with_builtin_services()),
    )
    .expect("build handler")
}

#[tokio::test]
async fn mutations_over_a_newer_store_are_refused_with_a_clear_error() {
    let tmp = tempfile::TempDir::new().unwrap();
    let path = tmp.path().join("connections.json");
    let original = r#"{"version":"99","connections":[],"folders":[],"future":1}"#;
    std::fs::write(&path, original).unwrap();

    let handler = handler_over(path.clone());
    init_handler(&handler).await;

    let calls = [
        (
            "connections.create",
            json!({"name": "n", "type": "local", "config": {}}),
        ),
        ("connections.update", json!({"id": "c", "name": "n"})),
        ("connections.delete", json!({"id": "c"})),
        ("connections.folders.create", json!({"name": "f"})),
        (
            "connections.folders.update",
            json!({"id": "f", "name": "n"}),
        ),
        ("connections.folders.delete", json!({"id": "f"})),
    ];
    for (i, (method, params)) in calls.into_iter().enumerate() {
        let reply = dispatch(&handler, method, params, 10 + i as u64).await;
        let err = &reply["error"];
        assert_eq!(err["code"], errors::INTERNAL_ERROR, "{method}: {reply}");
        assert!(
            err["message"]
                .as_str()
                .is_some_and(|m| m.contains("newer version")),
            "{method}: {reply}"
        );
        assert_eq!(err["data"]["reason"], "definitions_store_newer_version");
        assert_eq!(err["data"]["found"], 99);
    }
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
}

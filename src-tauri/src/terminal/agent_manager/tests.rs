use super::*;
use serde_json::json;
use termihub_core::protocol::methods::{ConnectionDefinition, FolderDefinition};

/// OBS-004: the agent reconnect-lifecycle log vocabulary must carry `agent_id`
/// (and the failure `error`) as **structured `tracing` fields**, not
/// interpolated into the message. This is what lets a supporter filter
/// `termihub.log` by agent across a reconnect instead of grepping message text.
// Serialized against every other test that installs a thread-local `tracing`
// default subscriber (see `utils::log_capture`, `session::manager`): a
// concurrent guard drop transiently reverts the global max-level to OFF and
// would drop our events (a well-known parallel-`tracing`-test race).
#[test]
#[serial_test::serial(tracing_default_subscriber)]
fn agent_reconnect_logs_carry_structured_fields() {
    let (capture, guard) = super::tracing_capture::install();
    log_agent_connection_lost("agent-xyz");
    log_agent_reconnected("agent-xyz");
    log_agent_reconnect_failed("agent-xyz", "handshake timeout");
    drop(guard);

    let events = capture.events();

    let lost = events
        .iter()
        .find(|e| e.message() == "connection lost, attempting reconnect")
        .expect("connection-lost event captured");
    assert_eq!(lost.field("agent_id"), Some("agent-xyz"));
    // The id is a field, never interpolated into the message.
    assert!(!lost.message().contains("agent-xyz"));

    let reconnected = events
        .iter()
        .find(|e| e.message() == "reconnected successfully")
        .expect("reconnected event captured");
    assert_eq!(reconnected.field("agent_id"), Some("agent-xyz"));

    let failed = events
        .iter()
        .find(|e| e.message() == "reconnection failed")
        .expect("reconnect-failed event captured");
    assert_eq!(failed.field("agent_id"), Some("agent-xyz"));
    assert_eq!(failed.field("error"), Some("handshake timeout"));
}

/// #3369: a `connection.list_host_sessions` reply decodes into camelCase DTOs
/// carrying each session's holder.
#[test]
fn parse_host_sessions_reply_decodes_holders() {
    let reply = json!({"sessions": [
        {"session_id": "a", "title": "Build", "type": "shell", "status": "running",
         "created_at": "2026-09-26T10:00:00Z", "last_activity": "2026-09-26T10:05:00Z",
         "holder": "other", "definition_id": "def-1"},
        {"session_id": "b", "title": "Logs", "type": "shell", "status": "running",
         "created_at": "2026-09-26T09:00:00Z", "last_activity": "2026-09-26T09:00:00Z",
         "holder": "none"},
        {"garbage": true}
    ]});
    let parsed = parse_host_sessions_reply(Ok(reply)).expect("decodes");
    assert!(parsed.supported);
    assert_eq!(parsed.sessions.len(), 2, "malformed entries are dropped");
    assert_eq!(parsed.sessions[0].holder, "other");
    assert_eq!(parsed.sessions[0].definition_id.as_deref(), Some("def-1"));
    assert_eq!(parsed.sessions[1].holder, "none");
    let wire = serde_json::to_value(&parsed).unwrap();
    assert_eq!(wire["sessions"][0]["sessionId"], "a");
    assert_eq!(wire["sessions"][0]["lastActivity"], "2026-09-26T10:05:00Z");
    assert_eq!(wire["sessions"][0]["type"], "shell");
}

/// #3369: an older agent without the method is "unsupported", not an error;
/// any other failure still surfaces.
#[test]
fn parse_host_sessions_reply_maps_method_not_found_to_unsupported() {
    let old = parse_host_sessions_reply(Err(TerminalError::RemoteError(
        "Method not found".to_string(),
    )))
    .expect("an older agent is not an error");
    assert!(!old.supported);
    assert!(old.sessions.is_empty());

    let other = parse_host_sessions_reply(Err(TerminalError::RemoteError(
        "Agent connection lost".to_string(),
    )));
    assert!(other.is_err());
}

/// Verify the desktop deserializes the agent's `connection.list` entry
/// (snake_case, with optional `definition_id`). Without correct serde
/// settings the entry would parse as empty and the Active Sessions list
/// would be silently dropped.
#[test]
fn parse_agent_session_info_from_snake_case_with_definition_id() {
    let entry = json!({
        "session_id": "abc-123",
        "title": "Build",
        "type": "shell",
        "status": "running",
        "created_at": "2026-02-14T10:30:00Z",
        "last_activity": "2026-02-14T10:30:00Z",
        "attached": false,
        "definition_id": "def-42",
    });
    let info: AgentSessionInfo = serde_json::from_value(entry).unwrap();
    assert_eq!(info.session_id, "abc-123");
    assert_eq!(info.session_type, "shell");
    assert_eq!(info.definition_id.as_deref(), Some("def-42"));
}

#[test]
fn agent_session_info_serializes_to_camel_case_for_frontend() {
    let info = AgentSessionInfo {
        session_id: "abc".to_string(),
        title: "T".to_string(),
        session_type: "shell".to_string(),
        status: "running".to_string(),
        attached: false,
        definition_id: Some("def-1".to_string()),
    };
    let v = serde_json::to_value(&info).unwrap();
    assert_eq!(v["sessionId"], "abc");
    assert_eq!(v["type"], "shell");
    assert_eq!(v["definitionId"], "def-1");
    assert!(v.get("session_id").is_none());
    assert!(v.get("definition_id").is_none());
}

#[test]
fn parse_agent_session_info_without_definition_id() {
    let entry = json!({
        "session_id": "abc-123",
        "title": "Ad hoc",
        "type": "shell",
        "status": "running",
        "created_at": "2026-02-14T10:30:00Z",
        "last_activity": "2026-02-14T10:30:00Z",
        "attached": false,
    });
    let info: AgentSessionInfo = serde_json::from_value(entry).unwrap();
    assert!(info.definition_id.is_none());
}

/// Regression test for #412: the agent sends `connection_types` as an array
/// of full `ConnectionTypeInfo` objects, not plain strings. The desktop must
/// accept this format without errors.
#[test]
fn parse_capabilities_with_connection_type_info_objects() {
    let caps_json = json!({
        "connectionTypes": [
            {
                "typeId": "local",
                "displayName": "Local Shell",
                "icon": "terminal",
                "schema": { "groups": [] },
                "capabilities": {
                    "monitoring": false,
                    "fileBrowser": false,
                    "resize": true,
                    "persistent": false
                }
            },
            {
                "typeId": "ssh",
                "displayName": "SSH",
                "icon": "ssh",
                "schema": { "groups": [] },
                "capabilities": {
                    "monitoring": true,
                    "fileBrowser": true,
                    "resize": true,
                    "persistent": true
                }
            }
        ],
        "maxSessions": 20,
        "availableShells": ["/bin/bash", "/bin/zsh"],
        "availableSerialPorts": ["/dev/ttyUSB0"],
        "dockerAvailable": true,
        "availableDockerImages": ["ubuntu:22.04"]
    });

    let caps: AgentCapabilities = serde_json::from_value(caps_json).unwrap();
    assert_eq!(caps.connection_types.len(), 2);
    assert_eq!(caps.connection_types[0]["typeId"], "local");
    assert_eq!(caps.connection_types[1]["typeId"], "ssh");
    assert_eq!(caps.max_sessions, 20);
    assert_eq!(caps.available_shells, vec!["/bin/bash", "/bin/zsh"]);
    assert_eq!(caps.available_serial_ports, vec!["/dev/ttyUSB0"]);
    assert!(caps.docker_available);
    assert_eq!(caps.available_docker_images, vec!["ubuntu:22.04"]);
}

/// Verify that optional fields default gracefully when absent,
/// ensuring backward compatibility with older agents.
#[test]
fn parse_capabilities_with_minimal_fields() {
    let caps_json = json!({
        "connectionTypes": [],
        "maxSessions": 10
    });

    let caps: AgentCapabilities = serde_json::from_value(caps_json).unwrap();
    assert!(caps.connection_types.is_empty());
    assert_eq!(caps.max_sessions, 10);
    assert!(caps.available_shells.is_empty());
    assert!(caps.available_serial_ports.is_empty());
    assert!(!caps.docker_available);
    assert!(caps.available_docker_images.is_empty());
}

/// Verify that capabilities round-trip through serialization,
/// ensuring the desktop can forward them to the frontend unchanged.
#[test]
fn capabilities_round_trip_serialization() {
    let caps = AgentCapabilities {
        connection_types: vec![json!({
            "typeId": "serial",
            "displayName": "Serial",
            "icon": "serial",
            "schema": { "groups": [] },
            "capabilities": {
                "monitoring": false,
                "fileBrowser": false,
                "resize": false,
                "persistent": false
            }
        })],
        max_sessions: 5,
        monitoring_supported: false,
        agent_version: String::new(),
        available_shells: vec!["/bin/sh".to_string()],
        available_serial_ports: vec!["/dev/ttyS0".to_string()],
        docker_available: false,
        available_docker_images: vec![],
    };

    let json_val = serde_json::to_value(&caps).unwrap();
    let roundtripped: AgentCapabilities = serde_json::from_value(json_val).unwrap();
    assert_eq!(roundtripped.connection_types.len(), 1);
    assert_eq!(roundtripped.connection_types[0]["typeId"], "serial");
    assert_eq!(roundtripped.max_sessions, 5);
    assert_eq!(roundtripped.available_shells, vec!["/bin/sh"]);
}

/// Helper mirroring the production path: deserialize the snake_case agent reply
/// into the shared `ConnectionDefinition` wire DTO, then convert to the frontend
/// `AgentDefinitionInfo` — exactly what `list_connections_and_folders` /
/// `save_definition` do after the DUP-001 migration.
fn definition_from_wire(v: serde_json::Value) -> Option<AgentDefinitionInfo> {
    serde_json::from_value::<ConnectionDefinition>(v)
        .ok()
        .map(AgentDefinitionInfo::from)
}

fn folder_from_wire(v: serde_json::Value) -> Option<AgentFolderInfo> {
    serde_json::from_value::<FolderDefinition>(v)
        .ok()
        .map(AgentFolderInfo::from)
}

/// Regression: the desktop deserializes snake_case connection fields from the
/// agent wire format into the shared DTO (DUP-001).
#[test]
fn parse_definition_from_snake_case_wire_format() {
    let wire = json!({
        "id": "conn-abc",
        "name": "Build Shell",
        "session_type": "shell",
        "config": {"shell": "/bin/bash"},
        "persistent": true,
        "folder_id": "folder-1"
    });
    let def = definition_from_wire(wire).unwrap();
    assert_eq!(def.id, "conn-abc");
    assert_eq!(def.name, "Build Shell");
    assert_eq!(def.session_type, "shell");
    assert!(def.persistent);
    assert_eq!(def.folder_id, Some("folder-1".to_string()));
}

/// A minimal reply defaults the optional fields, as the old hand-parser did.
#[test]
fn parse_definition_minimal() {
    let wire = json!({
        "id": "conn-1",
        "name": "Test",
        "session_type": "serial"
    });
    let def = definition_from_wire(wire).unwrap();
    assert_eq!(def.id, "conn-1");
    assert!(!def.persistent);
    assert_eq!(def.folder_id, None);
    assert_eq!(def.config, Value::Null);
}

/// A reply missing a required field is dropped (the typed equivalent of the old
/// parser returning `None`).
#[test]
fn parse_definition_returns_none_for_missing_required() {
    let wire = json!({"id": "conn-1", "name": "Test"});
    assert!(definition_from_wire(wire).is_none());
}

/// The desktop reads the `source_file` field for external connections.
#[test]
fn parse_definition_with_source_file() {
    let wire = json!({
        "id": "ext-1",
        "name": "Team Shell",
        "session_type": "local",
        "source_file": "/home/pi/team-connections.json"
    });
    let def = definition_from_wire(wire).unwrap();
    assert_eq!(
        def.source_file,
        Some("/home/pi/team-connections.json".to_string())
    );
}

/// Primary connections have no source_file.
#[test]
fn parse_definition_without_source_file() {
    let wire = json!({"id": "conn-1", "name": "Shell", "session_type": "local"});
    let def = definition_from_wire(wire).unwrap();
    assert_eq!(def.source_file, None);
}

/// source_file is omitted from JSON when None.
#[test]
fn definition_info_source_file_omitted_when_none() {
    let def = AgentDefinitionInfo {
        id: "conn-1".to_string(),
        name: "Test".to_string(),
        session_type: "shell".to_string(),
        config: json!({}),
        persistent: false,
        folder_id: None,
        terminal_options: None,
        icon: None,
        source_file: None,
    };
    let v = serde_json::to_value(&def).unwrap();
    assert!(v.get("sourceFile").is_none());
}

/// source_file is camelCase in JSON when present.
#[test]
fn definition_info_source_file_camel_case() {
    let def = AgentDefinitionInfo {
        id: "ext-1".to_string(),
        name: "External".to_string(),
        session_type: "local".to_string(),
        config: json!({}),
        persistent: false,
        folder_id: None,
        terminal_options: None,
        icon: None,
        source_file: Some("/home/pi/team.json".to_string()),
    };
    let v = serde_json::to_value(&def).unwrap();
    assert_eq!(v["sourceFile"], "/home/pi/team.json");
    assert!(v.get("source_file").is_none());
}

/// Regression: the desktop deserializes snake_case folder fields from the agent
/// wire format into the shared DTO (DUP-001).
#[test]
fn parse_folder_from_snake_case_wire_format() {
    let wire = json!({
        "id": "folder-abc",
        "name": "Production",
        "parent_id": "folder-root",
        "is_expanded": true
    });
    let folder = folder_from_wire(wire).unwrap();
    assert_eq!(folder.id, "folder-abc");
    assert_eq!(folder.name, "Production");
    assert_eq!(folder.parent_id, Some("folder-root".to_string()));
    assert!(folder.is_expanded);
}

/// A root-level folder reply (no parent) parses with defaulted fields.
#[test]
fn parse_folder_root_level() {
    let wire = json!({"id": "folder-1", "name": "Root"});
    let folder = folder_from_wire(wire).unwrap();
    assert_eq!(folder.parent_id, None);
    assert!(!folder.is_expanded);
}

/// AgentDefinitionInfo serializes to camelCase for Tauri→frontend boundary.
#[test]
fn definition_info_serializes_camel_case() {
    let def = AgentDefinitionInfo {
        id: "conn-1".to_string(),
        name: "Test".to_string(),
        session_type: "shell".to_string(),
        config: json!({}),
        persistent: true,
        folder_id: Some("folder-1".to_string()),
        terminal_options: None,
        icon: None,
        source_file: None,
    };
    let v = serde_json::to_value(&def).unwrap();
    assert_eq!(v["sessionType"], "shell");
    assert_eq!(v["folderId"], "folder-1");
    // Verify no snake_case keys
    assert!(v.get("session_type").is_none());
    assert!(v.get("folder_id").is_none());
}

/// AgentFolderInfo serializes to camelCase for Tauri→frontend boundary.
#[test]
fn folder_info_serializes_camel_case() {
    let folder = AgentFolderInfo {
        id: "folder-1".to_string(),
        name: "Test".to_string(),
        parent_id: Some("folder-0".to_string()),
        is_expanded: true,
    };
    let v = serde_json::to_value(&folder).unwrap();
    assert_eq!(v["parentId"], "folder-0");
    assert_eq!(v["isExpanded"], true);
    // Verify no snake_case keys
    assert!(v.get("parent_id").is_none());
    assert!(v.get("is_expanded").is_none());
}

/// AgentConnectionsData contains both connections and folders.
#[test]
fn connections_data_serialization() {
    let data = AgentConnectionsData {
        connections: vec![AgentDefinitionInfo {
            id: "conn-1".to_string(),
            name: "Shell".to_string(),
            session_type: "shell".to_string(),
            config: json!({}),
            persistent: false,
            folder_id: None,
            terminal_options: None,
            icon: None,
            source_file: None,
        }],
        folders: vec![AgentFolderInfo {
            id: "folder-1".to_string(),
            name: "Folder".to_string(),
            parent_id: None,
            is_expanded: false,
        }],
    };
    let v = serde_json::to_value(&data).unwrap();
    assert_eq!(v["connections"].as_array().unwrap().len(), 1);
    assert_eq!(v["folders"].as_array().unwrap().len(), 1);
    assert_eq!(v["connections"][0]["sessionType"], "shell");
    assert_eq!(v["folders"][0]["parentId"], Value::Null);
}

/// handle_notification routes `connection.monitoring.data` to the
/// correct monitoring channel based on the `host` field.
#[test]
fn handle_notification_routes_monitoring_data() {
    let b64 = base64::engine::general_purpose::STANDARD;
    let session_outputs: HashMap<String, OutputSender> = HashMap::new();
    let mut monitoring_outputs: HashMap<String, MonitoringRoute> = HashMap::new();

    let (tx, mut rx) = tokio::sync::mpsc::channel(4);
    monitoring_outputs.insert("session-42".to_string(), tx.into());

    let params = json!({
        "host": "session-42",
        "hostname": "myhost",
        "uptimeSeconds": 1234.5,
        "loadAverage": [0.1, 0.2, 0.3],
        "cpuUsagePercent": 50.0,
        "memoryTotalKb": 8000000,
        "memoryAvailableKb": 4000000,
        "memoryUsedPercent": 50.0,
        "diskTotalKb": 100000000,
        "diskUsedKb": 50000000,
        "diskUsedPercent": 50.0,
        "osInfo": "Linux 6.1"
    });

    handle_notification(
        "connection.monitoring.data",
        &params,
        &session_outputs,
        &monitoring_outputs,
        &b64,
    );

    let stats = rx.try_recv().expect("should have received monitoring data");
    assert_eq!(stats.hostname, "myhost");
    assert!((stats.cpu_usage_percent - 50.0).abs() < f64::EPSILON);
    assert_eq!(stats.os_info, "Linux 6.1");
}

/// handle_notification routes `connection.monitoring.status` to the host's
/// status channel once one is registered (#3321).
#[test]
fn handle_notification_routes_monitoring_status() {
    use termihub_core::monitoring::{MonitorStatus, MonitorStatusReason};
    let b64 = base64::engine::general_purpose::STANDARD;
    let session_outputs: HashMap<String, OutputSender> = HashMap::new();
    let mut monitoring_outputs: HashMap<String, MonitoringRoute> = HashMap::new();
    let (stats_tx, mut stats_rx) = tokio::sync::mpsc::channel(4);
    let (status_tx, mut status_rx) = tokio::sync::mpsc::channel(4);
    monitoring_outputs.insert(
        "self".to_string(),
        MonitoringRoute {
            stats: stats_tx,
            status: Some(status_tx),
        },
    );

    handle_notification(
        "connection.monitoring.status",
        &json!({"host": "self", "status": "offline", "reason": "parse"}),
        &session_outputs,
        &monitoring_outputs,
        &b64,
    );

    let report = status_rx.try_recv().expect("status report routed");
    assert_eq!(report.status, MonitorStatus::Offline);
    assert_eq!(report.reason, Some(MonitorStatusReason::Parse));
    assert!(stats_rx.try_recv().is_err(), "a status is not a sample");
}

/// A status report for a monitor that registered no status channel (an older
/// consumer), for an unknown host, or with a status this build does not know
/// is dropped without disturbing the sample route (#3321).
#[test]
fn handle_notification_drops_unroutable_monitoring_status() {
    let b64 = base64::engine::general_purpose::STANDARD;
    let session_outputs: HashMap<String, OutputSender> = HashMap::new();
    let mut monitoring_outputs: HashMap<String, MonitoringRoute> = HashMap::new();
    let (stats_tx, mut stats_rx) = tokio::sync::mpsc::channel(4);
    monitoring_outputs.insert("self".to_string(), stats_tx.into());

    for params in [
        json!({"host": "self", "status": "stale"}),
        json!({"host": "other", "status": "stale"}),
        json!({"host": "self", "status": "warpSpeed"}),
    ] {
        handle_notification(
            "connection.monitoring.status",
            &params,
            &session_outputs,
            &monitoring_outputs,
            &b64,
        );
    }
    assert!(stats_rx.try_recv().is_err());
}

/// An unknown notification method (e.g. one a newer agent adds) is ignored —
/// the property that lets an older desktop ignore `connection.monitoring.status`
/// (#3321).
#[test]
fn handle_notification_ignores_unknown_method() {
    let b64 = base64::engine::general_purpose::STANDARD;
    let session_outputs: HashMap<String, OutputSender> = HashMap::new();
    let mut monitoring_outputs: HashMap<String, MonitoringRoute> = HashMap::new();
    let (stats_tx, mut stats_rx) = tokio::sync::mpsc::channel(4);
    monitoring_outputs.insert("self".to_string(), stats_tx.into());

    handle_notification(
        "connection.monitoring.somethingNew",
        &json!({"host": "self"}),
        &session_outputs,
        &monitoring_outputs,
        &b64,
    );
    assert!(stats_rx.try_recv().is_err());
}

/// Regression test for #1660: a notification the agent emits *before* it
/// answers `initialize` must be buffered during the handshake and replayed
/// afterwards, not silently dropped. This reproduces the handshake read
/// loop's classification over a message stream (notification, then the init
/// response) and confirms the buffered notification still reaches the
/// desktop handlers. Before the fix, `classify_handshake_message` returned
/// `Skip` for the notification and the pre-init notice was discarded.
#[test]
fn preinit_notification_is_buffered_and_replayed() {
    let request_id: u64 = 1;

    // The agent emits a session output notification, then answers initialize.
    let payload = base64::engine::general_purpose::STANDARD.encode(b"hello");
    let lines = [
        format!(
            r#"{{"jsonrpc":"2.0","method":"connection.output","params":{{"session_id":"sess-1","data":"{payload}"}}}}"#
        ),
        r#"{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}"#.to_string(),
    ];

    // Drive the same classification the handshake loop uses, collecting
    // pre-init notifications until the initialize response arrives.
    let mut buffered: Vec<(String, Value)> = Vec::new();
    let mut saw_response = false;
    for line in &lines {
        let msg = jsonrpc::parse_message(line).expect("valid message");
        match jsonrpc::classify_handshake_message(msg, request_id) {
            jsonrpc::HandshakeOutcome::Response(_) => {
                saw_response = true;
                break;
            }
            jsonrpc::HandshakeOutcome::Buffer { method, params } => {
                buffered.push((method, params));
            }
            jsonrpc::HandshakeOutcome::Rejected(m) => panic!("unexpected rejection: {m}"),
            jsonrpc::HandshakeOutcome::Skip => panic!("notification should be buffered"),
        }
    }

    assert!(saw_response, "should have seen the initialize response");
    assert_eq!(buffered.len(), 1, "pre-init notification must be retained");
    assert_eq!(buffered[0].0, "connection.output");

    // Replaying the buffered notification after init reaches the registered
    // session output channel — the same dispatch the live loop performs.
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut session_outputs: HashMap<String, OutputSender> = HashMap::new();
    let monitoring_outputs: HashMap<String, MonitoringRoute> = HashMap::new();
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(4);
    session_outputs.insert("sess-1".to_string(), tx);

    for (method, params) in &buffered {
        handle_notification(method, params, &session_outputs, &monitoring_outputs, &b64);
    }

    let data = rx.try_recv().expect("buffered output should be delivered");
    assert_eq!(data, b"hello".to_vec());
}

/// handle_notification silently ignores monitoring data for unknown hosts.
#[test]
fn handle_notification_ignores_unknown_monitoring_host() {
    let b64 = base64::engine::general_purpose::STANDARD;
    let session_outputs: HashMap<String, OutputSender> = HashMap::new();
    let monitoring_outputs: HashMap<String, MonitoringRoute> = HashMap::new();

    let params = json!({
        "host": "unknown-host",
        "hostname": "myhost",
        "uptimeSeconds": 0.0,
        "loadAverage": [0.0, 0.0, 0.0],
        "cpuUsagePercent": 0.0,
        "memoryTotalKb": 0,
        "memoryAvailableKb": 0,
        "memoryUsedPercent": 0.0,
        "diskTotalKb": 0,
        "diskUsedKb": 0,
        "diskUsedPercent": 0.0,
        "osInfo": ""
    });

    // Should not panic — just silently drops the data.
    handle_notification(
        "connection.monitoring.data",
        &params,
        &session_outputs,
        &monitoring_outputs,
        &b64,
    );
}

/// Regression test for #627: reconnect_agent must stop when `alive` is set
/// to false by the caller (e.g. disconnect_agent). Without the alive check
/// the reconnect loop sleeps up to 3 minutes before giving up.
#[tokio::test]
async fn reconnect_agent_stops_when_alive_is_false() {
    let config = RemoteAgentConfig {
        host: "unreachable.example.com".to_string(),
        port: 22,
        username: "user".to_string(),
        auth_method: "password".to_string(),
        password: None,
        key_path: None,
        save_password: None,
        agent_path: None,
        external_connection_files: vec![],
        ..Default::default()
    };
    let settings = AgentSettings::default();
    let mut request_id = 0u64;
    let alive = Arc::new(AtomicBool::new(false));

    let result = reconnect_agent(&config, &settings, &mut request_id, &alive).await;

    assert!(result.is_err());
    let err = result.err().unwrap();
    assert!(
        err.contains("stopped") || err.contains("cancelled"),
        "expected stop-related error, got: {err}"
    );
}

/// AGT-014: `initialize` must report the desktop crate's real version in
/// `clientVersion`, not a hardcoded literal. The agent records this and echoes
/// it via `agent.list_connections` (the connected-client update guard, #1349),
/// so a constant makes every client look identical. Deriving it from
/// `CARGO_PKG_VERSION` also guards against the field silently going stale on the
/// next version bump (the old literal would have kept reporting `0.1.0`).
#[test]
fn initialize_params_report_real_client_version() {
    let settings = AgentSettings::default();
    let params = build_initialize_params(&settings, &[]);
    assert_eq!(
        params["clientVersion"],
        env!("CARGO_PKG_VERSION"),
        "clientVersion must track the desktop crate version, not a literal"
    );
    // The protocol/client identity fields stay as declared.
    assert_eq!(params["protocolVersion"], "0.3.0");
    assert_eq!(params["client"], "termihub-desktop");
}

/// serialize_request produces valid newline-terminated JSON-RPC.
#[test]
fn serialize_request_format() {
    let line = serialize_request(42, "connection.create", json!({"type": "shell"})).unwrap();
    assert!(line.ends_with('\n'));
    let parsed: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(parsed["id"], 42);
    assert_eq!(parsed["method"], "connection.create");
    assert_eq!(parsed["jsonrpc"], "2.0");
}

// ── Resource-hygiene helpers (#1239: G6 reap / prune, G7 reconcile) ──

/// Build a placeholder [`AgentConnection`] over the given command sender.
///
/// Used by tests that need to keep the command *receiver* alive (e.g. the
/// CONC-003 timeout test, which sends a request the receiver never answers).
/// A valid but inert [`AbortHandle`] for map-manipulation tests that never
/// drive the task. Spawned on a process-wide throwaway runtime that is never
/// polled, so the task never runs and aborting the handle is a harmless no-op.
fn dummy_abort_handle() -> AbortHandle {
    use std::sync::OnceLock;
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    let rt = RT.get_or_init(|| {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build throwaway test runtime")
    });
    rt.spawn(std::future::pending::<()>()).abort_handle()
}

fn make_agent_connection_with_tx(command_tx: UnboundedSender<AgentIoCommand>) -> AgentConnection {
    AgentConnection {
        command_tx,
        alive: Arc::new(AtomicBool::new(true)),
        reconnecting: Arc::new(AtomicBool::new(false)),
        io_task: dummy_abort_handle(),
        capabilities: AgentCapabilities {
            connection_types: vec![],
            max_sessions: 0,
            available_shells: vec![],
            available_serial_ports: vec![],
            docker_available: false,
            available_docker_images: vec![],
            monitoring_supported: false,
            agent_version: String::new(),
        },
        client_id: String::new(),
    }
}

/// Build a placeholder [`AgentConnection`] for map-manipulation tests.
///
/// The command channel receiver is dropped immediately — none of the
/// hygiene helpers send over it — so only `alive` is meaningful here.
fn make_agent_connection(alive: bool) -> AgentConnection {
    let (command_tx, _command_rx) = mpsc::unbounded_channel::<AgentIoCommand>();
    let mut conn = make_agent_connection_with_tx(command_tx);
    conn.alive = Arc::new(AtomicBool::new(alive));
    conn
}

/// G6: an exhausted reconnect self-reaps its own entry from the manager map
/// (via a weak reference) instead of leaving a zombie behind for lazy
/// eviction on the next `connect_agent`.
#[test]
fn reap_agent_removes_its_own_map_entry() {
    let agents: AgentMap = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut guard = agents.lock().unwrap();
        guard.insert("agent-1".to_string(), make_agent_connection(false));
        guard.insert("agent-2".to_string(), make_agent_connection(true));
    }

    let weak = Arc::downgrade(&agents);
    reap_agent(&weak, "agent-1");

    let guard = agents.lock().unwrap();
    assert!(
        !guard.contains_key("agent-1"),
        "reaped agent must be removed from the map"
    );
    assert!(
        guard.contains_key("agent-2"),
        "unrelated agents must be left untouched"
    );
}

/// A dead weak reference (manager already dropped) must not panic.
#[test]
fn reap_agent_tolerates_dropped_manager() {
    let weak = {
        let agents: AgentMap = Arc::new(Mutex::new(HashMap::new()));
        Arc::downgrade(&agents)
    };
    // Should be a no-op, not a panic.
    reap_agent(&weak, "agent-1");
}

/// Prune sweeps every `alive == false` entry and returns the removed ids,
/// while surviving (alive) entries remain.
#[test]
fn prune_dead_agents_removes_only_dead_entries() {
    let agents: AgentMap = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut guard = agents.lock().unwrap();
        guard.insert("dead-1".to_string(), make_agent_connection(false));
        guard.insert("alive-1".to_string(), make_agent_connection(true));
        guard.insert("dead-2".to_string(), make_agent_connection(false));
    }

    let mut removed = prune_dead_agents_from_map(&agents);
    removed.sort();
    assert_eq!(removed, vec!["dead-1".to_string(), "dead-2".to_string()]);

    let guard = agents.lock().unwrap();
    assert_eq!(guard.len(), 1);
    assert!(guard.contains_key("alive-1"));
}

/// G7: after a successful reconnect, output/monitoring senders keyed by
/// session ids that did *not* recover are dropped, while senders for
/// surviving session ids remain.
#[test]
fn reconcile_output_senders_drops_non_recovered_sessions() {
    let mut session_outputs: HashMap<String, OutputSender> = HashMap::new();
    let mut monitoring_outputs: HashMap<String, MonitoringRoute> = HashMap::new();

    let (out_survivor, _r1) = std::sync::mpsc::sync_channel(1);
    let (out_gone, _r2) = std::sync::mpsc::sync_channel(1);
    session_outputs.insert("survivor".to_string(), out_survivor);
    session_outputs.insert("gone".to_string(), out_gone);

    let (mon_survivor, _r3) = tokio::sync::mpsc::channel(1);
    let (mon_gone, _r4) = tokio::sync::mpsc::channel(1);
    monitoring_outputs.insert("survivor".to_string(), mon_survivor.into());
    monitoring_outputs.insert("gone".to_string(), mon_gone.into());

    let mut live_ids = std::collections::HashSet::new();
    live_ids.insert("survivor".to_string());

    reconcile_output_senders(&mut session_outputs, &mut monitoring_outputs, &live_ids);

    assert!(session_outputs.contains_key("survivor"));
    assert!(!session_outputs.contains_key("gone"));
    assert!(monitoring_outputs.contains_key("survivor"));
    assert!(!monitoring_outputs.contains_key("gone"));
}

// ── I/O-task force-stop (CONC-009) ───────────────────────────────────

/// Build an [`AgentConnection`] whose I/O task is a real spawned future that
/// ignores its command channel and never returns — a stand-in for a task
/// wedged in a blocking op that can only be stopped by an abort. Returns the
/// connection plus the task's `JoinHandle` so the test can observe the abort.
fn make_wedged_agent_connection() -> (AgentConnection, tokio::task::JoinHandle<()>) {
    let (command_tx, command_rx) = mpsc::unbounded_channel::<AgentIoCommand>();
    let command_tx_conn = command_tx.clone();
    // The task holds its own command sender (mirroring the real io_task's
    // `command_tx_task`) and parks forever, so neither a dropped external
    // sender nor a `Disconnect` can ever end it — only an abort can.
    let join = tokio::spawn(async move {
        let _held_rx = command_rx;
        let _held_tx = command_tx;
        std::future::pending::<()>().await;
    });
    let conn = AgentConnection {
        command_tx: command_tx_conn,
        alive: Arc::new(AtomicBool::new(true)),
        reconnecting: Arc::new(AtomicBool::new(false)),
        io_task: join.abort_handle(),
        capabilities: AgentCapabilities {
            connection_types: vec![],
            max_sessions: 0,
            available_shells: vec![],
            available_serial_ports: vec![],
            docker_available: false,
            available_docker_images: vec![],
            monitoring_supported: false,
            agent_version: String::new(),
        },
        client_id: String::new(),
    };
    (conn, join)
}

/// CONC-009: `disconnect_agent` force-stops a wedged I/O task via the retained
/// abort handle. The cooperative `Disconnect` can never reach a task parked in
/// a blocking reconnect (it also holds its own `command_tx` clone, so the
/// channel never closes), so without the abort the task and its SSH session
/// would leak. The abort is the guaranteed fallback.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_agent_aborts_wedged_io_task() {
    let app = tauri::test::mock_app();
    let manager = Arc::new(AgentConnectionManager::new(app.handle().clone()));

    let (conn, join) = make_wedged_agent_connection();
    {
        let mut agents = manager.agents.lock().unwrap();
        agents.insert("agent-1".to_string(), conn);
    }

    manager
        .disconnect_agent("agent-1")
        .expect("disconnect must succeed for a connected agent");

    // The task must actually stop — awaiting its handle resolves with a
    // cancellation, not by hanging for the timeout.
    let joined = tokio::time::timeout(std::time::Duration::from_secs(2), join)
        .await
        .expect("wedged io_task must be aborted, not left running");
    assert!(
        joined.expect_err("task was aborted").is_cancelled(),
        "the io_task must be stopped via abort"
    );
}

/// CONC-009: pruning a dead-but-wedged entry also force-stops its task. A task
/// that flipped `alive` false without exiting would otherwise linger; the
/// prune sweep aborts it as it removes the map entry.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prune_dead_agents_aborts_wedged_task() {
    let agents: AgentMap = Arc::new(Mutex::new(HashMap::new()));
    let (conn, join) = make_wedged_agent_connection();
    conn.alive.store(false, Ordering::SeqCst); // mark dead so prune sweeps it
    {
        let mut guard = agents.lock().unwrap();
        guard.insert("dead-1".to_string(), conn);
    }

    let removed = prune_dead_agents_from_map(&agents);
    assert_eq!(removed, vec!["dead-1".to_string()]);

    let joined = tokio::time::timeout(std::time::Duration::from_secs(2), join)
        .await
        .expect("pruned wedged io_task must be aborted, not left running");
    assert!(
        joined.expect_err("task was aborted").is_cancelled(),
        "the io_task must be stopped via abort on prune"
    );
}

// ── Reconnect input handling (CONC-014) ──────────────────────────────

/// CONC-014: the command backlog that accumulates during an outage is filtered
/// on reconnect — terminal `SessionInput` is dropped (never replayed into the
/// recovered session), `SessionResize` is coalesced to the latest per session,
/// and control commands are preserved in order.
#[test]
fn filter_reconnect_backlog_drops_input_and_coalesces_resize() {
    let backlog = vec![
        AgentIoCommand::SessionInput {
            session_id: "s1".to_string(),
            data: b"stale-keystroke".to_vec(),
        },
        AgentIoCommand::SessionResize {
            session_id: "s1".to_string(),
            cols: 80,
            rows: 24,
        },
        AgentIoCommand::UnregisterSession {
            session_id: "s1".to_string(),
        },
        AgentIoCommand::SessionInput {
            session_id: "s1".to_string(),
            data: b"more-stale".to_vec(),
        },
        AgentIoCommand::SessionResize {
            session_id: "s1".to_string(),
            cols: 120,
            rows: 40,
        },
        AgentIoCommand::SessionResize {
            session_id: "s2".to_string(),
            cols: 10,
            rows: 10,
        },
    ];

    let kept = filter_reconnect_backlog(backlog);

    // No stale input survives.
    assert!(
        !kept
            .iter()
            .any(|c| matches!(c, AgentIoCommand::SessionInput { .. })),
        "buffered SessionInput must never be replayed after reconnect"
    );
    // The control command is preserved.
    assert_eq!(
        kept.iter()
            .filter(|c| matches!(c, AgentIoCommand::UnregisterSession { .. }))
            .count(),
        1,
        "control commands must survive the reconnect filter"
    );
    // Resize is coalesced to the latest per session (s1 → 120x40, s2 → 10x10).
    let mut resizes: Vec<(String, u16, u16)> = kept
        .iter()
        .filter_map(|c| match c {
            AgentIoCommand::SessionResize {
                session_id,
                cols,
                rows,
            } => Some((session_id.clone(), *cols, *rows)),
            _ => None,
        })
        .collect();
    resizes.sort();
    assert_eq!(
        resizes,
        vec![("s1".to_string(), 120, 40), ("s2".to_string(), 10, 10),],
        "only the latest resize per session must be kept"
    );
}

/// CONC-014: `send_session_input` drops terminal input at the source while the
/// agent is reconnecting, so it never enters the unbounded queue nor replays
/// into the recovered session. Once reconnected, input flows normally again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn send_session_input_dropped_while_reconnecting() {
    let app = tauri::test::mock_app();
    let manager = Arc::new(AgentConnectionManager::new(app.handle().clone()));

    let (command_tx, mut command_rx) = mpsc::unbounded_channel::<AgentIoCommand>();
    let reconnecting = Arc::new(AtomicBool::new(true));
    {
        let mut conn = make_agent_connection_with_tx(command_tx);
        conn.reconnecting = reconnecting.clone();
        let mut agents = manager.agents.lock().unwrap();
        agents.insert("agent-1".to_string(), conn);
    }

    // While reconnecting: the call succeeds (fire-and-forget) but enqueues
    // nothing — the keystroke is intentionally discarded.
    manager
        .send_session_input("agent-1", "sess", b"typed-during-outage")
        .expect("send must not error while reconnecting");
    assert!(
        command_rx.try_recv().is_err(),
        "input typed during a reconnect must be dropped, not queued for replay"
    );

    // Once reconnected the normal input path is exercised exactly as before.
    reconnecting.store(false, Ordering::SeqCst);
    manager
        .send_session_input("agent-1", "sess", b"live-input")
        .expect("send must succeed once reconnected");
    match command_rx.try_recv() {
        Ok(AgentIoCommand::SessionInput { session_id, data }) => {
            assert_eq!(session_id, "sess");
            assert_eq!(data, b"live-input");
        }
        Ok(_) => panic!("expected a SessionInput command, got a different variant"),
        Err(e) => panic!("expected input to be queued once reconnected, got {e:?}"),
    }
}

// ── Cancellable connect (G1, #1235) ──────────────────────────────────

/// A per-agent cancellation token registered before a connect can be fired
/// by `cancel_connect` and reports whether an in-flight connect was found.
#[test]
fn cancel_connect_fires_registered_token() {
    let registry: ConnectingRegistry = Arc::new(Mutex::new(HashMap::new()));
    let token = CancellationToken::new();
    register_connecting_token(&registry, "agent-1", token.clone());

    assert!(!token.is_cancelled());
    // A matching agent id fires its token and reports success.
    assert!(cancel_connect_token(&registry, "agent-1"));
    assert!(token.is_cancelled());

    // A non-matching id is a no-op.
    assert!(!cancel_connect_token(&registry, "agent-2"));
}

/// CONC-002: the reconnect connect-cancellation watcher fires its token as
/// soon as `alive` flips false, so a hung reconnect connect (which selects
/// on that token) aborts promptly on a user Disconnect / shutdown instead of
/// parking the I/O task for the full connect timeout. This unit-tests the
/// `alive`→token bridge; the core proves the token actually aborts a real
/// hung connect (`connect_aborts_when_token_cancelled`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_connect_watcher_fires_token_when_alive_flips() {
    let alive = Arc::new(AtomicBool::new(true));
    let token = CancellationToken::new();
    let watcher = tokio::spawn(cancel_connect_when_disconnected(
        alive.clone(),
        token.clone(),
    ));

    // While alive, the token stays live well past one poll interval.
    tokio::time::sleep(RECONNECT_CANCEL_POLL_INTERVAL * 3).await;
    assert!(
        !token.is_cancelled(),
        "the token must not fire while alive is still true"
    );

    // A Disconnect flips alive; the watcher must fire the token promptly.
    alive.store(false, Ordering::SeqCst);
    tokio::time::timeout(std::time::Duration::from_secs(2), token.cancelled())
        .await
        .expect("watcher must fire the token promptly once alive is false");
    assert!(token.is_cancelled());
    let _ = watcher.await;
}

/// CONC-003: `send_request` must return a real timeout error within the
/// bounded window when the agent never answers (e.g. the I/O task is wedged
/// in a multi-minute reconnect), rather than blocking for the whole reconnect
/// window and then reporting a "timed out" that never actually fired.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn send_request_times_out_when_no_response_arrives() {
    let app = tauri::test::mock_app();
    let manager = Arc::new(AgentConnectionManager::new(app.handle().clone()));

    // Hold the command receiver but never answer — modelling an io_task
    // parked in reconnect. Keeping `_command_rx` alive is what makes the
    // command send succeed (a dropped rx fails early with a different error),
    // so the test truly exercises the wait-timeout path.
    let (command_tx, _command_rx) = mpsc::unbounded_channel::<AgentIoCommand>();
    {
        let mut agents = manager.agents.lock().unwrap();
        agents.insert(
            "agent-1".to_string(),
            make_agent_connection_with_tx(command_tx),
        );
    }

    let started = std::time::Instant::now();
    let result = {
        let m = manager.clone();
        tokio::task::spawn_blocking(move || {
            m.send_request_with_timeout(
                "agent-1",
                termihub_core::protocol::methods::CONNECTIONS_LIST,
                serde_json::json!({}),
                std::time::Duration::from_millis(200),
            )
        })
        .await
        .expect("spawn_blocking join")
    };
    let elapsed = started.elapsed();

    let err = result.expect_err("a request with no response must return a timeout error");
    assert!(
        err.to_string().to_lowercase().contains("timed out"),
        "expected a real timeout error, got: {err}"
    );
    assert!(
        elapsed < std::time::Duration::from_secs(2),
        "send_request must fail fast on timeout, took {elapsed:?}"
    );

    // Prove the receiver was still alive across the wait — i.e. we exercised
    // the timeout path, not the send-failure path.
    drop(_command_rx);
}

/// The RAII guard clears the registry entry when the connect finishes, so a
/// later cancel targets only live connects (no stale token left behind).
#[test]
fn connecting_guard_clears_registry_entry() {
    let registry: ConnectingRegistry = Arc::new(Mutex::new(HashMap::new()));
    {
        let token = CancellationToken::new();
        register_connecting_token(&registry, "agent-1", token);
        let _guard = ConnectingGuard {
            map: registry.clone(),
            id: "agent-1".to_string(),
        };
        assert!(registry.lock().unwrap().contains_key("agent-1"));
    }
    // Guard dropped → entry gone → cancel finds nothing.
    assert!(!cancel_connect_token(&registry, "agent-1"));
}

/// A token fired before the connect body begins aborts the blocking
/// connect+handshake promptly instead of waiting it out — the core G1
/// behaviour. Mirrors the `connect_and_authenticate` + initialize handshake
/// being wrapped in `tokio::select!` against the token.
#[tokio::test]
async fn run_cancellable_aborts_when_token_already_fired() {
    let token = CancellationToken::new();
    token.cancel();

    // The connect body would sleep for 30s; a working cancel returns at once.
    let result: Result<(), TerminalError> = run_connect_cancellable(&token, async {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        Ok(())
    })
    .await;

    assert!(result.is_err(), "a cancelled connect must return an error");
    let err = result.err().unwrap().to_string();
    assert!(
        err.to_lowercase().contains("cancel"),
        "expected a cancellation error, got: {err}"
    );
}

/// Firing the token while the connect body is in flight aborts it promptly.
#[tokio::test]
async fn run_cancellable_aborts_in_flight_connect() {
    let token = CancellationToken::new();
    let token_clone = token.clone();

    let join = tokio::spawn(async move {
        run_connect_cancellable(&token_clone, async {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            Ok::<(), TerminalError>(())
        })
        .await
    });

    // Give the body a moment to start, then cancel.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    token.cancel();

    let result = join.await.expect("join");
    assert!(result.is_err(), "an in-flight cancel must return an error");
}

/// Without a cancel the body runs to completion and its value is returned.
#[tokio::test]
async fn run_cancellable_returns_body_result_when_not_cancelled() {
    let token = CancellationToken::new();
    let result: Result<u32, TerminalError> =
        run_connect_cancellable(&token, async { Ok(42) }).await;
    assert_eq!(result.unwrap(), 42);
}

// ── Golden vector: canonical-engine migration (SM-020 slice 3) ──────────
//
// Pins the EXACT reconnect delay sequence + give-up the agent produces, so
// moving `reconnect_agent` off the hand-rolled capped-exponential onto the
// canonical `reconnect_backoff` engine is proven behavior-preserving. This is
// the highest-blast-radius reconnect path (every remote agent session), so the
// bar is byte-identical: fed the agent's production numbers with jitter
// disabled, the shared engine must reproduce the old 1,2,4,8,16,30,30,30,30,30 s
// schedule and then give up after exactly 10 attempts. The config here is spelled
// out inline (rather than importing the production `AGENT_BACKOFF` const) so this
// pin lands, red-to-green, *before* the loop is migrated onto the engine.

/// The agent reconnect delays, in whole ms, for its production configuration
/// (base 1 s, factor 2, cap 30 s, 10 attempts) — the exact sequence the
/// pre-migration `capped_exponential_delay(1s, attempt, 30s)` over
/// `attempt in 0..10` yielded. Attempts 6..=10 sit at the 30 s cap.
const AGENT_GOLDEN_DELAYS_MS: [i64; 10] = [
    1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000,
];

#[test]
fn golden_vector_agent_backoff_sequence_then_give_up() {
    use termihub_core::reconnect_backoff::{
        reconnect_reducer, BackoffConfig, ReconnectEvent, ReconnectPhase, INITIAL_RECONNECT_STATE,
    };
    // Exactly the agent's production numbers (mirrors `AGENT_BACKOFF`), jitter
    // disabled → deterministic. Kept inline so this test predates the const.
    let config = BackoffConfig {
        base_delay_ms: 1_000.0,
        factor: 2.0,
        max_delay_ms: 30_000.0,
        max_attempts: 10,
        jitter_ratio: 0.0,
    };
    // Jitter is disabled, so the RNG is never consulted; a constant keeps the
    // schedule deterministic.
    let mut no_jitter = || 0.0;
    let mut state = INITIAL_RECONNECT_STATE;
    let mut delays = Vec::new();

    // A fresh drop arms the first backoff window; each subsequent window is armed
    // by a failed attempt (the timer fires, then the attempt fails) — exactly the
    // Drop → (Attempt → Failure)* sequence `reconnect_agent` drives.
    state = reconnect_reducer(&state, ReconnectEvent::Drop, &config, &mut no_jitter);
    while state.phase == ReconnectPhase::Waiting {
        delays.push(state.delay_ms);
        state = reconnect_reducer(&state, ReconnectEvent::Attempt, &config, &mut no_jitter);
        state = reconnect_reducer(&state, ReconnectEvent::Failure, &config, &mut no_jitter);
    }

    assert_eq!(
        delays,
        AGENT_GOLDEN_DELAYS_MS.to_vec(),
        "agent reconnect backoff must yield exactly 1,2,4,8,16,30,30,30,30,30 s (jitter disabled)"
    );
    assert_eq!(
        state.phase,
        ReconnectPhase::Gaveup,
        "after 10 failed attempts the engine gives up (was the for-loop's exhausted Err)"
    );
    assert_eq!(
        state.attempt, config.max_attempts,
        "exactly `max_attempts` (10) attempts are made before giving up"
    );
}

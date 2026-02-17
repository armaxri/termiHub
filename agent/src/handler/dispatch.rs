use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use tracing::{debug, warn};

use base64::Engine;

use crate::protocol::errors;
use crate::protocol::messages::{JsonRpcErrorResponse, JsonRpcRequest, JsonRpcResponse};
use crate::protocol::methods::{
    Capabilities, HealthCheckResult, InitializeParams, InitializeResult, SessionAttachParams,
    SessionCloseParams, SessionCreateParams, SessionCreateResult, SessionDetachParams,
    SessionInputParams, SessionListEntry, SessionListResult,
};
use crate::session::manager::{SessionCreateError, SessionManager, MAX_SESSIONS};
use crate::session::types::SessionType;

/// The agent's protocol version.
const AGENT_PROTOCOL_VERSION: &str = "0.1.0";

/// Dispatcher handles incoming JSON-RPC requests and routes them
/// to the appropriate handler function.
pub struct Dispatcher {
    session_manager: Arc<SessionManager>,
    initialized: bool,
    start_time: Instant,
}

/// The result of dispatching a request: either a success or error response.
pub enum DispatchResult {
    Success(JsonRpcResponse),
    Error(JsonRpcErrorResponse),
}

impl DispatchResult {
    /// Serialize the result to a JSON `Value`.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Success(resp) => serde_json::to_value(resp).unwrap(),
            Self::Error(resp) => serde_json::to_value(resp).unwrap(),
        }
    }
}

impl Dispatcher {
    pub fn new(session_manager: Arc<SessionManager>) -> Self {
        Self {
            session_manager,
            initialized: false,
            start_time: Instant::now(),
        }
    }

    /// Dispatch a parsed JSON-RPC request to the appropriate handler.
    pub async fn dispatch(&mut self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();
        let method = request.method.as_str();

        debug!("Dispatching method: {}", method);

        // The `initialize` method is always allowed
        if method == "initialize" {
            return self.handle_initialize(request).await;
        }

        // All other methods require initialization
        if !self.initialized {
            return DispatchResult::Error(JsonRpcErrorResponse::new(
                id,
                errors::NOT_INITIALIZED,
                "Agent not initialized — call 'initialize' first",
            ));
        }

        match method {
            "session.create" => self.handle_session_create(request).await,
            "session.list" => self.handle_session_list(request).await,
            "session.close" => self.handle_session_close(request).await,
            "session.attach" => self.handle_session_attach(request).await,
            "session.detach" => self.handle_session_detach(request).await,
            "session.input" => self.handle_session_input(request).await,
            "session.resize" => self.handle_session_resize(request).await,
            "health.check" => self.handle_health_check(request).await,
            _ => {
                warn!("Unknown method: {}", method);
                DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::METHOD_NOT_FOUND,
                    format!("Method not found: {method}"),
                ))
            }
        }
    }

    async fn handle_initialize(&mut self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: InitializeParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid initialize params: {e}"),
                ));
            }
        };

        // Version negotiation: we only support major version 0
        let requested: Vec<&str> = params.protocol_version.split('.').collect();
        let major = requested.first().and_then(|s| s.parse::<u32>().ok());

        if major != Some(0) {
            return DispatchResult::Error(JsonRpcErrorResponse::new(
                id,
                errors::VERSION_NOT_SUPPORTED,
                format!(
                    "Unsupported protocol version: {} (agent supports 0.x)",
                    params.protocol_version
                ),
            ));
        }

        self.initialized = true;

        let result = InitializeResult {
            protocol_version: AGENT_PROTOCOL_VERSION.to_string(),
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            capabilities: Capabilities {
                session_types: vec!["shell".to_string(), "serial".to_string()],
                max_sessions: MAX_SESSIONS,
                available_shells: detect_available_shells(),
                available_serial_ports: detect_available_serial_ports(),
            },
        };

        DispatchResult::Success(JsonRpcResponse::new(
            id,
            serde_json::to_value(result).unwrap(),
        ))
    }

    async fn handle_session_create(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: SessionCreateParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid session.create params: {e}"),
                ));
            }
        };

        let session_type = match SessionType::from_str(&params.session_type) {
            Some(t) => t,
            None => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_CONFIGURATION,
                    format!("Unsupported session type: {}", params.session_type),
                ));
            }
        };

        let title = params
            .title
            .unwrap_or_else(|| format!("{} session", session_type.as_str()));

        let snapshot = match self
            .session_manager
            .create(session_type, title, params.config)
            .await
        {
            Ok(snapshot) => snapshot,
            Err(SessionCreateError::LimitReached) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::SESSION_LIMIT_REACHED,
                    format!("Session limit reached (max {MAX_SESSIONS})"),
                ));
            }
            Err(SessionCreateError::InvalidConfig(msg)) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_CONFIGURATION,
                    msg,
                ));
            }
            Err(SessionCreateError::BackendFailed(msg)) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::SESSION_CREATION_FAILED,
                    msg,
                ));
            }
        };

        let result = SessionCreateResult {
            session_id: snapshot.id,
            title: snapshot.title,
            session_type: snapshot.session_type.as_str().to_string(),
            status: snapshot.status.as_str().to_string(),
            created_at: snapshot.created_at.to_rfc3339(),
        };

        DispatchResult::Success(JsonRpcResponse::new(
            id,
            serde_json::to_value(result).unwrap(),
        ))
    }

    async fn handle_session_list(&self, request: JsonRpcRequest) -> DispatchResult {
        let sessions = self.session_manager.list().await;

        let entries: Vec<SessionListEntry> = sessions
            .into_iter()
            .map(|s| SessionListEntry {
                session_id: s.id,
                title: s.title,
                session_type: s.session_type.as_str().to_string(),
                status: s.status.as_str().to_string(),
                created_at: s.created_at.to_rfc3339(),
                last_activity: s.last_activity.to_rfc3339(),
                attached: s.attached,
            })
            .collect();

        let result = SessionListResult { sessions: entries };

        DispatchResult::Success(JsonRpcResponse::new(
            request.id,
            serde_json::to_value(result).unwrap(),
        ))
    }

    async fn handle_session_close(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: SessionCloseParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid session.close params: {e}"),
                ));
            }
        };

        if self.session_manager.close(&params.session_id).await {
            DispatchResult::Success(JsonRpcResponse::new(id, json!({})))
        } else {
            DispatchResult::Error(
                JsonRpcErrorResponse::new(id, errors::SESSION_NOT_FOUND, "Session not found")
                    .with_data(json!({"session_id": params.session_id})),
            )
        }
    }

    async fn handle_health_check(&self, request: JsonRpcRequest) -> DispatchResult {
        let uptime = self.start_time.elapsed().as_secs();
        let active = self.session_manager.active_count().await;

        let result = HealthCheckResult {
            status: "ok".to_string(),
            uptime_secs: uptime,
            active_sessions: active,
        };

        DispatchResult::Success(JsonRpcResponse::new(
            request.id,
            serde_json::to_value(result).unwrap(),
        ))
    }

    async fn handle_session_attach(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: SessionAttachParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid session.attach params: {e}"),
                ));
            }
        };

        match self.session_manager.attach(&params.session_id).await {
            Ok(()) => DispatchResult::Success(JsonRpcResponse::new(id, json!({}))),
            Err(msg) => DispatchResult::Error(
                JsonRpcErrorResponse::new(id, errors::SESSION_NOT_FOUND, msg)
                    .with_data(json!({"session_id": params.session_id})),
            ),
        }
    }

    async fn handle_session_detach(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: SessionDetachParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid session.detach params: {e}"),
                ));
            }
        };

        match self.session_manager.detach(&params.session_id).await {
            Ok(()) => DispatchResult::Success(JsonRpcResponse::new(id, json!({}))),
            Err(msg) => DispatchResult::Error(
                JsonRpcErrorResponse::new(id, errors::SESSION_NOT_FOUND, msg)
                    .with_data(json!({"session_id": params.session_id})),
            ),
        }
    }

    async fn handle_session_input(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: SessionInputParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid session.input params: {e}"),
                ));
            }
        };

        let b64 = base64::engine::general_purpose::STANDARD;
        let data = match b64.decode(&params.data) {
            Ok(d) => d,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid base64 data: {e}"),
                ));
            }
        };

        match self
            .session_manager
            .write_input(&params.session_id, &data)
            .await
        {
            Ok(()) => DispatchResult::Success(JsonRpcResponse::new(id, json!({}))),
            Err(msg) => DispatchResult::Error(
                JsonRpcErrorResponse::new(id, errors::SESSION_NOT_FOUND, msg)
                    .with_data(json!({"session_id": params.session_id})),
            ),
        }
    }

    async fn handle_session_resize(&self, request: JsonRpcRequest) -> DispatchResult {
        // No-op for serial sessions; returns success for all session types.
        DispatchResult::Success(JsonRpcResponse::new(request.id, json!({})))
    }
}

/// Well-known shell paths to probe on the host system.
const SHELL_CANDIDATES: &[&str] = &[
    "/bin/bash",
    "/bin/sh",
    "/bin/zsh",
    "/usr/bin/fish",
    "/usr/bin/bash",
    "/usr/bin/zsh",
    "/usr/local/bin/bash",
    "/usr/local/bin/zsh",
    "/usr/local/bin/fish",
];

/// Detect available shells by checking which candidate paths exist on disk.
fn detect_available_shells() -> Vec<String> {
    SHELL_CANDIDATES
        .iter()
        .filter(|p| Path::new(p).exists())
        .map(|p| p.to_string())
        .collect()
}

/// Detect available serial ports using the `serialport` crate.
fn detect_available_serial_ports() -> Vec<String> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.port_name)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_dispatcher() -> Dispatcher {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        Dispatcher::new(Arc::new(SessionManager::new(tx)))
    }

    fn make_request(method: &str, params: Value, id: u64) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params,
            id: json!(id),
        }
    }

    fn init_params() -> Value {
        json!({
            "protocol_version": "0.1.0",
            "client": "test",
            "client_version": "0.1.0"
        })
    }

    async fn init_dispatcher(d: &mut Dispatcher) {
        let req = make_request("initialize", init_params(), 1);
        let result = d.dispatch(req).await;
        assert!(matches!(result, DispatchResult::Success(_)));
    }

    // ── Initialize tests ────────────────────────────────────────────

    #[tokio::test]
    async fn initialize_succeeds() {
        let mut d = make_dispatcher();
        let req = make_request("initialize", init_params(), 1);
        let result = d.dispatch(req).await;

        let json = result.to_json();
        assert_eq!(json["result"]["protocol_version"], "0.1.0");
        assert_eq!(json["result"]["capabilities"]["max_sessions"], 20);
        assert!(json["result"]["capabilities"]["session_types"]
            .as_array()
            .unwrap()
            .contains(&json!("shell")));
        // available_shells and available_serial_ports must be arrays
        assert!(json["result"]["capabilities"]["available_shells"]
            .as_array()
            .is_some());
        assert!(json["result"]["capabilities"]["available_serial_ports"]
            .as_array()
            .is_some());
    }

    #[tokio::test]
    async fn initialize_rejects_incompatible_version() {
        let mut d = make_dispatcher();
        let req = make_request(
            "initialize",
            json!({
                "protocol_version": "1.0.0",
                "client": "test",
                "client_version": "1.0.0"
            }),
            1,
        );
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert_eq!(json["error"]["code"], errors::VERSION_NOT_SUPPORTED);
    }

    #[tokio::test]
    async fn initialize_rejects_invalid_params() {
        let mut d = make_dispatcher();
        let req = make_request("initialize", json!({}), 1);
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert_eq!(json["error"]["code"], errors::INVALID_PARAMS);
    }

    // ── Not-initialized gate ────────────────────────────────────────

    #[tokio::test]
    async fn methods_require_initialization() {
        let mut d = make_dispatcher();

        for method in &[
            "session.create",
            "session.list",
            "session.close",
            "health.check",
        ] {
            let req = make_request(method, json!({}), 1);
            let result = d.dispatch(req).await;
            let json = result.to_json();
            assert_eq!(
                json["error"]["code"],
                errors::NOT_INITIALIZED,
                "{method} should require initialization"
            );
        }
    }

    // ── Session create tests ────────────────────────────────────────

    #[tokio::test]
    async fn session_create_shell() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "session.create",
            json!({
                "type": "shell",
                "config": {"shell": "/bin/bash"},
                "title": "My shell"
            }),
            2,
        );
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert!(json["result"]["session_id"].is_string());
        assert_eq!(json["result"]["type"], "shell");
        assert_eq!(json["result"]["status"], "running");
        assert_eq!(json["result"]["title"], "My shell");
    }

    #[tokio::test]
    async fn session_create_serial_fails_without_port() {
        // Serial creation now actually opens the port, so it fails in CI
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "session.create",
            json!({
                "type": "serial",
                "config": {"port": "/dev/ttyUSB0"}
            }),
            2,
        );
        let result = d.dispatch(req).await;
        let json = result.to_json();
        // Should get SESSION_CREATION_FAILED because the port doesn't exist
        assert_eq!(
            json["error"]["code"],
            crate::protocol::errors::SESSION_CREATION_FAILED
        );
    }

    #[tokio::test]
    async fn session_create_unsupported_type() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "session.create",
            json!({"type": "unknown", "config": {}}),
            2,
        );
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert_eq!(json["error"]["code"], errors::INVALID_CONFIGURATION);
    }

    // ── Session list tests ──────────────────────────────────────────

    #[tokio::test]
    async fn session_list_empty() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request("session.list", json!({}), 2);
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert_eq!(json["result"]["sessions"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn session_list_after_create() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        // Create a session
        let req = make_request(
            "session.create",
            json!({"type": "shell", "config": {}, "title": "test"}),
            2,
        );
        d.dispatch(req).await;

        // List sessions
        let req = make_request("session.list", json!({}), 3);
        let result = d.dispatch(req).await;
        let json = result.to_json();
        let sessions = json["result"]["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["title"], "test");
    }

    // ── Session close tests ─────────────────────────────────────────

    #[tokio::test]
    async fn session_close_success() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        // Create
        let req = make_request(
            "session.create",
            json!({"type": "shell", "config": {}, "title": "temp"}),
            2,
        );
        let create_result = d.dispatch(req).await.to_json();
        let sid = create_result["result"]["session_id"].as_str().unwrap();

        // Close
        let req = make_request("session.close", json!({"session_id": sid}), 3);
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert!(json.get("result").is_some());

        // Verify gone
        let req = make_request("session.list", json!({}), 4);
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["result"]["sessions"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn session_close_not_found() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request("session.close", json!({"session_id": "nonexistent"}), 2);
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert_eq!(json["error"]["code"], errors::SESSION_NOT_FOUND);
        assert_eq!(json["error"]["data"]["session_id"], "nonexistent");
    }

    // ── Health check tests ──────────────────────────────────────────

    #[tokio::test]
    async fn health_check() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request("health.check", json!({}), 2);
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert_eq!(json["result"]["status"], "ok");
        assert!(json["result"]["uptime_secs"].is_number());
        assert_eq!(json["result"]["active_sessions"], 0);
    }

    // ── Unknown method ──────────────────────────────────────────────

    #[tokio::test]
    async fn unknown_method() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request("unknown.method", json!({}), 2);
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert_eq!(json["error"]["code"], errors::METHOD_NOT_FOUND);
    }

    // ── Session attach/detach/input tests ──────────────────────────

    #[tokio::test]
    async fn session_attach_not_found() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request("session.attach", json!({"session_id": "nonexistent"}), 2);
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert_eq!(json["error"]["code"], errors::SESSION_NOT_FOUND);
    }

    #[tokio::test]
    async fn session_detach_not_found() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request("session.detach", json!({"session_id": "nonexistent"}), 2);
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert_eq!(json["error"]["code"], errors::SESSION_NOT_FOUND);
    }

    #[tokio::test]
    async fn session_input_not_found() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "session.input",
            json!({"session_id": "nonexistent", "data": "aGVsbG8="}),
            2,
        );
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert_eq!(json["error"]["code"], errors::SESSION_NOT_FOUND);
    }

    #[tokio::test]
    async fn session_input_invalid_base64() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "session.input",
            json!({"session_id": "any", "data": "!!!not-base64!!!"}),
            2,
        );
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert_eq!(json["error"]["code"], errors::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn session_resize_returns_success() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "session.resize",
            json!({"session_id": "any", "cols": 120, "rows": 40}),
            2,
        );
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert!(json.get("result").is_some());
    }

    // ── Full protocol flow integration test ─────────────────────────

    #[tokio::test]
    async fn full_protocol_flow() {
        let mut d = make_dispatcher();

        // 1. Initialize
        let req = make_request("initialize", init_params(), 1);
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["result"]["protocol_version"], "0.1.0");

        // 2. Create shell session
        let req = make_request(
            "session.create",
            json!({
                "type": "shell",
                "config": {"shell": "/bin/bash", "cols": 80, "rows": 24},
                "title": "Build"
            }),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        let session_id = result["result"]["session_id"].as_str().unwrap().to_string();
        assert_eq!(result["result"]["status"], "running");

        // 3. Attach to the session
        let req = make_request("session.attach", json!({"session_id": session_id}), 3);
        let result = d.dispatch(req).await.to_json();
        assert!(result.get("result").is_some());

        // 4. Send input (no-op for shell stub, but protocol should succeed)
        let req = make_request(
            "session.input",
            json!({"session_id": session_id, "data": "aGVsbG8="}),
            4,
        );
        let result = d.dispatch(req).await.to_json();
        assert!(result.get("result").is_some());

        // 5. Resize (no-op for serial/stub)
        let req = make_request(
            "session.resize",
            json!({"session_id": session_id, "cols": 120, "rows": 40}),
            5,
        );
        let result = d.dispatch(req).await.to_json();
        assert!(result.get("result").is_some());

        // 6. List shows attached
        let req = make_request("session.list", json!({}), 6);
        let result = d.dispatch(req).await.to_json();
        let sessions = result["result"]["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 1);
        assert!(sessions[0]["attached"].as_bool().unwrap());

        // 7. Detach
        let req = make_request("session.detach", json!({"session_id": session_id}), 7);
        let result = d.dispatch(req).await.to_json();
        assert!(result.get("result").is_some());

        // 8. List shows detached
        let req = make_request("session.list", json!({}), 8);
        let result = d.dispatch(req).await.to_json();
        let sessions = result["result"]["sessions"].as_array().unwrap();
        assert!(!sessions[0]["attached"].as_bool().unwrap());

        // 9. Health check shows 1 active session
        let req = make_request("health.check", json!({}), 9);
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["result"]["active_sessions"], 1);

        // 10. Close session
        let req = make_request("session.close", json!({"session_id": session_id}), 10);
        let result = d.dispatch(req).await.to_json();
        assert!(result.get("result").is_some());

        // 11. Health check shows 0 active sessions
        let req = make_request("health.check", json!({}), 11);
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["result"]["active_sessions"], 0);
    }

    // ── Capability detection tests ─────────────────────────────────

    #[test]
    fn detect_shells_returns_existing_paths() {
        let shells = detect_available_shells();
        // On any Unix-like system, /bin/sh should exist
        #[cfg(unix)]
        assert!(
            shells.contains(&"/bin/sh".to_string()),
            "Expected /bin/sh to be detected, got: {shells:?}"
        );
        // All returned paths must actually exist
        for shell in &shells {
            assert!(
                Path::new(shell).exists(),
                "Detected shell does not exist: {shell}"
            );
        }
    }

    #[test]
    fn detect_serial_ports_returns_vec() {
        // We can't assert specific ports exist in CI, but the function should not panic
        let ports = detect_available_serial_ports();
        // Just verify it returns a valid vector (may be empty in CI)
        assert!(ports.len() < 1000, "Unreasonably many ports detected");
    }
}

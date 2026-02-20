use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use tracing::{debug, warn};

use base64::Engine;

use crate::files::docker::DockerFileBackend;
use crate::files::local::LocalFileBackend;
use crate::files::ssh::SshFileBackend;
use crate::files::{FileBackend, FileError};
use crate::protocol::errors;
use crate::protocol::messages::{JsonRpcErrorResponse, JsonRpcRequest, JsonRpcResponse};
use crate::protocol::methods::{
    Capabilities, ConnectionCreateParams, ConnectionDeleteParams, ConnectionUpdateParams,
    DockerSessionConfig, FilesDeleteParams, FilesListParams, FilesListResult, FilesReadParams,
    FilesReadResult, FilesRenameParams, FilesStatParams, FilesWriteParams, FolderCreateParams,
    FolderDeleteParams, FolderUpdateParams, HealthCheckResult, InitializeParams, InitializeResult,
    SessionAttachParams, SessionCloseParams, SessionCreateParams, SessionCreateResult,
    SessionDetachParams, SessionInputParams, SessionListEntry, SessionListResult,
    SessionResizeParams, SshSessionConfig,
};
use crate::session::definitions::{Connection, ConnectionStore, Folder};
use crate::session::manager::{SessionCreateError, SessionManager, MAX_SESSIONS};
use crate::session::types::SessionType;

/// The agent's protocol version.
const AGENT_PROTOCOL_VERSION: &str = "0.1.0";

/// Dispatcher handles incoming JSON-RPC requests and routes them
/// to the appropriate handler function.
pub struct Dispatcher {
    session_manager: Arc<SessionManager>,
    connection_store: Arc<ConnectionStore>,
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
    pub fn new(
        session_manager: Arc<SessionManager>,
        connection_store: Arc<ConnectionStore>,
    ) -> Self {
        Self {
            session_manager,
            connection_store,
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
            "connections.list" => self.handle_connections_list(request).await,
            "connections.create" => self.handle_connections_create(request).await,
            "connections.update" => self.handle_connections_update(request).await,
            "connections.delete" => self.handle_connections_delete(request).await,
            "connections.folders.create" => self.handle_connections_folders_create(request).await,
            "connections.folders.update" => self.handle_connections_folders_update(request).await,
            "connections.folders.delete" => self.handle_connections_folders_delete(request).await,
            "files.list" => self.handle_files_list(request).await,
            "files.read" => self.handle_files_read(request).await,
            "files.write" => self.handle_files_write(request).await,
            "files.delete" => self.handle_files_delete(request).await,
            "files.rename" => self.handle_files_rename(request).await,
            "files.stat" => self.handle_files_stat(request).await,
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

        let docker_available = detect_docker_available();
        let mut session_types = vec!["shell".to_string(), "serial".to_string()];
        if docker_available {
            session_types.push("docker".to_string());
        }
        // SSH client is always available on the agent host
        session_types.push("ssh".to_string());

        let result = InitializeResult {
            protocol_version: AGENT_PROTOCOL_VERSION.to_string(),
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            capabilities: Capabilities {
                session_types,
                max_sessions: MAX_SESSIONS,
                available_shells: detect_available_shells(),
                available_serial_ports: detect_available_serial_ports(),
                docker_available,
                available_docker_images: detect_docker_images(),
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
        let id = request.id.clone();

        let params: SessionResizeParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid session.resize params: {e}"),
                ));
            }
        };

        match self
            .session_manager
            .resize(&params.session_id, params.cols, params.rows)
            .await
        {
            Ok(()) => DispatchResult::Success(JsonRpcResponse::new(id, json!({}))),
            Err(msg) => DispatchResult::Error(
                JsonRpcErrorResponse::new(id, errors::SESSION_NOT_FOUND, msg)
                    .with_data(json!({"session_id": params.session_id})),
            ),
        }
    }

    // ── connections.* handlers ───────────────────────────────────────

    async fn handle_connections_list(&self, request: JsonRpcRequest) -> DispatchResult {
        let (connections, folders) = self.connection_store.list().await;
        DispatchResult::Success(JsonRpcResponse::new(
            request.id,
            json!({"connections": connections, "folders": folders}),
        ))
    }

    async fn handle_connections_create(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: ConnectionCreateParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid connections.create params: {e}"),
                ));
            }
        };

        let conn = Connection {
            id: format!("conn-{}", uuid::Uuid::new_v4()),
            name: params.name,
            session_type: params.session_type,
            config: params.config,
            persistent: params.persistent,
            folder_id: params.folder_id,
        };

        let snapshot = self.connection_store.create(conn).await;
        DispatchResult::Success(JsonRpcResponse::new(
            id,
            serde_json::to_value(snapshot).unwrap(),
        ))
    }

    async fn handle_connections_update(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: ConnectionUpdateParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid connections.update params: {e}"),
                ));
            }
        };

        // Convert folder_id: absent → None, null → Some(None), string → Some(Some(s))
        let folder_id = params.folder_id.map(|v| {
            if v.is_null() {
                None
            } else {
                v.as_str().map(|s| s.to_string())
            }
        });

        match self
            .connection_store
            .update(
                &params.id,
                params.name,
                params.session_type,
                params.config,
                params.persistent,
                folder_id,
            )
            .await
        {
            Some(snapshot) => DispatchResult::Success(JsonRpcResponse::new(
                id,
                serde_json::to_value(snapshot).unwrap(),
            )),
            None => DispatchResult::Error(
                JsonRpcErrorResponse::new(id, errors::CONNECTION_NOT_FOUND, "Connection not found")
                    .with_data(json!({"id": params.id})),
            ),
        }
    }

    async fn handle_connections_delete(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: ConnectionDeleteParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid connections.delete params: {e}"),
                ));
            }
        };

        if self.connection_store.delete(&params.id).await {
            DispatchResult::Success(JsonRpcResponse::new(id, json!({})))
        } else {
            DispatchResult::Error(
                JsonRpcErrorResponse::new(id, errors::CONNECTION_NOT_FOUND, "Connection not found")
                    .with_data(json!({"id": params.id})),
            )
        }
    }

    async fn handle_connections_folders_create(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: FolderCreateParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid connections.folders.create params: {e}"),
                ));
            }
        };

        let folder = Folder {
            id: format!("folder-{}", uuid::Uuid::new_v4()),
            name: params.name,
            parent_id: params.parent_id,
            is_expanded: false,
        };

        let snapshot = self.connection_store.create_folder(folder).await;
        DispatchResult::Success(JsonRpcResponse::new(
            id,
            serde_json::to_value(snapshot).unwrap(),
        ))
    }

    async fn handle_connections_folders_update(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: FolderUpdateParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid connections.folders.update params: {e}"),
                ));
            }
        };

        // Convert parent_id: absent → None, null → Some(None), string → Some(Some(s))
        let parent_id = params.parent_id.map(|v| {
            if v.is_null() {
                None
            } else {
                v.as_str().map(|s| s.to_string())
            }
        });

        match self
            .connection_store
            .update_folder(&params.id, params.name, parent_id, params.is_expanded)
            .await
        {
            Some(snapshot) => DispatchResult::Success(JsonRpcResponse::new(
                id,
                serde_json::to_value(snapshot).unwrap(),
            )),
            None => DispatchResult::Error(
                JsonRpcErrorResponse::new(id, errors::FOLDER_NOT_FOUND, "Folder not found")
                    .with_data(json!({"id": params.id})),
            ),
        }
    }

    async fn handle_connections_folders_delete(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: FolderDeleteParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid connections.folders.delete params: {e}"),
                ));
            }
        };

        if self.connection_store.delete_folder(&params.id).await {
            DispatchResult::Success(JsonRpcResponse::new(id, json!({})))
        } else {
            DispatchResult::Error(
                JsonRpcErrorResponse::new(id, errors::FOLDER_NOT_FOUND, "Folder not found")
                    .with_data(json!({"id": params.id})),
            )
        }
    }

    // ── files.* handlers ───────────────────────────────────────────

    async fn handle_files_list(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: FilesListParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid files.list params: {e}"),
                ));
            }
        };

        let backend = match self.resolve_file_backend(params.connection_id).await {
            Ok(b) => b,
            Err((code, msg)) => return DispatchResult::Error(JsonRpcErrorResponse::new(id, code, msg)),
        };

        match backend.list(&params.path).await {
            Ok(entries) => {
                let result = FilesListResult { entries };
                DispatchResult::Success(JsonRpcResponse::new(
                    id,
                    serde_json::to_value(result).unwrap(),
                ))
            }
            Err(e) => {
                let (code, msg) = map_file_error(e);
                DispatchResult::Error(JsonRpcErrorResponse::new(id, code, msg))
            }
        }
    }

    async fn handle_files_read(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: FilesReadParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid files.read params: {e}"),
                ));
            }
        };

        let backend = match self.resolve_file_backend(params.connection_id).await {
            Ok(b) => b,
            Err((code, msg)) => return DispatchResult::Error(JsonRpcErrorResponse::new(id, code, msg)),
        };

        match backend.read(&params.path).await {
            Ok(data) => {
                let b64 = base64::engine::general_purpose::STANDARD;
                let size = data.len() as u64;
                let result = FilesReadResult {
                    data: b64.encode(&data),
                    size,
                };
                DispatchResult::Success(JsonRpcResponse::new(
                    id,
                    serde_json::to_value(result).unwrap(),
                ))
            }
            Err(e) => {
                let (code, msg) = map_file_error(e);
                DispatchResult::Error(JsonRpcErrorResponse::new(id, code, msg))
            }
        }
    }

    async fn handle_files_write(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: FilesWriteParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid files.write params: {e}"),
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

        let backend = match self.resolve_file_backend(params.connection_id).await {
            Ok(b) => b,
            Err((code, msg)) => return DispatchResult::Error(JsonRpcErrorResponse::new(id, code, msg)),
        };

        match backend.write(&params.path, &data).await {
            Ok(()) => DispatchResult::Success(JsonRpcResponse::new(id, json!({}))),
            Err(e) => {
                let (code, msg) = map_file_error(e);
                DispatchResult::Error(JsonRpcErrorResponse::new(id, code, msg))
            }
        }
    }

    async fn handle_files_delete(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: FilesDeleteParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid files.delete params: {e}"),
                ));
            }
        };

        let backend = match self.resolve_file_backend(params.connection_id).await {
            Ok(b) => b,
            Err((code, msg)) => return DispatchResult::Error(JsonRpcErrorResponse::new(id, code, msg)),
        };

        match backend.delete(&params.path, params.is_directory).await {
            Ok(()) => DispatchResult::Success(JsonRpcResponse::new(id, json!({}))),
            Err(e) => {
                let (code, msg) = map_file_error(e);
                DispatchResult::Error(JsonRpcErrorResponse::new(id, code, msg))
            }
        }
    }

    async fn handle_files_rename(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: FilesRenameParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid files.rename params: {e}"),
                ));
            }
        };

        let backend = match self.resolve_file_backend(params.connection_id).await {
            Ok(b) => b,
            Err((code, msg)) => return DispatchResult::Error(JsonRpcErrorResponse::new(id, code, msg)),
        };

        match backend.rename(&params.old_path, &params.new_path).await {
            Ok(()) => DispatchResult::Success(JsonRpcResponse::new(id, json!({}))),
            Err(e) => {
                let (code, msg) = map_file_error(e);
                DispatchResult::Error(JsonRpcErrorResponse::new(id, code, msg))
            }
        }
    }

    async fn handle_files_stat(&self, request: JsonRpcRequest) -> DispatchResult {
        let id = request.id.clone();

        let params: FilesStatParams = match serde_json::from_value(request.params) {
            Ok(p) => p,
            Err(e) => {
                return DispatchResult::Error(JsonRpcErrorResponse::new(
                    id,
                    errors::INVALID_PARAMS,
                    format!("Invalid files.stat params: {e}"),
                ));
            }
        };

        let backend = match self.resolve_file_backend(params.connection_id).await {
            Ok(b) => b,
            Err((code, msg)) => return DispatchResult::Error(JsonRpcErrorResponse::new(id, code, msg)),
        };

        match backend.stat(&params.path).await {
            Ok(result) => DispatchResult::Success(JsonRpcResponse::new(
                id,
                serde_json::to_value(result).unwrap(),
            )),
            Err(e) => {
                let (code, msg) = map_file_error(e);
                DispatchResult::Error(JsonRpcErrorResponse::new(id, code, msg))
            }
        }
    }

    /// Resolve the appropriate file backend for a connection.
    ///
    /// - `None` → local filesystem
    /// - `Some(id)` → look up connection, dispatch by session type
    async fn resolve_file_backend(
        &self,
        connection_id: Option<String>,
    ) -> Result<Box<dyn FileBackend>, (i64, String)> {
        let connection_id = match connection_id {
            None => return Ok(Box::new(LocalFileBackend::new())),
            Some(id) => id,
        };

        let connection = self
            .connection_store
            .get(&connection_id)
            .await
            .ok_or((
                errors::CONNECTION_NOT_FOUND,
                format!("Connection not found: {connection_id}"),
            ))?;

        match connection.session_type.as_str() {
            "shell" => Ok(Box::new(LocalFileBackend::new())),
            "docker" => {
                let docker_config: DockerSessionConfig =
                    serde_json::from_value(connection.config).map_err(|e| {
                        (
                            errors::INVALID_CONFIGURATION,
                            format!("Invalid Docker config: {e}"),
                        )
                    })?;

                // Find a running Docker container for this image
                #[cfg(unix)]
                {
                    let container_name = self
                        .session_manager
                        .find_docker_container(&docker_config.image)
                        .await
                        .ok_or((
                            errors::FILE_OPERATION_FAILED,
                            format!(
                                "No running Docker session for image '{}'. \
                                 Start a Docker session first to browse its files.",
                                docker_config.image
                            ),
                        ))?;
                    Ok(Box::new(DockerFileBackend::new(container_name)))
                }
                #[cfg(not(unix))]
                {
                    let _ = docker_config;
                    Err((
                        errors::FILE_BROWSING_NOT_SUPPORTED,
                        "Docker file browsing is not supported on this platform".to_string(),
                    ))
                }
            }
            "ssh" => {
                let ssh_config: SshSessionConfig =
                    serde_json::from_value(connection.config).map_err(|e| {
                        (
                            errors::INVALID_CONFIGURATION,
                            format!("Invalid SSH config: {e}"),
                        )
                    })?;
                Ok(Box::new(SshFileBackend::new(ssh_config)))
            }
            "serial" => Err((
                errors::FILE_BROWSING_NOT_SUPPORTED,
                "File browsing is not supported for serial connections".to_string(),
            )),
            other => Err((
                errors::INVALID_CONFIGURATION,
                format!("Unknown connection type: {other}"),
            )),
        }
    }
}

/// Map a `FileError` to a JSON-RPC error code and message.
fn map_file_error(e: FileError) -> (i64, String) {
    match e {
        FileError::NotFound(msg) => (errors::FILE_NOT_FOUND, msg),
        FileError::PermissionDenied(msg) => (errors::PERMISSION_DENIED, msg),
        FileError::OperationFailed(msg) => (errors::FILE_OPERATION_FAILED, msg),
        FileError::NotSupported => (
            errors::FILE_BROWSING_NOT_SUPPORTED,
            e.to_string(),
        ),
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

/// Check if Docker is available and running.
fn detect_docker_available() -> bool {
    std::process::Command::new("docker")
        .args(["info"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// List locally available Docker images as "repository:tag" strings.
fn detect_docker_images() -> Vec<String> {
    let output = std::process::Command::new("docker")
        .args(["images", "--format", "{{.Repository}}:{{.Tag}}"])
        .output();

    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter(|line| !line.contains("<none>"))
            .map(|s| s.to_string())
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_dispatcher() -> Dispatcher {
        let (mgr, _) = make_dispatcher_with_manager();
        mgr
    }

    fn make_dispatcher_with_manager() -> (Dispatcher, Arc<SessionManager>) {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp = std::env::temp_dir().join(format!("termihub-test-{}.json", uuid::Uuid::new_v4()));
        let conn_store = Arc::new(ConnectionStore::new_temp(tmp));
        let session_manager = Arc::new(SessionManager::new(tx));
        let dispatcher = Dispatcher::new(session_manager.clone(), conn_store);
        (dispatcher, session_manager)
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
        // SSH is always available
        assert!(json["result"]["capabilities"]["session_types"]
            .as_array()
            .unwrap()
            .contains(&json!("ssh")));
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
            "connections.list",
            "connections.create",
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
    async fn session_create_docker_requires_image() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "session.create",
            json!({
                "type": "docker",
                "config": {},
                "title": "My session"
            }),
            2,
        );
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert_eq!(json["error"]["code"], errors::INVALID_CONFIGURATION);
    }

    #[tokio::test]
    async fn session_create_serial_fails_without_port() {
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

    #[tokio::test]
    async fn session_create_ssh_requires_host() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "session.create",
            json!({
                "type": "ssh",
                "config": {"username": "dev", "auth_method": "agent"},
                "title": "Jump session"
            }),
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
        let (mut d, mgr) = make_dispatcher_with_manager();
        init_dispatcher(&mut d).await;

        mgr.create_stub_session(SessionType::Shell, "test".to_string(), json!({}))
            .await
            .unwrap();

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
        let (mut d, mgr) = make_dispatcher_with_manager();
        init_dispatcher(&mut d).await;

        let snapshot = mgr
            .create_stub_session(SessionType::Shell, "temp".to_string(), json!({}))
            .await
            .unwrap();
        let sid = snapshot.id;

        let req = make_request("session.close", json!({"session_id": sid}), 3);
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert!(json.get("result").is_some());

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
        let (mut d, mgr) = make_dispatcher_with_manager();
        init_dispatcher(&mut d).await;

        let snapshot = mgr
            .create_stub_session(SessionType::Shell, "resize-test".to_string(), json!({}))
            .await
            .unwrap();
        let sid = snapshot.id;

        let req = make_request(
            "session.resize",
            json!({"session_id": sid, "cols": 120, "rows": 40}),
            3,
        );
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert!(json.get("result").is_some());
    }

    #[tokio::test]
    async fn session_resize_not_found() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "session.resize",
            json!({"session_id": "nonexistent", "cols": 120, "rows": 40}),
            2,
        );
        let result = d.dispatch(req).await;
        let json = result.to_json();
        assert_eq!(json["error"]["code"], errors::SESSION_NOT_FOUND);
    }

    // ── Full protocol flow integration test ─────────────────────────

    #[tokio::test]
    async fn full_protocol_flow() {
        let (mut d, mgr) = make_dispatcher_with_manager();

        // 1. Initialize
        let req = make_request("initialize", init_params(), 1);
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["result"]["protocol_version"], "0.1.0");

        // 2. Create a stub session (avoids spawning real backends)
        let snapshot = mgr
            .create_stub_session(SessionType::Shell, "Build".to_string(), json!({}))
            .await
            .unwrap();
        let session_id = snapshot.id;

        // 3. Attach to the session
        let req = make_request("session.attach", json!({"session_id": session_id}), 3);
        let result = d.dispatch(req).await.to_json();
        assert!(result.get("result").is_some());

        // 4. Send input (no-op for stub, but protocol should succeed)
        let req = make_request(
            "session.input",
            json!({"session_id": session_id, "data": "aGVsbG8="}),
            4,
        );
        let result = d.dispatch(req).await.to_json();
        assert!(result.get("result").is_some());

        // 5. Resize (no-op for stub sessions)
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
        #[cfg(unix)]
        assert!(
            shells.contains(&"/bin/sh".to_string()),
            "Expected /bin/sh to be detected, got: {shells:?}"
        );
        for shell in &shells {
            assert!(
                Path::new(shell).exists(),
                "Detected shell does not exist: {shell}"
            );
        }
    }

    #[test]
    fn detect_serial_ports_returns_vec() {
        let ports = detect_available_serial_ports();
        assert!(ports.len() < 1000, "Unreasonably many ports detected");
    }

    // ── Connection tests ────────────────────────────────────────────

    #[tokio::test]
    async fn connections_create_and_list() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        // Create
        let req = make_request(
            "connections.create",
            json!({
                "name": "Build Shell",
                "type": "shell",
                "config": {"shell": "/bin/bash"},
                "persistent": true
            }),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        let conn_id = result["result"]["id"].as_str().unwrap();
        assert!(conn_id.starts_with("conn-"));
        assert_eq!(result["result"]["name"], "Build Shell");
        assert!(result["result"]["persistent"].as_bool().unwrap());

        // List
        let req = make_request("connections.list", json!({}), 3);
        let result = d.dispatch(req).await.to_json();
        let conns = result["result"]["connections"].as_array().unwrap();
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0]["name"], "Build Shell");
        let folders = result["result"]["folders"].as_array().unwrap();
        assert!(folders.is_empty());
    }

    #[tokio::test]
    async fn connections_update() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        // Create
        let req = make_request(
            "connections.create",
            json!({"name": "Old", "type": "shell"}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        let conn_id = result["result"]["id"].as_str().unwrap().to_string();

        // Update
        let req = make_request(
            "connections.update",
            json!({"id": conn_id, "name": "New", "persistent": true}),
            3,
        );
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["result"]["name"], "New");
        assert!(result["result"]["persistent"].as_bool().unwrap());
    }

    #[tokio::test]
    async fn connections_update_not_found() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "connections.update",
            json!({"id": "nonexistent", "name": "X"}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["error"]["code"], errors::CONNECTION_NOT_FOUND);
    }

    #[tokio::test]
    async fn connections_delete() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        // Create
        let req = make_request(
            "connections.create",
            json!({"name": "Temp", "type": "shell"}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        let conn_id = result["result"]["id"].as_str().unwrap().to_string();

        // Delete
        let req = make_request("connections.delete", json!({"id": conn_id}), 3);
        let result = d.dispatch(req).await.to_json();
        assert!(result.get("result").is_some());

        // Verify gone
        let req = make_request("connections.list", json!({}), 4);
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["result"]["connections"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn connections_delete_not_found() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request("connections.delete", json!({"id": "nonexistent"}), 2);
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["error"]["code"], errors::CONNECTION_NOT_FOUND);
    }

    // ── Folder tests ────────────────────────────────────────────────

    #[tokio::test]
    async fn folders_create_and_list() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        // Create folder
        let req = make_request(
            "connections.folders.create",
            json!({"name": "Project A"}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        let folder_id = result["result"]["id"].as_str().unwrap();
        assert!(folder_id.starts_with("folder-"));
        assert_eq!(result["result"]["name"], "Project A");
        assert!(!result["result"]["is_expanded"].as_bool().unwrap());

        // List
        let req = make_request("connections.list", json!({}), 3);
        let result = d.dispatch(req).await.to_json();
        let folders = result["result"]["folders"].as_array().unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0]["name"], "Project A");
    }

    #[tokio::test]
    async fn folders_update() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        // Create
        let req = make_request("connections.folders.create", json!({"name": "Old Name"}), 2);
        let result = d.dispatch(req).await.to_json();
        let folder_id = result["result"]["id"].as_str().unwrap().to_string();

        // Update
        let req = make_request(
            "connections.folders.update",
            json!({"id": folder_id, "name": "New Name", "is_expanded": true}),
            3,
        );
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["result"]["name"], "New Name");
        assert!(result["result"]["is_expanded"].as_bool().unwrap());
    }

    #[tokio::test]
    async fn folders_update_not_found() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "connections.folders.update",
            json!({"id": "nonexistent", "name": "X"}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["error"]["code"], errors::FOLDER_NOT_FOUND);
    }

    #[tokio::test]
    async fn folders_delete() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        // Create
        let req = make_request(
            "connections.folders.create",
            json!({"name": "Temp Folder"}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        let folder_id = result["result"]["id"].as_str().unwrap().to_string();

        // Delete
        let req = make_request("connections.folders.delete", json!({"id": folder_id}), 3);
        let result = d.dispatch(req).await.to_json();
        assert!(result.get("result").is_some());

        // Verify gone
        let req = make_request("connections.list", json!({}), 4);
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["result"]["folders"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn folders_delete_not_found() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "connections.folders.delete",
            json!({"id": "nonexistent"}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["error"]["code"], errors::FOLDER_NOT_FOUND);
    }

    #[tokio::test]
    async fn connections_with_folder() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        // Create folder
        let req = make_request("connections.folders.create", json!({"name": "Project"}), 2);
        let result = d.dispatch(req).await.to_json();
        let folder_id = result["result"]["id"].as_str().unwrap().to_string();

        // Create connection in folder
        let req = make_request(
            "connections.create",
            json!({"name": "Shell", "type": "shell", "folder_id": folder_id}),
            3,
        );
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["result"]["folder_id"], folder_id);
    }

    // ── File browsing tests ────────────────────────────────────────

    #[tokio::test]
    async fn files_list_local() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), "world").unwrap();

        let req = make_request(
            "files.list",
            json!({"path": dir.path().to_str().unwrap()}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        let entries = result["result"]["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "hello.txt");
        assert_eq!(entries[0]["isDirectory"], false);
        assert_eq!(entries[0]["size"], 5);
    }

    #[tokio::test]
    async fn files_list_not_found() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "files.list",
            json!({"path": "/nonexistent/path/abc123"}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["error"]["code"], errors::FILE_NOT_FOUND);
    }

    #[tokio::test]
    async fn files_read_write_round_trip() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test.txt");
        let path_str = file_path.to_str().unwrap();

        // Write
        let data_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            b"hello, world!",
        );
        let req = make_request(
            "files.write",
            json!({"path": path_str, "data": data_b64}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        assert!(result.get("result").is_some());

        // Read
        let req = make_request("files.read", json!({"path": path_str}), 3);
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["result"]["data"], data_b64);
        assert_eq!(result["result"]["size"], 13);
    }

    #[tokio::test]
    async fn files_stat() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("stat_test.txt");
        std::fs::write(&file_path, "hello").unwrap();

        let req = make_request(
            "files.stat",
            json!({"path": file_path.to_str().unwrap()}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["result"]["name"], "stat_test.txt");
        assert_eq!(result["result"]["isDirectory"], false);
        assert_eq!(result["result"]["size"], 5);
    }

    #[tokio::test]
    async fn files_delete() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("to_delete.txt");
        std::fs::write(&file_path, "delete me").unwrap();

        let req = make_request(
            "files.delete",
            json!({"path": file_path.to_str().unwrap(), "isDirectory": false}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        assert!(result.get("result").is_some());
        assert!(!file_path.exists());
    }

    #[tokio::test]
    async fn files_rename() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.txt");
        let new = dir.path().join("new.txt");
        std::fs::write(&old, "content").unwrap();

        let req = make_request(
            "files.rename",
            json!({"old_path": old.to_str().unwrap(), "new_path": new.to_str().unwrap()}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        assert!(result.get("result").is_some());
        assert!(!old.exists());
        assert!(new.exists());
    }

    #[tokio::test]
    async fn files_with_connection_id_not_found() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "files.list",
            json!({"connection_id": "nonexistent", "path": "/tmp"}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["error"]["code"], errors::CONNECTION_NOT_FOUND);
    }

    #[tokio::test]
    async fn files_serial_not_supported() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        // Create a serial connection
        let req = make_request(
            "connections.create",
            json!({
                "name": "Serial",
                "type": "serial",
                "config": {"port": "/dev/ttyUSB0"}
            }),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        let conn_id = result["result"]["id"].as_str().unwrap().to_string();

        // Try to list files via serial connection
        let req = make_request(
            "files.list",
            json!({"connection_id": conn_id, "path": "/tmp"}),
            3,
        );
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["error"]["code"], errors::FILE_BROWSING_NOT_SUPPORTED);
    }

    #[tokio::test]
    async fn files_shell_connection_uses_local() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("file.txt"), "data").unwrap();

        // Create a shell connection
        let req = make_request(
            "connections.create",
            json!({"name": "Shell", "type": "shell", "config": {"shell": "/bin/sh"}}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        let conn_id = result["result"]["id"].as_str().unwrap().to_string();

        // List files via shell connection (should use local backend)
        let req = make_request(
            "files.list",
            json!({"connection_id": conn_id, "path": dir.path().to_str().unwrap()}),
            3,
        );
        let result = d.dispatch(req).await.to_json();
        let entries = result["result"]["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "file.txt");
    }

    #[tokio::test]
    async fn files_require_initialization() {
        let mut d = make_dispatcher();

        let req = make_request("files.list", json!({"path": "/tmp"}), 1);
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["error"]["code"], errors::NOT_INITIALIZED);
    }

    #[tokio::test]
    async fn files_write_invalid_base64() {
        let mut d = make_dispatcher();
        init_dispatcher(&mut d).await;

        let req = make_request(
            "files.write",
            json!({"path": "/tmp/test.txt", "data": "!!!not-base64!!!"}),
            2,
        );
        let result = d.dispatch(req).await.to_json();
        assert_eq!(result["error"]["code"], errors::INVALID_PARAMS);
    }
}

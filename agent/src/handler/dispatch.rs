//! JSON-RPC method handler using jsonrpsee's [`RpcModule`].
//!
//! [`AgentHandler`] registers all protocol methods into a [`RpcModule`] and
//! exposes a single [`AgentHandler::call_raw`] entry point used by the
//! NDJSON transport loop. Shared mutable state lives in
//! `Arc<Mutex<HandlerState>>`; the shutdown signal is conveyed through
//! `Arc<AtomicBool>` so the transport can stop after `agent.shutdown`.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use base64::Engine;
use jsonrpsee::core::server::RpcModule;
use jsonrpsee::types::ErrorObjectOwned;
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tracing::{debug, warn};

use crate::files::local::LocalFileBackend;
use crate::files::{FileBackend, FileError};
use crate::monitoring::MonitoringManagerApi;
use crate::network;
use crate::protocol::errors;
use crate::protocol::methods::{
    AgentSettings, AgentSettingsUpdateParams, AgentShutdownParams, AgentShutdownResult,
    Capabilities, ConnectionCreateParams, ConnectionDeleteParams, ConnectionTypesResult,
    ConnectionUpdateParams, FilesDeleteParams, FilesListParams, FilesListResult, FilesMkdirParams,
    FilesReadParams, FilesReadResult, FilesRenameParams, FilesStatParams, FilesWriteParams,
    FolderCreateParams, FolderDeleteParams, FolderUpdateParams, HealthCheckResult,
    InitializeParams, InitializeResult, MonitoringSubscribeParams, MonitoringUnsubscribeParams,
    NetworkDnsLookupParams, NetworkPingParams, NetworkPortScanParams, NetworkTracerouteParams,
    NetworkWolParams, SessionAttachParams, SessionCloseParams, SessionCreateParams,
    SessionCreateResult, SessionDetachParams, SessionGetBufferParams, SessionGetBufferResult,
    SessionInputParams, SessionListEntry, SessionListResult, SessionResizeParams,
};
use crate::session::definitions::{Connection, ConnectionStoreApi, Folder};
use crate::session::manager::{SessionCreateError, SessionManagerApi, MAX_SESSIONS};

/// The agent's protocol version.
///
/// Bumped to 0.2.0 for the connection.* protocol migration (#360).
const AGENT_PROTOCOL_VERSION: &str = "0.2.0";

/// Maximum response body size for jsonrpsee method calls: 32 MiB.
///
/// Large enough to accommodate base64-encoded file reads while still
/// providing a safety bound against runaway allocations.
const MAX_RESPONSE_BODY_SIZE: usize = 32 * 1024 * 1024;

// ── Shared handler state ───────────────────────────────────────────

/// Shared mutable state for all registered RPC method handlers.
struct HandlerState {
    session_manager: Arc<dyn SessionManagerApi>,
    connection_store: Arc<dyn ConnectionStoreApi>,
    monitoring_manager: Arc<dyn MonitoringManagerApi>,
    initialized: bool,
    start_time: Instant,
    agent_settings: AgentSettings,
    /// Shared with [`AgentHandler::shutdown_flag`] so the transport loop can
    /// detect shutdown without re-locking the mutex after every request.
    shutdown_flag: Arc<AtomicBool>,
}

// ── AgentHandler ───────────────────────────────────────────────────

/// JSON-RPC handler backed by jsonrpsee's [`RpcModule`].
///
/// All methods from the termiHub agent protocol are registered during
/// construction. The transport loop calls [`call_raw`] for each incoming
/// NDJSON line; jsonrpsee handles routing, error formatting, and response
/// serialisation.
pub struct AgentHandler {
    module: RpcModule<Mutex<HandlerState>>,
    pub shutdown_flag: Arc<AtomicBool>,
}

impl AgentHandler {
    pub fn new(
        session_manager: Arc<dyn SessionManagerApi>,
        connection_store: Arc<dyn ConnectionStoreApi>,
        monitoring_manager: Arc<dyn MonitoringManagerApi>,
    ) -> anyhow::Result<Self> {
        let shutdown_flag = Arc::new(AtomicBool::new(false));

        let state = Mutex::new(HandlerState {
            session_manager,
            connection_store,
            monitoring_manager,
            initialized: false,
            start_time: Instant::now(),
            agent_settings: AgentSettings::default(),
            shutdown_flag: shutdown_flag.clone(),
        });

        let mut module: RpcModule<Mutex<HandlerState>> = RpcModule::new(state);

        register_all(&mut module)?;

        Ok(AgentHandler {
            module,
            shutdown_flag,
        })
    }

    /// Process a raw JSON-RPC request string and return the response string.
    ///
    /// Also returns a boolean indicating whether `agent.shutdown` was called
    /// and the transport loop should stop after sending the response.
    pub async fn call_raw(&self, request: &str) -> (String, bool) {
        debug!("Dispatching: {}", request);
        let result = self
            .module
            .raw_json_request(request, MAX_RESPONSE_BODY_SIZE)
            .await;

        let response = match result {
            Ok((resp, _)) => resp,
            Err(e) => {
                warn!("RpcModule error: {e}");
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "error": {"code": -32700_i32, "message": format!("Parse error: {e}")},
                    "id": null
                })
                .to_string()
            }
        };
        let is_shutdown = self.shutdown_flag.load(Ordering::Acquire);
        debug!("Response: {}", response);
        (response, is_shutdown)
    }

    /// Whether `agent.shutdown` has been invoked.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_shutdown(&self) -> bool {
        self.shutdown_flag.load(Ordering::Acquire)
    }
}

// ── Error helpers ──────────────────────────────────────────────────

fn rpc_err(code: i64, message: impl Into<String>) -> ErrorObjectOwned {
    ErrorObjectOwned::owned(code as i32, message.into(), None::<Value>)
}

fn rpc_err_data(code: i64, message: impl Into<String>, data: Value) -> ErrorObjectOwned {
    ErrorObjectOwned::owned(code as i32, message.into(), Some(data))
}

fn not_initialized() -> ErrorObjectOwned {
    rpc_err(
        errors::NOT_INITIALIZED,
        "Agent not initialized — call 'initialize' first",
    )
}

fn invalid_params(context: &str, e: impl std::fmt::Display) -> ErrorObjectOwned {
    rpc_err(
        errors::INVALID_PARAMS,
        format!("Invalid {context} params: {e}"),
    )
}

fn map_file_error(e: FileError) -> ErrorObjectOwned {
    match e {
        FileError::NotFound(msg) => rpc_err(errors::FILE_NOT_FOUND, msg),
        FileError::PermissionDenied(msg) => rpc_err(errors::PERMISSION_DENIED, msg),
        FileError::OperationFailed(msg) => rpc_err(errors::FILE_OPERATION_FAILED, msg),
        FileError::NotSupported => rpc_err(errors::FILE_BROWSING_NOT_SUPPORTED, e.to_string()),
        FileError::Io(e) => rpc_err(errors::FILE_OPERATION_FAILED, e.to_string()),
    }
}

/// Convert a megabyte count (from agent settings) to a byte count,
/// with a floor of 64 KiB to avoid a zero-length buffer.
fn mb_to_bytes(mb: u32) -> usize {
    (mb as usize).saturating_mul(1_048_576).max(65_536)
}

// ── State-extraction helpers ───────────────────────────────────────
//
// Each helper locks HandlerState, enforces the initialized gate, and
// clones only the resource(s) the caller needs.  The lock is always
// released before the caller does any async work.

async fn check_initialized(ctx: &tokio::sync::Mutex<HandlerState>) -> Result<(), ErrorObjectOwned> {
    let s = ctx.lock().await;
    if !s.initialized {
        return Err(not_initialized());
    }
    Ok(())
}

async fn get_session_manager(
    ctx: &tokio::sync::Mutex<HandlerState>,
) -> Result<Arc<dyn SessionManagerApi>, ErrorObjectOwned> {
    let s = ctx.lock().await;
    if !s.initialized {
        return Err(not_initialized());
    }
    Ok(s.session_manager.clone())
}

async fn get_connection_store(
    ctx: &tokio::sync::Mutex<HandlerState>,
) -> Result<Arc<dyn ConnectionStoreApi>, ErrorObjectOwned> {
    let s = ctx.lock().await;
    if !s.initialized {
        return Err(not_initialized());
    }
    Ok(s.connection_store.clone())
}

async fn get_file_managers(
    ctx: &tokio::sync::Mutex<HandlerState>,
) -> Result<(Arc<dyn SessionManagerApi>, Arc<dyn ConnectionStoreApi>), ErrorObjectOwned> {
    let s = ctx.lock().await;
    if !s.initialized {
        return Err(not_initialized());
    }
    Ok((s.session_manager.clone(), s.connection_store.clone()))
}

async fn get_monitoring_managers(
    ctx: &tokio::sync::Mutex<HandlerState>,
) -> Result<(Arc<dyn SessionManagerApi>, Arc<dyn MonitoringManagerApi>), ErrorObjectOwned> {
    let s = ctx.lock().await;
    if !s.initialized {
        return Err(not_initialized());
    }
    Ok((s.session_manager.clone(), s.monitoring_manager.clone()))
}

// ── Method registration ────────────────────────────────────────────

fn register_all(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    register_initialize(module)?;
    register_connection_create(module)?;
    register_connection_list(module)?;
    register_connection_close(module)?;
    register_connection_attach(module)?;
    register_connection_detach(module)?;
    register_connection_write(module)?;
    register_connection_resize(module)?;
    register_connection_types(module)?;
    register_session_get_buffer(module)?;
    register_connections_list(module)?;
    register_connections_create(module)?;
    register_connections_update(module)?;
    register_connections_delete(module)?;
    register_connections_folders_create(module)?;
    register_connections_folders_update(module)?;
    register_connections_folders_delete(module)?;
    register_files_list(module)?;
    register_files_read(module)?;
    register_files_write(module)?;
    register_files_delete(module)?;
    register_files_rename(module)?;
    register_files_stat(module)?;
    register_files_mkdir(module)?;
    register_monitoring_subscribe(module)?;
    register_monitoring_unsubscribe(module)?;
    register_network_port_scan(module)?;
    register_network_ping(module)?;
    register_network_dns_lookup(module)?;
    register_network_open_ports(module)?;
    register_network_traceroute(module)?;
    register_network_wol(module)?;
    register_health_check(module)?;
    register_agent_shutdown(module)?;
    register_agent_settings_update(module)?;
    Ok(())
}

// ── initialize ────────────────────────────────────────────────────

fn register_initialize(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("initialize", |params, ctx, _ext| async move {
        let p: InitializeParams = params
            .parse()
            .map_err(|e| invalid_params("initialize", e))?;

        let major = p
            .protocol_version
            .split('.')
            .next()
            .and_then(|s| s.parse::<u32>().ok());

        if major != Some(0) {
            return Err(rpc_err(
                errors::VERSION_NOT_SUPPORTED,
                format!(
                    "Unsupported protocol version: {} (agent supports 0.x)",
                    p.protocol_version
                ),
            ));
        }

        let (session_manager, connection_store, buffer_size) = {
            let mut s = ctx.lock().await;
            s.initialized = true;
            s.agent_settings = p.agent_settings.clone();
            let buffer_size = mb_to_bytes(p.agent_settings.persistent_scrollback_buffer_size_mb);
            (
                s.session_manager.clone(),
                s.connection_store.clone(),
                buffer_size,
            )
        };

        session_manager
            .set_persistent_buffer_size_bytes(buffer_size)
            .await;

        if !p.external_connection_files.is_empty() {
            connection_store
                .load_external_files(&p.external_connection_files)
                .await;
        }

        let docker_available = detect_docker_available();
        let connection_types = session_manager.registry().available_types();

        Ok::<_, ErrorObjectOwned>(
            serde_json::to_value(InitializeResult {
                protocol_version: AGENT_PROTOCOL_VERSION.to_string(),
                agent_version: env!("CARGO_PKG_VERSION").to_string(),
                capabilities: Capabilities {
                    connection_types,
                    max_sessions: MAX_SESSIONS,
                    available_shells: detect_available_shells(),
                    available_serial_ports: termihub_core::session::serial::list_serial_ports(),
                    docker_available,
                    available_docker_images: detect_docker_images(),
                    monitoring_supported: detect_monitoring_supported(),
                },
            })
            .unwrap(),
        )
    })?;
    Ok(())
}

// ── connection.* ──────────────────────────────────────────────────

fn register_connection_create(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.create", |params, ctx, _ext| async move {
        let session_manager = get_session_manager(&ctx).await?;

        let p: SessionCreateParams = params
            .parse()
            .map_err(|e| invalid_params("connection.create", e))?;

        let type_id = normalize_type_id(&p.session_type);

        if !session_manager.registry().has_type(type_id) {
            return Err(rpc_err(
                errors::INVALID_CONFIGURATION,
                format!("Unsupported connection type: {type_id}"),
            ));
        }

        let title = p.title.unwrap_or_else(|| format!("{type_id} session"));

        let snapshot = session_manager
            .create(type_id, title, p.config)
            .await
            .map_err(|e| match e {
                SessionCreateError::LimitReached => rpc_err(
                    errors::SESSION_LIMIT_REACHED,
                    format!("Session limit reached (max {MAX_SESSIONS})"),
                ),
                SessionCreateError::InvalidConfig(msg) => {
                    rpc_err(errors::INVALID_CONFIGURATION, msg)
                }
                SessionCreateError::BackendFailed(msg) => {
                    rpc_err(errors::SESSION_CREATION_FAILED, msg)
                }
            })?;

        Ok::<_, ErrorObjectOwned>(
            serde_json::to_value(SessionCreateResult {
                session_id: snapshot.id,
                title: snapshot.title,
                session_type: snapshot.type_id,
                status: snapshot.status.as_str().to_string(),
                created_at: snapshot.created_at.to_rfc3339(),
            })
            .unwrap(),
        )
    })?;
    Ok(())
}

fn register_connection_list(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.list", |_params, ctx, _ext| async move {
        let session_manager = get_session_manager(&ctx).await?;

        let sessions = session_manager.list().await;
        let entries: Vec<SessionListEntry> = sessions
            .into_iter()
            .map(|s| SessionListEntry {
                session_id: s.id,
                title: s.title,
                session_type: s.type_id,
                status: s.status.as_str().to_string(),
                created_at: s.created_at.to_rfc3339(),
                last_activity: s.last_activity.to_rfc3339(),
                attached: s.attached,
            })
            .collect();

        Ok::<_, ErrorObjectOwned>(
            serde_json::to_value(SessionListResult { sessions: entries }).unwrap(),
        )
    })?;
    Ok(())
}

fn register_connection_close(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.close", |params, ctx, _ext| async move {
        let session_manager = get_session_manager(&ctx).await?;

        let p: SessionCloseParams = params
            .parse()
            .map_err(|e| invalid_params("connection.close", e))?;

        if session_manager.close(&p.session_id).await {
            Ok::<_, ErrorObjectOwned>(json!({}))
        } else {
            Err(rpc_err_data(
                errors::SESSION_NOT_FOUND,
                "Session not found",
                json!({"session_id": p.session_id}),
            ))
        }
    })?;
    Ok(())
}

fn register_connection_attach(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.attach", |params, ctx, _ext| async move {
        let session_manager = get_session_manager(&ctx).await?;

        let p: SessionAttachParams = params
            .parse()
            .map_err(|e| invalid_params("connection.attach", e))?;

        session_manager.attach(&p.session_id).await.map_err(|msg| {
            rpc_err_data(
                errors::SESSION_NOT_FOUND,
                msg,
                json!({"session_id": p.session_id}),
            )
        })?;

        Ok::<_, ErrorObjectOwned>(json!({}))
    })?;
    Ok(())
}

fn register_connection_detach(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.detach", |params, ctx, _ext| async move {
        let session_manager = get_session_manager(&ctx).await?;

        let p: SessionDetachParams = params
            .parse()
            .map_err(|e| invalid_params("connection.detach", e))?;

        session_manager.detach(&p.session_id).await.map_err(|msg| {
            rpc_err_data(
                errors::SESSION_NOT_FOUND,
                msg,
                json!({"session_id": p.session_id}),
            )
        })?;

        Ok::<_, ErrorObjectOwned>(json!({}))
    })?;
    Ok(())
}

fn register_connection_write(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.write", |params, ctx, _ext| async move {
        let session_manager = get_session_manager(&ctx).await?;

        let p: SessionInputParams = params
            .parse()
            .map_err(|e| invalid_params("connection.write", e))?;

        let b64 = base64::engine::general_purpose::STANDARD;
        let data = b64
            .decode(&p.data)
            .map_err(|e| rpc_err(errors::INVALID_PARAMS, format!("Invalid base64 data: {e}")))?;

        session_manager
            .write_input(&p.session_id, &data)
            .await
            .map_err(|msg| {
                rpc_err_data(
                    errors::SESSION_NOT_FOUND,
                    msg,
                    json!({"session_id": p.session_id}),
                )
            })?;

        Ok::<_, ErrorObjectOwned>(json!({}))
    })?;
    Ok(())
}

fn register_connection_resize(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.resize", |params, ctx, _ext| async move {
        let session_manager = get_session_manager(&ctx).await?;

        let p: SessionResizeParams = params
            .parse()
            .map_err(|e| invalid_params("connection.resize", e))?;

        session_manager
            .resize(&p.session_id, p.cols, p.rows)
            .await
            .map_err(|msg| {
                rpc_err_data(
                    errors::SESSION_NOT_FOUND,
                    msg,
                    json!({"session_id": p.session_id}),
                )
            })?;

        Ok::<_, ErrorObjectOwned>(json!({}))
    })?;
    Ok(())
}

fn register_connection_types(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.types", |_params, ctx, _ext| async move {
        let session_manager = get_session_manager(&ctx).await?;

        let monitoring_ok = detect_monitoring_supported();
        let types = session_manager
            .registry()
            .available_types()
            .into_iter()
            .map(|mut info| {
                if info.type_id == "local" {
                    info.capabilities.monitoring = monitoring_ok;
                }
                info
            })
            .collect();

        Ok::<_, ErrorObjectOwned>(serde_json::to_value(ConnectionTypesResult { types }).unwrap())
    })?;
    Ok(())
}

fn register_session_get_buffer(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("session.getBuffer", |params, ctx, _ext| async move {
        let session_manager = get_session_manager(&ctx).await?;

        let p: SessionGetBufferParams = params
            .parse()
            .map_err(|e| invalid_params("session.getBuffer", e))?;

        let data = session_manager
            .get_buffer(&p.session_id)
            .await
            .map_err(|e| rpc_err(errors::SESSION_NOT_FOUND, e))?;

        let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
        Ok::<_, ErrorObjectOwned>(
            serde_json::to_value(SessionGetBufferResult {
                session_id: p.session_id,
                data: encoded,
            })
            .unwrap(),
        )
    })?;
    Ok(())
}

// ── connections.* ─────────────────────────────────────────────────

fn register_connections_list(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connections.list", |_params, ctx, _ext| async move {
        let connection_store = get_connection_store(&ctx).await?;

        let (connections, folders) = connection_store.list().await;
        Ok::<_, ErrorObjectOwned>(json!({"connections": connections, "folders": folders}))
    })?;
    Ok(())
}

fn register_connections_create(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connections.create", |params, ctx, _ext| async move {
        let connection_store = get_connection_store(&ctx).await?;

        let p: ConnectionCreateParams = params
            .parse()
            .map_err(|e| invalid_params("connections.create", e))?;

        let conn = Connection {
            id: format!("conn-{}", uuid::Uuid::new_v4()),
            name: p.name,
            session_type: p.session_type,
            config: p.config,
            persistent: p.persistent,
            folder_id: p.folder_id,
            terminal_options: p.terminal_options,
            icon: p.icon,
        };

        let snapshot = connection_store.create(conn).await;
        Ok::<_, ErrorObjectOwned>(serde_json::to_value(snapshot).unwrap())
    })?;
    Ok(())
}

fn register_connections_update(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connections.update", |params, ctx, _ext| async move {
        let connection_store = get_connection_store(&ctx).await?;

        let p: ConnectionUpdateParams = params
            .parse()
            .map_err(|e| invalid_params("connections.update", e))?;

        let folder_id = p.folder_id.map(|v| {
            if v.is_null() {
                None
            } else {
                v.as_str().map(|s| s.to_string())
            }
        });
        let terminal_options = p
            .terminal_options
            .map(|v| if v.is_null() { None } else { Some(v) });
        let icon = p.icon.map(|v| {
            if v.is_null() {
                None
            } else {
                v.as_str().map(|s| s.to_string())
            }
        });

        match connection_store
            .update(
                &p.id,
                p.name,
                p.session_type,
                p.config,
                p.persistent,
                folder_id,
                terminal_options,
                icon,
            )
            .await
        {
            Some(snapshot) => Ok::<_, ErrorObjectOwned>(serde_json::to_value(snapshot).unwrap()),
            None => Err(rpc_err_data(
                errors::CONNECTION_NOT_FOUND,
                "Connection not found",
                json!({"id": p.id}),
            )),
        }
    })?;
    Ok(())
}

fn register_connections_delete(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connections.delete", |params, ctx, _ext| async move {
        let connection_store = get_connection_store(&ctx).await?;

        let p: ConnectionDeleteParams = params
            .parse()
            .map_err(|e| invalid_params("connections.delete", e))?;

        if connection_store.delete(&p.id).await {
            Ok::<_, ErrorObjectOwned>(json!({}))
        } else {
            Err(rpc_err_data(
                errors::CONNECTION_NOT_FOUND,
                "Connection not found",
                json!({"id": p.id}),
            ))
        }
    })?;
    Ok(())
}

fn register_connections_folders_create(
    module: &mut RpcModule<Mutex<HandlerState>>,
) -> anyhow::Result<()> {
    module.register_async_method(
        "connections.folders.create",
        |params, ctx, _ext| async move {
            let connection_store = get_connection_store(&ctx).await?;

            let p: FolderCreateParams = params
                .parse()
                .map_err(|e| invalid_params("connections.folders.create", e))?;

            let folder = Folder {
                id: format!("folder-{}", uuid::Uuid::new_v4()),
                name: p.name,
                parent_id: p.parent_id,
                is_expanded: false,
            };

            let snapshot = connection_store.create_folder(folder).await;
            Ok::<_, ErrorObjectOwned>(serde_json::to_value(snapshot).unwrap())
        },
    )?;
    Ok(())
}

fn register_connections_folders_update(
    module: &mut RpcModule<Mutex<HandlerState>>,
) -> anyhow::Result<()> {
    module.register_async_method(
        "connections.folders.update",
        |params, ctx, _ext| async move {
            let connection_store = get_connection_store(&ctx).await?;

            let p: FolderUpdateParams = params
                .parse()
                .map_err(|e| invalid_params("connections.folders.update", e))?;

            let parent_id = p.parent_id.map(|v| {
                if v.is_null() {
                    None
                } else {
                    v.as_str().map(|s| s.to_string())
                }
            });

            match connection_store
                .update_folder(&p.id, p.name, parent_id, p.is_expanded)
                .await
            {
                Some(snapshot) => {
                    Ok::<_, ErrorObjectOwned>(serde_json::to_value(snapshot).unwrap())
                }
                None => Err(rpc_err_data(
                    errors::FOLDER_NOT_FOUND,
                    "Folder not found",
                    json!({"id": p.id}),
                )),
            }
        },
    )?;
    Ok(())
}

fn register_connections_folders_delete(
    module: &mut RpcModule<Mutex<HandlerState>>,
) -> anyhow::Result<()> {
    module.register_async_method(
        "connections.folders.delete",
        |params, ctx, _ext| async move {
            let connection_store = get_connection_store(&ctx).await?;

            let p: FolderDeleteParams = params
                .parse()
                .map_err(|e| invalid_params("connections.folders.delete", e))?;

            if connection_store.delete_folder(&p.id).await {
                Ok::<_, ErrorObjectOwned>(json!({}))
            } else {
                Err(rpc_err_data(
                    errors::FOLDER_NOT_FOUND,
                    "Folder not found",
                    json!({"id": p.id}),
                ))
            }
        },
    )?;
    Ok(())
}

// ── connection.files.* ────────────────────────────────────────────

async fn resolve_file_backend(
    session_manager: &Arc<dyn SessionManagerApi>,
    connection_store: &Arc<dyn ConnectionStoreApi>,
    connection_id: Option<String>,
) -> Result<Box<dyn FileBackend>, ErrorObjectOwned> {
    let id = match connection_id {
        None => return Ok(Box::new(LocalFileBackend::new())),
        Some(id) => id,
    };

    if let Some(type_id) = session_manager.get_session_type_id(&id).await {
        return match normalize_type_id(&type_id) {
            "local" => Ok(Box::new(LocalFileBackend::new())),
            other => Err(rpc_err(
                errors::FILE_BROWSING_NOT_SUPPORTED,
                format!("File browsing is not yet supported for '{other}' sessions"),
            )),
        };
    }

    let connection = connection_store.get(&id).await.ok_or_else(|| {
        rpc_err(
            errors::CONNECTION_NOT_FOUND,
            format!("Connection not found: {id}"),
        )
    })?;

    match connection.session_type.as_str() {
        "local" | "shell" => Ok(Box::new(LocalFileBackend::new())),
        other => Err(rpc_err(
            errors::FILE_BROWSING_NOT_SUPPORTED,
            format!("File browsing is not yet supported for '{other}' connections"),
        )),
    }
}

fn register_files_list(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.files.list", |params, ctx, _ext| async move {
        let (session_manager, connection_store) = get_file_managers(&ctx).await?;

        let p: FilesListParams = params
            .parse()
            .map_err(|e| invalid_params("connection.files.list", e))?;

        let backend =
            resolve_file_backend(&session_manager, &connection_store, p.connection_id).await?;

        backend
            .list(&p.path)
            .await
            .map(|entries| serde_json::to_value(FilesListResult { entries }).unwrap())
            .map_err(map_file_error)
    })?;
    Ok(())
}

fn register_files_read(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.files.read", |params, ctx, _ext| async move {
        let (session_manager, connection_store) = get_file_managers(&ctx).await?;

        let p: FilesReadParams = params
            .parse()
            .map_err(|e| invalid_params("connection.files.read", e))?;

        let backend =
            resolve_file_backend(&session_manager, &connection_store, p.connection_id).await?;

        let data = backend.read(&p.path).await.map_err(map_file_error)?;
        let b64 = base64::engine::general_purpose::STANDARD;
        let size = data.len() as u64;
        Ok::<_, ErrorObjectOwned>(
            serde_json::to_value(FilesReadResult {
                data: b64.encode(&data),
                size,
            })
            .unwrap(),
        )
    })?;
    Ok(())
}

fn register_files_write(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.files.write", |params, ctx, _ext| async move {
        let (session_manager, connection_store) = get_file_managers(&ctx).await?;

        let p: FilesWriteParams = params
            .parse()
            .map_err(|e| invalid_params("connection.files.write", e))?;

        let b64 = base64::engine::general_purpose::STANDARD;
        let data = b64
            .decode(&p.data)
            .map_err(|e| rpc_err(errors::INVALID_PARAMS, format!("Invalid base64 data: {e}")))?;

        let backend =
            resolve_file_backend(&session_manager, &connection_store, p.connection_id).await?;

        backend
            .write(&p.path, &data)
            .await
            .map_err(map_file_error)?;
        Ok::<_, ErrorObjectOwned>(json!({}))
    })?;
    Ok(())
}

fn register_files_delete(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.files.delete", |params, ctx, _ext| async move {
        let (session_manager, connection_store) = get_file_managers(&ctx).await?;

        let p: FilesDeleteParams = params
            .parse()
            .map_err(|e| invalid_params("connection.files.delete", e))?;

        let backend =
            resolve_file_backend(&session_manager, &connection_store, p.connection_id).await?;

        backend
            .delete(&p.path, p.is_directory)
            .await
            .map_err(map_file_error)?;
        Ok::<_, ErrorObjectOwned>(json!({}))
    })?;
    Ok(())
}

fn register_files_rename(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.files.rename", |params, ctx, _ext| async move {
        let (session_manager, connection_store) = get_file_managers(&ctx).await?;

        let p: FilesRenameParams = params
            .parse()
            .map_err(|e| invalid_params("connection.files.rename", e))?;

        let backend =
            resolve_file_backend(&session_manager, &connection_store, p.connection_id).await?;

        backend
            .rename(&p.old_path, &p.new_path)
            .await
            .map_err(map_file_error)?;
        Ok::<_, ErrorObjectOwned>(json!({}))
    })?;
    Ok(())
}

fn register_files_stat(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.files.stat", |params, ctx, _ext| async move {
        let (session_manager, connection_store) = get_file_managers(&ctx).await?;

        let p: FilesStatParams = params
            .parse()
            .map_err(|e| invalid_params("connection.files.stat", e))?;

        let backend =
            resolve_file_backend(&session_manager, &connection_store, p.connection_id).await?;

        let result = backend.stat(&p.path).await.map_err(map_file_error)?;
        Ok::<_, ErrorObjectOwned>(serde_json::to_value(result).unwrap())
    })?;
    Ok(())
}

fn register_files_mkdir(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("connection.files.mkdir", |params, ctx, _ext| async move {
        let (session_manager, connection_store) = get_file_managers(&ctx).await?;

        let p: FilesMkdirParams = params
            .parse()
            .map_err(|e| invalid_params("connection.files.mkdir", e))?;

        let backend =
            resolve_file_backend(&session_manager, &connection_store, p.connection_id).await?;

        backend.mkdir(&p.path).await.map_err(map_file_error)?;
        Ok::<_, ErrorObjectOwned>(json!({}))
    })?;
    Ok(())
}

// ── connection.monitoring.* ───────────────────────────────────────

async fn resolve_monitoring_host(
    session_manager: &Arc<dyn SessionManagerApi>,
    host: &str,
) -> String {
    if let Some(type_id) = session_manager.get_session_type_id(host).await {
        if type_id == "local" {
            return "self".to_string();
        }
    }
    host.to_string()
}

fn register_monitoring_subscribe(
    module: &mut RpcModule<Mutex<HandlerState>>,
) -> anyhow::Result<()> {
    module.register_async_method(
        "connection.monitoring.subscribe",
        |params, ctx, _ext| async move {
            let (session_manager, monitoring_manager) = get_monitoring_managers(&ctx).await?;

            let p: MonitoringSubscribeParams = params
                .parse()
                .map_err(|e| invalid_params("monitoring.subscribe", e))?;

            let host = resolve_monitoring_host(&session_manager, &p.host).await;

            monitoring_manager
                .subscribe(&host, p.interval_ms)
                .await
                .map_err(|e| {
                    rpc_err(
                        errors::MONITORING_ERROR,
                        format!("Failed to subscribe: {e}"),
                    )
                })?;

            Ok::<_, ErrorObjectOwned>(json!({}))
        },
    )?;
    Ok(())
}

fn register_monitoring_unsubscribe(
    module: &mut RpcModule<Mutex<HandlerState>>,
) -> anyhow::Result<()> {
    module.register_async_method(
        "connection.monitoring.unsubscribe",
        |params, ctx, _ext| async move {
            let (session_manager, monitoring_manager) = get_monitoring_managers(&ctx).await?;

            let p: MonitoringUnsubscribeParams = params
                .parse()
                .map_err(|e| invalid_params("monitoring.unsubscribe", e))?;

            let host = resolve_monitoring_host(&session_manager, &p.host).await;
            monitoring_manager.unsubscribe(&host).await;

            Ok::<_, ErrorObjectOwned>(json!({}))
        },
    )?;
    Ok(())
}

// ── network.* ─────────────────────────────────────────────────────

fn register_network_port_scan(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("network.port_scan", |params, ctx, _ext| async move {
        check_initialized(&ctx).await?;

        let p: NetworkPortScanParams = params
            .parse()
            .map_err(|e| invalid_params("network.port_scan", e))?;

        network::handle_port_scan(p)
            .await
            .map(|r| serde_json::to_value(r).unwrap())
            .map_err(|e| rpc_err(errors::INTERNAL_ERROR, e.to_string()))
    })?;
    Ok(())
}

fn register_network_ping(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("network.ping", |params, ctx, _ext| async move {
        check_initialized(&ctx).await?;

        let p: NetworkPingParams = params
            .parse()
            .map_err(|e| invalid_params("network.ping", e))?;

        network::handle_ping(p)
            .await
            .map(|r| serde_json::to_value(r).unwrap())
            .map_err(|e| rpc_err(errors::INTERNAL_ERROR, e.to_string()))
    })?;
    Ok(())
}

fn register_network_dns_lookup(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("network.dns_lookup", |params, ctx, _ext| async move {
        check_initialized(&ctx).await?;

        let p: NetworkDnsLookupParams = params
            .parse()
            .map_err(|e| invalid_params("network.dns_lookup", e))?;

        network::handle_dns_lookup(p)
            .await
            .map(|r| serde_json::to_value(r).unwrap())
            .map_err(|e| rpc_err(errors::INTERNAL_ERROR, e.to_string()))
    })?;
    Ok(())
}

fn register_network_open_ports(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("network.open_ports", |_params, ctx, _ext| async move {
        check_initialized(&ctx).await?;

        network::handle_open_ports()
            .map(|r| serde_json::to_value(r).unwrap())
            .map_err(|e| rpc_err(errors::INTERNAL_ERROR, e.to_string()))
    })?;
    Ok(())
}

fn register_network_traceroute(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("network.traceroute", |params, ctx, _ext| async move {
        check_initialized(&ctx).await?;

        let p: NetworkTracerouteParams = params
            .parse()
            .map_err(|e| invalid_params("network.traceroute", e))?;

        network::handle_traceroute(p)
            .await
            .map(|r| serde_json::to_value(r).unwrap())
            .map_err(|e| rpc_err(errors::INTERNAL_ERROR, e.to_string()))
    })?;
    Ok(())
}

fn register_network_wol(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("network.wol", |params, ctx, _ext| async move {
        check_initialized(&ctx).await?;

        let p: NetworkWolParams = params
            .parse()
            .map_err(|e| invalid_params("network.wol", e))?;

        network::handle_wol(p)
            .map(|()| json!({}))
            .map_err(|e| rpc_err(errors::INTERNAL_ERROR, e.to_string()))
    })?;
    Ok(())
}

// ── health.check / agent.* ────────────────────────────────────────

fn register_health_check(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("health.check", |_params, ctx, _ext| async move {
        let (session_manager, uptime) = {
            let s = ctx.lock().await;
            if !s.initialized {
                return Err(not_initialized());
            }
            (s.session_manager.clone(), s.start_time.elapsed().as_secs())
        };

        let active = session_manager.active_count().await;
        Ok::<_, ErrorObjectOwned>(
            serde_json::to_value(HealthCheckResult {
                status: "ok".to_string(),
                uptime_secs: uptime,
                active_sessions: active,
            })
            .unwrap(),
        )
    })?;
    Ok(())
}

fn register_agent_shutdown(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method("agent.shutdown", |params, ctx, _ext| async move {
        let (session_manager, monitoring_manager, shutdown_flag) = {
            let s = ctx.lock().await;
            if !s.initialized {
                return Err(not_initialized());
            }
            (
                s.session_manager.clone(),
                s.monitoring_manager.clone(),
                s.shutdown_flag.clone(),
            )
        };

        let _p: AgentShutdownParams = params
            .parse()
            .map_err(|e| invalid_params("agent.shutdown", e))?;

        let detached = session_manager.active_count().await;
        monitoring_manager.shutdown().await;
        shutdown_flag.store(true, Ordering::Release);

        Ok::<_, ErrorObjectOwned>(
            serde_json::to_value(AgentShutdownResult {
                detached_sessions: detached,
            })
            .unwrap(),
        )
    })?;
    Ok(())
}

fn register_agent_settings_update(
    module: &mut RpcModule<Mutex<HandlerState>>,
) -> anyhow::Result<()> {
    module.register_async_method("agent.settingsUpdate", |params, ctx, _ext| async move {
        // Init check before params parse (protocol: NOT_INITIALIZED takes priority).
        // A second lock below applies the settings — initialized is monotone so
        // there is no TOCTOU hazard.
        check_initialized(&ctx).await?;

        let p: AgentSettingsUpdateParams = params
            .parse()
            .map_err(|e| invalid_params("agent.settingsUpdate", e))?;

        let session_manager = {
            let mut s = ctx.lock().await;
            s.agent_settings = p.settings.clone();
            s.session_manager.clone()
        };

        session_manager
            .set_persistent_buffer_size_bytes(mb_to_bytes(
                p.settings.persistent_scrollback_buffer_size_mb,
            ))
            .await;

        Ok::<_, ErrorObjectOwned>(json!({"applied": true}))
    })?;
    Ok(())
}

// ── Capability detection ───────────────────────────────────────────

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
    "/usr/local/bin/nu",
    "/usr/bin/nu",
    "/snap/bin/nu",
    "/usr/local/bin/pwsh",
    "/usr/bin/pwsh",
    "/snap/bin/pwsh",
];

fn detect_monitoring_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new("/proc/stat").exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

fn detect_available_shells() -> Vec<String> {
    SHELL_CANDIDATES
        .iter()
        .filter(|p| Path::new(p).exists())
        .map(|p| p.to_string())
        .collect()
}

fn detect_docker_available() -> bool {
    std::process::Command::new("docker")
        .args(["info"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

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

/// Normalize user-facing session type names to registry type IDs.
fn normalize_type_id(raw: &str) -> &str {
    match raw {
        "shell" => "local",
        other => other,
    }
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::manager::SessionManager;
    use serde_json::json;

    // ── Test helpers ───────────────────────────────────────────────

    fn make_handler() -> AgentHandler {
        let (handler, _) = make_handler_with_manager();
        handler
    }

    fn make_handler_with_manager() -> (AgentHandler, Arc<SessionManager>) {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp = std::env::temp_dir().join(format!("termihub-test-{}.json", uuid::Uuid::new_v4()));
        let conn_store = Arc::new(crate::session::definitions::ConnectionStore::new_temp(tmp));
        let registry = Arc::new(crate::registry::build_registry());
        let session_manager = Arc::new(SessionManager::new(tx.clone(), registry));
        let monitoring_manager = Arc::new(crate::monitoring::MonitoringManager::new(
            tx,
            conn_store.clone(),
        ));
        let handler = AgentHandler::new(
            session_manager.clone() as Arc<dyn SessionManagerApi>,
            conn_store as Arc<dyn ConnectionStoreApi>,
            monitoring_manager as Arc<dyn MonitoringManagerApi>,
        )
        .unwrap();
        (handler, session_manager)
    }

    async fn dispatch(handler: &AgentHandler, method: &str, params: Value, id: u64) -> Value {
        let req = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": id
        }))
        .unwrap();
        let (response, _) = handler.call_raw(&req).await;
        serde_json::from_str(&response).unwrap()
    }

    fn init_params() -> Value {
        json!({
            "protocolVersion": "0.1.0",
            "client": "test",
            "clientVersion": "0.1.0"
        })
    }

    async fn init_handler(handler: &AgentHandler) {
        let result = dispatch(handler, "initialize", init_params(), 1).await;
        assert!(result.get("result").is_some(), "init failed: {result}");
    }

    // ── Initialize tests ───────────────────────────────────────────

    #[tokio::test]
    async fn initialize_succeeds() {
        let handler = make_handler();
        let result = dispatch(&handler, "initialize", init_params(), 1).await;

        assert_eq!(result["result"]["protocol_version"], AGENT_PROTOCOL_VERSION);
        assert_eq!(result["result"]["capabilities"]["maxSessions"], 20);
        let conn_types = result["result"]["capabilities"]["connectionTypes"]
            .as_array()
            .expect("connectionTypes should be an array");
        let type_ids: Vec<&str> = conn_types
            .iter()
            .map(|t| t["typeId"].as_str().unwrap())
            .collect();
        assert!(
            type_ids.contains(&"local"),
            "Expected 'local' in {type_ids:?}"
        );
        assert!(type_ids.contains(&"ssh"), "Expected 'ssh' in {type_ids:?}");
        assert!(result["result"]["capabilities"]["availableShells"]
            .as_array()
            .is_some());
        assert!(result["result"]["capabilities"]["availableSerialPorts"]
            .as_array()
            .is_some());
    }

    #[tokio::test]
    async fn initialize_rejects_incompatible_version() {
        let handler = make_handler();
        let result = dispatch(
            &handler,
            "initialize",
            json!({"protocolVersion": "1.0.0", "client": "test", "clientVersion": "1.0.0"}),
            1,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::VERSION_NOT_SUPPORTED);
    }

    #[tokio::test]
    async fn initialize_rejects_invalid_params() {
        let handler = make_handler();
        let result = dispatch(&handler, "initialize", json!({}), 1).await;
        assert_eq!(result["error"]["code"], errors::INVALID_PARAMS);
    }

    // ── Not-initialized gate ───────────────────────────────────────

    #[tokio::test]
    async fn methods_require_initialization() {
        let handler = make_handler();

        for method in &[
            "connection.create",
            "connection.list",
            "connection.close",
            "health.check",
            "connections.list",
            "connections.create",
        ] {
            let result = dispatch(&handler, method, json!({}), 1).await;
            assert_eq!(
                result["error"]["code"],
                errors::NOT_INITIALIZED,
                "{method} should require initialization"
            );
        }
    }

    // ── Session create tests ───────────────────────────────────────

    #[tokio::test]
    async fn session_create_unknown_type() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connection.create",
            json!({"type": "unknown", "config": {}}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::INVALID_CONFIGURATION);
    }

    #[test]
    fn normalize_type_id_maps_shell_to_local() {
        assert_eq!(normalize_type_id("shell"), "local");
    }

    #[test]
    fn normalize_type_id_passes_through_known_types() {
        assert_eq!(normalize_type_id("local"), "local");
        assert_eq!(normalize_type_id("serial"), "serial");
        assert_eq!(normalize_type_id("ssh"), "ssh");
        assert_eq!(normalize_type_id("docker"), "docker");
        assert_eq!(normalize_type_id("telnet"), "telnet");
    }

    #[test]
    fn normalize_type_id_passes_through_unknown() {
        assert_eq!(normalize_type_id("unknown"), "unknown");
    }

    // ── Session list tests ─────────────────────────────────────────

    #[tokio::test]
    async fn session_list_empty() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(&handler, "connection.list", json!({}), 2).await;
        assert_eq!(result["result"]["sessions"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn session_list_after_create() {
        let (handler, mgr) = make_handler_with_manager();
        init_handler(&handler).await;

        mgr.create_stub_session("local", "test".to_string(), json!({}))
            .await
            .unwrap();

        let result = dispatch(&handler, "connection.list", json!({}), 3).await;
        let sessions = result["result"]["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["title"], "test");
    }

    // ── Session close tests ────────────────────────────────────────

    #[tokio::test]
    async fn session_close_success() {
        let (handler, mgr) = make_handler_with_manager();
        init_handler(&handler).await;

        let snapshot = mgr
            .create_stub_session("local", "temp".to_string(), json!({}))
            .await
            .unwrap();
        let sid = snapshot.id;

        let result = dispatch(&handler, "connection.close", json!({"session_id": sid}), 3).await;
        assert!(result.get("result").is_some());

        let result = dispatch(&handler, "connection.list", json!({}), 4).await;
        assert_eq!(result["result"]["sessions"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn session_close_not_found() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connection.close",
            json!({"session_id": "nonexistent"}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::SESSION_NOT_FOUND);
        assert_eq!(result["error"]["data"]["session_id"], "nonexistent");
    }

    // ── Health check tests ─────────────────────────────────────────

    #[tokio::test]
    async fn health_check() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(&handler, "health.check", json!({}), 2).await;
        assert_eq!(result["result"]["status"], "ok");
        assert!(result["result"]["uptime_secs"].as_u64().is_some());
        assert_eq!(result["result"]["active_sessions"], 0);
    }

    #[tokio::test]
    async fn health_check_requires_initialization() {
        let handler = make_handler();
        let result = dispatch(&handler, "health.check", json!({}), 1).await;
        assert_eq!(result["error"]["code"], errors::NOT_INITIALIZED);
    }

    // ── Session attach/detach tests ────────────────────────────────

    #[tokio::test]
    async fn session_attach_not_found() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connection.attach",
            json!({"session_id": "nonexistent"}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::SESSION_NOT_FOUND);
    }

    #[tokio::test]
    async fn session_detach_not_found() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connection.detach",
            json!({"session_id": "nonexistent"}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::SESSION_NOT_FOUND);
    }

    #[tokio::test]
    async fn session_input_not_found() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connection.write",
            json!({"session_id": "nonexistent", "data": "aGVsbG8="}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::SESSION_NOT_FOUND);
    }

    #[tokio::test]
    async fn session_input_invalid_base64() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connection.write",
            json!({"session_id": "any", "data": "!!!not-base64!!!"}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn session_resize_returns_success() {
        let (handler, mgr) = make_handler_with_manager();
        init_handler(&handler).await;

        let snapshot = mgr
            .create_stub_session("local", "resize-test".to_string(), json!({}))
            .await
            .unwrap();
        let sid = snapshot.id;

        let result = dispatch(
            &handler,
            "connection.resize",
            json!({"session_id": sid, "cols": 120, "rows": 40}),
            3,
        )
        .await;
        assert!(result.get("result").is_some());
    }

    #[tokio::test]
    async fn session_resize_not_found() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connection.resize",
            json!({"session_id": "nonexistent", "cols": 120, "rows": 40}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::SESSION_NOT_FOUND);
    }

    // ── Full protocol flow integration test ────────────────────────

    #[tokio::test]
    async fn full_protocol_flow() {
        let (handler, mgr) = make_handler_with_manager();

        // 1. Initialize
        let result = dispatch(&handler, "initialize", init_params(), 1).await;
        assert_eq!(result["result"]["protocol_version"], AGENT_PROTOCOL_VERSION);

        // 2. Create a stub session
        let snapshot = mgr
            .create_stub_session("local", "Build".to_string(), json!({}))
            .await
            .unwrap();
        let session_id = snapshot.id;

        // 3. Attach
        let result = dispatch(
            &handler,
            "connection.attach",
            json!({"session_id": session_id}),
            3,
        )
        .await;
        assert!(result.get("result").is_some());

        // 4. Send input
        let result = dispatch(
            &handler,
            "connection.write",
            json!({"session_id": session_id, "data": "aGVsbG8="}),
            4,
        )
        .await;
        assert!(result.get("result").is_some());

        // 5. Resize
        let result = dispatch(
            &handler,
            "connection.resize",
            json!({"session_id": session_id, "cols": 120, "rows": 40}),
            5,
        )
        .await;
        assert!(result.get("result").is_some());

        // 6. List shows attached
        let result = dispatch(&handler, "connection.list", json!({}), 6).await;
        let sessions = result["result"]["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 1);
        assert!(sessions[0]["attached"].as_bool().unwrap());

        // 7. Detach
        let result = dispatch(
            &handler,
            "connection.detach",
            json!({"session_id": session_id}),
            7,
        )
        .await;
        assert!(result.get("result").is_some());

        // 8. List shows detached
        let result = dispatch(&handler, "connection.list", json!({}), 8).await;
        let sessions = result["result"]["sessions"].as_array().unwrap();
        assert!(!sessions[0]["attached"].as_bool().unwrap());

        // 9. Health check: 1 active session
        let result = dispatch(&handler, "health.check", json!({}), 9).await;
        assert_eq!(result["result"]["active_sessions"], 1);

        // 10. Close session
        let result = dispatch(
            &handler,
            "connection.close",
            json!({"session_id": session_id}),
            10,
        )
        .await;
        assert!(result.get("result").is_some());

        // 11. Health check: 0 active sessions
        let result = dispatch(&handler, "health.check", json!({}), 11).await;
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
        let ports = termihub_core::session::serial::list_serial_ports();
        assert!(ports.len() < 1000, "Unreasonably many ports detected");
    }

    // ── Connection tests ───────────────────────────────────────────

    #[tokio::test]
    async fn connections_create_and_list() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connections.create",
            json!({"name": "Build Shell", "type": "shell", "config": {"shell": "/bin/bash"}, "persistent": true}),
            2,
        )
        .await;
        let conn_id = result["result"]["id"].as_str().unwrap();
        assert!(conn_id.starts_with("conn-"));
        assert_eq!(result["result"]["name"], "Build Shell");
        assert!(result["result"]["persistent"].as_bool().unwrap());

        let result = dispatch(&handler, "connections.list", json!({}), 3).await;
        let conns = result["result"]["connections"].as_array().unwrap();
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0]["name"], "Build Shell");
        let folders = result["result"]["folders"].as_array().unwrap();
        assert!(folders.is_empty());
    }

    #[tokio::test]
    async fn connections_update() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connections.create",
            json!({"name": "Old", "type": "shell"}),
            2,
        )
        .await;
        let conn_id = result["result"]["id"].as_str().unwrap().to_string();

        let result = dispatch(
            &handler,
            "connections.update",
            json!({"id": conn_id, "name": "New", "persistent": true}),
            3,
        )
        .await;
        assert_eq!(result["result"]["name"], "New");
        assert!(result["result"]["persistent"].as_bool().unwrap());
    }

    #[tokio::test]
    async fn connections_update_not_found() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connections.update",
            json!({"id": "nonexistent", "name": "X"}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::CONNECTION_NOT_FOUND);
    }

    #[tokio::test]
    async fn connections_delete() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connections.create",
            json!({"name": "Temp", "type": "shell"}),
            2,
        )
        .await;
        let conn_id = result["result"]["id"].as_str().unwrap().to_string();

        let result = dispatch(&handler, "connections.delete", json!({"id": conn_id}), 3).await;
        assert!(result.get("result").is_some());

        let result = dispatch(&handler, "connections.list", json!({}), 4).await;
        assert_eq!(result["result"]["connections"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn connections_delete_not_found() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connections.delete",
            json!({"id": "nonexistent"}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::CONNECTION_NOT_FOUND);
    }

    // ── Folder tests ───────────────────────────────────────────────

    #[tokio::test]
    async fn folders_create_and_list() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connections.folders.create",
            json!({"name": "Project A"}),
            2,
        )
        .await;
        let folder_id = result["result"]["id"].as_str().unwrap();
        assert!(folder_id.starts_with("folder-"));
        assert_eq!(result["result"]["name"], "Project A");
        assert!(!result["result"]["is_expanded"].as_bool().unwrap());

        let result = dispatch(&handler, "connections.list", json!({}), 3).await;
        let folders = result["result"]["folders"].as_array().unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0]["name"], "Project A");
    }

    #[tokio::test]
    async fn folders_update() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connections.folders.create",
            json!({"name": "Old Name"}),
            2,
        )
        .await;
        let folder_id = result["result"]["id"].as_str().unwrap().to_string();

        let result = dispatch(
            &handler,
            "connections.folders.update",
            json!({"id": folder_id, "name": "New Name", "is_expanded": true}),
            3,
        )
        .await;
        assert_eq!(result["result"]["name"], "New Name");
        assert!(result["result"]["is_expanded"].as_bool().unwrap());
    }

    #[tokio::test]
    async fn folders_update_not_found() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connections.folders.update",
            json!({"id": "nonexistent", "name": "X"}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::FOLDER_NOT_FOUND);
    }

    #[tokio::test]
    async fn folders_delete() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connections.folders.create",
            json!({"name": "Temp Folder"}),
            2,
        )
        .await;
        let folder_id = result["result"]["id"].as_str().unwrap().to_string();

        let result = dispatch(
            &handler,
            "connections.folders.delete",
            json!({"id": folder_id}),
            3,
        )
        .await;
        assert!(result.get("result").is_some());

        let result = dispatch(&handler, "connections.list", json!({}), 4).await;
        assert_eq!(result["result"]["folders"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn folders_delete_not_found() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connections.folders.delete",
            json!({"id": "nonexistent"}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::FOLDER_NOT_FOUND);
    }

    #[tokio::test]
    async fn connections_with_folder() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connections.folders.create",
            json!({"name": "Project"}),
            2,
        )
        .await;
        let folder_id = result["result"]["id"].as_str().unwrap().to_string();

        let result = dispatch(
            &handler,
            "connections.create",
            json!({"name": "Shell", "type": "shell", "folder_id": folder_id}),
            3,
        )
        .await;
        assert_eq!(result["result"]["folder_id"], folder_id);
    }

    // ── File browsing tests ────────────────────────────────────────

    #[tokio::test]
    async fn files_list_local() {
        let handler = make_handler();
        init_handler(&handler).await;

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), "world").unwrap();

        let result = dispatch(
            &handler,
            "connection.files.list",
            json!({"path": dir.path().to_str().unwrap()}),
            2,
        )
        .await;
        let entries = result["result"]["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "hello.txt");
        assert_eq!(entries[0]["isDirectory"], false);
        assert_eq!(entries[0]["size"], 5);
    }

    #[tokio::test]
    async fn files_list_not_found() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connection.files.list",
            json!({"path": "/nonexistent/path/abc123"}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::FILE_NOT_FOUND);
    }

    #[tokio::test]
    async fn files_read_write_round_trip() {
        let handler = make_handler();
        init_handler(&handler).await;

        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test.txt");
        let path_str = file_path.to_str().unwrap();

        let data_b64 =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"hello, world!");

        let result = dispatch(
            &handler,
            "connection.files.write",
            json!({"path": path_str, "data": data_b64}),
            2,
        )
        .await;
        assert!(result.get("result").is_some());

        let result = dispatch(
            &handler,
            "connection.files.read",
            json!({"path": path_str}),
            3,
        )
        .await;
        assert_eq!(result["result"]["data"], data_b64);
        assert_eq!(result["result"]["size"], 13);
    }

    #[tokio::test]
    async fn files_stat() {
        let handler = make_handler();
        init_handler(&handler).await;

        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("stat_test.txt");
        std::fs::write(&file_path, "hello").unwrap();

        let result = dispatch(
            &handler,
            "connection.files.stat",
            json!({"path": file_path.to_str().unwrap()}),
            2,
        )
        .await;
        assert_eq!(result["result"]["name"], "stat_test.txt");
        assert_eq!(result["result"]["isDirectory"], false);
        assert_eq!(result["result"]["size"], 5);
    }

    #[tokio::test]
    async fn files_delete() {
        let handler = make_handler();
        init_handler(&handler).await;

        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("to_delete.txt");
        std::fs::write(&file_path, "delete me").unwrap();

        let result = dispatch(
            &handler,
            "connection.files.delete",
            json!({"path": file_path.to_str().unwrap(), "isDirectory": false}),
            2,
        )
        .await;
        assert!(result.get("result").is_some());
        assert!(!file_path.exists());
    }

    #[tokio::test]
    async fn files_rename() {
        let handler = make_handler();
        init_handler(&handler).await;

        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.txt");
        let new = dir.path().join("new.txt");
        std::fs::write(&old, "content").unwrap();

        let result = dispatch(
            &handler,
            "connection.files.rename",
            json!({"old_path": old.to_str().unwrap(), "new_path": new.to_str().unwrap()}),
            2,
        )
        .await;
        assert!(result.get("result").is_some());
        assert!(!old.exists());
        assert!(new.exists());
    }

    #[tokio::test]
    async fn files_with_connection_id_not_found() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connection.files.list",
            json!({"connection_id": "nonexistent", "path": "/tmp"}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::CONNECTION_NOT_FOUND);
    }

    #[tokio::test]
    async fn files_serial_not_supported() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connections.create",
            json!({"name": "Serial", "type": "serial", "config": {"port": "/dev/ttyUSB0"}}),
            2,
        )
        .await;
        let conn_id = result["result"]["id"].as_str().unwrap().to_string();

        let result = dispatch(
            &handler,
            "connection.files.list",
            json!({"connection_id": conn_id, "path": "/tmp"}),
            3,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::FILE_BROWSING_NOT_SUPPORTED);
    }

    #[tokio::test]
    async fn files_shell_connection_uses_local() {
        let handler = make_handler();
        init_handler(&handler).await;

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("file.txt"), "data").unwrap();

        let result = dispatch(
            &handler,
            "connections.create",
            json!({"name": "Shell", "type": "shell", "config": {"shell": "/bin/sh"}}),
            2,
        )
        .await;
        let conn_id = result["result"]["id"].as_str().unwrap().to_string();

        let result = dispatch(
            &handler,
            "connection.files.list",
            json!({"connection_id": conn_id, "path": dir.path().to_str().unwrap()}),
            3,
        )
        .await;
        let entries = result["result"]["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "file.txt");
    }

    #[tokio::test]
    async fn files_list_via_session_id_uses_local_backend() {
        let (handler, mgr) = make_handler_with_manager();
        init_handler(&handler).await;

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("from_session.txt"), "hi").unwrap();

        let snapshot = mgr
            .create_stub_session("local", "test shell".to_string(), json!({}))
            .await
            .unwrap();
        let session_id = snapshot.id;

        let result = dispatch(
            &handler,
            "connection.files.list",
            json!({"connection_id": session_id, "path": dir.path().to_str().unwrap()}),
            2,
        )
        .await;
        let entries = result["result"]["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "from_session.txt");
    }

    #[tokio::test]
    async fn files_require_initialization() {
        let handler = make_handler();

        let result = dispatch(
            &handler,
            "connection.files.list",
            json!({"path": "/tmp"}),
            1,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::NOT_INITIALIZED);
    }

    #[tokio::test]
    async fn files_write_invalid_base64() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connection.files.write",
            json!({"path": "/tmp/test.txt", "data": "!!!not-base64!!!"}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::INVALID_PARAMS);
    }

    // ── Monitoring tests ───────────────────────────────────────────

    #[tokio::test]
    async fn monitoring_subscribe_self() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connection.monitoring.subscribe",
            json!({"host": "self", "interval_ms": 5000}),
            2,
        )
        .await;
        assert!(result.get("result").is_some());

        let result = dispatch(
            &handler,
            "connection.monitoring.unsubscribe",
            json!({"host": "self"}),
            3,
        )
        .await;
        assert!(result.get("result").is_some());
    }

    #[tokio::test]
    async fn monitoring_unsubscribe_nonexistent() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connection.monitoring.unsubscribe",
            json!({"host": "nonexistent"}),
            2,
        )
        .await;
        assert!(result.get("result").is_some());
    }

    #[tokio::test]
    async fn monitoring_subscribe_invalid_params() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(&handler, "connection.monitoring.subscribe", json!({}), 2).await;
        assert_eq!(result["error"]["code"], errors::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn monitoring_requires_initialization() {
        let handler = make_handler();

        let result = dispatch(
            &handler,
            "connection.monitoring.subscribe",
            json!({"host": "self"}),
            1,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::NOT_INITIALIZED);
    }

    #[tokio::test]
    async fn monitoring_subscribe_unknown_connection() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "connection.monitoring.subscribe",
            json!({"host": "nonexistent-conn"}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::MONITORING_ERROR);
    }

    #[tokio::test]
    async fn connection_types_local_has_monitoring_matching_platform() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(&handler, "connection.types", json!({}), 2).await;
        let types = result["result"]["types"].as_array().expect("types array");
        let local_type = types
            .iter()
            .find(|t| t["typeId"].as_str() == Some("local"))
            .expect("local type");
        let monitoring_cap = local_type["capabilities"]["monitoring"]
            .as_bool()
            .expect("monitoring bool");
        assert_eq!(monitoring_cap, detect_monitoring_supported());
    }

    #[tokio::test]
    async fn monitoring_subscribe_local_session_resolves_to_self() {
        use crate::monitoring::MonitoringManagerApi;
        use crate::session::definitions::ConnectionStoreApi;

        let store = Arc::new(MockConnectionStore::new());
        let monitor = Arc::new(MockMonitoringManager::new());
        let subscribed = monitor.subscribed.clone();

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let registry = Arc::new(crate::registry::build_registry());
        let session_manager = Arc::new(SessionManager::new(tx, registry));

        let handler = AgentHandler::new(
            session_manager.clone() as Arc<dyn SessionManagerApi>,
            store as Arc<dyn ConnectionStoreApi>,
            monitor as Arc<dyn MonitoringManagerApi>,
        )
        .unwrap();
        init_handler(&handler).await;

        let snapshot = session_manager
            .create_stub_session("local", "Shell".to_string(), json!({}))
            .await
            .unwrap();
        let session_id = snapshot.id;

        let result = dispatch(
            &handler,
            "connection.monitoring.subscribe",
            json!({"host": session_id, "interval_ms": 2000}),
            3,
        )
        .await;
        assert!(
            result.get("result").is_some(),
            "subscribe with local session id should succeed: {result}"
        );
        assert_eq!(
            subscribed.lock().await.as_slice(),
            ["self"],
            "local session should resolve to 'self' monitoring host"
        );
    }

    #[tokio::test]
    async fn monitoring_unsubscribe_local_session_resolves_to_self() {
        use crate::monitoring::MonitoringManagerApi;
        use crate::session::definitions::ConnectionStoreApi;

        let store = Arc::new(MockConnectionStore::new());
        let monitor = Arc::new(MockMonitoringManager::new());
        let unsubscribed = monitor.unsubscribed.clone();

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let registry = Arc::new(crate::registry::build_registry());
        let session_manager = Arc::new(SessionManager::new(tx, registry));

        let handler = AgentHandler::new(
            session_manager.clone() as Arc<dyn SessionManagerApi>,
            store as Arc<dyn ConnectionStoreApi>,
            monitor as Arc<dyn MonitoringManagerApi>,
        )
        .unwrap();
        init_handler(&handler).await;

        let snapshot = session_manager
            .create_stub_session("local", "Shell".to_string(), json!({}))
            .await
            .unwrap();
        let session_id = snapshot.id;

        dispatch(
            &handler,
            "connection.monitoring.unsubscribe",
            json!({"host": session_id}),
            3,
        )
        .await;
        assert_eq!(
            unsubscribed.lock().await.as_slice(),
            ["self"],
            "local session unsubscribe should resolve to 'self'"
        );
    }

    // ── agent.shutdown tests ───────────────────────────────────────

    #[tokio::test]
    async fn agent_shutdown_returns_session_count() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(&handler, "agent.shutdown", json!({}), 2).await;
        assert!(handler.is_shutdown());
        assert_eq!(result["result"]["detached_sessions"], 0);
    }

    #[tokio::test]
    async fn agent_shutdown_with_reason() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(&handler, "agent.shutdown", json!({"reason": "update"}), 2).await;
        assert!(handler.is_shutdown());
        assert!(result.get("result").is_some());
    }

    #[tokio::test]
    async fn agent_shutdown_with_active_sessions() {
        let (handler, mgr) = make_handler_with_manager();
        init_handler(&handler).await;

        mgr.create_stub_session("local", "test".to_string(), json!({}))
            .await
            .unwrap();

        let result = dispatch(&handler, "agent.shutdown", json!({}), 2).await;
        assert!(handler.is_shutdown());
        assert_eq!(result["result"]["detached_sessions"], 1);
    }

    #[tokio::test]
    async fn agent_shutdown_requires_initialization() {
        let handler = make_handler();

        let result = dispatch(&handler, "agent.shutdown", json!({}), 1).await;
        assert!(!handler.is_shutdown());
        assert_eq!(result["error"]["code"], errors::NOT_INITIALIZED);
    }

    // ── Shell candidate tests ──────────────────────────────────────

    #[test]
    fn shell_candidates_includes_pwsh_paths() {
        assert!(SHELL_CANDIDATES.contains(&"/usr/local/bin/pwsh"));
        assert!(SHELL_CANDIDATES.contains(&"/usr/bin/pwsh"));
        assert!(SHELL_CANDIDATES.contains(&"/snap/bin/pwsh"));
    }

    #[test]
    fn shell_candidates_includes_nushell_paths() {
        assert!(SHELL_CANDIDATES.contains(&"/usr/local/bin/nu"));
        assert!(SHELL_CANDIDATES.contains(&"/usr/bin/nu"));
        assert!(SHELL_CANDIDATES.contains(&"/snap/bin/nu"));
    }

    // ── network.* tests ────────────────────────────────────────────

    #[tokio::test]
    async fn network_dns_lookup_invalid_type_returns_error() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "network.dns_lookup",
            json!({"hostname": "example.com", "record_type": "BOGUS"}),
            2,
        )
        .await;
        assert!(
            result.get("error").is_some(),
            "expected error for unknown record type"
        );
    }

    #[tokio::test]
    async fn network_port_scan_invalid_port_spec_returns_error() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(
            &handler,
            "network.port_scan",
            json!({"host": "localhost", "ports": "not-a-port"}),
            2,
        )
        .await;
        assert!(
            result.get("error").is_some(),
            "expected error for invalid port spec"
        );
    }

    #[tokio::test]
    async fn network_wol_invalid_mac_returns_error() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(&handler, "network.wol", json!({"mac": "not-a-mac"}), 2).await;
        assert!(
            result.get("error").is_some(),
            "expected error for invalid MAC"
        );
    }

    #[tokio::test]
    async fn network_open_ports_returns_result() {
        let handler = make_handler();
        init_handler(&handler).await;

        let result = dispatch(&handler, "network.open_ports", json!({}), 2).await;
        assert!(
            result.get("result").is_some(),
            "expected result for open_ports"
        );
        assert!(result["result"]["ports"].is_array());
    }

    #[tokio::test]
    async fn network_methods_require_initialization() {
        let handler = make_handler();

        let result = dispatch(&handler, "network.open_ports", json!({}), 1).await;
        assert_eq!(result["error"]["code"], errors::NOT_INITIALIZED);
    }

    // ── Mock managers for DI tests ─────────────────────────────────

    use tokio::sync::Mutex as AsyncMutex;

    use crate::session::definitions::{
        Connection, ConnectionSnapshot, ConnectionStore, ConnectionStoreApi, Folder, FolderSnapshot,
    };
    use crate::session::manager::SessionManagerApi;

    struct MockConnectionStore {
        connections: AsyncMutex<Vec<ConnectionSnapshot>>,
        folders: AsyncMutex<Vec<FolderSnapshot>>,
    }

    impl MockConnectionStore {
        fn new() -> Self {
            Self {
                connections: AsyncMutex::new(Vec::new()),
                folders: AsyncMutex::new(Vec::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl ConnectionStoreApi for MockConnectionStore {
        async fn get(&self, id: &str) -> Option<ConnectionSnapshot> {
            self.connections
                .lock()
                .await
                .iter()
                .find(|c| c.id == id)
                .cloned()
        }

        async fn create(&self, conn: Connection) -> ConnectionSnapshot {
            let snap = ConnectionSnapshot {
                id: conn.id.clone(),
                name: conn.name,
                session_type: conn.session_type,
                config: conn.config,
                persistent: conn.persistent,
                folder_id: conn.folder_id,
                terminal_options: conn.terminal_options,
                icon: conn.icon,
                source_file: None,
            };
            self.connections.lock().await.push(snap.clone());
            snap
        }

        async fn update(
            &self,
            id: &str,
            name: Option<String>,
            _session_type: Option<String>,
            _config: Option<serde_json::Value>,
            _persistent: Option<bool>,
            _folder_id: Option<Option<String>>,
            _terminal_options: Option<Option<serde_json::Value>>,
            _icon: Option<Option<String>>,
        ) -> Option<ConnectionSnapshot> {
            let mut conns = self.connections.lock().await;
            let conn = conns.iter_mut().find(|c| c.id == id)?;
            if let Some(n) = name {
                conn.name = n;
            }
            Some(conn.clone())
        }

        async fn list(&self) -> (Vec<ConnectionSnapshot>, Vec<FolderSnapshot>) {
            (
                self.connections.lock().await.clone(),
                self.folders.lock().await.clone(),
            )
        }

        async fn delete(&self, id: &str) -> bool {
            let mut conns = self.connections.lock().await;
            let before = conns.len();
            conns.retain(|c| c.id != id);
            conns.len() < before
        }

        async fn create_folder(&self, folder: Folder) -> FolderSnapshot {
            let snap = FolderSnapshot {
                id: folder.id,
                name: folder.name,
                parent_id: folder.parent_id,
                is_expanded: folder.is_expanded,
            };
            self.folders.lock().await.push(snap.clone());
            snap
        }

        async fn update_folder(
            &self,
            id: &str,
            name: Option<String>,
            _parent_id: Option<Option<String>>,
            _is_expanded: Option<bool>,
        ) -> Option<FolderSnapshot> {
            let mut folders = self.folders.lock().await;
            let folder = folders.iter_mut().find(|f| f.id == id)?;
            if let Some(n) = name {
                folder.name = n;
            }
            Some(folder.clone())
        }

        async fn delete_folder(&self, id: &str) -> bool {
            let mut folders = self.folders.lock().await;
            let before = folders.len();
            folders.retain(|f| f.id != id);
            folders.len() < before
        }

        async fn load_external_files(&self, _paths: &[String]) {}
    }

    struct MockMonitoringManager {
        subscribed: Arc<AsyncMutex<Vec<String>>>,
        unsubscribed: Arc<AsyncMutex<Vec<String>>>,
    }

    impl MockMonitoringManager {
        fn new() -> Self {
            Self {
                subscribed: Arc::new(AsyncMutex::new(Vec::new())),
                unsubscribed: Arc::new(AsyncMutex::new(Vec::new())),
            }
        }
    }

    #[async_trait::async_trait]
    impl MonitoringManagerApi for MockMonitoringManager {
        async fn subscribe(&self, host: &str, _interval_ms: Option<u64>) -> anyhow::Result<()> {
            self.subscribed.lock().await.push(host.to_string());
            Ok(())
        }

        async fn unsubscribe(&self, host: &str) {
            self.unsubscribed.lock().await.push(host.to_string());
        }

        async fn shutdown(&self) {}
    }

    // ── Mock SessionManager DI tests ───────────────────────────────

    use crate::session::types::{SessionSnapshot, SessionStatus};
    use termihub_core::connection::ConnectionTypeRegistry;

    struct MockSessionManager {
        registry: ConnectionTypeRegistry,
        create_error: Option<SessionCreateError>,
        sessions: Arc<AsyncMutex<Vec<SessionSnapshot>>>,
    }

    impl MockSessionManager {
        fn new() -> Self {
            Self {
                registry: crate::registry::build_registry(),
                create_error: None,
                sessions: Arc::new(AsyncMutex::new(Vec::new())),
            }
        }

        fn with_create_error(error: SessionCreateError) -> Self {
            Self {
                registry: crate::registry::build_registry(),
                create_error: Some(error),
                sessions: Arc::new(AsyncMutex::new(Vec::new())),
            }
        }
    }

    #[async_trait::async_trait]
    impl SessionManagerApi for MockSessionManager {
        fn registry(&self) -> &ConnectionTypeRegistry {
            &self.registry
        }

        async fn create(
            &self,
            type_id: &str,
            title: String,
            _settings: serde_json::Value,
        ) -> Result<SessionSnapshot, SessionCreateError> {
            if let Some(ref e) = self.create_error {
                return Err(match e {
                    SessionCreateError::LimitReached => SessionCreateError::LimitReached,
                    SessionCreateError::InvalidConfig(m) => {
                        SessionCreateError::InvalidConfig(m.clone())
                    }
                    SessionCreateError::BackendFailed(m) => {
                        SessionCreateError::BackendFailed(m.clone())
                    }
                });
            }
            let snapshot = SessionSnapshot {
                id: uuid::Uuid::new_v4().to_string(),
                title,
                type_id: type_id.to_string(),
                status: SessionStatus::Running,
                created_at: chrono::Utc::now(),
                last_activity: chrono::Utc::now(),
                attached: false,
            };
            self.sessions.lock().await.push(snapshot.clone());
            Ok(snapshot)
        }

        async fn list(&self) -> Vec<SessionSnapshot> {
            self.sessions.lock().await.clone()
        }

        async fn get_session_type_id(&self, session_id: &str) -> Option<String> {
            self.sessions
                .lock()
                .await
                .iter()
                .find(|s| s.id == session_id)
                .map(|s| s.type_id.clone())
        }

        async fn close(&self, session_id: &str) -> bool {
            let mut sessions = self.sessions.lock().await;
            let before = sessions.len();
            sessions.retain(|s| s.id != session_id);
            sessions.len() < before
        }

        async fn close_all(&self) {
            self.sessions.lock().await.clear();
        }

        async fn detach_all(&self) {}

        async fn active_count(&self) -> u32 {
            self.sessions.lock().await.len() as u32
        }

        async fn attach(&self, session_id: &str) -> Result<(), String> {
            let sessions = self.sessions.lock().await;
            if sessions.iter().any(|s| s.id == session_id) {
                Ok(())
            } else {
                Err("Session not found".to_string())
            }
        }

        async fn detach(&self, session_id: &str) -> Result<(), String> {
            let sessions = self.sessions.lock().await;
            if sessions.iter().any(|s| s.id == session_id) {
                Ok(())
            } else {
                Err("Session not found".to_string())
            }
        }

        async fn write_input(&self, session_id: &str, _data: &[u8]) -> Result<(), String> {
            let sessions = self.sessions.lock().await;
            if sessions.iter().any(|s| s.id == session_id) {
                Ok(())
            } else {
                Err("Session not found".to_string())
            }
        }

        async fn resize(&self, session_id: &str, _cols: u16, _rows: u16) -> Result<(), String> {
            let sessions = self.sessions.lock().await;
            if sessions.iter().any(|s| s.id == session_id) {
                Ok(())
            } else {
                Err("Session not found".to_string())
            }
        }

        async fn get_buffer(&self, session_id: &str) -> Result<Vec<u8>, String> {
            let sessions = self.sessions.lock().await;
            if sessions.iter().any(|s| s.id == session_id) {
                Ok(Vec::new())
            } else {
                Err("Session not found".to_string())
            }
        }

        async fn set_persistent_buffer_size_bytes(&self, _bytes: usize) {}
    }

    fn make_mock_handler() -> AgentHandler {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp = std::env::temp_dir().join(format!("termihub-mock-{}.json", uuid::Uuid::new_v4()));
        let conn_store = Arc::new(ConnectionStore::new_temp(tmp));
        let monitoring_manager = Arc::new(crate::monitoring::MonitoringManager::new(
            tx,
            conn_store.clone(),
        ));
        let session_manager = Arc::new(MockSessionManager::new());
        AgentHandler::new(
            session_manager as Arc<dyn SessionManagerApi>,
            conn_store as Arc<dyn ConnectionStoreApi>,
            monitoring_manager as Arc<dyn MonitoringManagerApi>,
        )
        .unwrap()
    }

    fn make_mock_handler_failing(error: SessionCreateError) -> AgentHandler {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp = std::env::temp_dir().join(format!("termihub-mock-{}.json", uuid::Uuid::new_v4()));
        let conn_store = Arc::new(ConnectionStore::new_temp(tmp));
        let monitoring_manager = Arc::new(crate::monitoring::MonitoringManager::new(
            tx,
            conn_store.clone(),
        ));
        let session_manager = Arc::new(MockSessionManager::with_create_error(error));
        AgentHandler::new(
            session_manager as Arc<dyn SessionManagerApi>,
            conn_store as Arc<dyn ConnectionStoreApi>,
            monitoring_manager as Arc<dyn MonitoringManagerApi>,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn mock_session_create_backend_failed_returns_error() {
        let handler =
            make_mock_handler_failing(SessionCreateError::BackendFailed("PTY spawn failed".into()));
        dispatch(&handler, "initialize", init_params(), 1).await;

        let result = dispatch(
            &handler,
            "connection.create",
            json!({"type": "local", "config": {}}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::SESSION_CREATION_FAILED);
        assert!(result["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("PTY spawn failed"));
    }

    #[tokio::test]
    async fn mock_session_create_limit_reached_returns_error() {
        let handler = make_mock_handler_failing(SessionCreateError::LimitReached);
        dispatch(&handler, "initialize", init_params(), 1).await;

        let result = dispatch(
            &handler,
            "connection.create",
            json!({"type": "local", "config": {}}),
            2,
        )
        .await;
        assert_eq!(result["error"]["code"], errors::SESSION_LIMIT_REACHED);
    }

    #[tokio::test]
    async fn mock_session_create_and_list() {
        let handler = make_mock_handler();
        dispatch(&handler, "initialize", init_params(), 1).await;

        let create_result = dispatch(
            &handler,
            "connection.create",
            json!({"type": "local", "title": "My Shell", "config": {}}),
            2,
        )
        .await;
        assert!(
            create_result.get("result").is_some(),
            "expected session create to succeed: {create_result}"
        );
        let sid = create_result["result"]["session_id"].as_str().unwrap();

        let list_result = dispatch(&handler, "connection.list", json!({}), 3).await;
        let sessions = list_result["result"]["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["session_id"], sid);
    }

    #[tokio::test]
    async fn mock_health_check_counts_sessions() {
        let handler = make_mock_handler();
        dispatch(&handler, "initialize", init_params(), 1).await;

        dispatch(
            &handler,
            "connection.create",
            json!({"type": "local", "config": {}}),
            2,
        )
        .await;

        let result = dispatch(&handler, "health.check", json!({}), 3).await;
        assert_eq!(result["result"]["active_sessions"], 1);
    }

    #[tokio::test]
    async fn mock_connections_create_via_store_trait() {
        let store = Arc::new(MockConnectionStore::new());
        let monitor = Arc::new(MockMonitoringManager::new());

        let (_tx, _rx) = tokio::sync::mpsc::unbounded_channel::<
            crate::protocol::messages::JsonRpcNotification,
        >();
        let _registry = Arc::new(crate::registry::build_registry());
        let session_manager = Arc::new(MockSessionManager::new());

        let handler = AgentHandler::new(
            session_manager as Arc<dyn SessionManagerApi>,
            store.clone() as Arc<dyn ConnectionStoreApi>,
            monitor as Arc<dyn MonitoringManagerApi>,
        )
        .unwrap();
        dispatch(&handler, "initialize", init_params(), 1).await;

        let result = dispatch(
            &handler,
            "connections.create",
            json!({"name": "My SSH", "type": "ssh", "config": {"host": "example.com"}}),
            2,
        )
        .await;
        assert!(
            result.get("result").is_some(),
            "create should succeed: {result}"
        );

        let conns = store.connections.lock().await;
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].name, "My SSH");
    }
}

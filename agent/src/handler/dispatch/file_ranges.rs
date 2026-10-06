//! `connection.files.read_range` / `connection.files.write_range` (protocol
//! 0.26.0, #3587).
//!
//! Offset-addressed slices of a file, so the desktop can run a queued,
//! resumable transfer against an agent-hosted session one bounded request at a
//! time. The target resolves exactly as for every other `connection.files.*`
//! method ([`resolve_file_browser`]): the agent host, or the session's own
//! backend — run in the session daemon for a persistent session — which must
//! offer [`FileBrowser::ranged`](termihub_core::files::FileBrowser::ranged).
//! A backend without it, or a session started by an older session daemon,
//! answers `-32013` (file browsing not supported).
//!
//! A read of `length: 0` performs no I/O: it only answers whether the target
//! supports ranged access, which is the desktop's per-session capability probe.

use base64::Engine;
use jsonrpsee::core::server::RpcModule;
use jsonrpsee::types::ErrorObjectOwned;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use termihub_core::files::{FileBrowser, RangedFileAccess, MAX_RANGE_BYTES};
use termihub_core::protocol::methods::{
    FilesReadRangeParams, FilesReadRangeResult, FilesWriteRangeParams,
};

use super::{
    get_file_managers, invalid_params, map_file_error, resolve_file_browser, rpc_err,
    to_result_value, HandlerState,
};
use crate::protocol::errors;
use crate::protocol::methods as pm;

/// Register both ranged file methods.
pub(super) fn register(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    register_read_range(module)?;
    register_write_range(module)?;
    Ok(())
}

/// The ranged capability of a resolved browser, or `-32013`.
fn ranged(
    browser: &(dyn FileBrowser + Send + Sync),
) -> Result<&dyn RangedFileAccess, ErrorObjectOwned> {
    browser.ranged().ok_or_else(|| {
        rpc_err(
            errors::FILE_BROWSING_NOT_SUPPORTED,
            "Ranged file access is not supported for this session; \
             if it was started before the agent was updated, reopen it",
        )
    })
}

fn register_read_range(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method(
        pm::CONNECTION_FILES_READ_RANGE,
        |params, ctx, _ext| async move {
            let (session_manager, connection_store) = get_file_managers(&ctx).await?;
            let p: FilesReadRangeParams = params
                .parse()
                .map_err(|e| invalid_params("connection.files.read_range", e))?;
            if p.length > MAX_RANGE_BYTES {
                return Err(rpc_err(
                    errors::INVALID_PARAMS,
                    format!(
                        "length {} exceeds the {MAX_RANGE_BYTES}-byte limit",
                        p.length
                    ),
                ));
            }
            let browser =
                resolve_file_browser(&session_manager, &connection_store, p.connection_id).await?;
            let access = ranged(browser.as_ref())?;
            if p.length == 0 {
                // The capability probe: supported, nothing read.
                return to_result_value(&FilesReadRangeResult {
                    data: String::new(),
                    eof: false,
                });
            }
            let data = access
                .read_range(&p.path, p.offset, p.length)
                .await
                .map_err(map_file_error)?;
            to_result_value(&FilesReadRangeResult {
                eof: data.len() < p.length as usize,
                data: base64::engine::general_purpose::STANDARD.encode(&data),
            })
        },
    )?;
    Ok(())
}

fn register_write_range(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method(
        pm::CONNECTION_FILES_WRITE_RANGE,
        |params, ctx, _ext| async move {
            let (session_manager, connection_store) = get_file_managers(&ctx).await?;
            let p: FilesWriteRangeParams = params
                .parse()
                .map_err(|e| invalid_params("connection.files.write_range", e))?;
            let data = base64::engine::general_purpose::STANDARD
                .decode(&p.data)
                .map_err(|e| {
                    rpc_err(errors::INVALID_PARAMS, format!("Invalid base64 data: {e}"))
                })?;
            if data.len() > MAX_RANGE_BYTES as usize {
                return Err(rpc_err(
                    errors::INVALID_PARAMS,
                    format!(
                        "{} bytes exceed the {MAX_RANGE_BYTES}-byte limit",
                        data.len()
                    ),
                ));
            }
            let browser =
                resolve_file_browser(&session_manager, &connection_store, p.connection_id).await?;
            ranged(browser.as_ref())?
                .write_range(&p.path, p.offset, &data)
                .await
                .map_err(map_file_error)?;
            Ok::<Value, ErrorObjectOwned>(json!({}))
        },
    )?;
    Ok(())
}

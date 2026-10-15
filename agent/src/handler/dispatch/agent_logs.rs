//! `agent.logs.list` / `agent.logs.read` (protocol 0.32.0, #4519) — let a
//! connected desktop pull this agent's own per-process log files
//! (`<config>/logs/termihub-agent-….log`, #4319) into its Export Diagnostics
//! bundle, so a support case no longer needs a shell on the agent host.
//!
//! Mirrors `agent.crash_reports.*` (#3574): read-only and confined to the
//! agent's fixed log directory. The list takes no params; `read` accepts only
//! a plain log-family name that the current, capped listing returns, so no
//! path can be expressed. Unlike crash reports, log files are not redacted
//! when written, so every read is redacted here (the desktop redacts again),
//! and an over-long file returns its newest lines, capped at
//! [`MAX_REMOTE_LOG_BYTES`].

use std::path::PathBuf;

use jsonrpsee::core::server::RpcModule;
use jsonrpsee::types::ErrorObjectOwned;
use tokio::sync::Mutex;

use termihub_core::diagnostics::file_log::AGENT_LOG_FAMILY;
use termihub_core::diagnostics::redact::Redactor;
use termihub_core::diagnostics::remote_log::{self, MAX_REMOTE_LOG_BYTES};
use termihub_core::protocol::methods::{
    LogFileSummary, LogsListResult, LogsReadParams, LogsReadResult,
};

use super::{invalid_params, not_initialized, rpc_err, to_result_value, HandlerState};
use crate::protocol::errors;
use crate::protocol::methods as pm;

/// The log directory the `agent.logs.*` methods serve: the test override when
/// set, otherwise the agent's own (fixed, not wire-chosen) `<config>/logs`.
async fn get_log_dir(ctx: &Mutex<HandlerState>) -> Result<PathBuf, ErrorObjectOwned> {
    let s = ctx.lock().await;
    if !s.initialized {
        return Err(not_initialized());
    }
    Ok(s.log_dir
        .get()
        .cloned()
        .unwrap_or_else(crate::file_log::log_dir))
}

/// Register `agent.logs.list` and `agent.logs.read`.
pub(super) fn register(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method(pm::AGENT_LOGS_LIST, |_params, ctx, _ext| async move {
        let dir = get_log_dir(&ctx).await?;
        let logs =
            tokio::task::spawn_blocking(move || remote_log::list_family(&dir, AGENT_LOG_FAMILY))
                .await
                .map_err(|e| rpc_err(errors::INTERNAL_ERROR, e.to_string()))?
                .into_iter()
                .map(|e| LogFileSummary {
                    name: e.name,
                    size: e.size,
                })
                .collect();
        to_result_value(&LogsListResult { logs })
    })?;

    module.register_async_method(pm::AGENT_LOGS_READ, |params, ctx, _ext| async move {
        let dir = get_log_dir(&ctx).await?;
        let p: LogsReadParams = params
            .parse()
            .map_err(|e| invalid_params("agent.logs.read", e))?;
        if !remote_log::is_plain_log_name(&p.name, AGENT_LOG_FAMILY) {
            return Err(invalid_params("agent.logs.read", "not a log file name"));
        }
        let name = p.name.clone();
        let read = tokio::task::spawn_blocking(move || {
            remote_log::read_listed_log(
                &dir,
                AGENT_LOG_FAMILY,
                &name,
                MAX_REMOTE_LOG_BYTES,
                &Redactor::for_current_environment(),
            )
        })
        .await
        .map_err(|e| rpc_err(errors::INTERNAL_ERROR, e.to_string()))?;
        match read {
            Ok((text, truncated)) => to_result_value(&LogsReadResult {
                name: p.name,
                text,
                truncated,
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(rpc_err(
                errors::FILE_NOT_FOUND,
                format!("no log file named {}", p.name),
            )),
            Err(e) => Err(rpc_err(
                errors::FILE_OPERATION_FAILED,
                format!("could not read log file: {e}"),
            )),
        }
    })?;
    Ok(())
}

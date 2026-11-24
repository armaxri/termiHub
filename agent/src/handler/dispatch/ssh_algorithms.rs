//! `connection.sshAlgorithms` (protocol 0.44.0, #5896).
//!
//! The cipher, MAC, key exchange and host-key algorithm a held SSH session's
//! transport negotiated, for the desktop's "Connection security" popover. A
//! daemon-backed session answers with what its session daemon reported after
//! the attach; a session of another type, or one whose daemon was started by
//! an older agent, answers `{"algorithms": null}` and the popover keeps its
//! plain "Encrypted (SSH)". The session must exist, be running and be held by
//! the calling client, exactly as for `connection.processes.*`.

use jsonrpsee::core::server::RpcModule;
use jsonrpsee::types::ErrorObjectOwned;
use tokio::sync::Mutex;

use termihub_core::protocol::methods::{SshAlgorithmsParams, SshAlgorithmsResult};

use super::{get_file_managers, invalid_params, rpc_err, to_result_value, HandlerState};
use crate::protocol::errors;
use crate::protocol::methods as pm;
use crate::session::manager::SessionProcessError;

/// Register `connection.sshAlgorithms`.
pub(super) fn register(module: &mut RpcModule<Mutex<HandlerState>>) -> anyhow::Result<()> {
    module.register_async_method(
        pm::CONNECTION_SSH_ALGORITHMS,
        |params, ctx, _ext| async move {
            let (session_manager, _) = get_file_managers(&ctx).await?;
            let p: SshAlgorithmsParams = params
                .parse()
                .map_err(|e| invalid_params(pm::CONNECTION_SSH_ALGORITHMS, e))?;
            let algorithms = match session_manager.session_ssh_algorithms(&p.session_id).await {
                Ok(algorithms) => algorithms,
                // Nothing to report is not an error: the popover falls back.
                Err(SessionProcessError::Unsupported(_)) => None,
                Err(e) => return Err(session_error(&p.session_id, e)),
            };
            to_result_value(&SshAlgorithmsResult { algorithms })
        },
    )?;
    Ok(())
}

/// Map a refused session lookup to its JSON-RPC error.
fn session_error(id: &str, e: SessionProcessError) -> ErrorObjectOwned {
    match e {
        SessionProcessError::Unknown => rpc_err(
            errors::SESSION_NOT_FOUND,
            format!("Session not found: {id}"),
        ),
        SessionProcessError::Exited => rpc_err(
            errors::SESSION_NOT_RUNNING,
            format!("Session {id} is not running"),
        ),
        SessionProcessError::HeldElsewhere | SessionProcessError::Unsupported(_) => rpc_err(
            errors::SESSION_HELD_BY_OTHER,
            format!("Session {id} is not held by this client; attach it first"),
        ),
    }
}

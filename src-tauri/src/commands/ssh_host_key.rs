//! Tauri commands for interactive SSH host-key trust (#1959).
//!
//! The SSH handshake blocks on an untrusted host key and emits a
//! `ssh-host-key-prompt` event; the frontend dialog replies through
//! [`ssh_host_key_decision`], unblocking the connect. [`ssh_trust_list`] /
//! [`ssh_trust_forget`] back the trust-management settings UI, mirroring the RDP
//! trust commands.

use std::sync::Arc;

use tauri::State;

use crate::session::ssh_host_key_verifier::SshHostKeyVerifier;
use crate::utils::errors::TerminalError;

/// Deliver the user's verdict for a pending SSH host-key prompt (#1959).
///
/// `accept` proceeds with the connection; `remember` (only meaningful with
/// `accept`) persists the fingerprint so the host is trusted silently next time.
/// Returns whether a prompt with `prompt_id` was actually waiting — a stale or
/// duplicate reply returns `false` rather than erroring.
#[tauri::command]
pub async fn ssh_host_key_decision(
    prompt_id: String,
    accept: bool,
    remember: bool,
    verifier: State<'_, Arc<SshHostKeyVerifier>>,
) -> Result<bool, TerminalError> {
    Ok(verifier.resolve(&prompt_id, accept, remember))
}

/// One remembered SSH host and the host-key fingerprints trusted for it, for the
/// trust-management settings UI.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SshTrustedHost {
    /// Host key (`host:port`) as stored in the trust store.
    pub host: String,
    /// SHA-256 host-key fingerprints trusted for this host.
    pub fingerprints: Vec<String>,
}

/// List every remembered SSH host and its trusted host-key fingerprints, so the
/// settings UI can show what "Accept for host" has persisted.
#[tauri::command]
pub async fn ssh_trust_list(
    verifier: State<'_, Arc<SshHostKeyVerifier>>,
) -> Result<Vec<SshTrustedHost>, TerminalError> {
    Ok(verifier
        .trust_store()
        .entries()
        .into_iter()
        .map(|(host, fingerprints)| SshTrustedHost { host, fingerprints })
        .collect())
}

/// Revoke remembered SSH host-key trust. With `fingerprint` set, forgets just
/// that fingerprint (dropping the host once its last one is gone); without it,
/// forgets the whole host. Either way the next connect re-prompts. Returns
/// whether anything was removed.
#[tauri::command]
pub async fn ssh_trust_forget(
    host: String,
    fingerprint: Option<String>,
    verifier: State<'_, Arc<SshHostKeyVerifier>>,
) -> Result<bool, TerminalError> {
    let store = verifier.trust_store();
    Ok(match fingerprint {
        Some(fp) => store.forget_fingerprint(&host, &fp),
        None => store.forget_host(&host),
    })
}

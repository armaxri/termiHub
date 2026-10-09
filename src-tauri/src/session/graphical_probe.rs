//! Test connection's verdict for graphical backends that establish **after**
//! `connect()` returns (#4320, PARITY2-001).
//!
//! VNC does the whole RFB handshake and auth inside `connect()`, so its Test
//! verdict is the connect result. The RDP sidecar only *starts* there: its TCP
//! connect, TLS, certificate check and CredSSP/NLA run inside the helper
//! afterwards. Test therefore awaits the backend's first definitive outcome
//! ([`GraphicalBackend::wait_until_established`]) before tearing the probe down,
//! bounded by the graphical connect timeout and the Test's cancel token, and
//! answers a certificate prompt from the persisted trust store — a probe never
//! asks the user, so an unknown or changed certificate is reported as a typed
//! "not trusted" verdict instead.

use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use termihub_core::connection::{CertPrompt, GraphicalBackend};
use termihub_core::errors::{ConnectFailureKind, SessionError};

use crate::session::rdp_trust_store::{RdpTrustStore, TrustLookup};

/// Await `backend`'s definitive connect outcome for a Test connection.
///
/// - `Ok(())` once the session is established (reachable, certificate trusted,
///   credentials accepted).
/// - The backend's typed error when it gave up — `ConnectionFailed`
///   (unreachable), `AuthFailed`, or a classified timeout.
/// - [`ConnectFailureKind::Timeout`] when `timeout` elapses first.
/// - [`ConnectFailureKind::HostKeyUntrusted`] when the server presents a
///   certificate the trust store does not already trust for `host`.
/// - The usual "Connection cancelled" when `cancel` fires.
pub(crate) async fn await_verdict(
    backend: &dyn GraphicalBackend,
    host: &str,
    trust_store: Option<&RdpTrustStore>,
    timeout: Duration,
    cancel: Option<&CancellationToken>,
) -> Result<(), SessionError> {
    let mut prompts = backend.subscribe_cert_prompts();
    let established = backend.wait_until_established();
    tokio::pin!(established);
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let never = CancellationToken::new();
    let cancel = cancel.unwrap_or(&never);

    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                return Err(SessionError::SpawnFailed("Connection cancelled".to_string()));
            }
            verdict = &mut established => return verdict,
            Some(prompt) = next_prompt(&mut prompts) => {
                answer_cert_prompt(backend, host, trust_store, prompt).await?;
            }
            _ = &mut deadline => return Err(timed_out(host, timeout)),
        }
    }
}

/// The next certificate prompt, or never when the backend has none.
async fn next_prompt(
    prompts: &mut Option<termihub_core::connection::CertPromptReceiver>,
) -> Option<CertPrompt> {
    match prompts {
        Some(rx) => match rx.recv().await {
            Some(prompt) => Some(prompt),
            None => std::future::pending().await,
        },
        None => std::future::pending().await,
    }
}

/// Accept a certificate the trust store already trusts for `host`; decline any
/// other and fail the probe with the typed "not trusted" kind.
async fn answer_cert_prompt(
    backend: &dyn GraphicalBackend,
    host: &str,
    trust_store: Option<&RdpTrustStore>,
    prompt: CertPrompt,
) -> Result<(), SessionError> {
    let lookup = trust_store.map_or(TrustLookup::Unknown, |store| {
        store.lookup(host, &prompt.fingerprint)
    });
    if lookup == TrustLookup::Trusted {
        debug!(
            host,
            "test connection: accepting remembered RDP certificate"
        );
        return backend.send_cert_decision(true, false).await;
    }
    if let Err(e) = backend.send_cert_decision(false, false).await {
        warn!(error = %e, "test connection: failed to decline the RDP certificate");
    }
    let message = if lookup == TrustLookup::Changed {
        format!(
            "The certificate of {host} changed since you trusted it (fingerprint {}). This can \
             mean someone is intercepting the connection. Connect to review it.",
            prompt.fingerprint
        )
    } else {
        format!(
            "The certificate of {host} is not trusted yet (fingerprint {}). The server is \
             reachable; connect once to review and accept the certificate.",
            prompt.fingerprint
        )
    };
    Err(SessionError::Classified {
        kind: ConnectFailureKind::HostKeyUntrusted,
        message,
    })
}

/// The typed timeout verdict, worded like the graphical connect timeout.
fn timed_out(host: &str, timeout: Duration) -> SessionError {
    SessionError::Classified {
        kind: ConnectFailureKind::Timeout,
        message: format!(
            "Connection to {host} timed out after {}s. Check that the host and port are \
             correct, the server is running, and no firewall is blocking the connection.",
            timeout.as_secs()
        ),
    }
}

#[cfg(test)]
#[path = "graphical_probe_tests.rs"]
pub(crate) mod tests;

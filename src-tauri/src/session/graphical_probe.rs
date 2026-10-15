//! Test connection's verdict for graphical backends that establish **after**
//! `connect()` returns (#4320, PARITY2-001).
//!
//! VNC does the whole RFB handshake and auth inside `connect()`, so its Test
//! verdict is the connect result. The RDP sidecar only *starts* there: its TCP
//! connect, TLS, certificate check and CredSSP/NLA run inside the helper
//! afterwards. Test therefore awaits the backend's first definitive outcome
//! ([`GraphicalBackend::wait_until_established`]) before tearing the probe down,
//! bounded by the graphical connect timeout and the Test's cancel token.
//!
//! A certificate the persisted trust store already trusts is accepted silently.
//! Any other certificate is either:
//!
//! - **reviewed** by the user (#4510) when the caller supplies a
//!   [`CertReviewer`] — the interactive Test connection in the connection
//!   editor. The trust decision comes only from the user's explicit verdict;
//!   rejecting, closing the dialog, cancelling the test or letting the review
//!   time out all decline the certificate and leave the trust store untouched,
//!   and "remember" persists through [`RdpTrustStore::remember`], the same path
//!   a real connect's "Accept for host" takes. After an accept the probe
//!   continues to CredSSP and reports the real credential verdict.
//! - **declined** without asking when there is no reviewer (unattended callers),
//!   and reported as a typed "not trusted" verdict.

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use termihub_core::connection::{CertPrompt, GraphicalBackend};
use termihub_core::errors::{ConnectFailureKind, SessionError};

use crate::session::rdp_trust_store::{RdpTrustStore, TrustLookup};

/// How long an interactive certificate review may stay unanswered before it is
/// treated as a reject (#4510).
pub(crate) const CERT_REVIEW_TIMEOUT: Duration = Duration::from_secs(120);

/// An untrusted certificate the user is asked to review during a Test
/// connection (#4510) — the fields of the remote-desktop cert prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CertReviewRequest {
    pub host: String,
    pub fingerprint: String,
    pub subject: Option<String>,
    pub issuer: Option<String>,
    /// The host is known but presented a different certificate (possible MITM).
    pub changed: bool,
}

/// The user's explicit verdict on a [`CertReviewRequest`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CertReview {
    pub accept: bool,
    /// Persist the accepted certificate for the host (only meaningful with
    /// `accept`).
    pub remember: bool,
}

/// Asks the user to review an untrusted certificate during a Test connection.
///
/// `None` means no verdict arrived (the dialog went away without one); the
/// probe treats it as a reject.
#[async_trait::async_trait]
pub(crate) trait CertReviewer: Send + Sync {
    async fn review(&self, request: CertReviewRequest) -> Option<CertReview>;
}

/// Pending interactive Test-connection certificate reviews, keyed by the
/// test's `connect_id` (#4510). The reviewer registers a reply channel here and
/// the `test_connection_cert_decision` command answers it with the user's
/// verdict; nothing else can produce one.
#[derive(Default)]
pub struct ProbeCertReviews {
    pending: StdMutex<HashMap<String, (u64, oneshot::Sender<CertReview>)>>,
    next_ticket: std::sync::atomic::AtomicU64,
}

impl ProbeCertReviews {
    /// Register a review for `connect_id`, replacing (and so rejecting) any
    /// earlier one. The returned guard unregisters it on drop.
    pub(crate) fn register(&self, connect_id: &str) -> PendingReview<'_> {
        let ticket = self
            .next_ticket
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.lock().insert(connect_id.to_string(), (ticket, tx));
        PendingReview {
            reviews: self,
            connect_id: connect_id.to_string(),
            ticket,
            rx,
        }
    }

    /// Deliver the user's verdict for `connect_id`. Returns whether a review was
    /// waiting for it (a late answer after a timeout or cancel finds none).
    pub(crate) fn decide(&self, connect_id: &str, review: CertReview) -> bool {
        match self.lock().remove(connect_id) {
            Some((_, tx)) => tx.send(review).is_ok(),
            None => false,
        }
    }

    /// Whether a review is waiting for `connect_id`.
    #[cfg(test)]
    pub(crate) fn is_pending(&self, connect_id: &str) -> bool {
        self.lock().contains_key(connect_id)
    }

    fn lock(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, (u64, oneshot::Sender<CertReview>)>> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// A registered review awaiting its verdict; unregisters itself on drop, so a
/// review that timed out or was cancelled cannot be answered afterwards.
pub(crate) struct PendingReview<'a> {
    reviews: &'a ProbeCertReviews,
    connect_id: String,
    ticket: u64,
    rx: oneshot::Receiver<CertReview>,
}

impl PendingReview<'_> {
    /// The user's verdict, or `None` when the review was replaced without one.
    pub(crate) async fn verdict(&mut self) -> Option<CertReview> {
        (&mut self.rx).await.ok()
    }
}

impl Drop for PendingReview<'_> {
    fn drop(&mut self) {
        let mut pending = self.reviews.lock();
        // Only remove our own entry: a newer review for the same id replaced it.
        if pending
            .get(&self.connect_id)
            .is_some_and(|(ticket, _)| *ticket == self.ticket)
        {
            pending.remove(&self.connect_id);
        }
    }
}

/// Await `backend`'s definitive connect outcome for a Test connection.
///
/// - `Ok(())` once the session is established (reachable, certificate trusted,
///   credentials accepted).
/// - The backend's typed error when it gave up — `ConnectionFailed`
///   (unreachable), `AuthFailed`, or a classified timeout.
/// - [`ConnectFailureKind::Timeout`] when `timeout` elapses first.
/// - [`ConnectFailureKind::HostKeyUntrusted`] when the server presents a
///   certificate the trust store does not already trust for `host` and either
///   there is no `reviewer` or the user did not accept it (#4510).
/// - The usual "Connection cancelled" when `cancel` fires.
///
/// When the user accepts a certificate through `reviewer`, the connect timeout
/// restarts: the time spent reading the dialog does not count against the
/// server.
pub(crate) async fn await_verdict(
    backend: &dyn GraphicalBackend,
    host: &str,
    trust_store: Option<&RdpTrustStore>,
    reviewer: Option<&dyn CertReviewer>,
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
                let ctx = PromptContext { backend, host, trust_store, reviewer, cancel };
                if answer_cert_prompt(&ctx, prompt).await? == Answer::Reviewed {
                    deadline
                        .as_mut()
                        .reset(tokio::time::Instant::now() + timeout);
                }
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

/// What a certificate prompt is answered with.
struct PromptContext<'a> {
    backend: &'a dyn GraphicalBackend,
    host: &'a str,
    trust_store: Option<&'a RdpTrustStore>,
    reviewer: Option<&'a dyn CertReviewer>,
    cancel: &'a CancellationToken,
}

/// How an accepted certificate was accepted.
#[derive(Debug, PartialEq, Eq)]
enum Answer {
    /// The trust store already trusted it.
    Remembered,
    /// The user accepted it in the review dialog.
    Reviewed,
}

/// Why a reviewed certificate was not accepted.
enum Declined {
    /// The user rejected it (or closed the dialog).
    Rejected,
    /// No verdict arrived within [`CERT_REVIEW_TIMEOUT`].
    TimedOut,
    /// The Test was cancelled while the dialog was open.
    Cancelled,
}

/// Accept a certificate the trust store already trusts for `host`. Any other
/// certificate is put to the user when there is a reviewer, and accepted only
/// on their explicit verdict; otherwise it is declined and the probe fails with
/// the typed "not trusted" kind.
async fn answer_cert_prompt(
    ctx: &PromptContext<'_>,
    prompt: CertPrompt,
) -> Result<Answer, SessionError> {
    let PromptContext {
        backend,
        host,
        trust_store,
        reviewer,
        cancel,
    } = *ctx;
    let lookup = trust_store.map_or(TrustLookup::Unknown, |store| {
        store.lookup(host, &prompt.fingerprint)
    });
    if lookup == TrustLookup::Trusted {
        debug!(
            host,
            "test connection: accepting remembered RDP certificate"
        );
        backend.send_cert_decision(true, false).await?;
        return Ok(Answer::Remembered);
    }
    let changed = lookup == TrustLookup::Changed;

    let declined = match reviewer {
        Some(reviewer) => {
            let request = CertReviewRequest {
                host: host.to_string(),
                fingerprint: prompt.fingerprint.clone(),
                subject: prompt.subject.clone(),
                issuer: prompt.issuer.clone(),
                changed,
            };
            let verdict = tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(Declined::Cancelled),
                verdict = tokio::time::timeout(CERT_REVIEW_TIMEOUT, reviewer.review(request)) => {
                    match verdict {
                        Ok(Some(CertReview { accept: true, remember })) => Ok(remember),
                        Ok(_) => Err(Declined::Rejected),
                        Err(_) => Err(Declined::TimedOut),
                    }
                }
            };
            match verdict {
                Ok(remember) => {
                    // Persist through the same trust store a real connect's
                    // "Accept for host" writes (`cert_decision`), before handing
                    // the verdict down.
                    if remember {
                        if let Some(store) = trust_store {
                            store.remember(host, &prompt.fingerprint);
                        }
                    }
                    info!(
                        host,
                        remember, "test connection: user accepted the RDP certificate"
                    );
                    backend.send_cert_decision(true, remember).await?;
                    return Ok(Answer::Reviewed);
                }
                Err(declined) => Some(declined),
            }
        }
        None => None,
    };

    if let Err(e) = backend.send_cert_decision(false, false).await {
        warn!(error = %e, "test connection: failed to decline the RDP certificate");
    }
    if matches!(declined, Some(Declined::Cancelled)) {
        return Err(SessionError::SpawnFailed(
            "Connection cancelled".to_string(),
        ));
    }
    let fingerprint = &prompt.fingerprint;
    let message = match declined {
        Some(Declined::Rejected) => format!(
            "You did not accept the certificate of {host} (fingerprint {fingerprint}), so the \
             test stopped before checking the credentials. Nothing was trusted."
        ),
        Some(Declined::TimedOut) => format!(
            "The certificate of {host} (fingerprint {fingerprint}) was not reviewed within {}s, \
             so the test stopped before checking the credentials. Nothing was trusted.",
            CERT_REVIEW_TIMEOUT.as_secs()
        ),
        _ if changed => format!(
            "The certificate of {host} changed since you trusted it (fingerprint {fingerprint}). \
             This can mean someone is intercepting the connection. Connect to review it."
        ),
        _ => format!(
            "The certificate of {host} is not trusted yet (fingerprint {fingerprint}). The \
             server is reachable; connect once to review and accept the certificate."
        ),
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

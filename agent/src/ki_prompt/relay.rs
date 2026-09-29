//! Session-daemon ↔ worker relay for keyboard-interactive prompts (#3375).
//!
//! A persistent SSH session is connected by a separate **session daemon**
//! process (`termihub-agent --daemon`), not by the worker that talks to the
//! desktop. Before spawning such a daemon, the worker binds a per-session
//! current-user-only endpoint ([`KiRelaySession::start`]) and exports it as
//! [`KI_PROMPT_ENDPOINT_ENV`]. The daemon registers a [`DaemonRelayPrompter`]
//! that sends each round to the worker over that endpoint; the worker asks its
//! [`KiPromptHub`] (→ the desktop) and writes the answer back.
//!
//! The endpoint is exported only when the worker's hub is
//! [available](KiPromptHub::is_available) — a desktop that advertised prompt
//! support is attached — so a daemon spawned for an older desktop registers no
//! prompter and keeps the pre-#3375 behavior.
//!
//! ## Frames
//!
//! Each exchange is one short-lived connection using the daemon frame format
//! (`[type: u8][len: u32 BE][payload]`, see [`crate::daemon::protocol`]):
//!
//! | Type | Direction | Payload |
//! | --- | --- | --- |
//! | [`FRAME_PROMPT`] | daemon → worker | [`RelayPrompt`] JSON |
//! | [`FRAME_ANSWER`] | worker → daemon | `{"responses": [..] \| null}` |
//! | [`FRAME_FAILURE`] | daemon → worker | [`RelayFailure`] JSON — why the connect failed |
//! | [`FRAME_ACK`] | worker → daemon | empty — failure recorded |
//!
//! The failure report lets the worker surface a cancelled prompt or a rejected
//! second factor as a **typed** `connection.create` error rather than an
//! opaque "daemon exited" message. The daemon waits for the ack before exiting
//! so the worker records the reason before it notices the exit.
//!
//! ## Connect-failure reports for every daemon launch (#3751)
//!
//! The same endpoint also carries a classified connect failure (a core
//! [`ConnectFailureKind`] — timeout, SSH-agent auth, serial port missing /
//! denied / busy — plus its human message). The worker starts the relay for
//! **every** daemon launch and exports it as [`CONNECT_REPORT_ENDPOINT_ENV`];
//! [`KI_PROMPT_ENDPOINT_ENV`] (which installs the prompter) is still exported
//! only for SSH with a prompt-capable desktop. The worker turns a reported kind
//! into a [`ClassifiedConnectFailure`], which `connection.create` relays to the
//! desktop in its error `data`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use termihub_core::backends::ssh::keyboard_interactive::{
    KbdInteractiveAnswer, KbdInteractivePrompt, KbdInteractiveRequest, KeyboardInteractivePrompter,
};
use termihub_core::errors::{ConnectFailureKind, SessionError};
use termihub_core::protocol::methods::KbdInteractivePromptItem;
use tracing::{debug, warn};
use zeroize::Zeroizing;

use super::{KiPromptHub, PromptActivity};
use crate::daemon::protocol::{read_frame_async, write_frame_async};
use crate::daemon::transport::{BoxedReader, BoxedWriter, DaemonListener};

/// Env var carrying the worker's prompt-relay endpoint to a session daemon.
pub const KI_PROMPT_ENDPOINT_ENV: &str = "TERMIHUB_KI_PROMPT_ENDPOINT";

/// Env var carrying the worker's relay endpoint to a session daemon for its
/// connect-failure report (#3751). Exported for every daemon launch, unlike
/// [`KI_PROMPT_ENDPOINT_ENV`], so a serial or non-prompting SSH daemon can
/// still say *why* its connect failed.
pub const CONNECT_REPORT_ENDPOINT_ENV: &str = "TERMIHUB_CONNECT_REPORT_ENDPOINT";

/// Daemon → worker: a round to answer ([`RelayPrompt`] JSON).
pub const FRAME_PROMPT: u8 = 0x01;
/// Daemon → worker: the connect failed for a typed reason ([`RelayFailure`]).
pub const FRAME_FAILURE: u8 = 0x02;
/// Worker → daemon: the answer (`{"responses": [..] | null}`).
pub const FRAME_ANSWER: u8 = 0x81;
/// Worker → daemon: the failure report was recorded.
pub const FRAME_ACK: u8 = 0x82;

/// Bound on the daemon's best-effort failure report (connect + ack).
const FAILURE_REPORT_TIMEOUT: Duration = Duration::from_secs(3);
/// Bound on a relay connection's first frame arriving at the worker.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(10);

/// A round as sent daemon → worker.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayPrompt {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<KbdInteractivePromptItem>,
    pub round: u32,
}

impl RelayPrompt {
    fn from_request(request: &KbdInteractiveRequest) -> Self {
        Self {
            host: request.host.clone(),
            port: request.port,
            username: request.username.clone(),
            name: request.name.clone(),
            instructions: request.instructions.clone(),
            prompts: request
                .prompts
                .iter()
                .map(|p| KbdInteractivePromptItem {
                    prompt: p.prompt.clone(),
                    echo: p.echo,
                })
                .collect(),
            round: request.round,
        }
    }

    fn into_request(self) -> KbdInteractiveRequest {
        KbdInteractiveRequest {
            host: self.host,
            port: self.port,
            username: self.username,
            name: self.name,
            instructions: self.instructions,
            prompts: self
                .prompts
                .into_iter()
                .map(|p| KbdInteractivePrompt {
                    prompt: p.prompt,
                    echo: p.echo,
                })
                .collect(),
            round: self.round,
            via: None,
        }
    }
}

/// Answer as parsed by the daemon. Deliberately not `Debug`.
#[derive(Deserialize)]
struct RelayAnswer {
    responses: Option<Vec<String>>,
}

/// Answer as serialized by the worker, borrowing the zeroizing strings so no
/// unwiped copy is made.
#[derive(Serialize)]
struct RelayAnswerRef<'a> {
    responses: Option<Vec<&'a str>>,
}

/// Why an SSH connect failed, when that reason must reach the desktop typed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KiFailureKind {
    /// The user cancelled a keyboard-interactive prompt.
    AuthCancelled,
    /// A user-typed later factor (OTP) was rejected after an earlier factor
    /// was accepted — the saved password must be kept (#3376).
    SecondFactorFailed,
}

impl KiFailureKind {
    /// The typed reason carried by `error`, if any.
    pub fn from_session_error(error: &SessionError) -> Option<Self> {
        match error {
            SessionError::AuthCancelled => Some(Self::AuthCancelled),
            SessionError::SecondFactorFailed => Some(Self::SecondFactorFailed),
            _ => None,
        }
    }

    fn as_session_error(self) -> SessionError {
        match self {
            Self::AuthCancelled => SessionError::AuthCancelled,
            Self::SecondFactorFailed => SessionError::SecondFactorFailed,
        }
    }
}

/// The daemon's failure report: a prompt outcome, or a classified connect
/// failure with its human message (#3751). Every member is optional so either
/// shape parses.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayFailure {
    /// A keyboard-interactive outcome (#3375).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<KiFailureKind>,
    /// The typed connect-failure category (#3751).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect_failure: Option<ConnectFailureKind>,
    /// The human-readable connect error, shown to the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl RelayFailure {
    /// The report for `error`, or `None` when the error carries no typed
    /// reason the desktop needs (it then sees today's generic failure).
    pub fn from_session_error(error: &SessionError) -> Option<Self> {
        if let Some(kind) = KiFailureKind::from_session_error(error) {
            return Some(Self {
                kind: Some(kind),
                ..Self::default()
            });
        }
        let connect_failure = relayed_connect_failure_kind(error)?;
        Some(Self {
            kind: None,
            connect_failure: Some(connect_failure),
            message: Some(error.to_string()),
        })
    }

    /// The typed create error this report stands for, if any.
    pub fn into_error(self) -> Option<anyhow::Error> {
        if let Some(kind) = self.kind {
            return Some(anyhow::Error::new(KiConnectFailure(kind)));
        }
        let kind = self.connect_failure?;
        Some(anyhow::Error::new(ClassifiedConnectFailure {
            kind,
            message: self.message.unwrap_or_else(|| kind.code().to_string()),
        }))
    }
}

/// The connect-failure kind an agent relays to the desktop for `error`: its
/// classified kind (#3751), or `auth_failed` for a genuine credential rejection
/// (#3089) — both decided from the typed error, never from message text. A
/// hop-labelled jump-host failure is `SpawnFailed`/classified by then, so a
/// bastion's rejection is never relayed as the target's.
pub fn relayed_connect_failure_kind(error: &SessionError) -> Option<ConnectFailureKind> {
    match error {
        SessionError::AuthFailed => Some(ConnectFailureKind::AuthFailed),
        other => other.connect_failure_kind(),
    }
}

/// A connect failure with a typed [`ConnectFailureKind`] (I18N-009, #3751),
/// carried through `anyhow` from a session backend bring-up — a session
/// daemon's report or an in-process connect — to `connection.create`'s error
/// mapping, which relays the kind to the desktop in the error `data`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifiedConnectFailure {
    /// The failure category.
    pub kind: ConnectFailureKind,
    /// The human-readable message (displayed verbatim).
    pub message: String,
}

impl std::fmt::Display for ClassifiedConnectFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ClassifiedConnectFailure {}

/// A connect failure with a typed reason, carried through `anyhow` from the
/// session backend bring-up to `connection.create`'s error mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KiConnectFailure(pub KiFailureKind);

impl std::fmt::Display for KiConnectFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0.as_session_error())
    }
}

impl std::error::Error for KiConnectFailure {}

// ── Worker side ─────────────────────────────────────────────────────

/// The worker's per-session relay endpoint, live while the session's daemon
/// connects. Dropping it stops accepting and removes the endpoint.
pub struct KiRelaySession {
    endpoint: String,
    activity: Arc<PromptActivity>,
    failure: Arc<Mutex<Option<RelayFailure>>>,
    task: tokio::task::JoinHandle<()>,
}

impl KiRelaySession {
    /// Bind `endpoint` and start relaying rounds for `session_id` to `hub`.
    pub async fn start(
        hub: Arc<KiPromptHub>,
        session_id: &str,
        endpoint: String,
    ) -> std::io::Result<Self> {
        let mut listener = DaemonListener::bind(&endpoint).await?;
        let activity = PromptActivity::new();
        let failure = Arc::new(Mutex::new(None));
        let task = {
            let activity = activity.clone();
            let failure = failure.clone();
            let session_id = session_id.to_string();
            tokio::spawn(async move {
                let mut connections = tokio::task::JoinSet::new();
                loop {
                    let (reader, writer) = match listener.accept().await {
                        Ok(halves) => halves,
                        Err(e) => {
                            warn!(session_id, "prompt relay accept failed: {e}");
                            break;
                        }
                    };
                    connections.spawn(serve_connection(
                        reader,
                        writer,
                        hub.clone(),
                        session_id.clone(),
                        activity.clone(),
                        failure.clone(),
                    ));
                    // Reap finished exchanges so the set does not grow.
                    while connections.try_join_next().is_some() {}
                }
                listener.cleanup();
            })
        };
        Ok(Self {
            endpoint,
            activity,
            failure,
            task,
        })
    }

    /// The endpoint to export to the daemon.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Outstanding-prompt tracker for this session's connect.
    pub fn activity(&self) -> Arc<PromptActivity> {
        self.activity.clone()
    }

    /// The keyboard-interactive reason the daemon reported for a failed
    /// connect, if any.
    #[cfg(test)]
    pub fn failure(&self) -> Option<KiFailureKind> {
        self.report().and_then(|r| r.kind)
    }

    /// The daemon's whole failure report, if it sent one.
    pub fn report(&self) -> Option<RelayFailure> {
        self.failure
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The typed create error for the daemon's report — a prompt outcome or a
    /// classified connect failure (#3751) — if it sent one.
    pub fn failure_error(&self) -> Option<anyhow::Error> {
        self.report().and_then(RelayFailure::into_error)
    }
}

impl Drop for KiRelaySession {
    fn drop(&mut self) {
        // Aborting drops the listener and every in-flight exchange (whose
        // `ask` futures then close their desktop dialogs).
        self.task.abort();
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&self.endpoint);
        }
    }
}

/// Serve one daemon connection: a prompt round or a failure report.
async fn serve_connection(
    mut reader: BoxedReader,
    mut writer: BoxedWriter,
    hub: Arc<KiPromptHub>,
    session_id: String,
    activity: Arc<PromptActivity>,
    failure: Arc<Mutex<Option<RelayFailure>>>,
) {
    let frame = match tokio::time::timeout(FIRST_FRAME_TIMEOUT, read_frame_async(&mut reader)).await
    {
        Ok(Ok(Some(frame))) => frame,
        _ => return,
    };
    match frame.msg_type {
        FRAME_PROMPT => {
            let Ok(prompt) = serde_json::from_slice::<RelayPrompt>(&frame.payload) else {
                warn!(session_id, "malformed prompt relay frame");
                return;
            };
            let request = prompt.into_request();
            let _outstanding = activity.begin();
            let answer = tokio::select! {
                answer = hub.ask(&request, Some(session_id.clone())) => answer,
                // The daemon gave up (prompt timeout / connect aborted) and
                // closed the connection: drop the round, which closes the
                // desktop dialog.
                _ = read_frame_async(&mut reader) => {
                    debug!(session_id, "daemon abandoned a keyboard-interactive round");
                    return;
                }
            };
            let payload = match &answer {
                KbdInteractiveAnswer::Responses(r) => serde_json::to_vec(&RelayAnswerRef {
                    responses: Some(r.iter().map(|s| s.as_str()).collect()),
                }),
                KbdInteractiveAnswer::Cancelled => {
                    serde_json::to_vec(&RelayAnswerRef { responses: None })
                }
            };
            if let Ok(payload) = payload {
                let payload = Zeroizing::new(payload);
                let _ = write_frame_async(&mut writer, FRAME_ANSWER, &payload).await;
            }
        }
        FRAME_FAILURE => {
            if let Ok(report) = serde_json::from_slice::<RelayFailure>(&frame.payload) {
                *failure.lock().unwrap_or_else(|e| e.into_inner()) = Some(report);
            }
            let _ = write_frame_async(&mut writer, FRAME_ACK, &[]).await;
        }
        other => warn!(session_id, "unknown prompt relay frame 0x{other:02x}"),
    }
}

// ── Daemon side ─────────────────────────────────────────────────────

/// Connect to the worker's relay endpoint. It was bound before the daemon was
/// spawned, so a live worker accepts at once — use the short fail-fast connect
/// rather than the spawn-path wait.
async fn connect_to_worker(endpoint: &str) -> std::io::Result<(BoxedReader, BoxedWriter)> {
    crate::daemon::transport::connect_for_recovery(endpoint).await
}

/// Core prompter for a session daemon: relays each round to the spawning
/// worker over [`KI_PROMPT_ENDPOINT_ENV`].
pub struct DaemonRelayPrompter {
    endpoint: String,
}

impl DaemonRelayPrompter {
    /// Prompter relaying to `endpoint`.
    pub fn new(endpoint: String) -> Self {
        Self { endpoint }
    }

    async fn exchange(&self, request: &KbdInteractiveRequest) -> std::io::Result<KiAnswerOrClosed> {
        let (mut reader, mut writer) = connect_to_worker(&self.endpoint).await?;
        let payload = serde_json::to_vec(&RelayPrompt::from_request(request))
            .map_err(std::io::Error::other)?;
        write_frame_async(&mut writer, FRAME_PROMPT, &payload).await?;
        let Some(frame) = read_frame_async(&mut reader).await? else {
            return Ok(KiAnswerOrClosed::Closed);
        };
        let payload = Zeroizing::new(frame.payload);
        if frame.msg_type != FRAME_ANSWER {
            return Ok(KiAnswerOrClosed::Closed);
        }
        let answer: RelayAnswer =
            serde_json::from_slice(&payload).map_err(std::io::Error::other)?;
        Ok(KiAnswerOrClosed::Answer(match answer.responses {
            Some(r) => KbdInteractiveAnswer::Responses(r.into_iter().map(Zeroizing::new).collect()),
            None => KbdInteractiveAnswer::Cancelled,
        }))
    }
}

enum KiAnswerOrClosed {
    Answer(KbdInteractiveAnswer),
    Closed,
}

#[async_trait]
impl KeyboardInteractivePrompter for DaemonRelayPrompter {
    async fn prompt(&self, request: &KbdInteractiveRequest) -> KbdInteractiveAnswer {
        match self.exchange(request).await {
            Ok(KiAnswerOrClosed::Answer(answer)) => answer,
            // The worker (and so the desktop) went away mid-prompt: nobody can
            // answer, which ends the exchange like a cancel.
            Ok(KiAnswerOrClosed::Closed) => KbdInteractiveAnswer::Cancelled,
            Err(e) => {
                warn!("keyboard-interactive prompt relay failed: {e}");
                KbdInteractiveAnswer::Cancelled
            }
        }
    }
}

/// Register a [`DaemonRelayPrompter`] when the spawning worker exported a relay
/// endpoint, returning that endpoint (for [`report_connect_failure`]).
pub fn install_daemon_prompter_from_env() -> Option<String> {
    let endpoint = std::env::var(KI_PROMPT_ENDPOINT_ENV)
        .ok()
        .filter(|e| !e.is_empty())?;
    termihub_core::backends::ssh::keyboard_interactive::set_keyboard_interactive_prompter(
        Arc::new(DaemonRelayPrompter::new(endpoint.clone())),
    );
    Some(endpoint)
}

/// The endpoint a session daemon reports its connect failure to (#3751): the
/// dedicated [`CONNECT_REPORT_ENDPOINT_ENV`], else the prompt relay endpoint.
pub fn connect_report_endpoint_from_env(ki_prompt_endpoint: Option<&str>) -> Option<String> {
    std::env::var(CONNECT_REPORT_ENDPOINT_ENV)
        .ok()
        .filter(|e| !e.is_empty())
        .or_else(|| ki_prompt_endpoint.map(str::to_string))
}

/// Best-effort: tell the worker why the connect failed, when the reason is one
/// the desktop must see typed — a prompt outcome (#3375) or a classified
/// connect failure (#3751). Waits (bounded) for the worker's ack so the report
/// lands before the daemon exits.
pub async fn report_connect_failure(endpoint: &str, error: &SessionError) {
    let Some(failure) = RelayFailure::from_session_error(error) else {
        return;
    };
    let report = async {
        let (mut reader, mut writer) = connect_to_worker(endpoint).await?;
        let payload = serde_json::to_vec(&failure).map_err(std::io::Error::other)?;
        write_frame_async(&mut writer, FRAME_FAILURE, &payload).await?;
        let _ack = read_frame_async(&mut reader).await?;
        Ok::<_, std::io::Error>(())
    };
    match tokio::time::timeout(FAILURE_REPORT_TIMEOUT, report).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => debug!("could not report the connect failure to the worker: {e}"),
        Err(_) => debug!("timed out reporting the connect failure to the worker"),
    }
}

#[cfg(test)]
mod tests;

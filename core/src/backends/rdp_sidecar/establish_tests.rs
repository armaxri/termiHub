//! `wait_until_established` — the definitive connect verdict Test connection
//! awaits for RDP (#4320, PARITY2-001). Driven over an in-memory pipe standing
//! in for the sidecar's stdout, so no helper binary or RDP server is needed.

use std::time::Duration;

use super::*;

/// The sidecar end of the pipe, the shared state the waiter observes, and the
/// frame receiver (held so the reader keeps running).
type Harness = (
    tokio::io::DuplexStream,
    Arc<SidecarShared>,
    mpsc::Receiver<crate::connection::FrameUpdate>,
);

/// Spawn the reader over an in-memory pipe standing in for the sidecar.
fn spawn_reader() -> Harness {
    let (sidecar_stdout, host_read) = tokio::io::duplex(1024 * 1024);
    let (frame_tx, frame_rx) = mpsc::channel(CHANNEL_DEPTH);
    let (cursor_tx, _cursor_rx) = mpsc::channel(CHANNEL_DEPTH);
    let (cert_tx, _cert_rx) = mpsc::channel(CHANNEL_DEPTH);
    let shared = Arc::new(SidecarShared::new(false, None));
    tokio::spawn(run_reader(
        host_read,
        frame_tx,
        cursor_tx,
        cert_tx,
        shared.clone(),
        CancellationToken::new(),
    ));
    (sidecar_stdout, shared, frame_rx)
}

/// Script the sidecar's output (then EOF) and return the waiter's verdict.
async fn verdict_after(script: Vec<SidecarMessage>, eof: bool) -> Result<(), SessionError> {
    let (mut sidecar_stdout, shared, _frames) = spawn_reader();
    let waiter = {
        let shared = shared.clone();
        tokio::spawn(async move { shared.wait_until_established().await })
    };
    for msg in &script {
        write_message(&mut sidecar_stdout, msg).await.unwrap();
    }
    if eof {
        drop(sidecar_stdout);
    }
    tokio::time::timeout(Duration::from_secs(5), waiter)
        .await
        .expect("the waiter must resolve")
        .expect("join")
}

#[tokio::test]
async fn an_active_session_is_established() {
    let verdict = verdict_after(
        vec![
            SidecarMessage::State(GraphicalState::Connecting),
            SidecarMessage::State(GraphicalState::Authenticating),
            SidecarMessage::State(GraphicalState::Active),
        ],
        false,
    )
    .await;
    assert!(verdict.is_ok(), "{verdict:?}");
}

/// A closed port: the sidecar's TCP connect is refused, it reports a typed
/// connect failure and exits — Test reports it unreachable.
#[tokio::test]
async fn a_refused_connect_reports_connection_failed() {
    let verdict = verdict_after(
        vec![
            SidecarMessage::State(GraphicalState::ConnectFailed),
            SidecarMessage::Failure {
                kind: SidecarFailureKind::Connect,
                message: "RDP TCP connect to h:1 failed: connection refused".to_string(),
            },
            SidecarMessage::Error("connection refused".to_string()),
        ],
        true,
    )
    .await;
    match verdict {
        Err(SessionError::ConnectionFailed(msg)) => assert!(msg.contains("refused"), "{msg}"),
        other => panic!("expected ConnectionFailed, got {other:?}"),
    }
}

#[tokio::test]
async fn a_rejected_credential_reports_auth_failed() {
    let verdict = verdict_after(
        vec![
            SidecarMessage::Failure {
                kind: SidecarFailureKind::Auth,
                message: "logon failure".to_string(),
            },
            SidecarMessage::Error("logon failure".to_string()),
        ],
        true,
    )
    .await;
    assert!(
        matches!(verdict, Err(SessionError::AuthFailed)),
        "{verdict:?}"
    );
}

/// A peer that accepts TCP but never speaks RDP: the sidecar's connect timeout
/// fires and it reports the typed timeout kind.
#[tokio::test]
async fn a_sidecar_timeout_reports_the_typed_timeout_kind() {
    let verdict = verdict_after(
        vec![
            SidecarMessage::Failure {
                kind: SidecarFailureKind::Timeout,
                message: "RDP connect to h:3389 timed out after 30s".to_string(),
            },
            SidecarMessage::Error("timed out".to_string()),
        ],
        true,
    )
    .await;
    match verdict {
        Err(SessionError::Classified { kind, message }) => {
            assert_eq!(kind, ConnectFailureKind::Timeout);
            assert!(message.contains("timed out"), "{message}");
        }
        other => panic!("expected a classified timeout, got {other:?}"),
    }
}

/// A sidecar that dies (a panic, an older helper) without a typed reason still
/// fails the wait instead of hanging or passing.
#[tokio::test]
async fn an_untyped_exit_before_active_is_a_connection_failure() {
    let verdict = verdict_after(
        vec![SidecarMessage::State(GraphicalState::Connecting)],
        true,
    )
    .await;
    assert!(
        matches!(verdict, Err(SessionError::ConnectionFailed(_))),
        "{verdict:?}"
    );
}

/// While the negotiation is still running the waiter stays pending — the
/// caller's own timeout and cancel bound it.
#[tokio::test]
async fn the_wait_stays_pending_while_the_negotiation_runs() {
    let (mut sidecar_stdout, shared, _frames) = spawn_reader();
    write_message(
        &mut sidecar_stdout,
        &SidecarMessage::State(GraphicalState::Authenticating),
    )
    .await
    .unwrap();
    let pending =
        tokio::time::timeout(Duration::from_millis(100), shared.wait_until_established()).await;
    assert!(
        pending.is_err(),
        "the wait must not resolve yet: {pending:?}"
    );
}

#[tokio::test]
async fn a_disconnected_backend_is_not_running() {
    let verdict = GraphicalBackend::wait_until_established(&SidecarRdp::new()).await;
    assert!(
        matches!(verdict, Err(SessionError::NotRunning(_))),
        "{verdict:?}"
    );
}

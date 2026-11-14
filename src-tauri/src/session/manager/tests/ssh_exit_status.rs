//! A direct SSH tab reports the remote shell's exit status (#5801).
//!
//! The real SSH backend runs against the in-process test server, whose shell
//! ends the ways a real host does. `exit 5` ends the tab with
//! "[Process exited with code 5]" and is never reconnected, even on a
//! resilient tab; `exit` (0) ends it cleanly. A lost link or a hangup carries
//! no status, so a resilient tab still reconnects.

use super::*;

use std::time::{Duration, Instant};

use termihub_core::backends::ssh::host_key::{set_host_key_verifier, HostKeyInfo, HostKeyVerifier};
use termihub_core::backends::ssh::ki_test_server::{
    serve_tcp, PasswordPolicy, Script, TcpServer, SHELL_BANNER, SHELL_DROP_LINK, SHELL_HANGUP,
};
use termihub_core::connection::SessionEndCause;

use crate::session::registry::build_desktop_registry;

/// Upper bound for one wait. The exit usually lands within milliseconds.
const CEILING: Duration = Duration::from_secs(20);

const PASSWORD: &str = "exit-status-pass";

/// The throwaway test server's host key is unknown; trust it (process-wide,
/// first registration wins, same as the other src-tauri SSH tests).
fn trust_all_host_keys() {
    struct TrustAll;
    #[async_trait::async_trait]
    impl HostKeyVerifier for TrustAll {
        async fn verify(&self, _info: &HostKeyInfo) -> bool {
            true
        }
    }
    let _ = set_host_key_verifier(Arc::new(TrustAll));
}

async fn server() -> TcpServer {
    trust_all_host_keys();
    serve_tcp(Script {
        rounds: Vec::new(),
        password: PasswordPolicy::Sole(PASSWORD),
    })
    .await
    .expect("start the in-process SSH server")
}

/// Open a direct SSH tab on `server`, `resilient` as the client computes it,
/// and wait for its shell.
async fn open_tab(
    manager: &SessionManager,
    emitter: &MockEventEmitter,
    server: &TcpServer,
    resilient: bool,
) -> String {
    let session_id = manager
        .create_connection(
            "ssh",
            serde_json::json!({
                "host": "127.0.0.1",
                "port": server.addr.port(),
                "username": "exit-status-user",
                "authMethod": "password",
                "password": PASSWORD,
                "shellIntegration": false,
            }),
            None,
            Some("tab-1:0"),
            false,
            resilient,
            emitter.clone(),
        )
        .await
        .expect("the SSH tab opens");
    let deadline = Instant::now() + CEILING;
    while !output_text(emitter).contains(SHELL_BANNER) {
        assert!(Instant::now() < deadline, "the shell never started");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    session_id
}

fn output_text(emitter: &MockEventEmitter) -> String {
    emitter
        .outputs
        .lock()
        .unwrap()
        .iter()
        .map(|e| String::from_utf8_lossy(&e.data).into_owned())
        .collect()
}

async fn wait_for_exit(emitter: &MockEventEmitter, session_id: &str) -> TerminalExitEvent {
    let deadline = Instant::now() + CEILING;
    loop {
        if let Some(exit) = emitter
            .exits
            .lock()
            .unwrap()
            .iter()
            .find(|e| e.session_id == session_id)
        {
            return exit.clone();
        }
        assert!(
            Instant::now() < deadline,
            "no terminal-exit for {session_id}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The tab's drop folds once its session is gone from the manager (the fold
/// runs just after `terminal-exit`, before the entry is removed).
async fn folds_after_exit(
    manager: &SessionManager,
    emitter: &MockEventEmitter,
    session_id: &str,
) -> Vec<(String, DropFold)> {
    let deadline = Instant::now() + CEILING;
    while manager.sessions.lock().await.get(session_id).is_some() {
        assert!(Instant::now() < deadline, "{session_id} never cleaned up");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    emitter.session_drops.lock().unwrap().clone()
}

/// Type `line` into a fresh resilient SSH tab and return how it ended.
async fn end_with(line: &str) -> (TerminalExitEvent, Vec<(String, DropFold)>) {
    let server = server().await;
    let manager = SessionManager::new(build_desktop_registry(), Arc::new(FakeAgent::offline()));
    let emitter = MockEventEmitter::new();
    let session_id = open_tab(&manager, &emitter, &server, true).await;

    manager
        .send_input(&session_id, format!("{line}\r").as_bytes())
        .await
        .expect("type into the shell");

    let exit = wait_for_exit(&emitter, &session_id).await;
    let folds = folds_after_exit(&manager, &emitter, &session_id).await;
    (exit, folds)
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_with_a_code_ends_the_tab_without_a_reconnect() {
    let (exit, folds) = end_with("exit 5").await;
    assert_eq!(exit.exit_code, Some(5));
    assert_eq!(exit.end_cause, Some(SessionEndCause::RemoteClosed));
    assert_eq!(folds, vec![("tab-1".to_string(), DropFold::Dropped)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_clean_exit_ends_the_tab_cleanly() {
    let (exit, folds) = end_with("exit 0").await;
    assert_eq!(exit.exit_code, Some(0));
    assert_eq!(folds, vec![], "a clean exit folds nothing");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lost_link_still_reconnects_a_resilient_tab() {
    let (exit, folds) = end_with(SHELL_DROP_LINK).await;
    assert_eq!(exit.exit_code, None, "a lost link carries no status");
    assert_eq!(exit.end_cause, Some(SessionEndCause::IoError));
    assert_eq!(folds, vec![("tab-1".to_string(), DropFold::Reconnect)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hung_up_shell_still_reconnects_a_resilient_tab() {
    // A host going down hangs the shell up (`exit-signal HUP`): not the user
    // ending it, so the tab reconnects once the host is back.
    let (exit, folds) = end_with(SHELL_HANGUP).await;
    assert_eq!(exit.exit_code, None);
    assert_eq!(exit.end_cause, Some(SessionEndCause::RemoteClosed));
    assert_eq!(folds, vec![("tab-1".to_string(), DropFold::Reconnect)]);
}

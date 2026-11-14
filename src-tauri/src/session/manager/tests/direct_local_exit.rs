//! A direct (desktop-hosted) local shell the user exited reports its real
//! exit status on `terminal-exit` (#5784), like an agent-hosted one (#5742):
//! the tab reads "[Process exited with code N]", folds clean for `0` and
//! `dropped` otherwise, and is never reconnected — not even on a tab the
//! client marked resilient.
//!
//! Runs a real `bash` / `sh` in a scratch `HOME` / `XDG_*` / `HISTFILE`.

use super::initial_command::{env_vars, local_shell};
use super::*;

use std::time::{Duration, Instant};

/// Upper bound for one wait. A shell starts and exits within a second or so.
const CEILING: Duration = Duration::from_secs(60);

fn local_manager() -> SessionManager {
    let mut registry = termihub_core::connection::ConnectionTypeRegistry::new();
    registry.register("local", "Local Shell", "terminal", Box::new(local_shell));
    SessionManager::new(registry, Arc::new(FakeAgent::offline()))
}

fn emitted_text(emitter: &MockEventEmitter) -> String {
    let outputs = emitter.outputs.lock().unwrap();
    let all: Vec<u8> = outputs.iter().flat_map(|e| e.data.clone()).collect();
    String::from_utf8_lossy(&all).into_owned()
}

async fn eventually(mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + CEILING;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    cond()
}

/// Open a direct local shell tab, type `exit_line` once it reads input, and
/// return the `terminal-exit` and the drop folds it produced.
async fn exit_direct_shell(
    exit_line: &str,
    resilient: bool,
) -> (TerminalExitEvent, Vec<(String, DropFold)>) {
    let home = tempfile::tempdir().expect("scratch HOME");
    let home_str = home.path().to_str().expect("utf-8 temp path").to_string();
    let histfile = format!("{home_str}/.th_history");
    let shell = if termihub_core::session::shell::detect_available_shells()
        .iter()
        .any(|s| s == "bash")
    {
        "bash"
    } else {
        "sh"
    };
    let settings = serde_json::json!({
        "shell": shell,
        "envVars": env_vars(&[
            ("HOME", &home_str),
            ("ZDOTDIR", &home_str),
            ("HISTFILE", &histfile),
            ("XDG_CONFIG_HOME", &format!("{home_str}/.config")),
            ("XDG_DATA_HOME", &format!("{home_str}/.local/share")),
            ("XDG_STATE_HOME", &format!("{home_str}/.local/state")),
            ("XDG_CACHE_HOME", &format!("{home_str}/.cache")),
            ("TERM_PROGRAM", ""),
            ("SHELL_SESSION_HISTORY", "0"),
            ("BASH_SILENCE_DEPRECATION_WARNING", "1"),
        ]),
    });
    let manager = local_manager();
    let emitter = MockEventEmitter::new();
    let session_id = manager
        .create_connection(
            "local",
            settings,
            None,
            Some("tab-l:0"),
            false,
            resilient,
            emitter.clone(),
        )
        .await
        .expect("the direct local shell opens");

    manager
        .send_input_raw(&session_id, b"echo TH$((1))READY\r")
        .await
        .expect("type the probe");
    assert!(
        eventually(|| emitted_text(&emitter).contains("TH1READY")).await,
        "the shell never answered the probe: {:?}",
        emitted_text(&emitter)
    );
    manager
        .send_input_raw(&session_id, format!("{exit_line}\r").as_bytes())
        .await
        .expect("type exit");

    assert!(
        eventually(|| !emitter.exits.lock().unwrap().is_empty()).await,
        "no terminal-exit after {exit_line:?}"
    );
    let deadline = Instant::now() + CEILING;
    while manager.sessions.lock().await.get(&session_id).is_some() {
        assert!(Instant::now() < deadline, "{session_id} never cleaned up");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let exit = emitter.exits.lock().unwrap()[0].clone();
    let folds = emitter.session_drops.lock().unwrap().clone();
    (exit, folds)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[serial_test::serial(local_pty)]
async fn a_direct_shell_exited_with_a_code_reports_it_and_never_reconnects() {
    for resilient in [false, true] {
        let (exit, folds) = exit_direct_shell("exit 7", resilient).await;
        assert_eq!(exit.exit_code, Some(7), "resilient={resilient}");
        assert_eq!(exit.end_cause, None);
        assert_eq!(
            folds,
            vec![("tab-l".to_string(), DropFold::Dropped)],
            "a process exit is never a reconnect (resilient={resilient})"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[serial_test::serial(local_pty)]
async fn a_direct_shell_exited_plainly_reports_zero_and_folds_nothing() {
    let (exit, folds) = exit_direct_shell("exit", false).await;
    assert_eq!(exit.exit_code, Some(0));
    assert!(folds.is_empty(), "a clean exit folds nothing: {folds:?}");
}

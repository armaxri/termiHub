//! Application log secrecy (#1570, #4011, #4007).
//!
//! The durable application log is a file users attach to bug reports, so it
//! must never contain an SSH password, the credential-store passphrase, a sudo
//! password (elevated remote save, #1328/#1329) or anything typed into /
//! printed by a terminal. These tests drive the real code
//! paths with marker secrets while the real file sink is installed (the
//! [`RotatingLogFile`] writer, the `fmt` layer without ANSI, and the file
//! filter built by [`env_filter_for_level`]) and then grep the log file.
//!
//! The file filter is set to `trace`, the most verbose level the Settings
//! control offers, and the global `default_env_filter` envelope is left out, so
//! the file sees strictly more than any shipped configuration lets through.
//! Only an explicit `TERMIHUB_FILE_LOG=russh=trace` override (a deliberate
//! support-case escape hatch) can unclamp russh's packet logs; that is out of
//! scope here.
//!
//! The subscriber is installed as the thread default on the test thread and on
//! every thread of the test's own Tokio runtime (workers and the blocking pool,
//! via `on_thread_start`), so every task the connect spawns logs into it. Each
//! test also asserts a known line DID reach the file, so an empty log can never
//! pass for a clean one.

use super::{MockEventEmitter, NullAgent};

/// In-process SSH + SFTP + scripted-`sudo` server, so the sudo-password check
/// runs on every PR (#4007).
mod sudo_sftp_server;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::Layer;

use crate::commands::credential::guarded_unlock;
use crate::credential::{
    AutoLockTimer, CredentialKey, CredentialManager, CredentialStore, CredentialType, StorageMode,
};
use crate::session::manager::SessionManager;
use crate::session::registry::build_desktop_registry;
use crate::utils::docker_fixture_gate::fixture_ready;
use crate::utils::file_log::{env_filter_for_level, RotatingLogFile};
use termihub_core::backends::ssh::host_key::{set_host_key_verifier, HostKeyInfo, HostKeyVerifier};
use termihub_core::backends::ssh::ki_test_server::{serve_tcp, PasswordPolicy, Script};

const SSH_PASSWORD: &str = "Log-Secrecy-SSH-Pw-7f3a91";
const WRONG_PASSPHRASE: &str = "Log-Secrecy-Wrong-Passphrase-0c55e2";
const STORE_PASSPHRASE: &str = "Log-Secrecy-Store-Passphrase-b24d18";
const STORED_SECRET: &str = "Log-Secrecy-Stored-Secret-91aa4c";
/// Typed into the terminal; the test server's shell echoes it back, so it is
/// both terminal input and terminal output.
const TERMINAL_INPUT: &str = "log-secrecy-terminal-line-3e8d07";

/// The shipped file sink at `trace`, writing into `dir`.
fn file_log_dispatch(dir: &Path) -> tracing::Dispatch {
    let writer = RotatingLogFile::new(dir, "termihub", 10 * 1024 * 1024, 2).expect("open the log file");
    let filter = env_filter_for_level("trace").expect("trace is a selectable level");
    let layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(writer)
        .with_filter(filter);
    tracing::Dispatch::new(tracing_subscriber::registry().with(layer))
}

/// A multi-thread runtime (the session manager needs `block_in_place`) whose
/// every thread logs into `dispatch`.
fn runtime_logging_to(dispatch: &tracing::Dispatch) -> tokio::runtime::Runtime {
    let dispatch = dispatch.clone();
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .on_thread_start(move || {
            // The runtime's threads live exactly as long as the runtime, so the
            // guard is intentionally kept for the thread's whole life.
            std::mem::forget(tracing::dispatcher::set_default(&dispatch));
        })
        .build()
        .expect("build the test runtime")
}

/// Everything the sink wrote, across rotated generations.
fn read_log(dir: &Path) -> String {
    let mut out = String::new();
    for entry in std::fs::read_dir(dir).expect("read the log dir") {
        let path = entry.expect("log dir entry").path();
        out.push_str(&std::fs::read_to_string(&path).expect("read a log file"));
    }
    out
}

fn assert_absent(log: &str, secret: &str, what: &str) {
    assert!(
        !log.contains(secret),
        "the application log contains the {what} ({secret:?}):\n{log}"
    );
}

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

#[test]
fn ssh_password_login_and_terminal_content_stay_out_of_the_app_log() {
    let log_dir = tempfile::tempdir().expect("temp log dir");
    let dispatch = file_log_dispatch(log_dir.path());
    let _guard = tracing::dispatcher::set_default(&dispatch);
    trust_all_host_keys();
    let runtime = runtime_logging_to(&dispatch);
    runtime.block_on(ssh_password_login());
    // Dropping the runtime joins its threads, so every line is written.
    drop(runtime);

    let log = read_log(log_dir.path());
    // Positive control: the connect did log into this file.
    assert!(
        log.contains("Connecting SSH session"),
        "expected the SSH connect line in the log:\n{log}"
    );
    assert_absent(&log, SSH_PASSWORD, "SSH password");
    assert_absent(&log, TERMINAL_INPUT, "terminal input / echoed output");
}

/// Log in with a password through the session manager, type a line, see it
/// echoed, close the session.
async fn ssh_password_login() {
    let server = serve_tcp(Script {
        rounds: Vec::new(),
        password: PasswordPolicy::Sole(SSH_PASSWORD),
    })
    .await
    .expect("start the in-process SSH server");

    let manager = SessionManager::new(build_desktop_registry(), Arc::new(NullAgent));
    let emitter = MockEventEmitter::new();
    let settings = serde_json::json!({
        "host": "127.0.0.1",
        "port": server.addr.port(),
        "username": "log-secrecy-user",
        "authMethod": "password",
        "password": SSH_PASSWORD,
        "shellIntegration": false,
    });
    let session_id = manager
        .create_connection(
            "ssh",
            settings,
            None,
            Some("log-secrecy-tab:0"),
            false,
            false,
            emitter.clone(),
        )
        .await
        .expect("SSH password login through the session manager");
    assert_eq!(server.observed.lock().unwrap().authenticated, 1);

    manager
        .send_input(&session_id, format!("{TERMINAL_INPUT}\r").as_bytes())
        .await
        .expect("type into the terminal");
    let seen = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let text: String = emitter
                .outputs
                .lock()
                .unwrap()
                .iter()
                .map(|e| String::from_utf8_lossy(&e.data).into_owned())
                .collect();
            if text.contains(TERMINAL_INPUT) {
                return text;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the terminal echoes the typed line");
    assert!(seen.contains(TERMINAL_INPUT));

    manager
        .close_session(&session_id)
        .await
        .expect("close the session");
}

#[test]
fn credential_store_unlock_keeps_the_passphrase_and_secrets_out_of_the_app_log() {
    let log_dir = tempfile::tempdir().expect("temp log dir");
    let _guard = tracing::dispatcher::set_default(&file_log_dispatch(log_dir.path()));

    let config_dir = tempfile::tempdir().expect("temp config dir");
    let manager = CredentialManager::new(StorageMode::MasterPassword, config_dir.path().into());
    // The unlock command refuses without an auto-lock timer (WA-RS-004).
    let timer = AutoLockTimer::spawn_with(Arc::new(TestClock), Some(60), || {})
        .expect("spawn the auto-lock timer");
    manager.set_auto_lock_timer(timer);

    manager
        .with_master_password_store(|s| s.setup(STORE_PASSPHRASE))
        .expect("master-password mode")
        .expect("set up the store");
    let key = CredentialKey::new("log-secrecy-conn", CredentialType::Password);
    manager.set(&key, STORED_SECRET).expect("save a credential");
    manager
        .with_master_password_store(|s| s.lock())
        .expect("master-password mode");

    // A wrong passphrase first (the failure path logs too), then the real one,
    // both through the unlock command's own gate.
    assert!(guarded_unlock(&manager, WRONG_PASSPHRASE).is_err());
    guarded_unlock(&manager, STORE_PASSPHRASE).expect("unlock with the passphrase");
    assert_eq!(
        manager.get(&key).expect("read the credential").as_deref(),
        Some(STORED_SECRET)
    );
    tracing::info!("log-secrecy positive control");

    let log = read_log(log_dir.path());
    assert!(
        log.contains("log-secrecy positive control"),
        "expected the control line in the log:\n{log}"
    );
    assert_absent(&log, STORE_PASSPHRASE, "credential-store passphrase");
    assert_absent(&log, WRONG_PASSPHRASE, "mistyped passphrase");
    assert_absent(&log, STORED_SECRET, "stored credential");
}

/// The real monotonic clock (the timer never fires within the test: 60 min).
struct TestClock;

impl crate::credential::auto_lock::Clock for TestClock {
    fn now(&self) -> std::time::Instant {
        std::time::Instant::now()
    }
}

// ── Sudo password (elevated remote save, #1328 step 5 / #1329) ──────────

/// Root-owned file the `ssh-sudo` fixture ships (see `tests/docker/ssh-sudo`).
const ELEVATED_TARGET: &str = "/etc/termihub-elevated-target.txt";
/// The `ssh-sudo` fixture's account password, which is both the SSH login
/// password and the sudo password (a password-required sudoer).
const FIXTURE_SUDO_PASSWORD: &str = "testpass";
/// A rejected sudo password; the failure path logs too.
const WRONG_SUDO_PASSWORD: &str = "Log-Secrecy-Wrong-Sudo-Pw-5d19c3";

/// A wrong and then the right sudo password, through the session manager's
/// elevated save (the path the `session_write_file_elevated` command takes),
/// against the live `ssh-sudo` fixture. Neither password may reach the file
/// sink at trace.
///
/// Shares the fixture's one root-owned file with the `files::sftp`
/// elevated-save tests, so it joins their `elevated_save` serial group. Skips
/// without the container; hard-fails under `TERMIHUB_REQUIRE_DOCKER=1`.
#[test]
#[serial_test::serial(elevated_save)]
fn sudo_password_of_an_elevated_save_stays_out_of_the_app_log() {
    let port = std::env::var("TERMIHUB_TEST_SSH_SUDO_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2212);
    if !fixture_ready("ssh-sudo", port) {
        return;
    }

    let log_dir = tempfile::tempdir().expect("temp log dir");
    let dispatch = file_log_dispatch(log_dir.path());
    let _guard = tracing::dispatcher::set_default(&dispatch);
    trust_all_host_keys();
    let runtime = runtime_logging_to(&dispatch);
    runtime.block_on(elevated_save_wrong_then_right(port));
    drop(runtime);

    let log = read_log(log_dir.path());
    // Positive controls: the connect and both elevated saves logged here.
    assert!(
        log.contains("Connecting SSH session"),
        "expected the SSH connect line in the log:\n{log}"
    );
    assert_eq!(
        log.matches("SFTP elevated save: completed").count(),
        2,
        "expected both elevated saves to log their outcome:\n{log}"
    );
    assert_absent(&log, FIXTURE_SUDO_PASSWORD, "sudo / SSH password");
    assert_absent(&log, WRONG_SUDO_PASSWORD, "rejected sudo password");
}

/// Log in to the `ssh-sudo` fixture through the session manager, then save the
/// root-owned file elevated: first with a wrong sudo password, then the right.
async fn elevated_save_wrong_then_right(port: u16) {
    use termihub_core::backends::ssh::sftp_ops::ElevatedWriteResult;

    let manager = SessionManager::new(build_desktop_registry(), Arc::new(NullAgent));
    let emitter = MockEventEmitter::new();
    let settings = serde_json::json!({
        "host": "127.0.0.1",
        "port": port,
        "username": "testuser",
        "authMethod": "password",
        "password": FIXTURE_SUDO_PASSWORD,
        "shellIntegration": false,
    });
    let session_id = manager
        .create_connection(
            "ssh",
            settings,
            None,
            Some("log-secrecy-sudo-tab:0"),
            false,
            false,
            emitter,
        )
        .await
        .expect("SSH password login to the ssh-sudo fixture");

    let content = format!("log-secrecy-elevated-{}\n", uuid::Uuid::new_v4());
    let rejected = manager
        .session_write_file_elevated(&session_id, ELEVATED_TARGET, &content, WRONG_SUDO_PASSWORD)
        .await
        .expect("elevated save with a wrong password completes");
    assert_eq!(rejected, ElevatedWriteResult::IncorrectPassword);

    let saved = manager
        .session_write_file_elevated(
            &session_id,
            ELEVATED_TARGET,
            &content,
            FIXTURE_SUDO_PASSWORD,
        )
        .await
        .expect("elevated save with the right password completes");
    assert_eq!(saved, ElevatedWriteResult::Success);

    manager
        .close_session(&session_id)
        .await
        .expect("close the session");
}

// ── Sudo password, per-PR (no Docker) (#4007) ───────────────────────────

/// Root-owned file on the in-process server the elevated saves rewrite.
const IN_PROCESS_TARGET: &str = "/etc/termihub-in-process-target.conf";
/// A rejected sudo password for the in-process server.
const IN_PROCESS_WRONG_SUDO_PASSWORD: &str = "Log-Secrecy-Wrong-Sudo-Pw-e07b52";

/// The same wrong-then-right elevated save as
/// [`sudo_password_of_an_elevated_save_stays_out_of_the_app_log`], but against
/// the in-process SSH/SFTP/`sudo` server, so it runs on every PR rather than
/// only where the `ssh-sudo` container is up.
///
/// Positive controls make the check non-vacuous: the scripted `sudo` must have
/// received exactly the two passwords on stdin, the right one must really have
/// rewritten the target, and both saves must have logged their outcome. Then
/// neither sudo password nor the login password may appear in the trace-level
/// file sink.
#[test]
fn sudo_password_stays_out_of_the_app_log_against_an_in_process_server() {
    let log_dir = tempfile::tempdir().expect("temp log dir");
    let dispatch = file_log_dispatch(log_dir.path());
    let _guard = tracing::dispatcher::set_default(&dispatch);
    trust_all_host_keys();
    let runtime = runtime_logging_to(&dispatch);
    runtime.block_on(in_process_elevated_save_wrong_then_right());
    drop(runtime);

    let log = read_log(log_dir.path());
    assert!(
        log.contains("Connecting SSH session"),
        "expected the SSH connect line in the log:\n{log}"
    );
    assert_eq!(
        log.matches("SFTP elevated save: completed").count(),
        2,
        "expected both elevated saves to log their outcome:\n{log}"
    );
    assert_absent(&log, sudo_sftp_server::SUDO_PASSWORD, "sudo password");
    assert_absent(
        &log,
        IN_PROCESS_WRONG_SUDO_PASSWORD,
        "rejected sudo password",
    );
    assert_absent(&log, sudo_sftp_server::LOGIN_PASSWORD, "SSH password");
}

async fn in_process_elevated_save_wrong_then_right() {
    use sudo_sftp_server::{LOGIN_PASSWORD, SUDO_PASSWORD};
    use termihub_core::backends::ssh::sftp_ops::ElevatedWriteResult;

    let server = sudo_sftp_server::serve(&[(IN_PROCESS_TARGET, "original\n")]).await;
    let manager = SessionManager::new(build_desktop_registry(), Arc::new(NullAgent));
    let settings = serde_json::json!({
        "host": "127.0.0.1",
        "port": server.addr.port(),
        "username": "sudo-user",
        "authMethod": "password",
        "password": LOGIN_PASSWORD,
        "shellIntegration": false,
    });
    let session_id = manager
        .create_connection(
            "ssh",
            settings,
            None,
            Some("log-secrecy-in-process-sudo-tab:0"),
            false,
            false,
            MockEventEmitter::new(),
        )
        .await
        .expect("SSH password login to the in-process server");

    let content = format!("in-process-elevated-{}\n", uuid::Uuid::new_v4());
    let rejected = manager
        .session_write_file_elevated(
            &session_id,
            IN_PROCESS_TARGET,
            &content,
            IN_PROCESS_WRONG_SUDO_PASSWORD,
        )
        .await
        .expect("elevated save with a wrong password completes");
    assert_eq!(rejected, ElevatedWriteResult::IncorrectPassword);

    let saved = manager
        .session_write_file_elevated(&session_id, IN_PROCESS_TARGET, &content, SUDO_PASSWORD)
        .await
        .expect("elevated save with the right password completes");
    assert_eq!(saved, ElevatedWriteResult::Success);

    manager
        .close_session(&session_id)
        .await
        .expect("close the session");

    let observed = server.observed.lock().expect("observed");
    // The passwords really travelled to sudo — and only on its stdin.
    assert_eq!(
        observed.sudo_stdin,
        vec![
            format!("{IN_PROCESS_WRONG_SUDO_PASSWORD}\n"),
            format!("{SUDO_PASSWORD}\n"),
        ]
    );
    for command in &observed.commands {
        assert!(
            !command.contains(SUDO_PASSWORD) && !command.contains(IN_PROCESS_WRONG_SUDO_PASSWORD),
            "a sudo password reached a remote command line: {command}"
        );
    }
    // The right password rewrote the target; no temp upload was left behind.
    assert_eq!(
        observed.files.get(IN_PROCESS_TARGET).map(Vec::as_slice),
        Some(content.as_bytes())
    );
    let leftovers: Vec<_> = observed
        .files
        .keys()
        .filter(|p| p.starts_with("/tmp/termihub-"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "temp uploads left behind: {leftovers:?}"
    );
}

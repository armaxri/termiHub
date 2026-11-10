//! Deploy / update / rollback against an in-process SSH + SFTP host (#5162).
//!
//! Each test drives the production install path ([`install_agent_bytes`] and
//! its upload/rollback helpers) over a real russh session to the fake host in
//! [`super::fake_host`], then asserts what is left on the "remote": either the
//! new binary installed, or the previous binary intact and nothing
//! half-written in the upload dir.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use termihub_core::backends::ssh::handler::SshSession;
use tokio_util::sync::CancellationToken;

use super::fake_host::{self, broken_binary, fake_binary, HostState, DEFAULT_INSTALLED};
use super::*;

/// Large enough that the upload spans several SFTP writes.
const BINARY_SIZE: usize = 200 * 1024;

/// Outer watchdog: a regression that hangs fails the test instead of the suite.
const WATCHDOG: Duration = Duration::from_secs(30);

/// Run a sync deploy helper on a blocking-pool thread (its production context).
async fn on_blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::time::timeout(WATCHDOG, tokio::task::spawn_blocking(f))
        .await
        .expect("deploy helper hung past the watchdog")
        .expect("spawn_blocking join")
}

/// Install `bytes` to the default path over `session`.
async fn install(
    session: SshSession,
    bytes: Vec<u8>,
    cancel: Option<CancellationToken>,
) -> Result<AgentDeployResult, TerminalError> {
    on_blocking(move || {
        install_agent_bytes(
            &session,
            "Linux",
            DEFAULT_REMOTE_PATH,
            &bytes,
            &|_, _, _| {},
            cancel.as_ref(),
        )
    })
    .await
}

fn installed(state: &Arc<Mutex<HostState>>) -> Option<Vec<u8>> {
    state
        .lock()
        .expect("host")
        .files
        .get(DEFAULT_INSTALLED)
        .cloned()
}

fn ran(state: &Arc<Mutex<HostState>>, prefix: &str) -> bool {
    state
        .lock()
        .expect("host")
        .commands
        .iter()
        .any(|c| c.starts_with(prefix))
}

/// The host holds the previous binary untouched and nothing half-written.
fn assert_old_binary_intact(state: &Arc<Mutex<HostState>>, old: &[u8]) {
    assert_eq!(
        installed(state).as_deref(),
        Some(old),
        "the previously installed agent must be left untouched"
    );
    let staged = state.lock().expect("host").staged_files();
    assert!(
        staged.is_empty(),
        "no half-written binary may be left in the upload dir: {staged:?}"
    );
}

// ── Happy paths ─────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fresh_deploy_installs_and_verifies_the_binary() {
    let (session, state) = fake_host::connect(&[]).await;
    let bytes = fake_binary("0.9.0", BINARY_SIZE);

    let result = install(session, bytes.clone(), None).await.expect("deploy");

    assert_eq!(
        result,
        AgentDeployResult::Deployed {
            success: true,
            installed_version: Some("0.9.0".to_string()),
            installed_path: Some(DEFAULT_REMOTE_PATH.to_string()),
        }
    );
    assert_eq!(installed(&state), Some(bytes));
    let st = state.lock().expect("host");
    assert!(
        st.staged_files().is_empty(),
        "the upload was moved into place"
    );
    assert!(
        !st.dirs.iter().any(|d| d.contains("/updates/upload.")),
        "the emptied private upload dir is removed: {:?}",
        st.dirs
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_replaces_an_existing_binary() {
    let old = fake_binary("0.8.0", 1024);
    let (session, state) = fake_host::connect(&[(DEFAULT_INSTALLED, old)]).await;
    let new = fake_binary("0.9.0", BINARY_SIZE);

    let result = install(session, new.clone(), None).await.expect("update");

    match result {
        AgentDeployResult::Deployed {
            success: true,
            installed_version: Some(v),
            ..
        } => assert_eq!(v, "0.9.0", "verify must report the NEW binary"),
        other => panic!("expected a verified deploy, got {other:?}"),
    }
    assert_eq!(installed(&state), Some(new));
    assert!(state.lock().expect("host").staged_files().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn new_binary_that_refuses_to_start_is_reported_not_silent_success() {
    let old = fake_binary("0.8.0", 1024);
    let (session, _state) = fake_host::connect(&[(DEFAULT_INSTALLED, old)]).await;

    let result = install(session, broken_binary(BINARY_SIZE), None)
        .await
        .expect("the install itself completes");

    match result {
        AgentDeployResult::Deployed {
            success,
            installed_version,
            ..
        } => {
            assert!(!success, "a binary failing --version is not a success");
            assert_eq!(installed_version, None);
        }
        other => panic!("expected Deployed, got {other:?}"),
    }
}

// ── Upload failures and rollback ────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upload_failing_mid_transfer_removes_the_partial_and_keeps_the_old_binary() {
    let old = fake_binary("0.8.0", 1024);
    let (session, state) = fake_host::connect(&[(DEFAULT_INSTALLED, old.clone())]).await;
    state.lock().expect("host").faults.fail_write_after = Some(BINARY_SIZE / 3);

    let err = install(session, fake_binary("0.9.0", BINARY_SIZE), None)
        .await
        .expect_err("a failed upload must fail the deploy");

    assert!(!matches!(err, TerminalError::Cancelled), "got {err:?}");
    assert!(!ran(&state, "mkdir -p "), "nothing may be installed");
    assert_old_binary_intact(&state, &old);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rollback_failure_after_a_failed_upload_is_reported() {
    let old = fake_binary("0.8.0", 1024);
    let (session, state) = fake_host::connect(&[(DEFAULT_INSTALLED, old.clone())]).await;
    {
        let mut st = state.lock().expect("host");
        st.faults.fail_write_after = Some(BINARY_SIZE / 3);
        st.faults.deny_remove = true;
    }

    let err = install(session, fake_binary("0.9.0", BINARY_SIZE), None)
        .await
        .expect_err("a failed upload must fail the deploy");

    let msg = err.to_string();
    assert!(
        msg.contains("could not be removed"),
        "the stranded partial upload must be reported, got: {msg}"
    );
    let st = state.lock().expect("host");
    assert_eq!(st.sftp_removes.len(), 1, "the rollback was attempted");
    assert_eq!(st.files.get(DEFAULT_INSTALLED), Some(&old));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_mid_transfer_rolls_back_the_partial_upload() {
    let old = fake_binary("0.8.0", 1024);
    let (session, state) = fake_host::connect(&[(DEFAULT_INSTALLED, old.clone())]).await;
    let token = CancellationToken::new();
    state.lock().expect("host").faults.cancel_on_first_write = Some(token.clone());

    let err = install(session, fake_binary("0.9.0", BINARY_SIZE), Some(token))
        .await
        .expect_err("a cancelled upload must not succeed");

    assert!(matches!(err, TerminalError::Cancelled), "got {err:?}");
    assert!(!ran(&state, "mkdir -p "), "nothing may be installed");
    assert_old_binary_intact(&state, &old);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_with_a_failing_rollback_still_reports_cancelled() {
    let old = fake_binary("0.8.0", 1024);
    let (session, state) = fake_host::connect(&[(DEFAULT_INSTALLED, old.clone())]).await;
    let token = CancellationToken::new();
    {
        let mut st = state.lock().expect("host");
        st.faults.cancel_on_first_write = Some(token.clone());
        st.faults.deny_remove = true;
    }

    let err = install(session, fake_binary("0.9.0", BINARY_SIZE), Some(token))
        .await
        .expect_err("a cancelled upload must not succeed");

    assert!(matches!(err, TerminalError::Cancelled), "got {err:?}");
    let st = state.lock().expect("host");
    assert_eq!(st.sftp_removes.len(), 1, "the rollback was attempted");
    assert_eq!(st.files.get(DEFAULT_INSTALLED), Some(&old));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upload_helper_rolls_back_only_what_it_uploaded() {
    // Direct check of the helper: a successful upload is left in place for the
    // install step; nothing is removed.
    let (session, state) = fake_host::connect(&[]).await;
    let path = format!("{}/staged", fake_host::HOME);
    let bytes = fake_binary("0.9.0", BINARY_SIZE);
    let (p, b) = (path.clone(), bytes.clone());
    let written = on_blocking(move || upload_binary_or_rollback(&session, &b, &p, None))
        .await
        .expect("upload");
    assert_eq!(written, BINARY_SIZE as u64);
    let st = state.lock().expect("host");
    assert_eq!(st.files.get(&path), Some(&bytes));
    assert!(st.sftp_removes.is_empty());
}

// ── Permission errors ───────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_denied_on_upload_installs_nothing() {
    let old = fake_binary("0.8.0", 1024);
    let (session, state) = fake_host::connect(&[(DEFAULT_INSTALLED, old.clone())]).await;
    state.lock().expect("host").faults.deny_create = true;

    let err = install(session, fake_binary("0.9.0", BINARY_SIZE), None)
        .await
        .expect_err("a refused create must fail the deploy");

    assert!(
        err.to_string().contains("create remote file failed"),
        "{err}"
    );
    assert!(!ran(&state, "mkdir -p "), "nothing may be installed");
    assert_old_binary_intact(&state, &old);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unwritable_config_dir_fails_before_any_upload() {
    let (session, state) = fake_host::connect(&[]).await;
    state.lock().expect("host").faults.fail_prepare = true;

    let err = install(session, fake_binary("0.9.0", BINARY_SIZE), None)
        .await
        .expect_err("no private upload dir must fail the deploy");

    assert!(
        err.to_string().contains("private upload directory"),
        "{err}"
    );
    let st = state.lock().expect("host");
    assert!(
        st.files.is_empty(),
        "nothing may be uploaded: {:?}",
        st.files
    );
}

// ── Install interrupted between staging and the final rename ───────────

/// Drive an install whose `step` fails; the deploy must fail, leave the old
/// binary in place and remove the staged upload.
async fn assert_failed_install_step_rolls_back(step: &'static str) {
    let old = fake_binary("0.8.0", 1024);
    let (session, state) = fake_host::connect(&[(DEFAULT_INSTALLED, old.clone())]).await;
    state.lock().expect("host").faults.fail_install_step = Some(step);

    let result = install(session, fake_binary("0.9.0", BINARY_SIZE), None).await;

    let err = match result {
        Err(e) => e,
        Ok(r) => panic!("a failed `{step}` must fail the deploy, not report {r:?}"),
    };
    assert!(err.to_string().contains("Install command failed"), "{err}");
    assert_old_binary_intact(&state, &old);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn install_failing_at_the_rename_keeps_the_old_binary() {
    assert_failed_install_step_rolls_back("mv").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn install_dir_not_creatable_keeps_the_old_binary() {
    assert_failed_install_step_rolls_back("mkdir").await;
}

// ── Signature verification and coordinated staging ─────────────────────

/// Write `bytes` as a resolved agent binary in `dir`, with `sig` (if any) as
/// its `.sig` sidecar.
fn resolved_binary(dir: &tempfile::TempDir, bytes: &[u8], sig: Option<&str>) -> PathBuf {
    let path = dir.path().join("termihub-agent-linux-x64");
    std::fs::write(&path, bytes).expect("write binary");
    if let Some(sig) = sig {
        std::fs::write(dir.path().join("termihub-agent-linux-x64.sig"), sig).expect("write sig");
    }
    path
}

/// A `.sig` sidecar that does not verify (even a dev build refuses it; only
/// a *missing* signature is tolerated there).
const BAD_SIGNATURE: &str = "bm90LWEtcmVhbC1zaWduYXR1cmU=";

const VERSION: &str = env!("CARGO_PKG_VERSION");

async fn verify_install(
    session: SshSession,
    binary: PathBuf,
) -> Result<AgentDeployResult, TerminalError> {
    on_blocking(move || {
        verify_and_install(
            &session,
            "Linux",
            DEFAULT_REMOTE_PATH,
            &binary,
            VERSION,
            &|_, _, _| {},
            None,
        )
    })
    .await
}

async fn stage(session: SshSession, binary: PathBuf) -> Result<StagedBinary, TerminalError> {
    on_blocking(move || {
        stage_verified_binary(
            "agent-1",
            &session,
            "Linux".to_string(),
            DEFAULT_REMOTE_PATH,
            &binary,
            VERSION,
            None,
        )
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deploy_of_a_verified_binary_installs_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bytes = fake_binary("0.9.0", BINARY_SIZE);
    let binary = resolved_binary(&dir, &bytes, None);
    let (session, state) = fake_host::connect(&[]).await;

    let result = verify_install(session, binary).await.expect("deploy");

    assert!(
        matches!(result, AgentDeployResult::Deployed { success: true, .. }),
        "{result:?}"
    );
    assert_eq!(installed(&state), Some(bytes));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn signature_mismatch_refuses_the_deploy_before_touching_the_host() {
    let dir = tempfile::tempdir().expect("tempdir");
    let binary = resolved_binary(&dir, &fake_binary("0.9.0", 4096), Some(BAD_SIGNATURE));
    let old = fake_binary("0.8.0", 1024);
    let (session, state) = fake_host::connect(&[(DEFAULT_INSTALLED, old.clone())]).await;

    let err = verify_install(session, binary)
        .await
        .expect_err("a binary whose signature does not verify must be refused");

    assert!(
        err.to_string().to_lowercase().contains("signature"),
        "{err}"
    );
    let st = state.lock().expect("host");
    assert!(st.commands.is_empty(), "nothing may run: {:?}", st.commands);
    assert_eq!(st.files.len(), 1, "nothing may be uploaded: {:?}", st.files);
    assert_eq!(st.files.get(DEFAULT_INSTALLED), Some(&old));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn staging_uploads_without_installing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bytes = fake_binary("0.9.0", BINARY_SIZE);
    let binary = resolved_binary(&dir, &bytes, None);
    let old = fake_binary("0.8.0", 1024);
    let (session, state) = fake_host::connect(&[(DEFAULT_INSTALLED, old.clone())]).await;

    let staged = stage(session, binary).await.expect("stage");

    assert!(!staged.is_windows);
    assert_eq!(
        staged.expected_sha256,
        crate::terminal::agent_binary::sha256_hex_of_bytes(&bytes)
    );
    assert_eq!(staged.signature, None, "an unsigned dev binary has no sig");
    let upload_path = staged.upload_path.expect("a Unix stage has a path");
    let st = state.lock().expect("host");
    assert_eq!(st.files.get(&upload_path), Some(&bytes), "staged as is");
    assert_eq!(
        st.files.get(DEFAULT_INSTALLED),
        Some(&old),
        "staging never replaces the running agent"
    );
    assert!(
        !st.commands.iter().any(|c| c.starts_with("mkdir -p ")),
        "the install command must not run for a coordinated update"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn staging_refuses_a_bad_signature_before_touching_the_host() {
    let dir = tempfile::tempdir().expect("tempdir");
    let binary = resolved_binary(&dir, &fake_binary("0.9.0", 4096), Some(BAD_SIGNATURE));
    let (session, state) = fake_host::connect(&[]).await;

    stage(session, binary)
        .await
        .expect_err("a binary whose signature does not verify must not be staged");

    let st = state.lock().expect("host");
    assert!(st.commands.is_empty(), "nothing may run: {:?}", st.commands);
    assert!(st.files.is_empty(), "nothing may be uploaded");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn staging_upload_failure_leaves_nothing_half_written() {
    let dir = tempfile::tempdir().expect("tempdir");
    let binary = resolved_binary(&dir, &fake_binary("0.9.0", BINARY_SIZE), None);
    let old = fake_binary("0.8.0", 1024);
    let (session, state) = fake_host::connect(&[(DEFAULT_INSTALLED, old.clone())]).await;
    state.lock().expect("host").faults.fail_write_after = Some(BINARY_SIZE / 2);

    stage(session, binary)
        .await
        .expect_err("a failed staging upload must fail");

    assert_old_binary_intact(&state, &old);
}

//! Guarded local-process execution for the `run-local-process` workflow step
//! (#1857) — the highest-risk step in the Workflow Automation epic (#1851),
//! because it runs a program on the **user's own machine** rather than streaming
//! text into a remote session.
//!
//! The security model is layered:
//!
//! 1. **Explicit opt-in, enforced at the trust boundary.** [`run_local_process`]
//!    refuses to spawn anything unless `workflow_local_process_enabled` is set in
//!    the persisted [`AppSettings`]. The frontend gates on the same flag and adds
//!    a per-program confirmation/allowlist on top, but this backend check means a
//!    step can never spawn a process without the user having opted in — even if
//!    the frontend were bypassed.
//! 2. **Direct argv — never a shell.** The program is spawned with
//!    [`tokio::process::Command`] from `program` + a discrete `args` vector. No
//!    shell is ever involved and no argument is concatenated into a command line,
//!    so workflow-controlled strings cannot be interpreted as shell syntax.
//! 3. **Bounded and observable.** Execution is wrapped in a timeout, can be
//!    cancelled through [`cancel_local_process`], streams stdout/stderr back as
//!    events, and surfaces the process exit code.
//!
//! The spawn/stream/bound core lives in [`execute_local_process`] with no Tauri
//! dependency so the guardrails can be unit-tested directly.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::connection::settings::SettingsStorage;
use crate::utils::errors::TerminalError;

/// Tauri event carrying one streamed line of a local process's output, keyed by
/// `run_id` so the frontend can route it to the right workflow run view.
pub const EVENT_LOCAL_PROCESS_OUTPUT: &str = "workflow-local-process-output";

/// Default execution timeout when the caller does not specify one (30s).
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Hard upper bound on the execution timeout (10 minutes) so a caller cannot ask
/// for an effectively unbounded process.
const MAX_TIMEOUT_MS: u64 = 600_000;

/// One streamed line of local-process output.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalProcessOutputEvent {
    /// The run id this output belongs to.
    run_id: String,
    /// Which stream produced the line: `"stdout"` or `"stderr"`.
    stream: String,
    /// The line of text (without its trailing newline).
    line: String,
}

/// The terminal outcome of a local-process execution, returned to the runner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProcessOutcome {
    /// The process exit code, or `None` when the process was killed (cancelled or
    /// timed out) and so never reported one.
    pub exit_code: Option<i32>,
    /// `true` when the process was killed because it exceeded the timeout.
    pub timed_out: bool,
    /// `true` when the process was killed because the run was cancelled.
    pub cancelled: bool,
}

/// Registry of in-flight local processes, keyed by `run_id`, so a run can be
/// cancelled from the frontend. Managed Tauri state; the inner map is `Arc`-shared
/// so a spawned execution can clear its own entry on completion.
#[derive(Default, Clone)]
pub struct LocalProcessRegistry {
    active: Arc<Mutex<HashMap<String, Arc<CancellationToken>>>>,
}

impl LocalProcessRegistry {
    /// Register a run and return its cancellation token, cancelling any prior run
    /// registered under the same id first.
    fn register(&self, run_id: &str) -> Arc<CancellationToken> {
        let token = Arc::new(CancellationToken::new());
        if let Ok(mut map) = self.active.lock() {
            if let Some(prev) = map.insert(run_id.to_string(), token.clone()) {
                prev.cancel();
            }
        }
        token
    }

    /// Cancel an in-flight run. Returns `true` if one was registered.
    fn cancel(&self, run_id: &str) -> bool {
        let token = self
            .active
            .lock()
            .ok()
            .and_then(|map| map.get(run_id).cloned());
        match token {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Drop a run's entry once it finishes, but only when the registry still holds
    /// *this* token instance (so a re-registered id is left untouched).
    fn complete(&self, run_id: &str, token: &Arc<CancellationToken>) {
        if let Ok(mut map) = self.active.lock() {
            if map
                .get(run_id)
                .is_some_and(|stored| Arc::ptr_eq(stored, token))
            {
                map.remove(run_id);
            }
        }
    }
}

/// Clamp a caller-requested timeout into `[1ms, MAX_TIMEOUT_MS]`, applying the
/// default when unset.
fn resolve_timeout(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1, MAX_TIMEOUT_MS),
    )
}

/// Stream every line from `reader` to `tx`, tagged with `stream`. Ends when the
/// pipe closes (the child exited or was killed).
fn spawn_reader<R>(
    reader: Option<R>,
    stream: &'static str,
    tx: mpsc::UnboundedSender<(&'static str, String)>,
) -> tokio::task::JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let Some(reader) = reader else {
            return;
        };
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send((stream, line)).is_err() {
                break;
            }
        }
    })
}

/// Spawn `program` with the discrete `args`, stream its output as `(stream, line)`
/// pairs on `output_tx`, and wait for it to finish — bounded by `timeout` and
/// cancellable through `token`.
///
/// **This is the security-critical core.** The program is spawned via
/// [`tokio::process::Command`] with `program` + `args` passed as a discrete
/// argument vector: no shell, no string interpolation, so a workflow-controlled
/// argument (even one containing spaces, quotes, or shell metacharacters) reaches
/// the program as a single, literal argument and can never be reinterpreted as a
/// command line. Kept free of any Tauri dependency so the guardrails are unit
/// testable.
pub async fn execute_local_process(
    program: &str,
    args: &[String],
    timeout: Duration,
    token: &CancellationToken,
    output_tx: mpsc::UnboundedSender<(&'static str, String)>,
) -> Result<LocalProcessOutcome, TerminalError> {
    let program = program.trim();
    if program.is_empty() {
        return Err(TerminalError::WorkflowError(
            "no program configured for the local-process step".to_string(),
        ));
    }

    // Direct argv — NEVER a shell. `program` + discrete `args`, no interpolation.
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Suppress the console-window flash on Windows. No-op elsewhere.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|e| {
        TerminalError::WorkflowError(format!("failed to spawn local process '{program}': {e}"))
    })?;

    let stdout_task = spawn_reader(child.stdout.take(), "stdout", output_tx.clone());
    let stderr_task = spawn_reader(child.stderr.take(), "stderr", output_tx);

    // Wait for the child, bounded by the timeout and the cancel token. The wait
    // future is scoped so its mutable borrow of `child` is released before we may
    // need to kill the child in the cancel/timeout branches.
    enum Ending {
        Exited(std::process::ExitStatus),
        WaitErr(std::io::Error),
        Cancelled,
        TimedOut,
    }
    let ending = {
        let wait_fut = child.wait();
        tokio::pin!(wait_fut);
        tokio::select! {
            _ = token.cancelled() => Ending::Cancelled,
            _ = tokio::time::sleep(timeout) => Ending::TimedOut,
            res = &mut wait_fut => match res {
                Ok(status) => Ending::Exited(status),
                Err(e) => Ending::WaitErr(e),
            },
        }
    };

    let outcome = match ending {
        Ending::Exited(status) => LocalProcessOutcome {
            exit_code: status.code(),
            timed_out: false,
            cancelled: false,
        },
        Ending::WaitErr(e) => {
            return Err(TerminalError::WorkflowError(format!(
                "failed while waiting for local process '{program}': {e}"
            )));
        }
        Ending::Cancelled => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            LocalProcessOutcome {
                exit_code: None,
                timed_out: false,
                cancelled: true,
            }
        }
        Ending::TimedOut => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            LocalProcessOutcome {
                exit_code: None,
                timed_out: true,
                cancelled: false,
            }
        }
    };

    // Let the readers drain any buffered output now the pipes have closed.
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    Ok(outcome)
}

/// Spawn a guarded local process for a `run-local-process` workflow step.
///
/// Enforces the master opt-in (`workflow_local_process_enabled`) before doing
/// anything, then delegates to [`execute_local_process`], forwarding streamed
/// output as [`EVENT_LOCAL_PROCESS_OUTPUT`] events and returning the exit
/// outcome. Awaits completion so the caller learns the exit status.
#[tauri::command]
pub async fn run_local_process(
    run_id: String,
    program: String,
    args: Vec<String>,
    timeout_ms: Option<u64>,
    registry: State<'_, LocalProcessRegistry>,
    app_handle: AppHandle,
) -> Result<LocalProcessOutcome, TerminalError> {
    // GUARDRAIL: explicit opt-in, enforced at the trust boundary. A step can
    // never spawn a process unless the user has enabled local-process execution.
    let settings = SettingsStorage::new(&app_handle)
        .and_then(|storage| storage.load_with_recovery())
        .map(|recovered| recovered.data)
        .map_err(|e| {
            TerminalError::WorkflowError(format!("could not load settings to authorize step: {e}"))
        })?;
    if !settings.workflow_local_process_enabled {
        warn!(run_id, "refused local-process step: execution is disabled");
        return Err(TerminalError::WorkflowError(
            "local process execution is disabled; enable it in Settings before running this step"
                .to_string(),
        ));
    }

    let timeout = resolve_timeout(timeout_ms);
    debug!(run_id, program, ?timeout, "spawning guarded local process");

    let token = registry.register(&run_id);
    let registry_handle = registry.inner().clone();

    // Forward streamed output lines to the frontend as events.
    let (tx, mut rx) = mpsc::unbounded_channel::<(&'static str, String)>();
    let emit_task = {
        let app = app_handle.clone();
        let run_id = run_id.clone();
        tokio::spawn(async move {
            while let Some((stream, line)) = rx.recv().await {
                let _ = app.emit(
                    EVENT_LOCAL_PROCESS_OUTPUT,
                    LocalProcessOutputEvent {
                        run_id: run_id.clone(),
                        stream: stream.to_string(),
                        line,
                    },
                );
            }
        })
    };

    let outcome = execute_local_process(&program, &args, timeout, &token, tx).await;

    // The channel senders are dropped when execute_local_process returns, so the
    // emit task drains and ends on its own.
    let _ = emit_task.await;
    registry_handle.complete(&run_id, &token);

    outcome
}

/// Cancel an in-flight local process by its `run_id`. Returns `true` if a run was
/// registered under that id.
#[tauri::command]
pub fn cancel_local_process(run_id: String, registry: State<'_, LocalProcessRegistry>) -> bool {
    registry.cancel(&run_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drain the output channel into a flat list of `(stream, line)` pairs.
    fn collect_output(
        mut rx: mpsc::UnboundedReceiver<(&'static str, String)>,
    ) -> Vec<(String, String)> {
        let mut out = Vec::new();
        while let Ok((stream, line)) = rx.try_recv() {
            out.push((stream.to_string(), line));
        }
        out
    }

    #[tokio::test]
    async fn empty_program_is_refused() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let token = CancellationToken::new();
        let err = execute_local_process("   ", &[], Duration::from_secs(5), &token, tx)
            .await
            .expect_err("empty program must be refused");
        assert!(err.to_string().contains("no program"), "got: {err}");
    }

    /// GUARDRAIL: a space-containing argument is passed as a single discrete argv
    /// entry — never split or shell-interpreted. `printf '[%s]\n'` re-applies its
    /// format once per argument, so one argument prints `[a b]` while two would
    /// print `[a]` then `[b]`.
    #[cfg(unix)]
    #[tokio::test]
    async fn passes_args_as_discrete_argv_no_shell() {
        let (tx, rx) = mpsc::unbounded_channel();
        let token = CancellationToken::new();
        let args = vec!["[%s]\n".to_string(), "a b".to_string()];
        let outcome =
            execute_local_process("/usr/bin/printf", &args, Duration::from_secs(5), &token, tx)
                .await
                .expect("printf should run");
        assert_eq!(outcome.exit_code, Some(0));
        let lines: Vec<String> = collect_output(rx)
            .into_iter()
            .filter(|(s, _)| s == "stdout")
            .map(|(_, l)| l)
            .collect();
        // A single `[a b]` line proves "a b" arrived as ONE argument. A shell (or
        // a split) would have produced `[a]` and `[b]`.
        assert_eq!(lines, vec!["[a b]".to_string()]);
    }

    /// GUARDRAIL: a shell metacharacter in an argument is inert — it reaches the
    /// program literally rather than being interpreted. `printf` echoes it back
    /// verbatim; no subshell runs.
    #[cfg(unix)]
    #[tokio::test]
    async fn shell_metacharacters_in_args_are_literal() {
        let (tx, rx) = mpsc::unbounded_channel();
        let token = CancellationToken::new();
        let args = vec!["%s\n".to_string(), "; rm -rf / && echo pwned".to_string()];
        let outcome =
            execute_local_process("/usr/bin/printf", &args, Duration::from_secs(5), &token, tx)
                .await
                .expect("printf should run");
        assert_eq!(outcome.exit_code, Some(0));
        let lines: Vec<String> = collect_output(rx)
            .into_iter()
            .filter(|(s, _)| s == "stdout")
            .map(|(_, l)| l)
            .collect();
        assert_eq!(lines, vec!["; rm -rf / && echo pwned".to_string()]);
    }

    /// GUARDRAIL: the process exit code is surfaced.
    #[cfg(unix)]
    #[tokio::test]
    async fn surfaces_nonzero_exit_status() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let token = CancellationToken::new();
        // `sh -c 'exit 3'` is spawned as a direct argv (no shell wrapping by us);
        // it deterministically exits 3.
        let args = vec!["-c".to_string(), "exit 3".to_string()];
        let outcome = execute_local_process("/bin/sh", &args, Duration::from_secs(5), &token, tx)
            .await
            .expect("sh should run");
        assert_eq!(outcome.exit_code, Some(3));
        assert!(!outcome.timed_out);
        assert!(!outcome.cancelled);
    }

    /// GUARDRAIL: a process that outlives the timeout is killed and reported as
    /// timed out (no exit code).
    #[cfg(unix)]
    #[tokio::test]
    async fn enforces_timeout() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let token = CancellationToken::new();
        let args = vec!["30".to_string()];
        let outcome =
            execute_local_process("/bin/sleep", &args, Duration::from_millis(150), &token, tx)
                .await
                .expect("sleep should spawn");
        assert!(outcome.timed_out, "expected timeout: {outcome:?}");
        assert!(!outcome.cancelled);
        assert_eq!(outcome.exit_code, None);
    }

    /// GUARDRAIL: cancelling the token kills the process and reports cancelled.
    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_terminates_process() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let token = CancellationToken::new();
        let cancel_token = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            cancel_token.cancel();
        });
        let args = vec!["30".to_string()];
        let outcome =
            execute_local_process("/bin/sleep", &args, Duration::from_secs(30), &token, tx)
                .await
                .expect("sleep should spawn");
        assert!(outcome.cancelled, "expected cancelled: {outcome:?}");
        assert!(!outcome.timed_out);
        assert_eq!(outcome.exit_code, None);
    }

    /// Windows equivalent of the exit-status guardrail: `cmd /c exit 3` exits 3.
    #[cfg(windows)]
    #[tokio::test]
    async fn surfaces_nonzero_exit_status_windows() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let token = CancellationToken::new();
        let args = vec!["/c".to_string(), "exit 3".to_string()];
        let outcome = execute_local_process("cmd", &args, Duration::from_secs(5), &token, tx)
            .await
            .expect("cmd should run");
        assert_eq!(outcome.exit_code, Some(3));
        assert!(!outcome.timed_out);
        assert!(!outcome.cancelled);
    }

    /// Windows equivalent of the timeout guardrail: a long ping outlives a short
    /// timeout and is killed.
    #[cfg(windows)]
    #[tokio::test]
    async fn enforces_timeout_windows() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let token = CancellationToken::new();
        // ping -n 30 keeps the process alive well past the timeout.
        let args = vec!["-n".to_string(), "30".to_string(), "127.0.0.1".to_string()];
        let outcome = execute_local_process("ping", &args, Duration::from_millis(200), &token, tx)
            .await
            .expect("ping should spawn");
        assert!(outcome.timed_out, "expected timeout: {outcome:?}");
        assert_eq!(outcome.exit_code, None);
    }

    #[test]
    fn resolve_timeout_applies_default_and_bounds() {
        assert_eq!(
            resolve_timeout(None),
            Duration::from_millis(DEFAULT_TIMEOUT_MS)
        );
        assert_eq!(resolve_timeout(Some(0)), Duration::from_millis(1));
        assert_eq!(
            resolve_timeout(Some(MAX_TIMEOUT_MS * 10)),
            Duration::from_millis(MAX_TIMEOUT_MS)
        );
    }
}

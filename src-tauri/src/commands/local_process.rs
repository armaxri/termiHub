//! Guarded local-process execution for the `run-local-process` workflow step
//! (#1857) — the highest-risk step in the Workflow Automation epic (#1851),
//! because it runs a program on the **user's own machine** rather than streaming
//! text into a remote session.
//!
//! The security model is layered:
//!
//! 1. **Decided at the trust boundary.** [`run_local_process`] starts a program only
//!    when [`super::local_process_policy`] says so, from the persisted settings:
//!    experimental features and the opt-in must be on (#5988), and the program must
//!    be on the user's list or be the file the user approved for this run (#5994).
//!    A command of an automation that is not the user's own must have been confirmed
//!    as it is, or be approved for this run (#6019).
//!    It then starts exactly the file that was judged. That module states the rule
//!    and what it does not protect against (the window itself, above all).
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
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use super::local_process_policy::{self, LocalProcessCheck, Program, SearchEnv};
use crate::automations::manager::AutomationManager;
use crate::automations::trust::{ConfirmedCommand, Standing};
use crate::connection::settings::{AppSettings, SettingsStorage};
use crate::utils::errors::TerminalError;

/// Tauri event carrying one streamed line of a local process's output, keyed by
/// `run_id` so the frontend can route it to the right workflow run view.
pub const EVENT_LOCAL_PROCESS_OUTPUT: &str = "workflow-local-process-output";

/// Default execution timeout when the caller does not specify one (30s).
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Hard upper bound on the execution timeout (10 minutes) so a caller cannot ask
/// for an effectively unbounded process.
const MAX_TIMEOUT_MS: u64 = 600_000;

/// Bound on buffered local-process output lines before the reader task applies
/// backpressure (TAURI-014). Once this many lines are queued the reader `.await`s
/// the send instead of growing the queue, which stalls the pipe read and lets the
/// OS pipe buffer back the child off — bounding memory with **zero dropped
/// output**. Output completeness is a correctness requirement here: a dropped line
/// would silently corrupt the terminal/run view, so backpressure (not drop) is the
/// only acceptable overflow policy. Generous so a briefly-stalled frontend rarely
/// throttles a well-behaved process.
const LOCAL_PROCESS_OUTPUT_QUEUE_CAP: usize = 1024;

/// One streamed line of local-process output.
#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[cfg_attr(test, ts(rename = "LocalProcessOutputChunk"))]
#[serde(rename_all = "camelCase")]
struct LocalProcessOutputEvent {
    /// The run id this output belongs to.
    run_id: String,
    /// Which stream produced the line: `"stdout"` or `"stderr"`.
    #[cfg_attr(test, ts(type = "\"stdout\" | \"stderr\""))]
    stream: String,
    /// The line of text (without its trailing newline).
    line: String,
}

/// The terminal outcome of a local-process execution, returned to the runner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
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

/// The settings as they are on disk now. `None` when they are missing, unreadable,
/// corrupt or newer: then nothing starts. Never repairs or resets the file.
fn persisted_settings<R: Runtime>(app_handle: &AppHandle<R>) -> Option<AppSettings> {
    SettingsStorage::new(app_handle).ok()?.peek()
}

/// What starting `program` now would do: allowed, ask the user, or refused. The
/// frontend asks this before it starts a program, so it holds no rule of its own.
#[tauri::command]
pub fn check_local_process<R: Runtime>(
    program: String,
    args: Vec<String>,
    automation_chain: Vec<String>,
    app_handle: AppHandle<R>,
) -> LocalProcessCheck {
    local_process_policy::check(
        persisted_settings(&app_handle).as_ref(),
        &program,
        &SearchEnv::current(),
        |path| standing(&app_handle, &automation_chain, &program, &args, path),
    )
}

/// What is known about the automations behind a command (#6019): `chain` are their
/// ids, the one the run started with first.
fn standing<R: Runtime>(
    app_handle: &AppHandle<R>,
    chain: &[String],
    program: &str,
    args: &[String],
    path: &Path,
) -> Standing {
    app_handle
        .try_state::<AutomationManager>()
        .map_or(Standing::Unknown, |manager| {
            manager.standing(chain, program, args, path)
        })
}

/// The user confirmed a command of an automation that is not their own (#6019): it
/// is not asked about again. `path` is the file that was shown; when the program
/// is another file by now, nothing is remembered.
#[tauri::command]
pub fn confirm_local_process<R: Runtime>(
    program: String,
    args: Vec<String>,
    automation_chain: Vec<String>,
    path: String,
    app_handle: AppHandle<R>,
) -> Result<(), TerminalError> {
    let refused = TerminalError::AutomationError;
    let judged = local_process_policy::judge(
        persisted_settings(&app_handle).as_ref(),
        &program,
        &SearchEnv::current(),
    )
    .map_err(refused)?;
    if judged.program.path.to_str() != Some(path.as_str()) {
        return Err(TerminalError::AutomationError(format!(
            "\"{path}\" was confirmed, but it is {} now.",
            judged.program.path.display()
        )));
    }
    app_handle
        .try_state::<AutomationManager>()
        .ok_or_else(|| TerminalError::AutomationError("No automations are loaded.".into()))?
        .confirm_command(&automation_chain, &program, &args, &judged.program.path)
}

/// A command the user confirmed for an imported automation, for the settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedLocalCommand {
    /// Names it when it is revoked.
    pub key: String,
    /// The file and the arguments. Absent when an earlier build kept only a hash.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub path: Option<String>,
    /// Every argument.
    pub args: Vec<String>,
}

/// The confirmed commands of one imported automation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedLocalCommands {
    pub automation_id: String,
    /// Absent when there is no such automation here.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub automation_name: Option<String>,
    pub commands: Vec<ConfirmedLocalCommand>,
}

/// The commands the user confirmed for imported automations (#6057).
#[tauri::command]
pub fn list_confirmed_local_commands(
    manager: State<'_, AutomationManager>,
) -> Result<Vec<ConfirmedLocalCommands>, TerminalError> {
    Ok(manager
        .confirmed_commands()?
        .into_iter()
        .map(|a| ConfirmedLocalCommands {
            automation_id: a.automation_id,
            automation_name: a.name,
            commands: a
                .commands
                .into_iter()
                .map(|command| {
                    let key = command.key();
                    let (path, args) = match command {
                        ConfirmedCommand::Command { path, args } => (Some(path), args),
                        ConfirmedCommand::Hash(_) => (None, Vec::new()),
                    };
                    ConfirmedLocalCommand { key, path, args }
                })
                .collect(),
        })
        .collect())
}

/// Take confirmations back (#6057): one command of an automation, all of one
/// automation (no `key`), or all (no `automation_id`).
#[tauri::command]
pub fn revoke_confirmed_local_commands(
    automation_id: Option<String>,
    key: Option<String>,
    manager: State<'_, AutomationManager>,
) -> Result<(), TerminalError> {
    manager.revoke_confirmed(automation_id.as_deref(), key.as_deref())
}

/// Which of these entries of the list are programs that run whatever they are told
/// to (#6057). An entry that resolves to no file is judged by its name.
#[tauri::command]
pub fn interpreters_among(programs: Vec<String>) -> Vec<String> {
    let env = SearchEnv::current();
    programs
        .into_iter()
        .filter(|program| local_process_policy::is_interpreter_entry(program, &env))
        .collect()
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
    tx: mpsc::Sender<(&'static str, String)>,
) -> tokio::task::JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    // Not app-owned (#3105): request-scoped pipe reader; ends at the process's EOF.
    tokio::spawn(async move {
        let Some(reader) = reader else {
            return;
        };
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Backpressure, never drop (TAURI-014): a full queue makes this
            // `.await` rather than grow, throttling the read so the OS pipe backs
            // the child off. `send` errors only when the consumer is gone — the
            // process's output is no longer wanted, so stop reading then.
            if tx.send((stream, line)).await.is_err() {
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
async fn execute_local_process(
    program: &Program,
    args: &[String],
    timeout: Duration,
    token: &CancellationToken,
    output_tx: mpsc::Sender<(&'static str, String)>,
) -> Result<LocalProcessOutcome, TerminalError> {
    let shown = program.path.display();

    // Direct argv — NEVER a shell. `program` + discrete `args`, no interpolation.
    // The judged file itself: the OS gets no name to search for again.
    let mut command = Command::new(&program.path);
    // A program found by its name still sees that name.
    #[cfg(unix)]
    if let Some(name) = &program.bare_name {
        command.arg0(name);
    }
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Suppress the console-window flash on Windows. No-op elsewhere.
    // (`tokio::process::Command::creation_flags` is inherent — no `CommandExt`.)
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|e| {
        TerminalError::AutomationError(format!("failed to spawn local process '{shown}': {e}"))
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
            return Err(TerminalError::AutomationError(format!(
                "failed while waiting for local process '{shown}': {e}"
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
/// Starts only what [`local_process_policy::authorize`] allows (`approved_path` is
/// the file the user approved for this run, if it is not on the list), then delegates to [`execute_local_process`], forwarding streamed
/// output as [`EVENT_LOCAL_PROCESS_OUTPUT`] events and returning the exit
/// outcome. Awaits completion so the caller learns the exit status.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // The arguments of the IPC call.
pub async fn run_local_process<R: Runtime>(
    run_id: String,
    program: String,
    args: Vec<String>,
    automation_chain: Vec<String>,
    timeout_ms: Option<u64>,
    approved_path: Option<String>,
    registry: State<'_, LocalProcessRegistry>,
    app_handle: AppHandle<R>,
) -> Result<LocalProcessOutcome, TerminalError> {
    // GUARDRAIL: decided here, from the persisted settings, whatever the frontend
    // says about the run. Nothing between this and the spawn looks the program up.
    let program = local_process_policy::authorize(
        persisted_settings(&app_handle).as_ref(),
        &program,
        approved_path.as_deref(),
        &SearchEnv::current(),
        |path| standing(&app_handle, &automation_chain, &program, &args, path),
    )
    .map_err(|reason| {
        warn!(run_id, reason, "refused local-process step");
        TerminalError::AutomationError(reason)
    })?;

    let timeout = resolve_timeout(timeout_ms);
    debug!(run_id, program = %program.path.display(), ?timeout, "spawning guarded local process");

    let token = registry.register(&run_id);
    let registry_handle = registry.inner().clone();

    // Forward streamed output lines to the frontend as events. Bounded so a
    // stalled frontend throttles the process reader (backpressure) rather than
    // letting the queue grow without limit — TAURI-014. Output is never dropped.
    let (tx, mut rx) = mpsc::channel::<(&'static str, String)>(LOCAL_PROCESS_OUTPUT_QUEUE_CAP);
    let emit_task = {
        let app = app_handle.clone();
        let run_id = run_id.clone();
        // Not app-owned (#3105): request-scoped; cancelling could drop buffered process output.
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

    /// An automation of the user's own that runs `program` with any one argument.
    #[cfg(unix)]
    fn manage_automation<R: Runtime>(app: &tauri::App<R>, dir: &Path, program: &str) {
        use crate::automations::storage::StoreFile;
        let manager = AutomationManager::with_storage(StoreFile::in_dir(dir)).unwrap();
        manager
            .save(automation("mine", program))
            .expect("the automation is saved");
        app.manage(manager);
    }

    #[cfg(unix)]
    fn automation(id: &str, program: &str) -> crate::automations::config::Automation {
        serde_json::from_value(serde_json::json!({ "id": id, "name": id, "steps": [
            { "kind": "run-local-process", "program": program, "args": ["${file}"] }
        ]}))
        .unwrap()
    }

    /// #6019: the command of an imported automation starts only when the user
    /// confirmed or approved it, also when the program is on the list.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_of_an_imported_automation_is_confirmed_first() {
        use crate::automations::trust::SaveOrigin;
        use crate::utils::config_paths::ConfigDirOverride;

        let dir = tempfile::TempDir::new().unwrap();
        let app = tauri::test::mock_app();
        app.manage(ConfigDirOverride(dir.path().to_path_buf()));
        app.manage(LocalProcessRegistry::default());
        manage_automation(&app, dir.path(), "/usr/bin/touch");
        app.state::<AutomationManager>()
            .save_from(automation("theirs", "/usr/bin/touch"), SaveOrigin::Import)
            .unwrap();
        SettingsStorage::new(app.handle())
            .unwrap()
            .save(&AppSettings {
                experimental_features_enabled: Some(true),
                workflow_local_process_enabled: true,
                workflow_local_process_allowlist: vec!["/usr/bin/touch".into()],
                ..AppSettings::default()
            })
            .unwrap();
        let marker = |name: &str| dir.path().join(name).display().to_string();
        let run = |chain: &str, file: String, approved: Option<&str>| {
            run_local_process(
                "run-1".into(),
                "/usr/bin/touch".into(),
                vec![file],
                vec![chain.into()],
                Some(5_000),
                approved.map(str::to_string),
                app.state(),
                app.handle().clone(),
            )
        };
        // Attributed to one's own, to the imported one, to nothing.
        assert!(run("mine", marker("a"), None).await.is_ok());
        for chain in ["theirs", "gone"] {
            let reason = run(chain, marker("b"), None).await.unwrap_err().to_string();
            assert!(reason.contains("was not started"), "{reason}");
            assert!(!dir.path().join("b").exists());
        }
        assert!(run("theirs", marker("c"), Some("/usr/bin/touch"))
            .await
            .is_ok());
        assert!(run("theirs", marker("c"), None).await.is_err(), "once only");

        let confirm = |file: String, path: &str| {
            confirm_local_process(
                "/usr/bin/touch".into(),
                vec![file],
                vec!["theirs".into()],
                path.into(),
                app.handle().clone(),
            )
        };
        assert!(confirm(marker("d"), "/usr/bin/true").is_err());
        assert!(run("theirs", marker("d"), None).await.is_err());
        confirm(marker("d"), "/usr/bin/touch").unwrap();
        assert!(run("theirs", marker("d"), None).await.is_ok());
        assert!(run("theirs", marker("e"), None).await.is_err());
        assert!(!dir.path().join("e").exists());
    }

    /// Without the automations nothing is known about a command, so a program on the
    /// list does not start by itself.
    #[cfg(unix)]
    #[tokio::test]
    async fn without_the_automations_the_list_does_not_count() {
        use crate::utils::config_paths::ConfigDirOverride;

        let dir = tempfile::TempDir::new().unwrap();
        let app = tauri::test::mock_app();
        app.manage(ConfigDirOverride(dir.path().to_path_buf()));
        app.manage(LocalProcessRegistry::default());
        SettingsStorage::new(app.handle())
            .unwrap()
            .save(&AppSettings {
                experimental_features_enabled: Some(true),
                workflow_local_process_enabled: true,
                workflow_local_process_allowlist: vec!["/usr/bin/touch".into()],
                ..AppSettings::default()
            })
            .unwrap();
        let marker = dir.path().join("spawned");
        let result = run_local_process(
            "run-1".into(),
            "/usr/bin/touch".into(),
            vec![marker.display().to_string()],
            vec!["mine".into()],
            Some(5_000),
            None,
            app.state(),
            app.handle().clone(),
        )
        .await;
        assert!(result.is_err());
        assert!(!marker.exists());
    }

    /// The real command against settings on disk: with any control off it returns
    /// an error and no process is created; with all on it runs.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_command_spawns_only_with_every_control_on() {
        use crate::utils::config_paths::ConfigDirOverride;
        use tauri::Manager;

        for (experimental, enabled, listed) in [
            (None, true, true),
            (Some(false), true, true),
            (Some(true), false, true),
            (Some(true), true, false),
            (Some(true), true, true),
        ] {
            let dir = tempfile::TempDir::new().unwrap();
            let app = tauri::test::mock_app();
            app.manage(ConfigDirOverride(dir.path().to_path_buf()));
            app.manage(LocalProcessRegistry::default());
            manage_automation(&app, dir.path(), "/usr/bin/touch");
            SettingsStorage::new(app.handle())
                .unwrap()
                .save(&AppSettings {
                    experimental_features_enabled: experimental,
                    workflow_local_process_enabled: enabled,
                    workflow_local_process_allowlist: if listed {
                        vec!["/usr/bin/touch".into()]
                    } else {
                        Vec::new()
                    },
                    ..AppSettings::default()
                })
                .unwrap();
            let marker = dir.path().join("spawned");

            let result = run_local_process(
                "run-1".into(),
                "/usr/bin/touch".into(),
                vec![marker.display().to_string()],
                vec!["mine".into()],
                Some(5_000),
                None,
                app.state(),
                app.handle().clone(),
            )
            .await;

            let allowed = experimental == Some(true) && enabled && listed;
            let case = format!("experimental {experimental:?}, opt-in {enabled}, listed {listed}");
            assert_eq!(result.is_ok(), allowed, "{case}: {result:?}");
            assert_eq!(marker.exists(), allowed, "{case}");
        }
    }

    /// #5994: with both switches on, a program that is not on the allowlist is
    /// never spawned, whatever the caller says about the run.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_unlisted_program_is_never_spawned() {
        use crate::utils::config_paths::ConfigDirOverride;
        use tauri::Manager;

        let dir = tempfile::TempDir::new().unwrap();
        let app = tauri::test::mock_app();
        app.manage(ConfigDirOverride(dir.path().to_path_buf()));
        app.manage(LocalProcessRegistry::default());
        manage_automation(&app, dir.path(), "/usr/bin/touch");
        SettingsStorage::new(app.handle())
            .unwrap()
            .save(&AppSettings {
                experimental_features_enabled: Some(true),
                workflow_local_process_enabled: true,
                workflow_local_process_allowlist: vec!["/usr/bin/true".into()],
                ..AppSettings::default()
            })
            .unwrap();
        let marker = dir.path().join("spawned");
        let result = run_local_process(
            "run-1".into(),
            "/usr/bin/touch".into(),
            vec![marker.display().to_string()],
            vec!["mine".into()],
            Some(5_000),
            None,
            app.state(),
            app.handle().clone(),
        )
        .await;
        assert!(result.is_err());
        assert!(!marker.exists());
    }

    /// Drain the output channel into a flat list of `(stream, line)` pairs.
    #[cfg(unix)] // only the unix-gated argv tests inspect output
    fn collect_output(mut rx: mpsc::Receiver<(&'static str, String)>) -> Vec<(String, String)> {
        let mut out = Vec::new();
        while let Ok((stream, line)) = rx.try_recv() {
            out.push((stream.to_string(), line));
        }
        out
    }

    /// A judged program, as the policy hands it over.
    fn program(path: &str) -> Program {
        Program {
            path: path.into(),
            bare_name: None,
        }
    }

    /// The judged file is what starts, under the name it was asked for by.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_judged_file_starts_and_sees_its_bare_name() {
        let (tx, rx) = mpsc::channel(LOCAL_PROCESS_OUTPUT_QUEUE_CAP);
        let token = CancellationToken::new();
        let judged = Program {
            path: "/bin/sh".into(),
            bare_name: Some("shown-name".into()),
        };
        let args = ["-c".to_string(), "echo \"$0\"".to_string()];
        execute_local_process(&judged, &args, Duration::from_secs(5), &token, tx)
            .await
            .unwrap();
        assert_eq!(
            collect_output(rx),
            vec![("stdout".to_string(), "shown-name".to_string())]
        );
    }

    /// A program the user approved for this run starts without being listed, and
    /// only as the file that was approved.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_approved_program_starts_only_as_the_file_that_was_approved() {
        use crate::utils::config_paths::ConfigDirOverride;
        use tauri::Manager;

        let dir = tempfile::TempDir::new().unwrap();
        let app = tauri::test::mock_app();
        app.manage(ConfigDirOverride(dir.path().to_path_buf()));
        app.manage(LocalProcessRegistry::default());
        manage_automation(&app, dir.path(), "/usr/bin/touch");
        let storage = SettingsStorage::new(app.handle()).unwrap();
        storage
            .save(&AppSettings {
                experimental_features_enabled: Some(true),
                workflow_local_process_enabled: true,
                ..AppSettings::default()
            })
            .unwrap();
        for (approved, starts) in [("/usr/bin/true", false), ("/usr/bin/touch", true)] {
            let marker = dir.path().join("spawned");
            let result = run_local_process(
                "run-1".into(),
                "/usr/bin/touch".into(),
                vec![marker.display().to_string()],
                vec!["mine".into()],
                Some(5_000),
                Some(approved.into()),
                app.state(),
                app.handle().clone(),
            )
            .await;
            assert_eq!(result.is_ok(), starts, "{approved}: {result:?}");
            assert_eq!(marker.exists(), starts, "{approved}");
        }
    }

    /// Unreadable settings refuse, and the check never repairs or resets the file.
    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_settings_refuse_and_are_left_alone() {
        use crate::utils::config_paths::ConfigDirOverride;
        use tauri::Manager;

        let on = r#""experimentalFeaturesEnabled":true,"workflowLocalProcessEnabled":true"#;
        for raw in [
            "{ not json".to_string(),
            format!(
                r#"{{"version":"9999",{on},"workflowLocalProcessAllowlist":["/usr/bin/touch"]}}"#
            ),
            format!(r#"{{"version":"1",{on},"workflowLocalProcessAllowlist":"/usr/bin/touch"}}"#),
            format!(
                r#"{{"version":"1",{on},"workflowLocalProcessAllowlist":["/usr/bin/touch",7]}}"#
            ),
        ] {
            let dir = tempfile::TempDir::new().unwrap();
            let file = dir.path().join("settings.json");
            std::fs::write(&file, &raw).unwrap();
            let app = tauri::test::mock_app();
            app.manage(ConfigDirOverride(dir.path().to_path_buf()));
            app.manage(LocalProcessRegistry::default());
            let marker = dir.path().join("spawned");
            // Also when the window says that the user approved it.
            for approved in [None, Some("/usr/bin/touch".to_string())] {
                let result = run_local_process(
                    "run-1".into(),
                    "/usr/bin/touch".into(),
                    vec![marker.display().to_string()],
                    vec!["mine".into()],
                    Some(5_000),
                    approved,
                    app.state(),
                    app.handle().clone(),
                )
                .await;
                assert!(
                    result.unwrap_err().to_string().contains("cannot be read"),
                    "{raw}"
                );
            }
            let verdict = check_local_process(
                "/usr/bin/touch".into(),
                Vec::new(),
                vec!["mine".into()],
                app.handle().clone(),
            );
            assert!(
                matches!(verdict, LocalProcessCheck::Refused { .. }),
                "{raw}"
            );
            assert!(!marker.exists());
            assert_eq!(std::fs::read_to_string(&file).unwrap(), raw);
            assert_eq!(
                std::fs::read_dir(dir.path()).unwrap().count(),
                1,
                "no backup file"
            );
        }
    }

    /// GUARDRAIL: a space-containing argument is passed as a single discrete argv
    /// entry — never split or shell-interpreted. `printf '[%s]\n'` re-applies its
    /// format once per argument, so one argument prints `[a b]` while two would
    /// print `[a]` then `[b]`.
    #[cfg(unix)]
    #[tokio::test]
    async fn passes_args_as_discrete_argv_no_shell() {
        let (tx, rx) = mpsc::channel(LOCAL_PROCESS_OUTPUT_QUEUE_CAP);
        let token = CancellationToken::new();
        let args = vec!["[%s]\n".to_string(), "a b".to_string()];
        let outcome = execute_local_process(
            &program("/usr/bin/printf"),
            &args,
            Duration::from_secs(5),
            &token,
            tx,
        )
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
        let (tx, rx) = mpsc::channel(LOCAL_PROCESS_OUTPUT_QUEUE_CAP);
        let token = CancellationToken::new();
        let args = vec!["%s\n".to_string(), "; rm -rf / && echo pwned".to_string()];
        let outcome = execute_local_process(
            &program("/usr/bin/printf"),
            &args,
            Duration::from_secs(5),
            &token,
            tx,
        )
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
        let (tx, _rx) = mpsc::channel(LOCAL_PROCESS_OUTPUT_QUEUE_CAP);
        let token = CancellationToken::new();
        // `sh -c 'exit 3'` is spawned as a direct argv (no shell wrapping by us);
        // it deterministically exits 3.
        let args = vec!["-c".to_string(), "exit 3".to_string()];
        let outcome = execute_local_process(
            &program("/bin/sh"),
            &args,
            Duration::from_secs(5),
            &token,
            tx,
        )
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
        let (tx, _rx) = mpsc::channel(LOCAL_PROCESS_OUTPUT_QUEUE_CAP);
        let token = CancellationToken::new();
        let args = vec!["30".to_string()];
        let outcome = execute_local_process(
            &program("/bin/sleep"),
            &args,
            Duration::from_millis(150),
            &token,
            tx,
        )
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
        let (tx, _rx) = mpsc::channel(LOCAL_PROCESS_OUTPUT_QUEUE_CAP);
        let token = CancellationToken::new();
        let cancel_token = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            cancel_token.cancel();
        });
        let args = vec!["30".to_string()];
        let outcome = execute_local_process(
            &program("/bin/sleep"),
            &args,
            Duration::from_secs(30),
            &token,
            tx,
        )
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
        let (tx, _rx) = mpsc::channel(LOCAL_PROCESS_OUTPUT_QUEUE_CAP);
        let token = CancellationToken::new();
        let args = vec!["/c".to_string(), "exit 3".to_string()];
        let outcome =
            execute_local_process(&program("cmd"), &args, Duration::from_secs(5), &token, tx)
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
        let (tx, _rx) = mpsc::channel(LOCAL_PROCESS_OUTPUT_QUEUE_CAP);
        let token = CancellationToken::new();
        // ping -n 30 keeps the process alive well past the timeout.
        let args = vec!["-n".to_string(), "30".to_string(), "127.0.0.1".to_string()];
        let outcome = execute_local_process(
            &program("ping"),
            &args,
            Duration::from_millis(200),
            &token,
            tx,
        )
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

    /// TAURI-014: the output channel is bounded and applies **backpressure**, not
    /// dropping. A full buffer rejects an eager `try_send` (so the reader would
    /// `.await` instead of growing the queue); once the consumer drains, the held
    /// line is delivered — nothing is lost, and order is preserved.
    #[tokio::test]
    async fn output_channel_applies_backpressure_without_dropping() {
        let (tx, mut rx) = mpsc::channel::<(&'static str, String)>(1);

        // Fill the single buffer slot.
        tx.send(("stdout", "first".to_string())).await.unwrap();

        // The buffer is full: an eager send cannot be accepted — a real reader
        // would suspend on `send().await` here rather than queue more (bounded
        // memory), and crucially the line is NOT discarded.
        match tx.try_send(("stdout", "second".to_string())) {
            Err(mpsc::error::TrySendError::Full((stream, line))) => {
                assert_eq!(stream, "stdout");
                assert_eq!(line, "second");
            }
            other => panic!("expected a Full backpressure signal, got {other:?}"),
        }

        // Draining frees a slot; the previously-blocked line then flows through in
        // order — throttled, never dropped.
        assert_eq!(rx.recv().await.unwrap(), ("stdout", "first".to_string()));
        tx.send(("stdout", "second".to_string())).await.unwrap();
        assert_eq!(rx.recv().await.unwrap(), ("stdout", "second".to_string()));
    }

    /// TAURI-014: every produced line survives the bounded channel in order, even
    /// when the buffer is far smaller than the number of lines — the reader is
    /// throttled by backpressure, and no line is skipped or reordered.
    #[tokio::test]
    async fn spawn_reader_preserves_all_lines_in_order_under_backpressure() {
        use tokio::io::AsyncWriteExt;

        // A tiny (capacity-1) channel guarantees the reader hits backpressure
        // repeatedly while the consumer drains one line at a time.
        let (tx, mut rx) = mpsc::channel::<(&'static str, String)>(1);
        let (client, mut server) = tokio::io::duplex(64);

        // Feed 50 numbered lines, then drop the writer to signal EOF.
        tokio::spawn(async move {
            for i in 0..50 {
                server
                    .write_all(format!("line{i}\n").as_bytes())
                    .await
                    .unwrap();
            }
            drop(server);
        });

        let handle = spawn_reader(Some(client), "stdout", tx);

        let mut got = Vec::new();
        while let Some((stream, line)) = rx.recv().await {
            assert_eq!(stream, "stdout");
            got.push(line);
        }
        handle.await.unwrap();

        let expected: Vec<String> = (0..50).map(|i| format!("line{i}")).collect();
        assert_eq!(
            got, expected,
            "all lines must arrive exactly once, in order"
        );
    }
}

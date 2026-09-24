//! Process listing and termination — types, parsers, and the cross-backend
//! [`ProcessManager`] seam (PROD-0028).
//!
//! The monitoring subsystem surfaces aggregate [`SystemStats`](super::SystemStats)
//! per backend but has no per-process view and no way to terminate a process.
//! This module adds both, mirroring the monitoring provider split:
//!
//! * A backend exposes an optional [`ProcessManager`] (see
//!   [`ConnectionType::process_manager`](crate::connection::ConnectionType::process_manager)).
//!   Backends with no notion of processes (serial, telnet, …) return `None` and
//!   the capability is simply absent.
//! * Linux-like remotes (SSH / Docker / WSL) share one implementation,
//!   [`ExecProcessManager`], which runs [`PROCESS_LIST_COMMAND`] / a `kill`
//!   command over the backend's own exec transport (a [`ProcessExecSource`],
//!   the process twin of [`ProcStatsSource`](super::ProcStatsSource)) and parses
//!   the output with [`parse_ps_output`]. One exec per refresh — never one per
//!   process.
//! * The local machine uses a `sysinfo`-based manager (see
//!   `local_process`), gated behind the `local-shell` feature.
//!
//! ## Kill safety
//!
//! Termination is destructive, so this module is deliberately conservative:
//!
//! * Only two signals are offered — [`KillSignal::Term`] (SIGTERM) and
//!   [`KillSignal::Kill`] (SIGKILL). A fuller signal menu is an explicit
//!   follow-up, not something this code invents.
//! * A kill always targets an exact numeric [`pid`](ProcessInfo::pid). The pid
//!   is a `u32`, so a kill can never degrade into a name-matched sweep, and the
//!   remote command built by [`build_kill_command`] interpolates only that
//!   integer and a fixed signal name — no user text reaches the shell.
//! * Every failure is a typed [`ProcessError`]; nothing is silently swallowed.

use serde::{Deserialize, Serialize};

use crate::errors::CoreError;

/// Maximum number of processes returned by a single list.
///
/// The list is the top CPU consumers (the `ps` command sorts by `-pcpu`; the
/// local `sysinfo` manager sorts the same way before truncating). A hard cap
/// keeps the payload — and the rendered table — bounded regardless of how many
/// processes the host runs.
pub const MAX_PROCESSES: usize = 50;

/// The command run on Linux-like hosts (SSH / Docker / WSL) to list processes.
///
/// `export LC_ALL=C LANG=C;` pins a stable locale so `pcpu` / `pmem` are
/// dot-decimal and ungrouped regardless of the remote's `$LANG` (mirrors
/// [`MONITORING_COMMAND`](super::MONITORING_COMMAND)). Columns are fixed and
/// parsed positionally by [`parse_ps_output`]: `pid user pcpu pmem comm`, sorted
/// by descending CPU so the interesting processes come first even before the
/// cap is applied. `comm` (the executable name, not the full arg vector) is last
/// so a name with embedded spaces still parses.
pub const PROCESS_LIST_COMMAND: &str =
    "export LC_ALL=C LANG=C; ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu";

/// A single process as shown in the process table.
///
/// Field naming is `camelCase` on the wire to match the frontend/agent JSON
/// convention (as with [`SystemStats`](super::SystemStats)).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    /// Numeric process id — the exact, only target a kill ever uses.
    pub pid: u32,
    /// Process/command name (`comm` on `ps`, the executable name on `sysinfo`).
    pub name: String,
    /// Owning user name. Empty string when the source cannot resolve it.
    pub user: String,
    /// CPU usage percentage. May exceed 100 on multi-core hosts (per `ps`/`top`
    /// convention). `0.0` when the source has no delta yet.
    pub cpu_percent: f64,
    /// Resident memory as a percentage of total RAM.
    pub memory_percent: f64,
    /// Resident memory in kB when the source reports it (local `sysinfo`).
    /// `None` for `ps`-sourced remotes, which report only `pmem` percentage in
    /// the single round-trip.
    #[serde(default)]
    pub memory_kb: Option<u64>,
}

/// The termination signal to deliver.
///
/// Deliberately limited to the two safe, universally-portable signals. A fuller
/// menu (HUP, INT, USR1/2, …) is an explicit follow-up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KillSignal {
    /// SIGTERM — polite, catchable termination request. The default.
    Term,
    /// SIGKILL — forced, uncatchable termination.
    Kill,
}

impl KillSignal {
    /// The signal name as `kill` expects it after `-s` (e.g. `"TERM"`).
    pub fn as_name(self) -> &'static str {
        match self {
            KillSignal::Term => "TERM",
            KillSignal::Kill => "KILL",
        }
    }

    /// The POSIX signal number (SIGTERM = 15, SIGKILL = 9).
    pub fn as_number(self) -> i32 {
        match self {
            KillSignal::Term => 15,
            KillSignal::Kill => 9,
        }
    }
}

/// Build the remote shell command that kills exactly `pid` with `signal`.
///
/// `kill -s <NAME> <pid>` targets a single numeric pid; the only interpolated
/// values are a fixed signal name and an integer, so no caller-supplied text
/// ever reaches the shell and the command can never become a name-matched
/// `pkill`-style sweep.
pub fn build_kill_command(pid: u32, signal: KillSignal) -> String {
    format!(
        "export LC_ALL=C LANG=C; kill -s {} {}",
        signal.as_name(),
        pid
    )
}

/// Parse the output of [`PROCESS_LIST_COMMAND`] into [`ProcessInfo`] rows.
///
/// Robustness contract (this output comes from an untrusted remote):
/// * The header line (`PID USER …`) is skipped naturally — its first column
///   does not parse as a `u32`.
/// * Any line whose pid / cpu / mem columns do not parse, or that has too few
///   columns, is **skipped**, never panicked on.
/// * At most [`MAX_PROCESSES`] rows are returned; input is assumed pre-sorted by
///   descending CPU (the command's `--sort=-pcpu`), so truncation keeps the top
///   consumers.
pub fn parse_ps_output(output: &str) -> Vec<ProcessInfo> {
    let mut processes = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Columns: pid user pcpu pmem comm. `split_whitespace` collapses runs of
        // spaces; `comm` is last and may (rarely) contain spaces, so the first
        // four columns are taken positionally and everything after is the name.
        let cols: Vec<&str> = trimmed.split_whitespace().collect();
        if cols.len() < 5 {
            continue;
        }

        let pid: u32 = match cols[0].parse() {
            Ok(p) => p,
            Err(_) => continue, // header row or garbage — skip.
        };
        let user = cols[1].to_string();
        let cpu_percent: f64 = match cols[2].parse() {
            Ok(c) => c,
            Err(_) => continue,
        };
        let memory_percent: f64 = match cols[3].parse() {
            Ok(m) => m,
            Err(_) => continue,
        };
        // `comm` is the remaining columns joined — handles the rare name with a
        // space without misattributing a numeric column.
        let name = cols[4..].join(" ");
        if name.is_empty() {
            continue;
        }

        processes.push(ProcessInfo {
            pid,
            name,
            user,
            cpu_percent,
            memory_percent,
            memory_kb: None,
        });

        if processes.len() >= MAX_PROCESSES {
            break;
        }
    }

    processes
}

/// Truncate a process list to [`MAX_PROCESSES`], keeping the highest CPU first.
///
/// Used by the local (`sysinfo`) manager, whose source is not pre-sorted. The
/// `ps` path is already sorted and capped in [`parse_ps_output`], so this is the
/// single shared place the cap and ordering rule live.
pub fn sort_and_cap(mut processes: Vec<ProcessInfo>) -> Vec<ProcessInfo> {
    processes.sort_by(|a, b| {
        b.cpu_percent
            .partial_cmp(&a.cpu_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    processes.truncate(MAX_PROCESSES);
    processes
}

/// A typed error from a [`ProcessManager`] operation.
///
/// A destructive operation must fail loudly and specifically, never as an opaque
/// string. This crosses the Tauri IPC boundary to the frontend, where it is
/// serialized (see the [`Serialize`] impl below) as the same
/// `{ code, message, details }` envelope the desktop `TerminalError` uses, so the
/// frontend's `parseBackendError` renders its clean `message` unchanged and can
/// branch on the stable `code`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProcessError {
    /// This backend has no process management (serial, telnet, a graphical
    /// backend, …). The UI capability-gates on this so it is a defensive
    /// backstop rather than an expected path.
    #[error("process management is not supported for this connection")]
    NotSupported,

    /// The target process does not exist (already exited, or a stale pid).
    #[error("process {0} not found")]
    NotFound(u32),

    /// The operation was refused for lack of privilege (e.g. killing a process
    /// owned by another user without the rights to do so).
    #[error("permission denied: {0}")]
    PermissionDenied(String),

    /// Listing failed (transport/exec error, unparseable output).
    #[error("failed to list processes: {0}")]
    ListFailed(String),

    /// Killing failed for a reason other than the specific cases above.
    #[error("failed to kill process {pid}: {message}")]
    KillFailed { pid: u32, message: String },
}

impl ProcessError {
    /// A stable, locale-independent machine code for this error — the `code`
    /// field of the IPC envelope, mirroring [`TerminalError`]'s scheme so the
    /// frontend can classify structurally rather than by matching English text.
    pub fn code(&self) -> &'static str {
        match self {
            ProcessError::NotSupported => "process_not_supported",
            ProcessError::NotFound(_) => "process_not_found",
            ProcessError::PermissionDenied(_) => "process_permission_denied",
            ProcessError::ListFailed(_) => "process_list_failed",
            ProcessError::KillFailed { .. } => "process_kill_failed",
        }
    }
}

impl From<CoreError> for ProcessError {
    fn from(e: CoreError) -> Self {
        ProcessError::ListFailed(e.to_string())
    }
}

impl Serialize for ProcessError {
    /// Serialize as the structured IPC error envelope `{ code, message, details }`
    /// so the frontend renders `message` and can branch on `code` — identical in
    /// shape to how [`TerminalError`] crosses the boundary.
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut envelope = serializer.serialize_struct("ProcessError", 3)?;
        envelope.serialize_field("code", self.code())?;
        envelope.serialize_field("message", &self.to_string())?;
        envelope.serialize_field("details", &Option::<()>::None)?;
        envelope.end()
    }
}

/// Result of running a single command over a backend's exec transport.
///
/// Unlike [`ProcStatsSource`](super::ProcStatsSource) (which needs only stdout),
/// a kill must know whether the command *succeeded*, so this carries stderr and
/// the exit status too. `exit_status` is `None` when the transport cannot report
/// one (it is then inferred from stderr).
#[derive(Debug, Clone, Default)]
pub struct ProcessCommandOutput {
    /// Captured stdout.
    pub stdout: String,
    /// Captured stderr (used to classify a kill failure).
    pub stderr: String,
    /// Process exit status, when the transport reports it.
    pub exit_status: Option<i32>,
}

/// A backend's exec transport for process operations — the process twin of
/// [`ProcStatsSource`](super::ProcStatsSource).
///
/// Implementations run an arbitrary command in the target (an SSH exec channel,
/// `docker exec`, `wsl.exe -d <distro>`) and return its captured output. Used by
/// [`ExecProcessManager`] for both listing and killing so neither the `ps`
/// parsing nor the kill-result classification is re-implemented per backend.
#[async_trait::async_trait]
pub trait ProcessExecSource: Send + Sync + 'static {
    /// Run `command` in the target and return its captured output.
    async fn exec(&self, command: &str) -> Result<ProcessCommandOutput, CoreError>;
}

/// Cross-backend process management capability.
///
/// Obtained from [`ConnectionType::process_manager`](crate::connection::ConnectionType::process_manager).
/// A backend that returns `None` has no process capability at all.
#[async_trait::async_trait]
pub trait ProcessManager: Send + Sync {
    /// List the top [`MAX_PROCESSES`] processes by CPU.
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, ProcessError>;

    /// Terminate `pid` with `signal`. Targets the exact pid only.
    async fn kill_process(&self, pid: u32, signal: KillSignal) -> Result<(), ProcessError>;
}

/// Classify a failed remote `kill` from its captured output.
///
/// `kill` writes a diagnostic to stderr and exits non-zero. The two cases worth
/// distinguishing for the user are "no such process" (the process already went
/// away — effectively success from their point of view, but reported honestly)
/// and "operation not permitted" (a privilege problem). Everything else is a
/// generic [`ProcessError::KillFailed`].
fn classify_kill_failure(pid: u32, output: &ProcessCommandOutput) -> ProcessError {
    let stderr = output.stderr.to_ascii_lowercase();
    if stderr.contains("no such process") {
        ProcessError::NotFound(pid)
    } else if stderr.contains("not permitted") || stderr.contains("permission denied") {
        ProcessError::PermissionDenied(output.stderr.trim().to_string())
    } else {
        let message = if output.stderr.trim().is_empty() {
            match output.exit_status {
                Some(code) => format!("kill exited with status {code}"),
                None => "kill failed".to_string(),
            }
        } else {
            output.stderr.trim().to_string()
        };
        ProcessError::KillFailed { pid, message }
    }
}

/// `true` when a captured command output indicates success.
///
/// A `None` exit status (transport cannot report one) is treated as success
/// only when stderr is empty — otherwise a diagnostic on stderr is taken as a
/// failure to classify.
fn command_succeeded(output: &ProcessCommandOutput) -> bool {
    match output.exit_status {
        Some(0) => true,
        Some(_) => false,
        None => output.stderr.trim().is_empty(),
    }
}

/// [`ProcessManager`] for Linux-like exec backends (SSH / Docker / WSL).
///
/// Runs [`PROCESS_LIST_COMMAND`] / [`build_kill_command`] over a
/// [`ProcessExecSource`] and reuses [`parse_ps_output`]. One exec per operation.
pub struct ExecProcessManager {
    source: std::sync::Arc<dyn ProcessExecSource>,
}

impl ExecProcessManager {
    /// Wrap an exec source as a process manager.
    pub fn new(source: std::sync::Arc<dyn ProcessExecSource>) -> Self {
        Self { source }
    }
}

#[async_trait::async_trait]
impl ProcessManager for ExecProcessManager {
    async fn list_processes(&self) -> Result<Vec<ProcessInfo>, ProcessError> {
        let output = self
            .source
            .exec(PROCESS_LIST_COMMAND)
            .await
            .map_err(|e| ProcessError::ListFailed(e.to_string()))?;
        // `ps` may exit non-zero on some minimal hosts while still producing a
        // usable table; parse whatever stdout we got. Only a total absence of
        // parseable rows is a failure.
        let processes = parse_ps_output(&output.stdout);
        if processes.is_empty() && !command_succeeded(&output) {
            let detail = if output.stderr.trim().is_empty() {
                "ps produced no parseable output".to_string()
            } else {
                output.stderr.trim().to_string()
            };
            return Err(ProcessError::ListFailed(detail));
        }
        Ok(processes)
    }

    async fn kill_process(&self, pid: u32, signal: KillSignal) -> Result<(), ProcessError> {
        let command = build_kill_command(pid, signal);
        let output = self
            .source
            .exec(&command)
            .await
            .map_err(|e| ProcessError::KillFailed {
                pid,
                message: e.to_string(),
            })?;
        if command_succeeded(&output) {
            Ok(())
        } else {
            Err(classify_kill_failure(pid, &output))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    // ── KillSignal mapping ──────────────────────────────────────────────

    #[test]
    fn kill_signal_names_and_numbers() {
        assert_eq!(KillSignal::Term.as_name(), "TERM");
        assert_eq!(KillSignal::Kill.as_name(), "KILL");
        assert_eq!(KillSignal::Term.as_number(), 15);
        assert_eq!(KillSignal::Kill.as_number(), 9);
    }

    #[test]
    fn kill_signal_serde_is_camel_case() {
        assert_eq!(
            serde_json::to_string(&KillSignal::Term).unwrap(),
            "\"term\""
        );
        assert_eq!(
            serde_json::to_string(&KillSignal::Kill).unwrap(),
            "\"kill\""
        );
        let s: KillSignal = serde_json::from_str("\"kill\"").unwrap();
        assert_eq!(s, KillSignal::Kill);
    }

    // ── build_kill_command targets the EXACT pid + signal ───────────────

    #[test]
    fn build_kill_command_uses_exact_pid_and_signal() {
        assert_eq!(
            build_kill_command(4321, KillSignal::Term),
            "export LC_ALL=C LANG=C; kill -s TERM 4321"
        );
        assert_eq!(
            build_kill_command(9, KillSignal::Kill),
            "export LC_ALL=C LANG=C; kill -s KILL 9"
        );
    }

    #[test]
    fn build_kill_command_never_contains_a_wildcard_or_name() {
        // A regression guard: the command must be a numeric-pid kill, never a
        // name-matched sweep (no `pkill`, `killall`, `-r`, or `*`).
        let cmd = build_kill_command(1234, KillSignal::Kill);
        assert!(cmd.contains(" 1234"));
        assert!(!cmd.contains("pkill"));
        assert!(!cmd.contains("killall"));
        assert!(!cmd.contains('*'));
    }

    // ── parse_ps_output ─────────────────────────────────────────────────

    const PS_SAMPLE: &str = "\
  PID USER             %CPU %MEM COMMAND
    1 root              0.0  0.1 systemd
  842 alice            12.5  3.4 firefox
 1337 bob               5.2  1.0 node
";

    #[test]
    fn parse_ps_output_skips_header_and_parses_rows() {
        let procs = parse_ps_output(PS_SAMPLE);
        assert_eq!(procs.len(), 3);

        assert_eq!(procs[0].pid, 1);
        assert_eq!(procs[0].user, "root");
        assert_eq!(procs[0].cpu_percent, 0.0);
        assert_eq!(procs[0].memory_percent, 0.1);
        assert_eq!(procs[0].name, "systemd");
        assert_eq!(procs[0].memory_kb, None);

        assert_eq!(procs[1].pid, 842);
        assert_eq!(procs[1].user, "alice");
        assert_eq!(procs[1].cpu_percent, 12.5);
        assert_eq!(procs[1].memory_percent, 3.4);
        assert_eq!(procs[1].name, "firefox");

        assert_eq!(procs[2].pid, 1337);
        assert_eq!(procs[2].name, "node");
    }

    #[test]
    fn parse_ps_output_skips_malformed_lines_without_panicking() {
        let input = "\
  PID USER             %CPU %MEM COMMAND
    1 root              0.0  0.1 systemd
garbage line with too few
  abc root              1.0  1.0 notapid
  842 alice            12.5  3.4 firefox
   99 nan_user          x.y  1.0 badcpu
";
        let procs = parse_ps_output(input);
        // Only the two well-formed rows survive; the header, the short line, the
        // non-numeric pid, and the non-numeric cpu are all skipped.
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 1);
        assert_eq!(procs[1].pid, 842);
    }

    #[test]
    fn parse_ps_output_handles_command_names_with_spaces() {
        let input = "  PID USER %CPU %MEM COMMAND\n 200 root 1.0 2.0 my daemon proc\n";
        let procs = parse_ps_output(input);
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].name, "my daemon proc");
        assert_eq!(procs[0].pid, 200);
    }

    #[test]
    fn parse_ps_output_caps_at_max_processes() {
        let mut input = String::from("  PID USER %CPU %MEM COMMAND\n");
        for i in 0..(MAX_PROCESSES + 25) {
            input.push_str(&format!("{} root 1.0 1.0 proc{}\n", 1000 + i, i));
        }
        let procs = parse_ps_output(&input);
        assert_eq!(procs.len(), MAX_PROCESSES);
        // Truncation keeps the first (highest-CPU, per the command's sort) rows.
        assert_eq!(procs[0].pid, 1000);
    }

    #[test]
    fn parse_ps_output_empty_input_is_empty_not_panic() {
        assert!(parse_ps_output("").is_empty());
        assert!(parse_ps_output("   \n  \n").is_empty());
    }

    #[test]
    fn sort_and_cap_sorts_desc_and_truncates() {
        let mk = |pid: u32, cpu: f64| ProcessInfo {
            pid,
            name: format!("p{pid}"),
            user: "u".into(),
            cpu_percent: cpu,
            memory_percent: 0.0,
            memory_kb: None,
        };
        let mut input = vec![mk(1, 5.0), mk(2, 50.0), mk(3, 20.0)];
        for i in 0..MAX_PROCESSES {
            input.push(mk(1000 + i as u32, 0.0));
        }
        let out = sort_and_cap(input);
        assert_eq!(out.len(), MAX_PROCESSES);
        assert_eq!(out[0].pid, 2); // 50%
        assert_eq!(out[1].pid, 3); // 20%
        assert_eq!(out[2].pid, 1); // 5%
    }

    // ── kill failure classification ─────────────────────────────────────

    #[test]
    fn classify_kill_failure_maps_no_such_process_to_not_found() {
        let out = ProcessCommandOutput {
            stdout: String::new(),
            stderr: "kill: (4321): No such process".into(),
            exit_status: Some(1),
        };
        assert_eq!(
            classify_kill_failure(4321, &out),
            ProcessError::NotFound(4321)
        );
    }

    #[test]
    fn classify_kill_failure_maps_not_permitted_to_permission_denied() {
        let out = ProcessCommandOutput {
            stdout: String::new(),
            stderr: "kill: (1): Operation not permitted".into(),
            exit_status: Some(1),
        };
        matches!(
            classify_kill_failure(1, &out),
            ProcessError::PermissionDenied(_)
        )
        .then_some(())
        .expect("not-permitted must map to PermissionDenied");
    }

    #[test]
    fn classify_kill_failure_generic_when_unknown() {
        let out = ProcessCommandOutput {
            stdout: String::new(),
            stderr: "kill: something weird".into(),
            exit_status: Some(2),
        };
        match classify_kill_failure(7, &out) {
            ProcessError::KillFailed { pid, .. } => assert_eq!(pid, 7),
            other => panic!("expected KillFailed, got {other:?}"),
        }
    }

    #[test]
    fn command_succeeded_rules() {
        assert!(command_succeeded(&ProcessCommandOutput {
            exit_status: Some(0),
            ..Default::default()
        }));
        assert!(!command_succeeded(&ProcessCommandOutput {
            exit_status: Some(1),
            ..Default::default()
        }));
        // No exit status + empty stderr = success; + stderr = failure.
        assert!(command_succeeded(&ProcessCommandOutput {
            exit_status: None,
            stderr: "  ".into(),
            ..Default::default()
        }));
        assert!(!command_succeeded(&ProcessCommandOutput {
            exit_status: None,
            stderr: "boom".into(),
            ..Default::default()
        }));
    }

    // ── ExecProcessManager over a fake source ───────────────────────────

    struct FakeExecSource {
        /// Records the exact commands run, in order.
        commands: Arc<Mutex<Vec<String>>>,
        calls: Arc<AtomicUsize>,
        list_output: String,
        kill_output: ProcessCommandOutput,
        fail_exec: bool,
    }

    impl FakeExecSource {
        fn new(list_output: &str, kill_output: ProcessCommandOutput) -> Self {
            Self {
                commands: Arc::new(Mutex::new(Vec::new())),
                calls: Arc::new(AtomicUsize::new(0)),
                list_output: list_output.to_string(),
                kill_output,
                fail_exec: false,
            }
        }
    }

    #[async_trait::async_trait]
    impl ProcessExecSource for FakeExecSource {
        async fn exec(&self, command: &str) -> Result<ProcessCommandOutput, CoreError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.commands.lock().unwrap().push(command.to_string());
            if self.fail_exec {
                return Err(CoreError::Other("transport down".into()));
            }
            if command.contains("ps -eo") {
                Ok(ProcessCommandOutput {
                    stdout: self.list_output.clone(),
                    stderr: String::new(),
                    exit_status: Some(0),
                })
            } else {
                Ok(self.kill_output.clone())
            }
        }
    }

    #[tokio::test]
    async fn exec_manager_lists_processes() {
        let src = Arc::new(FakeExecSource::new(
            PS_SAMPLE,
            ProcessCommandOutput::default(),
        ));
        let mgr = ExecProcessManager::new(src.clone());
        let procs = mgr.list_processes().await.expect("list");
        assert_eq!(procs.len(), 3);
        assert_eq!(procs[1].name, "firefox");
        // Exactly one exec — never one per process.
        assert_eq!(src.calls.load(Ordering::SeqCst), 1);
        assert!(src.commands.lock().unwrap()[0].contains("ps -eo pid,user,pcpu,pmem,comm"));
    }

    #[tokio::test]
    async fn exec_manager_kill_sends_exact_pid_and_signal() {
        let src = Arc::new(FakeExecSource::new(
            "",
            ProcessCommandOutput {
                exit_status: Some(0),
                ..Default::default()
            },
        ));
        let mgr = ExecProcessManager::new(src.clone());
        mgr.kill_process(5555, KillSignal::Kill)
            .await
            .expect("kill");
        let cmds = src.commands.lock().unwrap();
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0], "export LC_ALL=C LANG=C; kill -s KILL 5555");
    }

    #[tokio::test]
    async fn exec_manager_kill_maps_no_such_process() {
        let src = Arc::new(FakeExecSource::new(
            "",
            ProcessCommandOutput {
                stderr: "kill: (5555): No such process".into(),
                exit_status: Some(1),
                ..Default::default()
            },
        ));
        let mgr = ExecProcessManager::new(src);
        let err = mgr.kill_process(5555, KillSignal::Term).await.unwrap_err();
        assert_eq!(err, ProcessError::NotFound(5555));
    }

    #[tokio::test]
    async fn exec_manager_list_transport_error_is_typed() {
        let mut src = FakeExecSource::new("", ProcessCommandOutput::default());
        src.fail_exec = true;
        let mgr = ExecProcessManager::new(Arc::new(src));
        let err = mgr.list_processes().await.unwrap_err();
        matches!(err, ProcessError::ListFailed(_))
            .then_some(())
            .expect("transport error must be a typed ListFailed");
    }

    #[test]
    fn process_error_serializes_as_ipc_envelope() {
        let json = serde_json::to_string(&ProcessError::NotSupported).unwrap();
        assert!(
            json.contains("\"code\":\"process_not_supported\""),
            "{json}"
        );
        assert!(json.contains("\"message\""));
        assert!(json.contains("\"details\":null"));

        let json = serde_json::to_string(&ProcessError::NotFound(42)).unwrap();
        assert!(json.contains("\"code\":\"process_not_found\""), "{json}");
        // The human message carries the pid.
        assert!(json.contains("42"), "{json}");
    }

    #[test]
    fn process_error_codes_are_stable() {
        assert_eq!(ProcessError::NotSupported.code(), "process_not_supported");
        assert_eq!(ProcessError::NotFound(1).code(), "process_not_found");
        assert_eq!(
            ProcessError::PermissionDenied("x".into()).code(),
            "process_permission_denied"
        );
        assert_eq!(
            ProcessError::ListFailed("x".into()).code(),
            "process_list_failed"
        );
        assert_eq!(
            ProcessError::KillFailed {
                pid: 1,
                message: "x".into()
            }
            .code(),
            "process_kill_failed"
        );
    }
}

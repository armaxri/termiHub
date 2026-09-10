//! Reusable SSH command-execution helper.
//!
//! Generalizes the stdout-only exec used internally by monitoring into a
//! helper that writes stdin to the exec channel and captures the command's
//! **stdout, stderr, and exit status**. Higher layers use this to run a remote
//! command and inspect its full result — e.g. probing whether a connection can
//! open an exec channel at all, or (later) piping content into `sudo tee` for
//! privilege-elevated writes.

use russh::ChannelMsg;

use crate::errors::CoreError;

use super::handler::SshSession;

/// Captured result of running a command over an SSH exec channel.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SshExecOutput {
    /// Everything the command wrote to standard output.
    pub stdout: String,
    /// Everything the command wrote to standard error.
    pub stderr: String,
    /// The command's exit status. `0` on success; defaults to `0` only when the
    /// server closes the channel without reporting a status **or** a signal. A
    /// command killed by a signal reports a non-zero `128 + signum` status (see
    /// [`terminated_by_signal`](Self::terminated_by_signal)), so a signalled
    /// death never masquerades as success.
    pub exit_status: i32,
    /// When the remote command was terminated by a signal (SSH `exit-signal`
    /// rather than `exit-status`), the signal name (e.g. `"KILL"`, `"TERM"`,
    /// `"SEGV"`). `None` for a normally-exited command. This makes a
    /// signal-killed command distinguishable from a clean exit even before
    /// inspecting `exit_status`.
    pub terminated_by_signal: Option<String>,
}

/// A single event read from an exec channel while a command runs.
///
/// Modelled as a small enum so the orchestration in [`run_exec`] can be
/// exercised by unit tests with a scripted mock channel, without a live SSH
/// server.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ExecEvent {
    /// A chunk of standard-output bytes.
    Stdout(Vec<u8>),
    /// A chunk of standard-error bytes.
    Stderr(Vec<u8>),
    /// The command's reported exit status.
    Exit(i32),
    /// The command was terminated by a signal; carries the signal name (e.g.
    /// `"KILL"`). The remote sends this (SSH `exit-signal`) instead of an exit
    /// status when a process dies from a signal.
    Signal(String),
    /// The remote signalled end-of-output.
    Eof,
    /// The channel closed; no further events will arrive.
    Closed,
}

/// Minimal abstraction over an SSH exec channel.
///
/// Exists so [`run_exec`] can be unit-tested with a mock channel that scripts
/// its [`ExecEvent`]s, decoupling the stdin/stdout/stderr/exit-status handling
/// from the live russh channel.
#[async_trait::async_trait]
trait ExecChannel {
    /// Start executing `command` on the channel.
    async fn exec(&mut self, command: &str) -> Result<(), CoreError>;
    /// Write `data` to the command's standard input.
    async fn write_stdin(&mut self, data: &[u8]) -> Result<(), CoreError>;
    /// Signal end-of-input so the command sees EOF on its stdin.
    async fn send_eof(&mut self) -> Result<(), CoreError>;
    /// Await the next channel event, or `None` once the channel is exhausted.
    async fn next_event(&mut self) -> Option<ExecEvent>;
}

/// Orchestrate a single command execution over an [`ExecChannel`].
///
/// Starts the command, writes `stdin` (when non-empty), signals EOF, then
/// drains channel events accumulating stdout, stderr, and the exit status
/// until the channel closes.
async fn run_exec<C: ExecChannel>(
    channel: &mut C,
    command: &str,
    stdin: &str,
) -> Result<SshExecOutput, CoreError> {
    channel.exec(command).await?;

    if !stdin.is_empty() {
        channel.write_stdin(stdin.as_bytes()).await?;
    }
    // Always signal EOF so a command that reads stdin (e.g. `cat`, `sudo tee`)
    // sees end-of-input and terminates; harmless for commands that read none.
    channel.send_eof().await?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut exit_status = 0;
    let mut terminated_by_signal: Option<String> = None;

    while let Some(event) = channel.next_event().await {
        match event {
            ExecEvent::Stdout(data) => stdout.extend_from_slice(&data),
            ExecEvent::Stderr(data) => stderr.extend_from_slice(&data),
            ExecEvent::Exit(status) => exit_status = status,
            ExecEvent::Signal(_name) => {}
            ExecEvent::Eof => {}
            ExecEvent::Closed => break,
        }
    }

    Ok(SshExecOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_status,
        terminated_by_signal,
    })
}

/// Conventional POSIX signal number for a signal name, as used by SSH
/// `exit-signal` (RFC 4254 §6.10 names them without the `SIG` prefix).
///
/// Unknown / custom signal names map to `0`, which still yields a non-zero
/// `128 + 0` exit status via [`signal_exit_status`] so a signalled death is
/// never mistaken for success.
fn signal_number(name: &str) -> i32 {
    match name {
        "HUP" => 1,
        "INT" => 2,
        "QUIT" => 3,
        "ILL" => 4,
        "TRAP" => 5,
        "ABRT" | "IOT" => 6,
        "BUS" => 7,
        "FPE" => 8,
        "KILL" => 9,
        "USR1" => 10,
        "SEGV" => 11,
        "USR2" => 12,
        "PIPE" => 13,
        "ALRM" => 14,
        "TERM" => 15,
        _ => 0,
    }
}

/// Non-zero exit status for a command terminated by `signal_name`, following the
/// shell convention of `128 + signum` (e.g. `SIGKILL` → `137`). Always non-zero,
/// so a signal-killed command reads as a failure to callers that key success off
/// `exit_status == 0`.
fn signal_exit_status(signal_name: &str) -> i32 {
    128 + signal_number(signal_name)
}

/// Adapter implementing [`ExecChannel`] over a live russh channel.
struct RusshExecChannel(russh::Channel<russh::client::Msg>);

#[async_trait::async_trait]
impl ExecChannel for RusshExecChannel {
    async fn exec(&mut self, command: &str) -> Result<(), CoreError> {
        self.0
            .exec(false, command)
            .await
            .map_err(|e| CoreError::Other(format!("Exec failed: {e}")))
    }

    async fn write_stdin(&mut self, data: &[u8]) -> Result<(), CoreError> {
        self.0
            .data(data)
            .await
            .map_err(|e| CoreError::Other(format!("Write stdin failed: {e}")))
    }

    async fn send_eof(&mut self) -> Result<(), CoreError> {
        self.0
            .eof()
            .await
            .map_err(|e| CoreError::Other(format!("Send EOF failed: {e}")))
    }

    async fn next_event(&mut self) -> Option<ExecEvent> {
        // Loop so unrecognised messages (window adjustments, non-stderr
        // extended data, …) don't end the drain prematurely.
        loop {
            match self.0.wait().await {
                Some(ChannelMsg::Data { data }) => return Some(ExecEvent::Stdout(data.to_vec())),
                Some(ChannelMsg::ExtendedData { data, ext }) => {
                    // ext == 1 is stderr (SSH_EXTENDED_DATA_STDERR); ignore
                    // other extended-data types and keep draining.
                    if ext == 1 {
                        return Some(ExecEvent::Stderr(data.to_vec()));
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    return Some(ExecEvent::Exit(exit_status as i32));
                }
                Some(ChannelMsg::Eof) => return Some(ExecEvent::Eof),
                Some(ChannelMsg::Close) => return Some(ExecEvent::Closed),
                None => return None,
                _ => {}
            }
        }
    }
}

/// Execute `command` over an authenticated SSH `session`, sending `stdin` to
/// the command's standard input and capturing its stdout, stderr, and exit
/// status.
///
/// Pass an empty `stdin` for commands that read no input. This generalizes the
/// stdout-only exec used internally by the monitoring provider.
pub async fn ssh_exec_with_stdin(
    session: &SshSession,
    command: &str,
    stdin: &str,
) -> Result<SshExecOutput, CoreError> {
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| CoreError::Other(format!("Channel open failed: {e}")))?;
    let mut channel = RusshExecChannel(channel);
    run_exec(&mut channel, command, stdin).await
}

/// Marker string echoed by the exec-capability probe.
///
/// A working shell/exec channel echoes it back on stdout; an SFTP-only
/// connection (`ForceCommand internal-sftp`) or a relayed connection cannot run
/// the command, so the marker never reaches stdout. Kept beside the probe that
/// uses it (and consumed by the SSH exec integration tests) so the single
/// definition can never drift.
pub const EXEC_PROBE_MARKER: &str = "termihub_exec_probe_ok";

/// Decide, from an exec probe's captured output, whether the connection can run
/// remote commands (i.e. an exec channel is usable).
///
/// Keyed off the marker in stdout (not just a zero exit) so an SFTP-only server
/// that quietly closes the forced-subsystem channel with exit 0 is still
/// reported as not capable.
pub fn exec_probe_indicates_capability(output: &SshExecOutput) -> bool {
    output.exit_status == 0 && output.stdout.contains(EXEC_PROBE_MARKER)
}

/// Probe whether an exec (command) channel can be opened and used on `session`.
///
/// Runs a tiny command that echoes [`EXEC_PROBE_MARKER`] back over an exec
/// channel. A normal SSH+shell connection echoes it (`true`); an SFTP-only
/// (`ForceCommand internal-sftp`) or relayed connection cannot run the command,
/// so the marker never appears (`false`). Any transport error is also reported
/// as `false` — an unusable exec channel is "not capable", never a propagated
/// error. Lets a caller know whether privilege-elevated writes — which need a
/// shell to run `sudo` — are possible for this connection.
pub async fn probe_exec_capability(session: &SshSession) -> bool {
    let probe = format!("echo {EXEC_PROBE_MARKER}");
    match ssh_exec_with_stdin(session, &probe, "").await {
        Ok(output) => exec_probe_indicates_capability(&output),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// A scripted exec channel: yields a fixed sequence of [`ExecEvent`]s and
    /// records what the orchestration wrote to it.
    #[derive(Default)]
    struct MockChannel {
        events: VecDeque<ExecEvent>,
        commands: Vec<String>,
        stdin: Vec<u8>,
        eof_sent: bool,
        fail_exec: bool,
        /// When set, `next_event` never resolves — models a half-dead server
        /// that opened the channel but never sends EOF/Close, so the exec drain
        /// must be bounded by a timeout to recover.
        hang: bool,
    }

    impl MockChannel {
        fn with_events(events: Vec<ExecEvent>) -> Self {
            Self {
                events: events.into(),
                ..Default::default()
            }
        }

        /// A channel whose `next_event` blocks forever, simulating a stalled
        /// server that never closes the exec channel.
        fn hanging() -> Self {
            Self {
                hang: true,
                ..Default::default()
            }
        }
    }

    #[async_trait::async_trait]
    impl ExecChannel for MockChannel {
        async fn exec(&mut self, command: &str) -> Result<(), CoreError> {
            if self.fail_exec {
                return Err(CoreError::Other("exec refused".to_string()));
            }
            self.commands.push(command.to_string());
            Ok(())
        }

        async fn write_stdin(&mut self, data: &[u8]) -> Result<(), CoreError> {
            self.stdin.extend_from_slice(data);
            Ok(())
        }

        async fn send_eof(&mut self) -> Result<(), CoreError> {
            self.eof_sent = true;
            Ok(())
        }

        async fn next_event(&mut self) -> Option<ExecEvent> {
            if self.hang {
                // Never resolves; the caller must impose a timeout.
                std::future::pending::<()>().await;
            }
            self.events.pop_front()
        }
    }

    fn bytes(s: &str) -> Vec<u8> {
        s.as_bytes().to_vec()
    }

    #[tokio::test]
    async fn captures_stdout_stderr_and_exit_status() {
        let mut ch = MockChannel::with_events(vec![
            ExecEvent::Stdout(bytes("hello\n")),
            ExecEvent::Stderr(bytes("oops\n")),
            ExecEvent::Exit(3),
            ExecEvent::Eof,
            ExecEvent::Closed,
        ]);

        let out = run_exec(&mut ch, "do-thing", "")
            .await
            .expect("run_exec should succeed");

        assert_eq!(out.stdout, "hello\n");
        assert_eq!(out.stderr, "oops\n");
        assert_eq!(out.exit_status, 3);
    }

    #[tokio::test]
    async fn concatenates_multiple_stdout_chunks() {
        let mut ch = MockChannel::with_events(vec![
            ExecEvent::Stdout(bytes("foo")),
            ExecEvent::Stdout(bytes("bar")),
            ExecEvent::Exit(0),
            ExecEvent::Closed,
        ]);

        let out = run_exec(&mut ch, "cat", "").await.expect("ok");

        assert_eq!(out.stdout, "foobar");
        assert_eq!(out.exit_status, 0);
    }

    #[tokio::test]
    async fn passes_command_string_through() {
        let mut ch = MockChannel::with_events(vec![ExecEvent::Closed]);

        let _ = run_exec(&mut ch, "sudo tee /etc/hosts", "")
            .await
            .expect("ok");

        assert_eq!(ch.commands, vec!["sudo tee /etc/hosts".to_string()]);
    }

    #[tokio::test]
    async fn writes_stdin_then_signals_eof() {
        let mut ch = MockChannel::with_events(vec![ExecEvent::Exit(0), ExecEvent::Closed]);

        let _ = run_exec(&mut ch, "cat", "payload").await.expect("ok");

        assert_eq!(ch.stdin, b"payload");
        assert!(ch.eof_sent, "EOF must be signalled after writing stdin");
    }

    #[tokio::test]
    async fn empty_stdin_writes_nothing_but_still_signals_eof() {
        let mut ch = MockChannel::with_events(vec![ExecEvent::Closed]);

        let _ = run_exec(&mut ch, "id", "").await.expect("ok");

        assert!(
            ch.stdin.is_empty(),
            "no stdin should be written for empty input"
        );
        assert!(ch.eof_sent, "EOF must still be signalled");
    }

    /// When the server reports **neither** an exit status **nor** a signal
    /// (it just closes the channel), the status defaults to `0` and no signal
    /// is recorded. This "clean close, no status" case must stay distinct from
    /// a signal-killed command, which reports a non-zero status (see
    /// [`signal_killed_command_reports_failure_not_exit_zero`]).
    #[tokio::test]
    async fn defaults_exit_status_to_zero_when_neither_status_nor_signal_reported() {
        let mut ch =
            MockChannel::with_events(vec![ExecEvent::Stdout(bytes("done")), ExecEvent::Closed]);

        let out = run_exec(&mut ch, "echo done", "").await.expect("ok");

        assert_eq!(out.exit_status, 0);
        assert_eq!(out.stdout, "done");
        assert_eq!(
            out.terminated_by_signal, None,
            "a clean close with no status is not a signal death"
        );
    }

    /// Regression for CORE-004/TBE-001: a command killed by a signal (SSH sends
    /// `exit-signal`, never `exit-status`) must be reported as a **failure**,
    /// not the default exit `0` that would read as success on the elevated-write
    /// / probe paths.
    #[tokio::test]
    async fn signal_killed_command_reports_failure_not_exit_zero() {
        let mut ch = MockChannel::with_events(vec![
            ExecEvent::Stdout(bytes("partial write")),
            ExecEvent::Signal("KILL".to_string()),
            ExecEvent::Closed,
        ]);

        let out = run_exec(&mut ch, "sudo tee /etc/hosts", "new content")
            .await
            .expect("run_exec should succeed");

        assert_ne!(
            out.exit_status, 0,
            "a signal-killed command must not report success (exit 0)"
        );
        assert_eq!(
            out.exit_status,
            signal_exit_status("KILL"),
            "SIGKILL should map to 128 + 9 = 137"
        );
        assert_eq!(out.terminated_by_signal.as_deref(), Some("KILL"));
        // The captured partial output is still preserved.
        assert_eq!(out.stdout, "partial write");
    }

    /// The exec-capability probe discriminator and sudo classifier both key off
    /// `exit_status == 0`; confirm a signal death flips them to "not
    /// capable"/"failed" via the non-zero status.
    #[tokio::test]
    async fn signal_death_makes_probe_report_not_capable() {
        let mut ch = MockChannel::with_events(vec![
            ExecEvent::Stdout(bytes(&format!("{EXEC_PROBE_MARKER}\n"))),
            ExecEvent::Signal("TERM".to_string()),
            ExecEvent::Closed,
        ]);

        let out = run_exec(&mut ch, "echo marker", "").await.expect("ok");

        assert!(
            !exec_probe_indicates_capability(&out),
            "a signal-killed probe must not read as capable even if the marker was emitted"
        );
    }

    #[test]
    fn signal_exit_status_follows_128_plus_signum_convention() {
        assert_eq!(signal_exit_status("KILL"), 137);
        assert_eq!(signal_exit_status("TERM"), 143);
        assert_eq!(signal_exit_status("SEGV"), 139);
        assert_eq!(signal_exit_status("INT"), 130);
        // Unknown / custom signal names are still a non-zero failure.
        assert_ne!(signal_exit_status("SOMETHING_CUSTOM"), 0);
    }

    #[tokio::test]
    async fn propagates_exec_error() {
        let mut ch = MockChannel {
            fail_exec: true,
            ..Default::default()
        };

        let err = run_exec(&mut ch, "id", "").await.unwrap_err();

        assert!(matches!(err, CoreError::Other(_)));
    }

    // --- Exec-capability probe discriminator (migrated from src-tauri) ---

    fn probe_output(stdout: &str, exit_status: i32) -> SshExecOutput {
        SshExecOutput {
            stdout: stdout.to_string(),
            exit_status,
            ..Default::default()
        }
    }

    /// A shell connection echoes the probe marker with exit 0 → capable.
    #[test]
    fn exec_probe_true_when_marker_echoed_and_exit_zero() {
        let output = probe_output(&format!("{EXEC_PROBE_MARKER}\n"), 0);
        assert!(exec_probe_indicates_capability(&output));
    }

    /// An SFTP-only channel yields no marker (e.g. binary SFTP bytes, even at
    /// exit 0) → not capable.
    #[test]
    fn exec_probe_false_when_marker_absent() {
        let output = probe_output("\u{0}\u{0}sftp-subsystem-bytes", 0);
        assert!(!exec_probe_indicates_capability(&output));
    }

    /// A non-zero exit means the probe did not run cleanly → not capable.
    #[test]
    fn exec_probe_false_on_nonzero_exit() {
        let output = probe_output(&format!("{EXEC_PROBE_MARKER}\n"), 1);
        assert!(!exec_probe_indicates_capability(&output));
    }
}

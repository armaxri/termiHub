//! SSH connection abstraction for dependency-injected testing.
//!
//! Defines [`SshConnector`] — a trait that abstracts the connection +
//! shell-channel creation step so that [`super::Ssh`] can be unit-tested
//! without a real SSH server.
//!
//! # Production path
//!
//! [`RusshSshConnector`] calls `connect_and_authenticate` and uses
//! russh to open a PTY shell channel with optional X11 forwarding.
//!
//! # Test path
//!
//! Inject any `Box<dyn SshConnector>` implementation that returns in-memory
//! pipes. `MockSshConnector` (in `#[cfg(test)]`) provides this.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::config::SshConfig;
use crate::errors::SessionError;

use super::remote_shell::{self, RemoteShell, SetupGate};

// ── Type aliases for complex closure types ─────────────────────────

type WriteFn = Arc<dyn Fn(&[u8]) -> Result<(), SessionError> + Send + Sync>;
type ResizeFn = Arc<dyn Fn(u16, u16) -> Result<(), SessionError> + Send + Sync>;
type SetBlockingFn = Arc<dyn Fn(bool) + Send + Sync>;
type IoFn = Arc<dyn Fn() -> Result<(), SessionError> + Send + Sync>;

// ── SshShellHandle ─────────────────────────────────────────────────

/// Handles for an established SSH shell session.
///
/// Returned by [`SshConnector::open_shell`] and consumed by the
/// `Ssh` backend's `connect()` method.
pub struct SshShellHandle {
    /// Reads SSH channel output; blocks until data is available or the
    /// session's `alive` flag is cleared.
    pub reader: Box<dyn Read + Send>,
    /// Writes input data to the channel.
    pub write: WriteFn,
    /// Resizes the PTY to `(cols, rows)`.
    pub resize: ResizeFn,
    /// No-op with russh (kept for API compatibility with mocks).
    pub set_blocking: SetBlockingFn,
    /// Sends EOF on the channel.
    pub send_eof: IoFn,
    /// Closes the channel.
    pub close: IoFn,
    /// Opaque resources kept alive for the session lifetime (e.g. X11Forwarder).
    pub extensions: Vec<Box<dyn std::any::Any + Send>>,
    /// Set (before the reader sees EOF) when the host **refused the shell**
    /// (#4078): the shell request was answered with a failure, or the channel
    /// closed right after open carrying OpenSSH's `ForceCommand internal-sftp`
    /// refusal. The backend then probes SFTP and, if it works, keeps the session
    /// up as files-only instead of tearing it down. Never set for a shell that
    /// ran and later exited (e.g. the user typed `exit`).
    pub shell_refused: Arc<AtomicBool>,
    /// The remote login shell, when the connector probed it — asked to (shell
    /// integration, #4143) or because it typed env / X11 setup lines (#4147);
    /// [`RemoteShell::Unknown`] otherwise.
    pub remote_shell: RemoteShell,
}

// ── Shell-refusal detection (#4078) ───────────────────────────────

/// OpenSSH's message for a non-SFTP session on a `ForceCommand internal-sftp`
/// host (`session.c`: "This service allows sftp connections only.").
pub(crate) const SFTP_ONLY_REFUSAL_MARKER: &str = "allows sftp connections only";

/// How soon after the shell request the channel must end for its output to
/// count as a refusal rather than a shell that ran and exited. A ForceCommand
/// refusal ends within milliseconds; the window only has to absorb network
/// latency and a slow server.
pub(crate) const SHELL_REFUSAL_WINDOW: Duration = Duration::from_secs(10);

/// Bytes of early channel output kept for refusal detection. The refusal is a
/// single short line; anything longer is a real shell's output.
pub(crate) const EARLY_OUTPUT_CAP: usize = 4096;

/// Decide whether a shell channel that just ended was **refused** by the host
/// rather than run and exited (#4078).
///
/// Refused when the server answered the shell request with a failure, or when
/// the channel ended within [`SHELL_REFUSAL_WINDOW`] of the request and its
/// early output carries the `ForceCommand internal-sftp` refusal message. A
/// normal shell that the user exits (any time, any output without the marker)
/// is never a refusal, so it closes the session exactly as before.
pub(crate) fn is_shell_refusal(
    request_failed: bool,
    early_output: &[u8],
    elapsed: Duration,
) -> bool {
    if request_failed {
        return true;
    }
    if elapsed > SHELL_REFUSAL_WINDOW {
        return false;
    }
    String::from_utf8_lossy(early_output)
        .to_ascii_lowercase()
        .contains(SFTP_ONLY_REFUSAL_MARKER)
}

/// Append `data` to the early-output capture, up to [`EARLY_OUTPUT_CAP`].
fn capture_early_output(early: &mut Vec<u8>, data: &[u8]) {
    let room = EARLY_OUTPUT_CAP.saturating_sub(early.len());
    early.extend_from_slice(&data[..data.len().min(room)]);
}

// ── SshConnector trait ─────────────────────────────────────────────

/// SSH connection + shell-channel factory.
#[async_trait::async_trait]
pub trait SshConnector: Send + Sync + 'static {
    /// Establish the SSH connection and open a PTY shell channel.
    ///
    /// `cancel`, when supplied, aborts an in-flight connect (TCP / handshake /
    /// each jump-host hop) promptly instead of waiting out the connect timeout —
    /// used to cancel a *connecting* shell session (#952).
    async fn open_shell(
        &self,
        config: &SshConfig,
        alive: Arc<AtomicBool>,
        cancel: Option<&CancellationToken>,
    ) -> Result<SshShellHandle, SessionError>;

    /// Like [`open_shell`](Self::open_shell), but when `detect_remote_shell` is
    /// set, also probe the remote login shell (#4143) — before the shell
    /// channel opens — and report it in [`SshShellHandle::remote_shell`]. Shell
    /// integration needs it to pick a setup line the shell can parse.
    ///
    /// The default ignores the flag (the handle reports whatever `open_shell`
    /// set), which keeps test doubles simple.
    async fn open_shell_detecting(
        &self,
        config: &SshConfig,
        alive: Arc<AtomicBool>,
        cancel: Option<&CancellationToken>,
        detect_remote_shell: bool,
    ) -> Result<SshShellHandle, SessionError> {
        let _ = detect_remote_shell;
        self.open_shell(config, alive, cancel).await
    }
}

// ── Command enum for the channel task ─────────────────────────────

enum ChannelCmd {
    Write(Vec<u8>),
    Resize(u32, u32),
    Eof,
}

/// Decide whether the channel task should keep running after an outgoing
/// `channel.data` / `window_change` result.
///
/// On error the interactive session must be **torn down** rather than silently
/// swallowing the user's input (CORE-007): the caller breaks the task loop,
/// which clears the shared `alive` flag after the loop, so the failure surfaces
/// (the terminal stops looking live and input is no longer accepted) instead of
/// keystrokes vanishing into a dead channel. Returns `true` to keep looping,
/// `false` to break and tear down.
fn should_continue_after_send<T, E: std::fmt::Display>(
    result: Result<T, E>,
    operation: &str,
) -> bool {
    match result {
        Ok(_) => true,
        Err(e) => {
            tracing::warn!(
                error = %e,
                operation,
                "SSH shell channel send failed; tearing down session"
            );
            false
        }
    }
}

// ── RusshShellReader ───────────────────────────────────────────────

/// Bridges async russh channel output to a synchronous `Read` impl.
///
/// A background tokio task owns the russh [`Channel`] and sends data
/// chunks through a `std::sync::mpsc`. This reader drains that queue,
/// blocking briefly on each receive to avoid busy-waiting.
struct RusshShellReader {
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
    buf_pos: usize,
    alive: Arc<AtomicBool>,
}

impl RusshShellReader {
    fn new(rx: std::sync::mpsc::Receiver<Vec<u8>>, alive: Arc<AtomicBool>) -> Self {
        Self {
            rx,
            buf: Vec::new(),
            buf_pos: 0,
            alive,
        }
    }
}

impl Read for RusshShellReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // Drain leftover bytes from previous receive first.
        if self.buf_pos < self.buf.len() {
            let n = (self.buf.len() - self.buf_pos).min(buf.len());
            buf[..n].copy_from_slice(&self.buf[self.buf_pos..self.buf_pos + n]);
            self.buf_pos += n;
            if self.buf_pos == self.buf.len() {
                self.buf.clear();
                self.buf_pos = 0;
            }
            return Ok(n);
        }

        loop {
            if !self.alive.load(Ordering::SeqCst) {
                return Ok(0);
            }
            match self.rx.recv_timeout(Duration::from_millis(50)) {
                Ok(data) if !data.is_empty() => {
                    let n = data.len().min(buf.len());
                    buf[..n].copy_from_slice(&data[..n]);
                    if n < data.len() {
                        self.buf = data[n..].to_vec();
                        self.buf_pos = 0;
                    }
                    return Ok(n);
                }
                // Empty vec = EOF sentinel from the channel task.
                Ok(_) => return Ok(0),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
    }
}

// ── RusshSshConnector (production) ────────────────────────────────

/// Production SSH connector using russh.
pub struct RusshSshConnector;

#[async_trait::async_trait]
impl SshConnector for RusshSshConnector {
    async fn open_shell(
        &self,
        config: &SshConfig,
        alive: Arc<AtomicBool>,
        cancel: Option<&CancellationToken>,
    ) -> Result<SshShellHandle, SessionError> {
        self.open_shell_detecting(config, alive, cancel, false)
            .await
    }

    async fn open_shell_detecting(
        &self,
        config: &SshConfig,
        alive: Arc<AtomicBool>,
        cancel: Option<&CancellationToken>,
        detect_remote_shell: bool,
    ) -> Result<SshShellHandle, SessionError> {
        use super::jump_host::connect_target;
        use super::x11::X11Forwarder;
        use russh::ChannelMsg;

        // Opaque resources kept alive for the session lifetime.
        let mut extensions: Vec<Box<dyn std::any::Any + Send>> = Vec::new();

        // Connect directly, or through a ProxyJump chain when one is configured —
        // abortable via `cancel` so a Stop while connecting interrupts promptly.
        let (mut session, registry, gateway_ref) = connect_target(config, cancel).await?;
        if let Some(gateway_ref) = gateway_ref {
            // Hold the pooled gateway reference for the session lifetime. It keeps
            // the shared bastion session (and its direct-tcpip channel carrying
            // this target session) alive; dropping it with `extensions` releases
            // the reference back to the pool, closing the gateway once unused.
            extensions.push(Box::new(gateway_ref));
        }
        // Ask the host which login shell it runs (#4143) on its own exec
        // channel, closed again before the shell channel opens — so a host
        // with `MaxSessions 1` is not refused the shell, and the answer is in
        // hand before anything is typed into the session. Needed whenever a
        // setup line will be typed: shell integration (the caller asks), the
        // env-var fallback and the X11 lines (#4147).
        let types_setup = !config.env.is_empty() || config.enable_x11_forwarding;
        let remote_shell = if detect_remote_shell || types_setup {
            super::remote_shell::detect_remote_shell(&session).await
        } else {
            RemoteShell::Unknown
        };
        let mut x11_display: Option<u32> = None;
        let mut x11_cookie: Option<String> = None;
        if config.enable_x11_forwarding {
            // Ensure a usable local X server via the app-registered provisioner
            // (epic #1047). It resolves the concrete server (managed or adopted)
            // so the forwarder does not re-probe. When none is registered (core
            // standalone / tests) `resolved` is `None` and the forwarder falls
            // back to detecting a user-run server. A provisioning failure is
            // logged with its actionable message and the session continues
            // without display forwarding rather than aborting the whole connect.
            use super::x11::x_server_provisioner;
            let resolved = match x_server_provisioner() {
                // Thread the connect-abort token so a Stop while XQuartz is still
                // coming up (macOS) short-cuts the readiness wait promptly (#1260).
                Some(provisioner) => match provisioner.ensure(cancel.cloned()).await {
                    Ok(lease) => {
                        // Hold the desktop session-lifetime guard (dependent-session
                        // refcount lease, #1107) for the whole session. Pushing it
                        // into `extensions` now — before the forwarder even starts —
                        // means it is released on session end *or* if the connect
                        // fails afterwards, so the refcount matches acquire exactly.
                        if let Some(guard) = lease.guard {
                            extensions.push(guard);
                        }
                        lease.resolved
                    }
                    Err(message) => {
                        tracing::warn!("X server provisioning failed: {message}");
                        None
                    }
                },
                None => None,
            };
            match X11Forwarder::start(config, &mut session, registry, alive.clone(), resolved).await
            {
                Ok((forwarder, display_num, cookie)) => {
                    x11_display = Some(display_num);
                    x11_cookie = cookie;
                    extensions.push(Box::new(forwarder));
                }
                Err(e) => {
                    tracing::warn!("X11 forwarding setup failed, continuing without it: {e}");
                }
            }
        }

        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("Channel open failed: {e}")))?;

        // SSH agent forwarding (#1699): request it on the session channel to the
        // final target so the local agent's keys reach the host — and, since this
        // channel rides the jump-host tunnel, end to end through the chain. The
        // server later opens an `auth-agent@openssh.com` channel that the handler
        // bridges to the local agent. Skipped (with a clear log) when no agent is
        // running, and best-effort (`want_reply=false`) so a server that does not
        // support forwarding never fails the connection.
        if config.forward_agent {
            if super::agent_forward::local_agent_available().await {
                match channel.agent_forward(false).await {
                    Ok(()) => {
                        tracing::debug!(host = %config.host, "requested SSH agent forwarding")
                    }
                    Err(e) => tracing::warn!("SSH agent forwarding request failed: {e}"),
                }
            } else {
                tracing::debug!(
                    host = %config.host,
                    "forwardAgent is set but no local SSH agent is available; skipping"
                );
            }
        }

        // User-specified environment variables via the SSH channel env request.
        // Best-effort: the server only accepts names whitelisted in its
        // `AcceptEnv`, but when it does accept a name the value is present
        // before the login shell's rc files run. Names it rejects are covered
        // by the `export` injection after the shell starts (see below).
        for (key, value) in &config.env {
            // Log the per-name outcome so a dropped env var is diagnosable. The
            // server only honours names in its `AcceptEnv`; a rejection is common
            // and non-fatal (the `export` injection below is the fallback), but it
            // must not be invisible. Never log `value` — env values may be secrets.
            match channel.set_env(false, key, value).await {
                Ok(()) => tracing::debug!(key = %key, "sent SSH env request"),
                Err(e) => tracing::warn!(
                    key = %key,
                    error = %e,
                    "SSH env request rejected by server; relying on export fallback"
                ),
            }
        }

        channel
            .request_pty(
                false,
                "xterm-256color",
                config.cols as u32,
                config.rows as u32,
                0,
                0,
                &[],
            )
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("PTY request failed: {e}")))?;

        // Ask for a reply so a host that refuses the shell answers with a
        // failure the channel task can see (#4078). Nothing waits on the reply
        // here, so a server that never answers cannot stall the connect.
        channel
            .request_shell(true)
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("Shell request failed: {e}")))?;
        let shell_requested_at = std::time::Instant::now();
        let shell_refused = Arc::new(AtomicBool::new(false));

        // Type the setup lines into the shell, in its own syntax and line
        // ending (#4147): the env-var fallback — covering names the server's
        // `AcceptEnv` rejected above — then the X11 `DISPLAY` / `xauth` lines.
        // Never log these lines: they embed env values and the
        // MIT-MAGIC-COOKIE-1 secret. A PowerShell login shell on Linux/macOS
        // gets them only once its first prompt is up (#4148): the gate holds
        // them, and every later write, until then.
        let mut gate = SetupGate::new(
            remote_shell::defers_setup_until_prompt(remote_shell),
            shell_requested_at,
        );
        let mut setup: Vec<(&str, String)> = Vec::new();
        if let Some(line) = remote_shell::env_setup_line(remote_shell, &config.env) {
            setup.push(("env", line));
        }
        if let Some(display_num) = x11_display {
            for line in remote_shell::x11_setup_lines(remote_shell, display_num, x11_cookie.as_deref())
            {
                setup.push(("x11", line));
            }
        }
        for (what, line) in setup {
            if let Some(data) = gate.write(line.into_bytes()) {
                if let Err(e) = channel.data(&data[..]).await {
                    tracing::warn!(
                        setup = what,
                        error = %e,
                        "failed to inject an SSH session setup line; configured environment \
                         variables or X11 display forwarding may not apply"
                    );
                }
            }
        }
        if gate.is_holding() {
            tracing::debug!("holding the session setup until the remote PowerShell prompt is up");
        }

        // ── Async→sync bridge ──────────────────────────────────────────

        // data_tx: channel task → blocking reader thread
        let (data_tx, data_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(64);
        // cmd_tx:  write/resize/close closures → channel task
        let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::unbounded_channel::<ChannelCmd>();

        let alive_task = alive.clone();
        let refused_task = shell_refused.clone();
        tokio::spawn(async move {
            // Early output + the shell-request reply, for refusal detection.
            let mut early_output: Vec<u8> = Vec::new();
            let mut request_failed = false;
            // Only the shell request on this channel wants a reply, so the first
            // Success / Failure answers it.
            let mut awaiting_shell_reply = true;
            loop {
                // Release the held setup once the prompt is up (#4148).
                if let Some(burst) = gate.poll(std::time::Instant::now()) {
                    tracing::debug!(writes = burst.len(), "releasing the held session setup");
                    let mut ok = true;
                    for data in burst {
                        ok = should_continue_after_send(channel.data(&data[..]).await, "write");
                        if !ok {
                            break;
                        }
                    }
                    if !ok {
                        break;
                    }
                }
                // Far in the future when the gate is open (the branch is off then).
                let gate_check = gate
                    .next_check()
                    .unwrap_or_else(|| std::time::Instant::now() + std::time::Duration::from_secs(3600));
                tokio::select! {
                    biased;
                    // Outgoing commands (write / resize / close).
                    cmd = cmd_rx.recv() => {
                        match cmd {
                            Some(ChannelCmd::Write(data)) => {
                                // Held (in order) until the prompt, or sent now.
                                let Some(data) = gate.write(data) else { continue };
                                if !should_continue_after_send(
                                    channel.data(&data[..]).await,
                                    "write",
                                ) {
                                    break;
                                }
                            }
                            Some(ChannelCmd::Resize(cols, rows)) => {
                                if !should_continue_after_send(
                                    channel.window_change(cols, rows, 0, 0).await,
                                    "resize",
                                ) {
                                    break;
                                }
                            }
                            Some(ChannelCmd::Eof) | None => {
                                let _ = channel.eof().await;
                                break;
                            }
                        }
                    }
                    // Incoming data from the server.
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { ref data }) => {
                                gate.on_output(std::time::Instant::now());
                                capture_early_output(&mut early_output, data);
                                if data_tx.send(data.to_vec()).is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                                // Without a PTY the refusal arrives on stderr.
                                capture_early_output(&mut early_output, data);
                            }
                            Some(ChannelMsg::Success) => awaiting_shell_reply = false,
                            Some(ChannelMsg::Failure) if awaiting_shell_reply => {
                                // The host refused the shell request outright.
                                request_failed = true;
                                break;
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                            _ => {}
                        }
                    }
                    // The held setup's settle / cap deadline (#4148).
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(gate_check)),
                        if gate.is_holding() => {}
                }
            }
            // Flag a refusal *before* signalling EOF or clearing `alive`, so the
            // reader thread (which exits on either signal) always sees the verdict.
            if is_shell_refusal(request_failed, &early_output, shell_requested_at.elapsed()) {
                tracing::info!("SSH host refused the interactive shell");
                refused_task.store(true, Ordering::SeqCst);
            }
            // Signal EOF to the reader (an empty chunk is the sentinel). Never
            // block here: if the queue is full the reader still exits once it
            // drains and sees `alive` cleared below.
            let _ = data_tx.try_send(Vec::new());
            alive_task.store(false, Ordering::SeqCst);
        });

        // Clone cmd_tx for each closure (UnboundedSender::send is non-blocking,
        // safe to call from any thread including non-tokio threads).
        let cmd_write = cmd_tx.clone();
        let cmd_resize = cmd_tx.clone();
        let cmd_eof = cmd_tx.clone();
        let cmd_close = cmd_tx;
        let alive_write = alive.clone();

        Ok(SshShellHandle {
            reader: Box::new(RusshShellReader::new(data_rx, alive.clone())),
            write: Arc::new(move |data: &[u8]| {
                if !alive_write.load(Ordering::SeqCst) {
                    return Err(SessionError::Io(std::io::Error::other("session dead")));
                }
                cmd_write
                    .send(ChannelCmd::Write(data.to_vec()))
                    .map_err(|e| SessionError::Io(std::io::Error::other(e.to_string())))
            }),
            resize: Arc::new(move |cols: u16, rows: u16| {
                cmd_resize
                    .send(ChannelCmd::Resize(cols as u32, rows as u32))
                    .map_err(|e| SessionError::Io(std::io::Error::other(e.to_string())))
            }),
            set_blocking: Arc::new(|_| {}),
            send_eof: Arc::new(move || {
                cmd_eof
                    .send(ChannelCmd::Eof)
                    .map_err(|e| SessionError::Io(std::io::Error::other(e.to_string())))
            }),
            close: Arc::new(move || {
                let _ = cmd_close.send(ChannelCmd::Eof);
                Ok(())
            }),
            extensions,
            shell_refused,
            remote_shell,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Shell-refusal detection (#4078) ──────────────────────────────

    const OPENSSH_REFUSAL: &[u8] = b"This service allows sftp connections only.\r\n";

    #[test]
    fn failed_shell_request_is_a_refusal() {
        assert!(is_shell_refusal(true, b"", Duration::from_secs(60)));
    }

    #[test]
    fn immediate_forcecommand_exit_is_a_refusal() {
        assert!(is_shell_refusal(
            false,
            OPENSSH_REFUSAL,
            Duration::from_millis(40)
        ));
        // Case and surrounding bytes (a banner, CR/LF) do not matter.
        assert!(is_shell_refusal(
            false,
            b"welcome\r\nTHIS SERVICE ALLOWS SFTP CONNECTIONS ONLY.",
            Duration::from_secs(2)
        ));
    }

    #[test]
    fn a_user_exit_is_not_a_refusal() {
        // A shell that ran and was exited: prompt output, no marker.
        assert!(!is_shell_refusal(
            false,
            b"user@host:~$ exit\r\nlogout\r\n",
            Duration::from_millis(500)
        ));
        assert!(!is_shell_refusal(false, b"", Duration::from_millis(10)));
    }

    #[test]
    fn the_marker_long_after_open_is_not_a_refusal() {
        // e.g. the user `cat`s a file mentioning the message, then exits.
        assert!(!is_shell_refusal(
            false,
            OPENSSH_REFUSAL,
            SHELL_REFUSAL_WINDOW + Duration::from_secs(1)
        ));
    }

    #[test]
    fn early_output_capture_is_capped() {
        let mut early = Vec::new();
        capture_early_output(&mut early, &[b'a'; EARLY_OUTPUT_CAP - 2]);
        capture_early_output(&mut early, b"bcdef");
        assert_eq!(early.len(), EARLY_OUTPUT_CAP);
        assert!(early.ends_with(b"bc"));
        capture_early_output(&mut early, b"more");
        assert_eq!(early.len(), EARLY_OUTPUT_CAP);
    }

    /// A successful `channel.data` / `window_change` result keeps the channel
    /// task looping.
    #[test]
    fn should_continue_after_send_ok_keeps_looping() {
        assert!(should_continue_after_send::<(), &str>(Ok(()), "write"));
        assert!(should_continue_after_send::<(), &str>(Ok(()), "resize"));
    }

    /// Regression for CORE-007: a failing send must NOT be silently discarded.
    /// The helper returns `false`, telling the task loop to break — which clears
    /// the shared `alive` flag and tears the session down, so a failed write no
    /// longer leaves the terminal looking live while swallowing input.
    #[test]
    fn should_continue_after_send_err_breaks_task() {
        assert!(!should_continue_after_send::<(), &str>(
            Err("transport error"),
            "write"
        ));
        assert!(!should_continue_after_send::<(), &str>(
            Err("transport error"),
            "resize"
        ));
    }

    /// The break-on-error contract clears `alive`, exactly as the task loop does
    /// after it breaks: model the loop's teardown and assert the flag flips.
    #[test]
    fn break_on_send_error_clears_alive() {
        let alive = Arc::new(AtomicBool::new(true));
        // Simulate the task: a send fails, the helper says stop, we break, and
        // the post-loop teardown clears `alive`.
        let keep_going = should_continue_after_send::<(), &str>(Err("boom"), "write");
        assert!(!keep_going, "a failed send must stop the task");
        if !keep_going {
            alive.store(false, Ordering::SeqCst);
        }
        assert!(
            !alive.load(Ordering::SeqCst),
            "the session must be torn down (alive cleared) after a failed send"
        );
    }
}

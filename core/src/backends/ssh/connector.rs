//! SSH connection abstraction for dependency-injected testing.
//!
//! Defines [`SshConnector`] — a trait that abstracts the connection +
//! shell-channel creation step so that [`super::Ssh`] can be unit-tested
//! without a real SSH server.
//!
//! # Production path
//!
//! [`RusshSshConnector`] calls [`connect_and_authenticate`] and uses
//! russh to open a PTY shell channel with optional X11 forwarding.
//!
//! # Test path
//!
//! Inject any `Box<dyn SshConnector>` implementation that returns in-memory
//! pipes. [`MockSshConnector`] (in `#[cfg(test)]`) provides this.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::config::SshConfig;
use crate::errors::SessionError;

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
}

// ── SshConnector trait ─────────────────────────────────────────────

/// SSH connection + shell-channel factory.
#[async_trait::async_trait]
pub trait SshConnector: Send + Sync + 'static {
    async fn open_shell(
        &self,
        config: &SshConfig,
        alive: Arc<AtomicBool>,
    ) -> Result<SshShellHandle, SessionError>;
}

// ── Command enum for the channel task ─────────────────────────────

enum ChannelCmd {
    Write(Vec<u8>),
    Resize(u32, u32),
    Eof,
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
    ) -> Result<SshShellHandle, SessionError> {
        use super::auth::connect_and_authenticate;
        use super::x11::X11Forwarder;
        use russh::ChannelMsg;

        let (mut session, registry) = connect_and_authenticate(config).await?;

        // Optional X11 forwarding (must be set up before opening the shell channel).
        let mut extensions: Vec<Box<dyn std::any::Any + Send>> = Vec::new();
        let mut x11_display: Option<u32> = None;
        let mut x11_cookie: Option<String> = None;
        if config.enable_x11_forwarding {
            match X11Forwarder::start(config, &mut session, registry, alive.clone()).await {
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

        // User-specified environment variables (best-effort; many servers reject setenv).
        for (key, value) in &config.env {
            let _ = channel.set_env(false, key, value).await;
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

        channel
            .request_shell(false)
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("Shell request failed: {e}")))?;

        // Inject DISPLAY and xauth if X11 forwarding is active.
        if let Some(display_num) = x11_display {
            let export_cmd = format!("export DISPLAY=localhost:{display_num}.0\n");
            let _ = channel.data(export_cmd.as_bytes()).await;
            if let Some(ref cookie) = x11_cookie {
                let xauth_cmd = format!(
                    "xauth add localhost:{display_num} MIT-MAGIC-COOKIE-1 {cookie} 2>/dev/null\n"
                );
                let _ = channel.data(xauth_cmd.as_bytes()).await;
            }
        }

        // ── Async→sync bridge ──────────────────────────────────────────

        // data_tx: channel task → blocking reader thread
        let (data_tx, data_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(64);
        // cmd_tx:  write/resize/close closures → channel task
        let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::unbounded_channel::<ChannelCmd>();

        let alive_task = alive.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    // Outgoing commands (write / resize / close).
                    cmd = cmd_rx.recv() => {
                        match cmd {
                            Some(ChannelCmd::Write(data)) => {
                                let _ = channel.data(&data[..]).await;
                            }
                            Some(ChannelCmd::Resize(cols, rows)) => {
                                let _ = channel.window_change(cols, rows, 0, 0).await;
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
                                if data_tx.send(data.to_vec()).is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::Eof) | None => {
                                // Signal EOF to the reader.
                                let _ = data_tx.send(Vec::new());
                                break;
                            }
                            _ => {}
                        }
                    }
                }
            }
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
        })
    }
}

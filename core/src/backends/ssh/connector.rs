//! SSH connection abstraction for dependency-injected testing.
//!
//! Defines [`SshConnector`] — a trait that abstracts the connection +
//! shell-channel creation step so that [`super::Ssh`] can be unit-tested
//! without a real SSH server.
//!
//! # Production path
//!
//! [`Ssh2SshConnector`] calls [`connect_and_authenticate`] and uses
//! libssh2 to open a PTY shell channel, including optional X11 forwarding.
//!
//! # Test path
//!
//! Inject any `Box<dyn SshConnector>` implementation that returns in-memory
//! pipes. [`MockSshConnector`] (in `#[cfg(test)]`) provides this.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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
    /// Reads from the SSH channel. In production, returns `WouldBlock`
    /// when no data is available; the [`Ssh2SshShellReader`] wrapper
    /// handles the retry loop.
    pub reader: Box<dyn Read + Send>,
    /// Writes input data to the channel (handles blocking-mode toggle internally).
    pub write: WriteFn,
    /// Resizes the PTY to `(cols, rows)`.
    pub resize: ResizeFn,
    /// Switches the underlying session's blocking mode.
    pub set_blocking: SetBlockingFn,
    /// Sends EOF on the channel.
    pub send_eof: IoFn,
    /// Closes the channel.
    pub close: IoFn,
    /// Opaque extensions kept alive for the session lifetime (e.g. X11Forwarder).
    pub extensions: Vec<Box<dyn std::any::Any + Send>>,
}

// ── SshConnector trait ─────────────────────────────────────────────

/// SSH connection + shell-channel factory.
///
/// The production implementation ([`Ssh2SshConnector`]) opens a real
/// TCP+SSH connection, authenticates, sets up an optional X11 tunnel,
/// requests a PTY, and starts a shell. Tests inject a mock that returns
/// in-memory pipes.
pub trait SshConnector: Send + Sync + 'static {
    /// Connect to the SSH server described by `config` and open a
    /// shell channel, returning I/O handles.
    ///
    /// `alive` is the session's liveness flag; the connector may store
    /// a clone for use in background threads (e.g. X11 tunnel).
    fn open_shell(
        &self,
        config: &SshConfig,
        alive: Arc<AtomicBool>,
    ) -> Result<SshShellHandle, SessionError>;
}

// ── Ssh2SshShellReader ─────────────────────────────────────────────

/// Wraps an `ssh2::Channel` to implement `Read` with non-blocking
/// retry logic suitable for the background reader thread.
///
/// `ssh2` in non-blocking mode returns `WouldBlock` when no data is
/// available. This reader sleeps briefly and retries until data arrives,
/// the channel reaches EOF, or the session's `alive` flag is cleared.
pub struct Ssh2SshShellReader {
    channel: Arc<Mutex<ssh2::Channel>>,
    alive: Arc<AtomicBool>,
}

impl Ssh2SshShellReader {
    pub fn new(channel: Arc<Mutex<ssh2::Channel>>, alive: Arc<AtomicBool>) -> Self {
        Self { channel, alive }
    }
}

impl Read for Ssh2SshShellReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if !self.alive.load(Ordering::SeqCst) {
                return Ok(0);
            }
            let result = {
                let mut ch = self
                    .channel
                    .lock()
                    .map_err(|e| std::io::Error::other(format!("channel lock: {e}")))?;
                ch.read(buf)
            };
            match result {
                ok @ Ok(_) => return ok,
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
    }
}

// ── Ssh2SshConnector (production) ─────────────────────────────────

/// Production SSH connector using libssh2.
///
/// Calls [`connect_and_authenticate`] then opens a PTY shell channel
/// (with optional X11 forwarding). Supports all auth methods handled
/// by [`super::auth::connect_and_authenticate`].
pub struct Ssh2SshConnector;

impl SshConnector for Ssh2SshConnector {
    fn open_shell(
        &self,
        config: &SshConfig,
        alive: Arc<AtomicBool>,
    ) -> Result<SshShellHandle, SessionError> {
        use super::auth::connect_and_authenticate;
        use super::x11::X11Forwarder;

        let session = Arc::new(connect_and_authenticate(config)?);

        // Optional X11 forwarding must be set up before the shell channel.
        let mut extensions: Vec<Box<dyn std::any::Any + Send>> = Vec::new();
        let mut x11_display: Option<u32> = None;
        let mut x11_cookie: Option<String> = None;
        if config.enable_x11_forwarding {
            match X11Forwarder::start(config, alive.clone()) {
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
            .channel_session()
            .map_err(|e| SessionError::SpawnFailed(format!("Channel open failed: {e}")))?;

        // Try to set DISPLAY via setenv before PTY/shell.
        let mut display_set_via_env = false;
        if let Some(display_num) = x11_display {
            let display_val = format!("localhost:{display_num}.0");
            if channel.setenv("DISPLAY", &display_val).is_ok() {
                display_set_via_env = true;
            }
        }

        // User-specified environment variables.
        for (key, value) in &config.env {
            let _ = channel.setenv(key, value);
        }

        channel
            .request_pty(
                "xterm-256color",
                None,
                Some((config.cols as u32, config.rows as u32, 0, 0)),
            )
            .map_err(|e| SessionError::SpawnFailed(format!("PTY request failed: {e}")))?;

        channel
            .shell()
            .map_err(|e| SessionError::SpawnFailed(format!("Shell request failed: {e}")))?;

        // Inject DISPLAY/xauth if setenv failed (most servers reject it).
        if let Some(display_num) = x11_display {
            if !display_set_via_env {
                let _ = std::io::Write::write_all(
                    &mut channel,
                    format!("export DISPLAY=localhost:{display_num}.0\n").as_bytes(),
                );
            }
            if let Some(ref cookie) = x11_cookie {
                let _ = std::io::Write::write_all(
                    &mut channel,
                    format!(
                        "xauth add localhost:{display_num} MIT-MAGIC-COOKIE-1 {cookie} 2>/dev/null\n"
                    )
                    .as_bytes(),
                );
            }
        }

        // Switch to non-blocking for the reader thread.
        session.set_blocking(false);

        let channel = Arc::new(Mutex::new(channel));
        let session_for_write = session.clone();
        let session_for_resize = session.clone();
        let session_for_blocking = session.clone();
        let channel_for_write = channel.clone();
        let channel_for_resize = channel.clone();
        let channel_for_eof = channel.clone();
        let channel_for_close = channel.clone();
        let session_for_close = session.clone();
        // Clone alive for the write closure so a write failure (e.g. TCP write
        // timeout on a dead connection) signals the reader thread to exit, which
        // then drops the output sender and triggers terminal-exit.
        let alive_for_write = alive.clone();

        Ok(SshShellHandle {
            reader: Box::new(Ssh2SshShellReader::new(channel.clone(), alive)),
            write: Arc::new(move |data: &[u8]| {
                let mut ch = channel_for_write
                    .lock()
                    .map_err(|e| SessionError::Io(std::io::Error::other(format!("lock: {e}"))))?;
                session_for_write.set_blocking(true);
                let result = std::io::Write::write_all(&mut *ch, data);
                session_for_write.set_blocking(false);
                drop(ch);
                if result.is_err() {
                    alive_for_write.store(false, Ordering::SeqCst);
                }
                result.map_err(SessionError::Io)
            }),
            resize: Arc::new(move |cols: u16, rows: u16| {
                let mut ch = channel_for_resize
                    .lock()
                    .map_err(|e| SessionError::Io(std::io::Error::other(format!("lock: {e}"))))?;
                session_for_resize.set_blocking(true);
                let result = ch.request_pty_size(cols as u32, rows as u32, None, None);
                session_for_resize.set_blocking(false);
                drop(ch);
                result.map_err(|e| {
                    SessionError::Io(std::io::Error::other(format!("PTY resize failed: {e}")))
                })
            }),
            set_blocking: Arc::new(move |blocking: bool| {
                session_for_blocking.set_blocking(blocking);
            }),
            send_eof: Arc::new(move || {
                let mut ch = channel_for_eof
                    .lock()
                    .map_err(|e| SessionError::Io(std::io::Error::other(format!("lock: {e}"))))?;
                ch.send_eof()
                    .map_err(|e| SessionError::Io(std::io::Error::other(e.to_string())))
            }),
            close: Arc::new(move || {
                let mut ch = channel_for_close
                    .lock()
                    .map_err(|e| SessionError::Io(std::io::Error::other(format!("lock: {e}"))))?;
                session_for_close.set_blocking(true);
                let _ = ch.send_eof();
                let result = ch.close();
                session_for_close.set_blocking(false);
                drop(ch);
                result.map_err(|e| SessionError::Io(std::io::Error::other(e.to_string())))
            }),
            extensions,
        })
    }
}

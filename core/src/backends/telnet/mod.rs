//! Telnet backend implementing [`ConnectionType`](crate::connection::ConnectionType).
//!
//! Uses a raw TCP socket with telnet protocol handling: IAC command filtering,
//! window-size (NAWS, RFC 1073) and terminal-type (RFC 1091) negotiation — see
//! [`negotiation`] — plus an optional prompt-driven auto-login — see
//! [`auto_login`]. This is the canonical telnet implementation, used by both
//! the desktop and agent crates (the desktop crate previously had its own
//! implementation in `src-tauri/src/terminal/telnet.rs`).

mod auto_login;
mod negotiation;
mod reader;
mod schema;

use std::io::Write;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tracing::{debug, info};

use crate::config::{expand_config_value, TelnetConfig};
use crate::connection::{
    Capabilities, ConnectionType, OutputReceiver, OutputSender, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;

use crate::output::OUTPUT_CHANNEL_CAPACITY;
use tokio_util::sync::CancellationToken;

pub use auto_login::{
    AutoLoginConfig, DEFAULT_AUTO_LOGIN_TIMEOUT_SECS, DEFAULT_LOGIN_PROMPT, DEFAULT_PASSWORD_PROMPT,
};
pub use negotiation::DEFAULT_TERMINAL_TYPE;
use negotiation::{Negotiator, DO, DONT, IAC, SB, SE, WILL, WONT};

/// Read timeout for the reader thread (allows periodic alive checks and the
/// auto-login prompt timeout).
const READ_TIMEOUT: Duration = Duration::from_millis(100);

/// Upper bound on a buffered subnegotiation payload. Real payloads (TTYPE
/// SEND, NAWS, …) are a few bytes; a runaway `IAC SB` without `IAC SE` must
/// not grow memory without bound — excess bytes are discarded.
const MAX_SUBNEG_LEN: usize = 512;

/// `authMethod` value that enables auto-login.
const AUTH_METHOD_AUTO_LOGIN: &str = "password";

/// Default telnet port used when the `port` setting is absent or invalid.
const DEFAULT_PORT: u16 = 23;

/// Parse the `port` setting into a `u16`, defaulting to [`DEFAULT_PORT`].
///
/// Accepts either a JSON number or a numeric string. An out-of-range value is
/// **rejected** rather than silently rewritten: the numeric branch uses a
/// checked [`u16::try_from`] instead of a wrapping `as` cast, so a numeric
/// `70000` falls back to the default exactly as the string `"70000"` already
/// did — the two branches now agree (#2916, the `as`-cast half of ERR-010).
/// Previously `n as u16` truncated (`65536` → `0`, `70000` → `4464`), silently
/// targeting the wrong port. Mirrors the SSH backend's CORE-006 fix.
fn parse_port_setting(port: Option<&serde_json::Value>) -> u16 {
    port.and_then(|v| {
        v.as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .or_else(|| v.as_str().and_then(|s| s.parse::<u16>().ok()))
    })
    .unwrap_or(DEFAULT_PORT)
}

/// Telnet backend using a raw TCP socket, implementing [`ConnectionType`].
///
/// # Lifecycle
///
/// 1. Create with [`Telnet::new()`] (disconnected state).
/// 2. Call [`connect()`](ConnectionType::connect) with settings JSON.
/// 3. Use [`write()`](ConnectionType::write),
///    [`subscribe_output()`](ConnectionType::subscribe_output) for I/O.
/// 4. Call [`disconnect()`](ConnectionType::disconnect) to clean up.
pub struct Telnet {
    /// State is `None` when disconnected, `Some` when connected.
    state: Option<ConnectedState>,
    /// The output sender is stored so `subscribe_output()` can replace
    /// the channel. The reader thread also holds a reference and picks up
    /// the replacement on its next iteration.
    output_tx: Arc<Mutex<Option<OutputSender>>>,
}

/// Internal state of an active telnet connection.
struct ConnectedState {
    writer: Arc<Mutex<TcpStream>>,
    /// Option negotiation state, shared with the reader thread. Lock order is
    /// always `negotiator` → `writer` so size reports are written in order.
    negotiator: Arc<Mutex<Negotiator>>,
    alive: Arc<AtomicBool>,
    /// Set to `true` by a graceful [`disconnect()`](ConnectionType::disconnect)
    /// before the state is dropped, so the [`Drop`] guard below becomes a no-op.
    /// The graceful path and the guard must never both tear the socket down.
    disconnected: bool,
}

impl Drop for ConnectedState {
    /// Best-effort synchronous teardown for CORE-020: guarantees the reader
    /// thread is stopped and the TCP socket is shut down even when the connected
    /// state is dropped WITHOUT a graceful
    /// [`disconnect()`](ConnectionType::disconnect) — a panic between spawn and
    /// store, an early `?` return, or a manager that forgets.
    ///
    /// Without this, `alive` stays `true` and the reader thread — which reads its
    /// own `try_clone()`'d socket, independent of the state's writer — would
    /// never notice the session ended and would leak forever. Clearing `alive`
    /// makes the reader loop exit on its next timeout, and `shutdown(Both)`
    /// unblocks it immediately. Both operations are synchronous and non-blocking,
    /// so they are safe to run directly in `Drop` (no runtime is awaited, nothing
    /// blocks — mandatory because `Drop` may run on a tokio worker thread). The
    /// shutdown error is swallowed, so this can never panic.
    ///
    /// When [`disconnect()`](ConnectionType::disconnect) already ran it set
    /// `disconnected = true` and this is a no-op, so the graceful path and this
    /// guard never both shut the socket down.
    fn drop(&mut self) {
        if self.disconnected {
            return;
        }
        self.alive.store(false, Ordering::SeqCst);
        if let Ok(writer) = self.writer.lock() {
            let _ = writer.shutdown(std::net::Shutdown::Both);
        }
    }
}

impl Telnet {
    /// Create a new disconnected `Telnet` instance.
    pub fn new() -> Self {
        Self {
            state: None,
            output_tx: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for Telnet {
    fn default() -> Self {
        Self::new()
    }
}

/// Parser state for [`TelnetFilter`], persisted across TCP reads so an IAC
/// sequence split across a read boundary is resumed rather than mishandled.
enum FilterState {
    /// Ordinary data flow.
    Data,
    /// Saw an `IAC` byte; awaiting the command byte.
    Iac,
    /// Saw `IAC <cmd>` where `cmd` is DO/DONT/WILL/WONT; awaiting the option byte.
    Negotiate(u8),
    /// Inside a subnegotiation (after `IAC SB`); buffering payload until `IAC SE`.
    Subneg,
    /// Inside a subnegotiation and saw an `IAC`; the next byte is either `SE`
    /// (ends the subnegotiation) or an escaped/ignored byte that keeps it open.
    SubnegIac,
}

/// Stateful filter for telnet IAC command sequences.
///
/// A single [`TelnetFilter`] is created per connection and fed successive TCP
/// reads via [`filter()`](TelnetFilter::filter). Each call returns the
/// user-visible data with all IAC sequences stripped. Option commands and
/// complete subnegotiations are handed to the [`Negotiator`], whose replies
/// are appended to the caller's `responses` buffer (written back by the
/// caller, so the filter itself never touches a socket).
///
/// Because TCP delivers arbitrary chunk sizes, an IAC command or
/// subnegotiation can straddle a read boundary. The parser is a byte-at-a-time
/// state machine whose [`FilterState`] persists between calls, so a sequence
/// split across reads is resumed on the next chunk instead of leaking raw
/// bytes (a stray `0xFF`, dropped negotiation, or leaked subnegotiation
/// payload) into the terminal (#2331).
struct TelnetFilter {
    state: FilterState,
    /// Payload of the subnegotiation in progress (IAC-unescaped).
    subneg: Vec<u8>,
}

impl TelnetFilter {
    /// Create a new filter in the default (data) state.
    fn new() -> Self {
        Self {
            state: FilterState::Data,
            subneg: Vec::new(),
        }
    }

    /// Filter one chunk of raw telnet bytes, resuming from the state left by
    /// the previous call. Negotiation replies are appended to `responses`.
    fn filter(
        &mut self,
        data: &[u8],
        negotiator: &mut Negotiator,
        responses: &mut Vec<u8>,
    ) -> Vec<u8> {
        let mut output = Vec::with_capacity(data.len());

        for &byte in data {
            match self.state {
                FilterState::Data => {
                    if byte == IAC {
                        self.state = FilterState::Iac;
                    } else {
                        output.push(byte);
                    }
                }
                FilterState::Iac => match byte {
                    IAC => {
                        // Escaped 0xFF byte.
                        output.push(IAC);
                        self.state = FilterState::Data;
                    }
                    DO | DONT | WILL | WONT => {
                        // Await the option byte before responding.
                        self.state = FilterState::Negotiate(byte);
                    }
                    SB => {
                        self.subneg.clear();
                        self.state = FilterState::Subneg;
                    }
                    _ => {
                        // Two-byte command with no option (NOP, GA, unknown) — skip.
                        self.state = FilterState::Data;
                    }
                },
                FilterState::Negotiate(cmd) => {
                    negotiator.on_command(cmd, byte, responses);
                    self.state = FilterState::Data;
                }
                FilterState::Subneg => {
                    // Buffer the payload; only IAC can end/escape it.
                    if byte == IAC {
                        self.state = FilterState::SubnegIac;
                    } else {
                        self.push_subneg(byte);
                    }
                }
                FilterState::SubnegIac => {
                    // `IAC SE` ends the subnegotiation; `IAC IAC` is an escaped
                    // 0xFF payload byte and anything else is malformed — either
                    // way keep consuming the subnegotiation until a real `IAC SE`.
                    match byte {
                        SE => {
                            negotiator.on_subnegotiation(&self.subneg, responses);
                            self.subneg.clear();
                            self.state = FilterState::Data;
                        }
                        IAC => {
                            self.push_subneg(IAC);
                            self.state = FilterState::Subneg;
                        }
                        _ => self.state = FilterState::Subneg,
                    }
                }
            }
        }

        output
    }

    fn push_subneg(&mut self, byte: u8) {
        if self.subneg.len() < MAX_SUBNEG_LEN {
            self.subneg.push(byte);
        }
    }
}

/// Session options parsed from the settings beyond the transport
/// ([`TelnetConfig`]): the terminal type and the optional auto-login.
#[derive(Debug)]
struct SessionOptions {
    terminal_type: String,
    auto_login: Option<AutoLoginConfig>,
}

/// Read an optional string setting.
fn str_setting<'a>(settings: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    settings.get(key).and_then(|v| v.as_str())
}

/// Read an optional non-negative integer setting given as a JSON number or a
/// numeric string (the schema-driven form emits numbers as strings).
fn u64_setting(settings: &serde_json::Value, key: &str) -> Option<u64> {
    settings.get(key).and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
    })
}

/// Parse the terminal-type and auto-login settings. Auto-login is enabled
/// only when `authMethod` is `"password"`; the password itself is resolved by
/// the caller (credential store / prompt) and arrives in `password`.
fn parse_session_options(settings: &serde_json::Value) -> SessionOptions {
    let terminal_type = str_setting(settings, "terminalType")
        .unwrap_or(DEFAULT_TERMINAL_TYPE)
        .to_string();
    let auto_login =
        (str_setting(settings, "authMethod") == Some(AUTH_METHOD_AUTO_LOGIN)).then(|| {
            let timeout_secs = u64_setting(settings, "autoLoginTimeoutSecs")
                .filter(|s| *s > 0)
                .unwrap_or(DEFAULT_AUTO_LOGIN_TIMEOUT_SECS);
            AutoLoginConfig::new(
                expand_config_value(str_setting(settings, "username").unwrap_or("").trim()),
                // The password is a secret and is deliberately not expanded.
                str_setting(settings, "password").map(str::to_string),
                str_setting(settings, "loginPrompt").unwrap_or(DEFAULT_LOGIN_PROMPT),
                str_setting(settings, "passwordPrompt").unwrap_or(DEFAULT_PASSWORD_PROMPT),
                Duration::from_secs(timeout_secs),
            )
        });
    SessionOptions {
        terminal_type,
        auto_login,
    }
}

/// Resolve + TCP-connect, abortable via an optional cancellation token.
///
/// With no token this is the plain blocking [`crate::net::connect_timeout_resolved`]
/// call the backend has always made — run inline on the caller's task, so the
/// non-cancelled path is unchanged. With a token the blocking connect runs on a
/// blocking thread and is raced against cancellation (`biased`, so an
/// already-cancelled token wins immediately), returning the shared
/// [`connect_cancelled`](super::connect_cancelled) error promptly instead of
/// blocking until the connect timeout (PARITY-007). A cancelled connect leaves
/// the orphaned blocking task to finish and drop its socket on its own.
async fn connect_tcp_cancellable(
    host: String,
    port: u16,
    timeout: Duration,
    cancel: Option<CancellationToken>,
) -> Result<TcpStream, SessionError> {
    let do_connect = move || {
        crate::net::connect_timeout_resolved(&host, port, timeout)
            .map_err(|e| SessionError::SpawnFailed(format!("TCP connect failed: {e}")))
    };
    match cancel {
        None => do_connect(),
        Some(token) => {
            // Already cancelled — don't even start the blocking connect.
            if token.is_cancelled() {
                return Err(super::connect_cancelled());
            }
            let join = tokio::task::spawn_blocking(do_connect);
            tokio::select! {
                biased;
                _ = token.cancelled() => Err(super::connect_cancelled()),
                res = join => res.map_err(|e| {
                    SessionError::SpawnFailed(format!("TCP connect task failed: {e}"))
                })?,
            }
        }
    }
}

/// Write `data` to the shared socket under its lock and flush.
fn write_locked(writer: &Mutex<TcpStream>, data: &[u8]) -> Result<(), SessionError> {
    let mut writer = writer.lock().map_err(|e| {
        SessionError::Io(std::io::Error::other(format!("Failed to lock writer: {e}")))
    })?;
    writer.write_all(data).map_err(SessionError::Io)?;
    writer.flush().map_err(SessionError::Io)?;
    Ok(())
}

/// Send the negotiator's opening offer (`IAC WILL NAWS`).
fn send_initial_offer(
    negotiator: &Mutex<Negotiator>,
    writer: &Mutex<TcpStream>,
) -> Result<(), SessionError> {
    let mut negotiator = negotiator
        .lock()
        .map_err(|e| SessionError::SpawnFailed(format!("Failed to lock negotiator: {e}")))?;
    let offer = negotiator.initial_offer();
    if !offer.is_empty() {
        write_locked(writer, &offer)?;
    }
    Ok(())
}

#[async_trait::async_trait]
impl ConnectionType for Telnet {
    fn type_id(&self) -> &str {
        "telnet"
    }

    fn display_name(&self) -> &str {
        "Telnet"
    }

    fn settings_schema(&self) -> SettingsSchema {
        schema::settings_schema()
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            // Window size is propagated via NAWS (RFC 1073) when the server
            // agrees; a server that refuses simply keeps its own size.
            resize: true,
            persistent: false,
            terminal: true,
            // Telnet has no port-forwarding mechanism.
            tunneling: false,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        self.connect_cancellable(settings, None).await
    }

    /// Connect, aborting the (blocking) DNS-resolve + TCP-connect promptly when
    /// `cancel` fires instead of waiting out the connect timeout (PARITY-007).
    /// Nothing is stored on `self` until the connect fully succeeds. When
    /// `cancel` is `None` the connect runs inline exactly as before.
    async fn connect_cancellable(
        &mut self,
        settings: serde_json::Value,
        cancel: Option<CancellationToken>,
    ) -> Result<(), SessionError> {
        if self.state.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }

        // Parse settings JSON into TelnetConfig.
        let host = settings
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let port: u16 = parse_port_setting(settings.get("port"));
        // Accept the connect timeout as a JSON number or a numeric string (the
        // schema-driven form emits numbers as strings); absent/invalid falls
        // back to the default budget via `TelnetConfig::connect_timeout`.
        let connect_timeout_secs = u64_setting(&settings, "connectTimeoutSecs");

        let config = TelnetConfig {
            host,
            port,
            connect_timeout_secs,
        };

        // Expand ${VAR} placeholders.
        let config = config.expand();

        if config.host.is_empty() {
            return Err(SessionError::InvalidConfig(
                "Host must not be empty".to_string(),
            ));
        }

        let options = parse_session_options(&settings);

        info!(host = %config.host, port = config.port, "Connecting telnet session");

        // Resolve the host via DNS before connecting. `connect_timeout` requires
        // an already-resolved `SocketAddr`, so a hostname (`router.local`,
        // `bbs.example.com`) must be resolved first — a bare IP-literal parse
        // would reject every hostname (CORE-015).
        let stream = connect_tcp_cancellable(
            config.host.clone(),
            config.port,
            config.connect_timeout(),
            cancel,
        )
        .await?;

        // Enable TCP keepalive so a half-open connection (peer vanishes with no
        // FIN/RST — cable pull, NAT timeout, crashed host) is eventually torn
        // down by the OS instead of hanging in "Connected" forever. The dead
        // socket surfaces as a read error, the reader thread breaks, and the
        // session emits `terminal-exit` (#1123).
        crate::net::enable_tcp_keepalive(&stream);

        stream
            .set_read_timeout(Some(READ_TIMEOUT))
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to set read timeout: {e}")))?;

        // Clone for the reader thread.
        let reader_stream = stream
            .try_clone()
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to clone TCP stream: {e}")))?;

        let alive = Arc::new(AtomicBool::new(true));
        let writer = Arc::new(Mutex::new(stream));
        let negotiator = Arc::new(Mutex::new(Negotiator::new(&options.terminal_type)));

        // Proactively offer NAWS so servers that never ask still learn the
        // window size; a refusing server answers DONT and nothing else changes.
        send_initial_offer(&negotiator, &writer)?;

        // Set up output channel.
        let (tx, _rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        {
            let mut guard = self
                .output_tx
                .lock()
                .map_err(|e| SessionError::SpawnFailed(format!("Failed to lock output_tx: {e}")))?;
            *guard = Some(tx);
        }

        if options.auto_login.is_some() {
            // Never log the credentials themselves — only that auto-login is on.
            info!("Telnet auto-login enabled; waiting for the login prompt");
        }

        // Spawn reader thread: bridges sync TCP reads to async tokio channel,
        // answers option negotiation and drives the optional auto-login.
        reader::spawn(reader::ReaderContext {
            stream: reader_stream,
            writer: writer.clone(),
            negotiator: negotiator.clone(),
            alive: alive.clone(),
            output_tx: self.output_tx.clone(),
            auto_login: options.auto_login,
        });

        self.state = Some(ConnectedState {
            writer,
            negotiator,
            alive,
            disconnected: false,
        });

        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        if let Some(mut state) = self.state.take() {
            // Mark the graceful path so the `Drop` guard on `state` (which runs
            // when it goes out of scope at the end of this block) does not shut
            // the socket down a second time (CORE-020 double-teardown guard).
            state.disconnected = true;
            state.alive.store(false, Ordering::SeqCst);
            // Shut down the socket to unblock the reader thread.
            if let Ok(writer) = state.writer.lock() {
                let _ = writer.shutdown(std::net::Shutdown::Both);
            }
            // Clear the sender to signal the reader thread to stop.
            if let Ok(mut guard) = self.output_tx.lock() {
                *guard = None;
            }
            debug!("Telnet session disconnected");
        }
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.state
            .as_ref()
            .is_some_and(|s| s.alive.load(Ordering::SeqCst))
    }

    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| SessionError::NotRunning("Not connected".to_string()))?;
        write_locked(&state.writer, data)
    }

    /// Report the new window size to the server via `SB NAWS` (RFC 1073).
    ///
    /// The size is always remembered — a server that enables NAWS later gets
    /// it then — but only sent while NAWS is active. Disconnected or refused
    /// sessions return `Ok(())`: resize is best-effort, never an error.
    fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        let Some(state) = self.state.as_ref() else {
            return Ok(());
        };
        let mut negotiator = state.negotiator.lock().map_err(|e| {
            SessionError::Io(std::io::Error::other(format!(
                "Failed to lock negotiator: {e}"
            )))
        })?;
        if let Some(bytes) = negotiator.resize(cols, rows) {
            // Written while still holding the negotiator lock so concurrent
            // size reports reach the wire in order.
            write_locked(&state.writer, &bytes)?;
        }
        Ok(())
    }

    fn subscribe_output(&self) -> OutputReceiver {
        let (tx, rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        if let Ok(mut guard) = self.output_tx.lock() {
            *guard = Some(tx);
        }
        rx
    }

    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

#[cfg(test)]
mod tests;

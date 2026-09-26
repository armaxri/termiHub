//! Telnet backend implementing [`ConnectionType`](crate::connection::ConnectionType).
//!
//! Uses a raw TCP socket with basic telnet protocol handling (IAC command
//! filtering). This is the canonical telnet implementation, used by both the
//! desktop and agent crates (the desktop crate previously had its own
//! implementation in `src-tauri/src/terminal/telnet.rs`).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tracing::{debug, info};

use crate::config::TelnetConfig;
use crate::connection::{
    Capabilities, ConnectionType, FieldType, OutputReceiver, OutputSender, SettingsField,
    SettingsGroup, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;

use crate::output::OUTPUT_CHANNEL_CAPACITY;
use tokio_util::sync::CancellationToken;

/// Read timeout for the reader thread (allows periodic alive checks).
const READ_TIMEOUT: Duration = Duration::from_millis(100);

// Telnet protocol constants.
const IAC: u8 = 255;
const SE: u8 = 240;
const SB: u8 = 250;
const WILL: u8 = 251;
const WONT: u8 = 252;
const DO: u8 = 253;
const DONT: u8 = 254;

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
    /// Inside a subnegotiation (after `IAC SB`); consuming payload until `IAC SE`.
    Subneg,
    /// Inside a subnegotiation and saw an `IAC`; the next byte is either `SE`
    /// (ends the subnegotiation) or an escaped/ignored byte that keeps it open.
    SubnegIac,
}

/// Stateful filter for telnet IAC command sequences, responding with WONT/DONT
/// to all negotiation attempts.
///
/// A single [`TelnetFilter`] is created per connection and fed successive TCP
/// reads via [`filter()`](TelnetFilter::filter). Each call returns the
/// user-visible data with all IAC sequences stripped; negotiation responses
/// (WONT for DO, DONT for WILL) are written directly to the provided stream.
///
/// Because TCP delivers arbitrary chunk sizes, an IAC command or
/// subnegotiation can straddle a read boundary. The parser is a byte-at-a-time
/// state machine whose [`FilterState`] persists between calls, so a sequence
/// split across reads is resumed on the next chunk instead of leaking raw
/// bytes (a stray `0xFF`, dropped negotiation, or leaked subnegotiation
/// payload) into the terminal (#2331).
struct TelnetFilter {
    state: FilterState,
}

impl TelnetFilter {
    /// Create a new filter in the default (data) state.
    fn new() -> Self {
        Self {
            state: FilterState::Data,
        }
    }

    /// Filter one chunk of raw telnet bytes, resuming from the state left by
    /// the previous call.
    fn filter(&mut self, data: &[u8], stream: &mut TcpStream) -> Vec<u8> {
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
                        self.state = FilterState::Subneg;
                    }
                    _ => {
                        // Two-byte command with no option (NOP, GA, unknown) — skip.
                        self.state = FilterState::Data;
                    }
                },
                FilterState::Negotiate(cmd) => {
                    match cmd {
                        // Refuse all DO requests.
                        DO => {
                            let _ = stream.write_all(&[IAC, WONT, byte]);
                        }
                        // Refuse all WILL offers.
                        WILL => {
                            let _ = stream.write_all(&[IAC, DONT, byte]);
                        }
                        // DONT / WONT — acknowledged, nothing to send.
                        _ => {}
                    }
                    self.state = FilterState::Data;
                }
                FilterState::Subneg => {
                    // Discard subnegotiation payload; only IAC can end/escape it.
                    if byte == IAC {
                        self.state = FilterState::SubnegIac;
                    }
                }
                FilterState::SubnegIac => {
                    // `IAC SE` ends the subnegotiation; `IAC IAC` is escaped
                    // payload and anything else is malformed — either way keep
                    // consuming the subnegotiation until a real `IAC SE`.
                    self.state = if byte == SE {
                        FilterState::Data
                    } else {
                        FilterState::Subneg
                    };
                }
            }
        }

        output
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

#[async_trait::async_trait]
impl ConnectionType for Telnet {
    fn type_id(&self) -> &str {
        "telnet"
    }

    fn display_name(&self) -> &str {
        "Telnet"
    }

    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema {
            groups: vec![SettingsGroup {
                collapsed: false,
                key: "telnet".to_string(),
                label: "Telnet".to_string(),
                fields: vec![
                    SettingsField {
                        key: "host".to_string(),
                        label: "Host".to_string(),
                        description: Some(
                            "Hostname or IP address of the telnet server".to_string(),
                        ),
                        help_text: None,
                        field_type: FieldType::Text,
                        required: true,
                        default: None,
                        placeholder: Some("192.168.1.1".to_string()),
                        supports_env_expansion: true,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    },
                    SettingsField {
                        key: "port".to_string(),
                        label: "Port".to_string(),
                        description: Some("TCP port number".to_string()),
                        help_text: None,
                        field_type: FieldType::Port,
                        required: true,
                        default: Some(serde_json::json!(23)),
                        placeholder: None,
                        supports_env_expansion: false,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    },
                    SettingsField {
                        key: "connectTimeoutSecs".to_string(),
                        label: "Connect Timeout (s)".to_string(),
                        description: Some(
                            "Seconds to wait for the TCP connection before giving up".to_string(),
                        ),
                        help_text: Some(
                            "Bounds how long a connection to an unreachable host blocks before \
                             failing. Leave empty to use the default (10 s)."
                                .to_string(),
                        ),
                        field_type: FieldType::Number {
                            min: Some(1.0),
                            max: Some(300.0),
                        },
                        required: false,
                        default: None,
                        placeholder: Some("10".to_string()),
                        supports_env_expansion: false,
                        supports_tilde_expansion: false,
                        visible_when: None,
                    },
                ],
            }],
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: false,
            graphical: false,
            resize: false,
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
        let connect_timeout_secs: Option<u64> = settings.get("connectTimeoutSecs").and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        });

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
        let mut reader = stream
            .try_clone()
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to clone TCP stream: {e}")))?;

        let alive = Arc::new(AtomicBool::new(true));

        // Set up output channel.
        let (tx, _rx) = tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        {
            let mut guard = self
                .output_tx
                .lock()
                .map_err(|e| SessionError::SpawnFailed(format!("Failed to lock output_tx: {e}")))?;
            *guard = Some(tx);
        }

        // Spawn reader thread: bridges sync TCP reads to async tokio channel.
        let alive_clone = alive.clone();
        let output_tx_clone = self.output_tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut filter = TelnetFilter::new();
            while alive_clone.load(Ordering::SeqCst) {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let filtered = filter.filter(&buf[..n], &mut reader);
                        if filtered.is_empty() {
                            continue;
                        }
                        // Clone the sender out of the guard and DROP the lock
                        // BEFORE the blocking send. `blocking_send` parks this
                        // thread under backpressure (full channel), so holding
                        // `output_tx` across it would stall any path that needs
                        // the same lock (teardown clearing the sender, or a
                        // disconnect) behind a reader that is itself blocked —
                        // a lockup where the session can neither drain nor be
                        // torn down (CONC-010). Senders are cheap to clone.
                        let sender = match output_tx_clone.lock() {
                            Ok(guard) => match guard.as_ref() {
                                Some(sender) => sender.clone(),
                                // No sender — disconnected.
                                None => break,
                            },
                            Err(_) => break,
                        };
                        // Lock released above; the blocking send below can no
                        // longer stall other holders of `output_tx`.
                        let _ = sender.blocking_send(filtered);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                    Err(_) => break,
                }
            }
            alive_clone.store(false, Ordering::SeqCst);
        });

        self.state = Some(ConnectedState {
            writer: Arc::new(Mutex::new(stream)),
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
        let mut writer = state.writer.lock().map_err(|e| {
            SessionError::Io(std::io::Error::other(format!("Failed to lock writer: {e}")))
        })?;
        writer.write_all(data).map_err(SessionError::Io)?;
        writer.flush().map_err(SessionError::Io)?;
        Ok(())
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        // Basic telnet doesn't support terminal resize.
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

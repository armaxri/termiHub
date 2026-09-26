//! Session daemon process — hosts a [`ConnectionType`] instance.
//!
//! Invoked as `termihub-agent --daemon <session-id>` by the agent.
//! Communicates with the agent over a local IPC channel — a Unix domain
//! socket on unix, a Windows named pipe on windows (see
//! [`crate::daemon::transport`]) — using the length-prefixed binary frame
//! protocol defined in `protocol.rs`.
//!
//! The daemon keeps the connection alive independently of the agent
//! process. When the agent disconnects and reconnects, the daemon
//! replays the ring buffer to bring the agent up to date.

use std::time::Duration;

use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::daemon::protocol::{self, *};
use crate::daemon::transport::{self, BoxedReader, BoxedWriter, DaemonListener};
use termihub_core::buffer::{RingBuffer, DEFAULT_BUFFER_CAPACITY};
use termihub_core::connection::{ConnectionType, OutputReceiver};

/// Default ring buffer size (1 MiB); derived from the shared core default so the
/// daemon and core agree on a single value (DUP-006).
const DEFAULT_BUFFER_SIZE: usize = DEFAULT_BUFFER_CAPACITY;

/// Configuration for the session daemon, read from environment variables.
#[derive(Debug)]
struct DaemonConfig {
    session_id: String,
    /// Transport endpoint: a socket path on unix, a pipe name on windows.
    endpoint: String,
    type_id: String,
    settings: serde_json::Value,
    buffer_size: usize,
}

impl DaemonConfig {
    /// Build the daemon configuration from the environment plus the connection
    /// `settings` handed to the daemon out-of-band.
    ///
    /// The `settings` JSON is passed on the daemon's **stdin** (see
    /// [`read_settings_from_stdin`]), never through an environment variable: a
    /// connection config carries resolved plaintext secrets (SSH/VNC/RDP/FTP
    /// passwords and key passphrases), and an env var is world-readable for the
    /// same user via `/proc/<pid>/environ` for the process's whole lifetime,
    /// which the `0o600` on `state.json` cannot cover (AGT-021). Stdin is a
    /// private pipe between the spawning worker and this daemon.
    ///
    /// Required env vars:
    /// - `TERMIHUB_TYPE_ID` — connection type identifier (e.g., `"local"`, `"ssh"`)
    ///
    /// Optional env vars:
    /// - `TERMIHUB_SOCKET_PATH` — transport endpoint (socket path on unix,
    ///   pipe name on windows; default: auto-generated)
    /// - `TERMIHUB_BUFFER_SIZE` — ring buffer size in bytes (default: 1 MiB)
    fn from_env(session_id: &str, settings: serde_json::Value) -> anyhow::Result<Self> {
        let endpoint = std::env::var("TERMIHUB_SOCKET_PATH")
            .unwrap_or_else(|_| transport::session_endpoint(session_id));

        let type_id = std::env::var("TERMIHUB_TYPE_ID")
            .map_err(|_| anyhow::anyhow!("TERMIHUB_TYPE_ID env var is required"))?;

        let buffer_size = std::env::var("TERMIHUB_BUFFER_SIZE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_BUFFER_SIZE);

        Ok(Self {
            session_id: session_id.to_string(),
            endpoint,
            type_id,
            settings,
            buffer_size,
        })
    }
}

/// Read the connection `settings` JSON from the daemon's stdin, to EOF.
///
/// The spawning worker writes the settings JSON to this daemon's stdin pipe and
/// then closes it; we read the whole stream and parse it. This keeps plaintext
/// secrets out of the environment (AGT-021) — stdin is a private channel, unlike
/// `/proc/<pid>/environ`. An empty stream (no settings supplied) parses to an
/// empty object, preserving the previous env-absent default; a non-empty but
/// malformed stream is a hard error so a broken handoff fails the connect
/// cleanly rather than silently connecting with empty settings.
fn read_settings_from_stdin() -> anyhow::Result<serde_json::Value> {
    use std::io::Read;
    let mut raw = String::new();
    std::io::stdin()
        .read_to_string(&mut raw)
        .map_err(|e| anyhow::anyhow!("failed to read daemon settings from stdin: {e}"))?;
    parse_settings_payload(&raw)
}

/// Parse the settings payload read from stdin.
///
/// Split out from [`read_settings_from_stdin`] so the parsing rules (empty →
/// `{}`, malformed → error) are unit-testable without a real stdin pipe.
fn parse_settings_payload(raw: &str) -> anyhow::Result<serde_json::Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::Value::Object(serde_json::Map::new()));
    }
    serde_json::from_str(trimmed)
        .map_err(|e| anyhow::anyhow!("failed to parse daemon settings JSON from stdin: {e}"))
}

/// Entry point for the session daemon process.
///
/// Creates a [`ConnectionType`] instance from the registry, connects it
/// using the settings from environment variables, and runs the event loop
/// that bridges the connection to the agent via the Unix socket.
pub async fn run_daemon(session_id: &str) -> anyhow::Result<()> {
    // Read the connection settings from stdin BEFORE anything else: the
    // spawning worker writes the settings JSON to our stdin and closes it, and
    // we must drain that pipe to EOF. Doing it up front keeps the secret-bearing
    // config off the environment (AGT-021).
    let settings = read_settings_from_stdin()?;
    let config = DaemonConfig::from_env(session_id, settings)?;

    info!(
        "Session daemon starting: id={}, type={}, buffer={}",
        config.session_id, config.type_id, config.buffer_size
    );

    // Create and connect the ConnectionType *before* binding the socket.
    // The socket appearing on disk signals to callers that the daemon is
    // ready to accept connections, so we must finish slow operations
    // (e.g. Docker image pull / container creation) first.
    let registry = crate::registry::build_registry();
    let mut connection = registry.create(&config.type_id).map_err(|e| {
        anyhow::anyhow!("Failed to create connection type '{}': {e}", config.type_id)
    })?;

    connection
        .connect(config.settings.clone())
        .await
        .map_err(|e| anyhow::anyhow!("Failed to connect: {e}"))?;

    info!("Connection established: type={}", config.type_id);

    // Bind the transport listener — this creates the endpoint (socket file on
    // unix, named pipe on windows), restricted to the current user, signalling
    // to callers that the daemon is ready to accept connections.
    let mut listener = DaemonListener::bind(&config.endpoint).await?;

    info!("Listening on endpoint: {}", config.endpoint);

    // Subscribe to output
    let output_rx = connection.subscribe_output();

    // Run the main event loop
    let result = daemon_loop(
        &config.session_id,
        connection,
        output_rx,
        &mut listener,
        config.buffer_size,
    )
    .await;

    // Cleanup the endpoint
    listener.cleanup();

    info!("Session daemon exiting: {}", config.session_id);
    result
}

/// Commands sent from the agent reader task to the main loop.
enum AgentCommand {
    /// Raw input bytes for the connection.
    Input(Vec<u8>),
    /// Resize the terminal.
    Resize(u16, u16),
    /// Agent requested detach.
    Detach,
    /// Agent requested kill.
    Kill,
    /// Agent requested current buffer contents without reconnecting.
    QueryBuffer,
    /// Agent disconnected (EOF or error).
    ///
    /// Carries the connection generation that produced this disconnect so the
    /// main loop can ignore stale disconnects from previous connections that
    /// arrive after a new connection has already been accepted.
    Disconnected(u64),
}

/// Main daemon event loop.
///
/// Multiplexes between connection output, new agent connections, and
/// agent commands using `tokio::select!`.
async fn daemon_loop(
    session_id: &str,
    mut connection: Box<dyn ConnectionType>,
    mut output_rx: OutputReceiver,
    listener: &mut DaemonListener,
    buffer_size: usize,
) -> anyhow::Result<()> {
    let mut ring_buffer = RingBuffer::new(buffer_size);
    let mut agent_writer: Option<BoxedWriter> = None;
    let mut reader_task: Option<tokio::task::JoinHandle<()>> = None;
    // Monotonically increasing counter bumped on every new agent connection.
    // Passed into each reader task so that a stale Disconnected from an old
    // connection can be distinguished from one that belongs to the current
    // connection and safely ignored.
    let mut connection_gen: u64 = 0;

    // Channel for receiving commands from the agent reader task.
    let (agent_cmd_tx, mut agent_cmd_rx) = mpsc::channel::<AgentCommand>(64);

    loop {
        tokio::select! {
            // Output from the ConnectionType
            output = output_rx.recv() => {
                match output {
                    Some(data) => {
                        ring_buffer.write(&data);

                        // Forward to agent if connected
                        if let Some(ref mut writer) = agent_writer {
                            if protocol::write_frame_async(writer, MSG_OUTPUT, &data)
                                .await
                                .is_err()
                            {
                                debug!("Agent connection lost on write");
                                agent_writer = None;
                                abort_reader(&mut reader_task);
                            }
                        }
                    }
                    None => {
                        // Connection output channel closed — connection ended
                        info!("Connection output channel closed");
                        send_exited_async(&mut agent_writer, 0).await;
                        return Ok(());
                    }
                }
            }

            // New agent connection
            conn = listener.accept() => {
                match conn {
                    Ok((mut read_half, mut write_half)) => {
                        info!(session_id, "Agent connected");

                        // AGT-015: `state.json` is shared per-user across every
                        // `--stdio` worker (one per attached desktop, ADR-11). A
                        // worker recovering sessions on startup must never evict a
                        // session another *live* worker is actively attached to —
                        // otherwise opening a second desktop steals the first
                        // desktop's live terminals. When a writer is already
                        // attached, consult the newcomer's declared intent: a
                        // recovery connect is refused (its live owner keeps the
                        // session); a takeover connect evicts as before.
                        let decision = if agent_writer.is_some() {
                            let intent = read_attach_intent(&mut read_half).await;
                            decide_attach(true, intent)
                        } else {
                            AttachDecision::FreshAttach
                        };
                        match decision {
                            AttachDecision::RefuseOwnedByLivePeer => {
                                // OBS-012: log the ownership decision so a
                                // "my session vanished" report is explicable —
                                // here the incumbent live writer keeps it.
                                info!(
                                    session_id,
                                    "Refusing recovery connect: a live writer is still \
                                     attached, leaving the session with its owner (AGT-015)"
                                );
                                let _ = protocol::write_frame_async(
                                    &mut write_half,
                                    MSG_ERROR,
                                    ERR_OWNED_BY_LIVE_PEER,
                                )
                                .await;
                                // Keep the existing writer and do NOT bump the
                                // generation; the refused connection is dropped
                                // here at end of scope.
                                continue;
                            }
                            AttachDecision::EvictAndTakeover => {
                                // OBS-012: a takeover is about to displace the
                                // current live writer (another desktop taking the
                                // session over). Record it at WARN so the loser's
                                // "session disappeared" is traceable to a
                                // deliberate takeover, not a crash.
                                warn!(
                                    session_id,
                                    "Takeover connect is evicting the current live writer \
                                     for this session (OBS-012)"
                                );
                                // SM-003 (single-attach): tell the incumbent it was
                                // evicted *before* its connection is dropped below,
                                // so its desktop folds an explicit "taken over"
                                // state rather than an ambiguous drop.
                                notify_evicted(&mut agent_writer).await;
                            }
                            AttachDecision::FreshAttach => {}
                        }

                        // Bump the generation so any in-flight Disconnected from
                        // the previous connection is treated as stale.
                        connection_gen += 1;
                        let gen = connection_gen;

                        // Drop the old connection
                        agent_writer = None;
                        abort_reader(&mut reader_task);
                        while agent_cmd_rx.try_recv().is_ok() {}

                        // Send buffer replay
                        let buffered = ring_buffer.read_all();
                        if !buffered.is_empty()
                            && protocol::write_frame_async(
                                &mut write_half,
                                MSG_BUFFER_REPLAY,
                                &buffered,
                            )
                            .await
                            .is_err()
                        {
                            warn!("Failed to send buffer replay");
                            continue;
                        }

                        // Send ready signal
                        if protocol::write_frame_async(&mut write_half, MSG_READY, &[])
                            .await
                            .is_err()
                        {
                            warn!("Failed to send ready");
                            continue;
                        }

                        agent_writer = Some(write_half);

                        // Spawn reader task for agent commands
                        let tx = agent_cmd_tx.clone();
                        reader_task = Some(tokio::spawn(async move {
                            agent_reader_loop(read_half, tx, gen).await;
                        }));
                    }
                    Err(e) => {
                        warn!("Listener accept error: {e}");
                    }
                }
            }

            // Commands from the agent reader task
            cmd = agent_cmd_rx.recv() => {
                match cmd {
                    Some(AgentCommand::Input(data)) => {
                        if let Err(e) = connection.write(&data) {
                            warn!("Connection write error: {e}");
                        }
                    }
                    Some(AgentCommand::Resize(cols, rows)) => {
                        if let Err(e) = connection.resize(cols, rows) {
                            warn!("Connection resize error: {e}");
                        }
                    }
                    Some(AgentCommand::Detach) => {
                        info!("Agent requested detach");
                        agent_writer = None;
                        abort_reader(&mut reader_task);
                    }
                    Some(AgentCommand::Kill) => {
                        info!("Agent requested kill");
                        if let Err(e) = connection.disconnect().await {
                            warn!("Disconnect error: {e}");
                        }
                        send_exited_async(&mut agent_writer, 0).await;
                        return Ok(());
                    }
                    Some(AgentCommand::QueryBuffer) => {
                        if let Some(ref mut writer) = agent_writer {
                            let buffered = ring_buffer.read_all();
                            if protocol::write_frame_async(writer, MSG_BUFFER_REPLAY, &buffered)
                                .await
                                .is_err()
                            {
                                debug!("Failed to send buffer reply to agent");
                                agent_writer = None;
                                abort_reader(&mut reader_task);
                            }
                        }
                    }
                    Some(AgentCommand::Disconnected(gen)) => {
                        if gen == connection_gen {
                            info!("Agent disconnected");
                            agent_writer = None;
                            abort_reader(&mut reader_task);
                        } else {
                            debug!(
                                "Stale Disconnected (gen={gen}, current={connection_gen}), ignoring"
                            );
                        }
                    }
                    None => {
                        // All senders dropped — shouldn't happen since we hold one
                        debug!("Agent command channel closed");
                    }
                }
            }
        }
    }
}

/// Upper bound on the best-effort [`MSG_EVICTED`] write to an incumbent writer
/// (SM-003). The frame is tiny and normally lands in the socket buffer at once;
/// the bound only guards against a wedged incumbent stalling the takeover.
const EVICTED_NOTIFY_TIMEOUT: Duration = Duration::from_secs(1);

/// Best-effort: send [`MSG_EVICTED`] to the current writer, if any, just before a
/// takeover drops it (SM-003, single-attach). Failures are ignored — the incumbent
/// then observes the plain EOF, which is the historical behaviour.
async fn notify_evicted(agent_writer: &mut Option<BoxedWriter>) {
    if let Some(writer) = agent_writer.as_mut() {
        let _ = tokio::time::timeout(
            EVICTED_NOTIFY_TIMEOUT,
            protocol::write_frame_async(writer, MSG_EVICTED, &[]),
        )
        .await;
    }
}

/// Background task that reads frames from the agent and sends commands
/// to the main loop via a channel.
///
/// `gen` is the connection generation assigned when this connection was
/// accepted; it is included in `Disconnected` so the main loop can ignore
/// stale disconnects from previous connections.
async fn agent_reader_loop(mut reader: BoxedReader, tx: mpsc::Sender<AgentCommand>, gen: u64) {
    loop {
        // Steady-state reads use the mid-frame timeout (#3015): an agent that
        // begins a frame and then wedges must be dropped (Disconnected) rather
        // than pinning this reader task and leaving the daemon holding a stale
        // writer. The first-byte wait stays unbounded, so an idle agent that
        // simply is not typing is never disconnected.
        match protocol::read_session_frame_timeout(&mut reader).await {
            Ok(Some(frame)) => {
                let cmd = match frame.msg_type {
                    MSG_INPUT => AgentCommand::Input(frame.payload),
                    MSG_RESIZE => {
                        if let Some((cols, rows)) = protocol::decode_resize(&frame.payload) {
                            debug!("Resize to {cols}x{rows}");
                            AgentCommand::Resize(cols, rows)
                        } else {
                            continue;
                        }
                    }
                    MSG_DETACH => AgentCommand::Detach,
                    MSG_KILL => AgentCommand::Kill,
                    MSG_QUERY_BUFFER => AgentCommand::QueryBuffer,
                    // AGT-015: an attach-intent hint is only meaningful at accept
                    // time. On the fast path (no writer was attached) it is read
                    // here as the first frame instead — ignore it.
                    MSG_ATTACH_INTENT => continue,
                    other => {
                        debug!("Unknown frame type from agent: 0x{other:02x}");
                        continue;
                    }
                };
                if tx.send(cmd).await.is_err() {
                    return; // main loop dropped the receiver
                }
            }
            Ok(None) => {
                // EOF
                let _ = tx.send(AgentCommand::Disconnected(gen)).await;
                return;
            }
            Err(e) => {
                debug!("Agent frame read error: {e}");
                let _ = tx.send(AgentCommand::Disconnected(gen)).await;
                return;
            }
        }
    }
}

/// What to do with a newly-accepted agent connection, given whether a live
/// writer is already attached and the newcomer's declared attach intent.
///
/// Extracted so the AGT-015 / OBS-012 ownership decision — refuse a recovery
/// connect vs. evict-and-take-over vs. plain fresh attach — is unit-testable and
/// has a single, logged decision point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttachDecision {
    /// No live writer was attached; the newcomer simply attaches.
    FreshAttach,
    /// A live writer is attached and the newcomer is a recovery connect: refuse
    /// it and leave the session with its current owner (AGT-015).
    RefuseOwnedByLivePeer,
    /// A live writer is attached and the newcomer is a takeover: evict the
    /// incumbent and hand the session over (OBS-012 logs this).
    EvictAndTakeover,
}

/// Decide how to handle a new connection from `writer_attached` (is a live
/// writer already attached) and its declared `intent`.
fn decide_attach(writer_attached: bool, intent: u8) -> AttachDecision {
    if !writer_attached {
        AttachDecision::FreshAttach
    } else if intent == INTENT_RECOVERY {
        AttachDecision::RefuseOwnedByLivePeer
    } else {
        // Takeover, or an absent/malformed intent which defaults to takeover,
        // preserving the historical evict-on-accept behaviour.
        AttachDecision::EvictAndTakeover
    }
}

/// Read a newly-connected worker's [`MSG_ATTACH_INTENT`] to learn whether it is
/// a recovery connect (refuse if a live writer is attached) or a takeover.
///
/// The current worker always sends this frame first, so the read returns
/// immediately. Defaults to [`INTENT_TAKEOVER`] — preserving the historical
/// evict-on-accept behavior — if the frame is absent, malformed, or does not
/// arrive within a short window (a pre-AGT-015 worker never sends it). The short
/// timeout also bounds how long the daemon's event loop can stall here.
async fn read_attach_intent(reader: &mut BoxedReader) -> u8 {
    const INTENT_TIMEOUT: Duration = Duration::from_secs(2);
    match tokio::time::timeout(INTENT_TIMEOUT, protocol::read_frame_async(reader)).await {
        Ok(Ok(Some(frame))) if frame.msg_type == MSG_ATTACH_INTENT => {
            frame.payload.first().copied().unwrap_or(INTENT_TAKEOVER)
        }
        _ => INTENT_TAKEOVER,
    }
}

/// Abort a running reader task if there is one.
fn abort_reader(task: &mut Option<tokio::task::JoinHandle<()>>) {
    if let Some(t) = task.take() {
        t.abort();
    }
}

/// Send an Exited frame to the agent if connected.
async fn send_exited_async(writer: &mut Option<BoxedWriter>, code: i32) {
    if let Some(ref mut w) = writer {
        let payload = protocol::encode_exit_code(code);
        let _ = protocol::write_frame_async(w, MSG_EXITED, &payload).await;
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Env var tests mutate the process environment and must run serially.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    // ── attach-ownership decision (AGT-015 / OBS-012) ─────────────────

    #[test]
    fn decide_attach_fresh_when_no_writer_attached() {
        // With no live writer, intent is irrelevant — always a fresh attach.
        assert_eq!(
            decide_attach(false, INTENT_RECOVERY),
            AttachDecision::FreshAttach
        );
        assert_eq!(
            decide_attach(false, INTENT_TAKEOVER),
            AttachDecision::FreshAttach
        );
    }

    #[test]
    fn decide_attach_refuses_recovery_when_writer_attached() {
        // A recovery connect must not steal a live peer's session (AGT-015).
        assert_eq!(
            decide_attach(true, INTENT_RECOVERY),
            AttachDecision::RefuseOwnedByLivePeer
        );
    }

    #[test]
    fn decide_attach_evicts_on_takeover_when_writer_attached() {
        // A takeover (or an absent/unknown intent defaulting to takeover) evicts
        // the incumbent — the OBS-012 eviction that must be logged.
        assert_eq!(
            decide_attach(true, INTENT_TAKEOVER),
            AttachDecision::EvictAndTakeover
        );
        let unknown_intent = 0xEE;
        assert_eq!(
            decide_attach(true, unknown_intent),
            AttachDecision::EvictAndTakeover
        );
    }

    #[test]
    fn parse_settings_payload_empty_is_empty_object() {
        // An absent/empty settings stream must default to an empty object, so a
        // daemon spawned without settings behaves exactly as the old env-absent
        // path did rather than erroring.
        assert_eq!(parse_settings_payload("").unwrap(), serde_json::json!({}));
        assert_eq!(
            parse_settings_payload("   \n\t ").unwrap(),
            serde_json::json!({})
        );
    }

    #[test]
    fn parse_settings_payload_parses_json() {
        let v = parse_settings_payload(r#"{"host":"192.168.1.1","port":22}"#).unwrap();
        assert_eq!(v["host"], "192.168.1.1");
        assert_eq!(v["port"], 22);
    }

    #[test]
    fn parse_settings_payload_rejects_malformed_json() {
        // A malformed handoff must fail the connect cleanly, never silently
        // fall back to empty settings.
        let err = parse_settings_payload("{not json").unwrap_err();
        assert!(err.to_string().contains("parse daemon settings"));
    }

    #[test]
    fn daemon_config_requires_type_id() {
        let _guard = ENV_LOCK.lock().unwrap();

        std::env::remove_var("TERMIHUB_TYPE_ID");
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");

        let result = DaemonConfig::from_env("test-123", serde_json::json!({}));
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("TERMIHUB_TYPE_ID"));
    }

    #[test]
    fn daemon_config_from_env() {
        let _guard = ENV_LOCK.lock().unwrap();

        std::env::set_var("TERMIHUB_TYPE_ID", "ssh");
        std::env::set_var("TERMIHUB_SOCKET_PATH", "/tmp/test-daemon.sock");
        std::env::set_var("TERMIHUB_BUFFER_SIZE", "2097152");

        let config = DaemonConfig::from_env(
            "test-456",
            serde_json::json!({"host":"192.168.1.1","port":22}),
        )
        .unwrap();
        assert_eq!(config.session_id, "test-456");
        assert_eq!(config.type_id, "ssh");
        assert_eq!(config.settings["host"], "192.168.1.1");
        assert_eq!(config.settings["port"], 22);
        assert_eq!(config.endpoint, "/tmp/test-daemon.sock");
        assert_eq!(config.buffer_size, 2097152);

        // Clean up
        std::env::remove_var("TERMIHUB_TYPE_ID");
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");
    }

    #[test]
    fn daemon_config_defaults() {
        let _guard = ENV_LOCK.lock().unwrap();

        std::env::set_var("TERMIHUB_TYPE_ID", "local");
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");

        let config = DaemonConfig::from_env("test-789", serde_json::json!({})).unwrap();
        assert_eq!(config.type_id, "local");
        assert_eq!(config.settings, serde_json::json!({}));
        assert_eq!(config.buffer_size, DEFAULT_BUFFER_SIZE);
        // The default endpoint embeds the session id (socket path on unix,
        // pipe name on windows).
        assert!(
            config.endpoint.contains("test-789"),
            "got {}",
            config.endpoint
        );

        // Clean up
        std::env::remove_var("TERMIHUB_TYPE_ID");
    }

    // ── SSH agent forwarding through the remote-agent backend (#1719) ─────
    //
    // The remote-agent SSH backend is the reused `termihub_core` SSH
    // `ConnectionType` (see `crate::registry`), so `forwardAgent` is honored on
    // the agent's SSH leg by the same connector/handler that #1699 added: the
    // session channel requests `auth-agent-req@openssh.com` and the forwarded
    // agent channel is bridged to the ssh-agent local to the **agent host**
    // (`$SSH_AUTH_SOCK` / the Windows OpenSSH pipe). The daemon inherits the
    // agent's environment (`SystemDaemonLauncher` never clears it), so when the
    // desktop→agent SSH leg itself forwards the agent, that host-local socket
    // transparently chains back to the operator's own agent — end to end,
    // without a bespoke JSON-RPC relay. The chosen model is documented in
    // `docs/testing.md` → "SSH agent forwarding through the remote agent".
    //
    // These tests pin the agent-side seam: the `forwardAgent` flag survives the
    // settings handoff untouched and, fed to the core parser exactly as the
    // daemon feeds it at connect time, yields an SshConfig with forwarding
    // enabled. The connector request, the handler bridge, and the
    // no-agent-available no-op themselves are covered by core unit tests.

    /// `forwardAgent: true` in the connection settings survives the settings
    /// handoff into the daemon and maps to `SshConfig.forward_agent`, so the
    /// reused core SSH backend requests forwarding on the agent's SSH leg.
    #[test]
    fn daemon_ssh_settings_carry_forward_agent() {
        let _guard = ENV_LOCK.lock().unwrap();

        std::env::set_var("TERMIHUB_TYPE_ID", "ssh");
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");

        let settings = serde_json::json!({
            "host": "target.example",
            "username": "me",
            "authMethod": "agent",
            "forwardAgent": true,
        });
        let config = DaemonConfig::from_env("fwd-agent-1", settings).unwrap();
        // The flag reaches the daemon verbatim …
        assert_eq!(config.settings["forwardAgent"], serde_json::json!(true));
        // … and the daemon feeds exactly these settings to the core SSH backend,
        // whose parser turns it into an enabled `forward_agent`.
        let ssh = termihub_core::backends::ssh::parse_ssh_settings(&config.settings);
        assert!(
            ssh.forward_agent,
            "forwardAgent must reach the core SSH backend through the agent"
        );

        std::env::remove_var("TERMIHUB_TYPE_ID");
    }

    /// With `forwardAgent` absent (every pre-#1699 saved connection), the
    /// agent's SSH leg leaves forwarding off — a graceful default, so those
    /// connections behave exactly as before.
    #[test]
    fn daemon_ssh_settings_default_forward_agent_off() {
        let _guard = ENV_LOCK.lock().unwrap();

        std::env::set_var("TERMIHUB_TYPE_ID", "ssh");
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");

        let settings = serde_json::json!({"host":"target.example","username":"me"});
        let config = DaemonConfig::from_env("fwd-agent-2", settings).unwrap();
        let ssh = termihub_core::backends::ssh::parse_ssh_settings(&config.settings);
        assert!(
            !ssh.forward_agent,
            "an absent forwardAgent must leave the agent's SSH leg unforwarded"
        );

        std::env::remove_var("TERMIHUB_TYPE_ID");
    }

    // ── Generation-counter regression tests ──────────────────────────────
    //
    // These tests verify that a stale Disconnected from an old connection
    // does not destroy a newly accepted connection.

    /// A stale Disconnected (gen < current) must be silently ignored so that
    /// the newly accepted connection remains intact.
    #[tokio::test]
    async fn stale_disconnected_does_not_destroy_new_connection() {
        use tokio::sync::mpsc;

        let (tx, mut rx) = mpsc::channel::<AgentCommand>(64);

        // Simulate: old connection gen=1 sends Disconnected after gen=2 was accepted.
        tx.send(AgentCommand::Disconnected(1)).await.unwrap();

        // The main loop logic: connection_gen is now 2.
        let connection_gen: u64 = 2;
        let mut agent_writer_is_set = true;

        // Drain one command — should be the stale Disconnected.
        if let Some(AgentCommand::Disconnected(gen)) = rx.recv().await {
            if gen == connection_gen {
                agent_writer_is_set = false;
            }
            // gen=1 != connection_gen=2 → ignore
        }

        // Connection must still be considered live.
        assert!(
            agent_writer_is_set,
            "stale Disconnected(gen=1) must not clear agent_writer when connection_gen=2"
        );
    }

    /// A Disconnected whose generation matches the current connection must be
    /// processed and clear the writer.
    #[tokio::test]
    async fn current_disconnected_clears_writer() {
        use tokio::sync::mpsc;

        let (tx, mut rx) = mpsc::channel::<AgentCommand>(64);

        let connection_gen: u64 = 3;
        tx.send(AgentCommand::Disconnected(3)).await.unwrap();

        let mut agent_writer_is_set = true;

        if let Some(AgentCommand::Disconnected(gen)) = rx.recv().await {
            if gen == connection_gen {
                agent_writer_is_set = false;
            }
        }

        assert!(
            !agent_writer_is_set,
            "Disconnected(gen=3) must clear agent_writer when connection_gen=3"
        );
    }

    // ── #3015: mid-frame liveness on the daemon's agent reader ───────────
    //
    // The daemon's agent reader mirrors the client reader: a peer (the agent /
    // worker) that begins a frame and then wedges must be dropped so the daemon
    // does not keep holding a stale writer, while a merely-idle agent (no bytes
    // in flight) is never disconnected.

    /// A peer that writes a partial frame and then stalls must be surfaced as a
    /// `Disconnected` within a bounded time, so the daemon drops the wedged
    /// connection instead of pinning the reader task forever (#3015).
    ///
    /// `start_paused` lets the mid-frame timeout elapse in virtual time.
    #[tokio::test(start_paused = true)]
    async fn agent_reader_loop_disconnects_a_peer_that_stalls_mid_frame() {
        use tokio::io::AsyncWriteExt;

        let (mut client, server) = tokio::io::duplex(64 * 1024);
        // Begin a frame (one type byte) then stall; keep the connection open.
        client
            .write_all(&[MSG_INPUT])
            .await
            .expect("write partial frame header");

        let (tx, mut rx) = mpsc::channel::<AgentCommand>(64);
        let reader: BoxedReader = Box::new(server);
        let handle = tokio::spawn(async move {
            agent_reader_loop(reader, tx, 7).await;
        });

        let cmd = rx
            .recv()
            .await
            .expect("a mid-frame-stalled peer must produce a Disconnected (#3015)");
        assert!(
            matches!(cmd, AgentCommand::Disconnected(7)),
            "the wedged peer must disconnect with its own generation (#3015)"
        );

        handle.await.expect("reader task joins");
        drop(client);
    }

    /// An idle-but-alive agent (no bytes in flight, connection open) must NOT be
    /// disconnected: the mid-frame timeout only bounds a frame that has already
    /// begun, so the reader waits unbounded for the first byte (#3015).
    #[tokio::test(start_paused = true)]
    async fn agent_reader_loop_keeps_an_idle_but_alive_peer() {
        let (client, server) = tokio::io::duplex(64 * 1024);
        // The agent is idle: it sends nothing, but never drops the connection.

        let (tx, mut rx) = mpsc::channel::<AgentCommand>(64);
        let reader: BoxedReader = Box::new(server);
        let handle = tokio::spawn(async move {
            agent_reader_loop(reader, tx, 9).await;
        });

        // Advance far past any mid-frame timeout; with no first byte there is no
        // timer, so the reader must stay parked and emit no command.
        tokio::time::advance(Duration::from_secs(3600)).await;
        tokio::task::yield_now().await;

        assert!(
            rx.try_recv().is_err(),
            "a merely-idle agent must not be disconnected (#3015)"
        );
        assert!(
            !handle.is_finished(),
            "the daemon reader must still be parked on the idle connection (#3015)"
        );

        handle.abort();
        drop(client);
    }

    // ── AGT-015: owner-scoped recovery guard ────────────────────────────
    //
    // These drive the real `daemon_loop` over a real endpoint with real
    // `DaemonClient` connects, proving the daemon never evicts a live writer for
    // a recovery connect (the second-desktop data-loss bug) while still allowing
    // a fresh worker to recover a truly-orphaned session and a deliberate
    // takeover to replace a live writer.
    pub(crate) mod recovery_guard {
        use crate::daemon::client::{DaemonClient, OwnedByLivePeer};
        use crate::daemon::transport::{self, DaemonListener};
        use crate::io::transport::NotificationSender;
        use termihub_core::connection::{
            Capabilities, ConnectionType, OutputReceiver, SettingsSchema,
        };
        use termihub_core::errors::SessionError;

        /// Minimal in-process connection type: the daemon loop only needs it to
        /// exist and accept writes/resizes; it produces no output.
        struct FakeConnection;

        #[async_trait::async_trait]
        impl ConnectionType for FakeConnection {
            fn type_id(&self) -> &str {
                "fake"
            }
            fn display_name(&self) -> &str {
                "Fake"
            }
            fn settings_schema(&self) -> SettingsSchema {
                SettingsSchema { groups: vec![] }
            }
            fn capabilities(&self) -> Capabilities {
                Capabilities {
                    monitoring: false,
                    file_browser: false,
                    graphical: false,
                    resize: true,
                    persistent: true,
                    terminal: true,
                    tunneling: false,
                }
            }
            async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
                Ok(())
            }
            async fn disconnect(&mut self) -> Result<(), SessionError> {
                Ok(())
            }
            fn is_connected(&self) -> bool {
                true
            }
            fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
                Ok(())
            }
            fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
                Ok(())
            }
            fn subscribe_output(&self) -> OutputReceiver {
                let (_tx, rx) = tokio::sync::mpsc::channel(1);
                rx
            }
            fn monitoring(&self) -> Option<&dyn termihub_core::monitoring::MonitoringProvider> {
                None
            }
            fn file_browser(&self) -> Option<&dyn termihub_core::files::FileBrowser> {
                None
            }
        }

        fn make_notification_tx() -> NotificationSender {
            let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
            tx
        }

        fn unique_endpoint(tag: &str) -> String {
            let id = format!(
                "itest-agt015-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            transport::session_endpoint(&id)
        }

        /// Bind an endpoint and run a real `daemon_loop` against it on a
        /// background task. Returns the endpoint and the loop's join handle.
        pub(crate) async fn spawn_daemon(endpoint: &str) -> tokio::task::JoinHandle<()> {
            let mut listener = DaemonListener::bind(endpoint)
                .await
                .expect("bind daemon endpoint");
            let (out_tx, out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
            tokio::spawn(async move {
                // Keep the output sender alive for the life of the loop: dropping
                // it would close the output channel and make `daemon_loop` exit.
                let _out_tx = out_tx;
                let conn: Box<dyn ConnectionType> = Box::new(FakeConnection);
                let _ =
                    super::super::daemon_loop("test-session", conn, out_rx, &mut listener, 4096)
                        .await;
                listener.cleanup();
            })
        }

        /// The core AGT-015 invariant: while a live writer is attached, a recovery
        /// connect (a second desktop's worker) is REFUSED — the daemon keeps the
        /// live writer instead of evicting it.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn recovery_connect_refused_while_live_writer_attached() {
            let endpoint = unique_endpoint("refuse");
            let _daemon = spawn_daemon(&endpoint).await;

            // Worker A attaches (fresh spawn / takeover) and stays live.
            let client_a =
                DaemonClient::connect("s".into(), endpoint.clone(), make_notification_tx())
                    .await
                    .expect("worker A attaches");
            assert!(client_a.is_alive(), "worker A must be attached and alive");

            // Worker B (second desktop) tries to RECOVER the same session.
            let err = match DaemonClient::connect_for_recovery(
                "s".into(),
                endpoint.clone(),
                make_notification_tx(),
            )
            .await
            {
                Ok(_) => panic!("recovery must be refused while a live writer is attached"),
                Err(e) => e,
            };
            assert!(
                err.downcast_ref::<OwnedByLivePeer>().is_some(),
                "refusal must surface as OwnedByLivePeer, got: {err:#}"
            );

            // A must NOT have been evicted: it can still round-trip a request.
            client_a
                .query_buffer()
                .await
                .expect("worker A must still be attached after the refused recovery");
        }

        /// A worker restarting for the *same* desktop (its predecessor is gone, so
        /// no writer is attached) still recovers a truly-orphaned session — the
        /// flagship persistent-session feature is preserved.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn recovery_connect_succeeds_when_no_writer_attached() {
            let endpoint = unique_endpoint("orphan");
            let _daemon = spawn_daemon(&endpoint).await;

            let client = DaemonClient::connect_for_recovery(
                "s".into(),
                endpoint.clone(),
                make_notification_tx(),
            )
            .await
            .expect("an orphaned session (no live writer) must be recoverable");
            assert!(client.is_alive(), "recovered session must be alive");
        }

        /// A deliberate re-attach (takeover) still replaces a live writer — the
        /// guard only refuses *recovery* connects, never a takeover.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn takeover_connect_still_replaces_live_writer() {
            let endpoint = unique_endpoint("takeover");
            let _daemon = spawn_daemon(&endpoint).await;

            let _client_a =
                DaemonClient::connect("s".into(), endpoint.clone(), make_notification_tx())
                    .await
                    .expect("worker A attaches");

            let client_b =
                DaemonClient::connect("s".into(), endpoint.clone(), make_notification_tx())
                    .await
                    .expect("a takeover connect must succeed even while A is attached");
            assert!(client_b.is_alive(), "the taking-over writer must be alive");
        }

        // ── SM-003: single-attach eviction ──────────────────────────────

        type NotificationRx =
            tokio::sync::mpsc::UnboundedReceiver<crate::protocol::messages::JsonRpcNotification>;

        fn notification_pair() -> (NotificationSender, NotificationRx) {
            tokio::sync::mpsc::unbounded_channel()
        }

        /// Wait (bounded) for the next `connection.evicted` notification, skipping
        /// any interleaved output notifications. Returns its `reason`.
        async fn next_evicted(rx: &mut NotificationRx) -> String {
            let deadline = std::time::Duration::from_secs(10);
            tokio::time::timeout(deadline, async {
                loop {
                    let n = rx.recv().await.expect("notification channel open");
                    if n.method == crate::protocol::methods::CONNECTION_EVICTED {
                        assert_eq!(n.params["session_id"], "s");
                        return n.params["reason"].as_str().unwrap_or_default().to_string();
                    }
                }
            })
            .await
            .expect("an evicted owner must receive connection.evicted")
        }

        /// Wait (bounded) until `pred` holds, polling.
        async fn eventually(mut pred: impl FnMut() -> bool) -> bool {
            for _ in 0..200 {
                if pred() {
                    return true;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            pred()
        }

        /// A takeover evicts the incumbent with a **typed** notification — not a
        /// silent EOF — while the session itself stays alive and the incumbent
        /// stops writing to it. Exactly one owner remains.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn takeover_evicts_incumbent_with_typed_notification() {
            let endpoint = unique_endpoint("sm003-evict");
            let _daemon = spawn_daemon(&endpoint).await;

            let (tx_a, mut rx_a) = notification_pair();
            let client_a = DaemonClient::connect("s".into(), endpoint.clone(), tx_a)
                .await
                .expect("worker A attaches");
            let client_b =
                DaemonClient::connect("s".into(), endpoint.clone(), make_notification_tx())
                    .await
                    .expect("worker B takes over");

            assert_eq!(next_evicted(&mut rx_a).await, "takeover");
            assert!(client_a.is_evicted(), "A must report it was taken over");
            assert!(
                client_a.is_alive(),
                "an eviction is not an exit: the session is still alive"
            );
            assert!(
                DaemonClient::write_via_handle(&client_a.writer_handle(), b"x")
                    .await
                    .is_err(),
                "an evicted owner must not write to the session"
            );
            assert!(!client_b.is_evicted(), "B is the single owner");
            client_b
                .query_buffer()
                .await
                .expect("the new owner controls the session");
        }

        /// Reclaim (a takeover re-attach) flips ownership back: the reclaiming
        /// side controls the session again and the other side is evicted in turn.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn reclaim_flips_ownership_back() {
            let endpoint = unique_endpoint("sm003-reclaim");
            let _daemon = spawn_daemon(&endpoint).await;

            let (tx_a, mut rx_a) = notification_pair();
            let mut client_a = DaemonClient::connect("s".into(), endpoint.clone(), tx_a)
                .await
                .expect("worker A attaches");
            let (tx_b, mut rx_b) = notification_pair();
            let client_b = DaemonClient::connect("s".into(), endpoint.clone(), tx_b)
                .await
                .expect("worker B takes over");
            assert_eq!(next_evicted(&mut rx_a).await, "takeover");

            client_a.attach().await.expect("A reclaims");
            assert!(!client_a.is_evicted(), "a reclaim clears A's eviction");
            assert_eq!(next_evicted(&mut rx_b).await, "takeover");
            assert!(client_b.is_evicted(), "B is evicted by the reclaim");
            client_a
                .query_buffer()
                .await
                .expect("A controls the session again");
        }

        /// Two owners racing to take over the same session end with **exactly one**
        /// owner: every other contender is evicted.
        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn racing_takeovers_leave_exactly_one_owner() {
            let endpoint = unique_endpoint("sm003-race");
            let _daemon = spawn_daemon(&endpoint).await;

            let client_a =
                DaemonClient::connect("s".into(), endpoint.clone(), make_notification_tx())
                    .await
                    .expect("worker A attaches");
            let (b, c) = tokio::join!(
                DaemonClient::connect("s".into(), endpoint.clone(), make_notification_tx()),
                DaemonClient::connect("s".into(), endpoint.clone(), make_notification_tx()),
            );
            let client_b = b.expect("B connects");
            let client_c = c.expect("C connects");
            let clients = [&client_a, &client_b, &client_c];
            let single_owner =
                eventually(|| clients.iter().filter(|c| !c.is_evicted()).count() == 1).await;
            assert!(single_owner, "exactly one owner must remain after the race");
            let owner = clients.iter().find(|c| !c.is_evicted()).expect("one owner");
            owner
                .query_buffer()
                .await
                .expect("the owner controls the session");
        }

        /// Backward compatibility: an incumbent that predates SM-003 sees the new
        /// frame as one unknown type followed by the same EOF it always got, so it
        /// falls back to today's drop handling.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn legacy_incumbent_sees_evicted_frame_then_eof() {
            use crate::daemon::protocol::{self, MSG_EVICTED, MSG_READY};

            let endpoint = unique_endpoint("sm003-legacy");
            let _daemon = spawn_daemon(&endpoint).await;

            // A raw, pre-SM-003 incumbent: no attach-intent frame, just the
            // handshake.
            let (mut reader, _writer) = transport::connect(&endpoint).await.expect("connect");
            loop {
                let frame = protocol::read_frame_async(&mut reader)
                    .await
                    .expect("read")
                    .expect("frame");
                if frame.msg_type == MSG_READY {
                    break;
                }
            }

            let _client_b =
                DaemonClient::connect("s".into(), endpoint.clone(), make_notification_tx())
                    .await
                    .expect("B takes over");

            let frame = protocol::read_frame_async(&mut reader)
                .await
                .expect("read")
                .expect("the evicted frame precedes the close");
            assert_eq!(frame.msg_type, MSG_EVICTED);
            assert!(frame.payload.is_empty());
            let eof = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                protocol::read_frame_async(&mut reader),
            )
            .await
            .expect("the daemon closes the evicted connection");
            assert!(
                matches!(eof, Ok(None) | Err(_)),
                "the legacy incumbent then observes the historical EOF"
            );
        }
    }
}

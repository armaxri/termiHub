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
use termihub_core::buffer::RingBuffer;
use termihub_core::connection::{ConnectionType, OutputReceiver};

/// Default ring buffer size: 1 MiB.
const DEFAULT_BUFFER_SIZE: usize = 1_048_576;

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
    /// Read configuration from environment variables.
    ///
    /// Required env vars:
    /// - `TERMIHUB_TYPE_ID` — connection type identifier (e.g., `"local"`, `"ssh"`)
    /// - `TERMIHUB_SETTINGS` — JSON settings for `ConnectionType::connect()`
    ///
    /// Optional env vars:
    /// - `TERMIHUB_SOCKET_PATH` — transport endpoint (socket path on unix,
    ///   pipe name on windows; default: auto-generated)
    /// - `TERMIHUB_BUFFER_SIZE` — ring buffer size in bytes (default: 1 MiB)
    fn from_env(session_id: &str) -> anyhow::Result<Self> {
        let endpoint = std::env::var("TERMIHUB_SOCKET_PATH")
            .unwrap_or_else(|_| transport::session_endpoint(session_id));

        let type_id = std::env::var("TERMIHUB_TYPE_ID")
            .map_err(|_| anyhow::anyhow!("TERMIHUB_TYPE_ID env var is required"))?;

        let settings: serde_json::Value = std::env::var("TERMIHUB_SETTINGS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

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

/// Entry point for the session daemon process.
///
/// Creates a [`ConnectionType`] instance from the registry, connects it
/// using the settings from environment variables, and runs the event loop
/// that bridges the connection to the agent via the Unix socket.
pub async fn run_daemon(session_id: &str) -> anyhow::Result<()> {
    let config = DaemonConfig::from_env(session_id)?;

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

/// Background task that reads frames from the agent and sends commands
/// to the main loop via a channel.
///
/// `gen` is the connection generation assigned when this connection was
/// accepted; it is included in `Disconnected` so the main loop can ignore
/// stale disconnects from previous connections.
async fn agent_reader_loop(mut reader: BoxedReader, tx: mpsc::Sender<AgentCommand>, gen: u64) {
    loop {
        match protocol::read_frame_async(&mut reader).await {
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
mod tests {
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
    fn daemon_config_requires_type_id() {
        let _guard = ENV_LOCK.lock().unwrap();

        std::env::remove_var("TERMIHUB_TYPE_ID");
        std::env::remove_var("TERMIHUB_SETTINGS");
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");

        let result = DaemonConfig::from_env("test-123");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("TERMIHUB_TYPE_ID"));
    }

    #[test]
    fn daemon_config_from_env() {
        let _guard = ENV_LOCK.lock().unwrap();

        std::env::set_var("TERMIHUB_TYPE_ID", "ssh");
        std::env::set_var("TERMIHUB_SETTINGS", r#"{"host":"192.168.1.1","port":22}"#);
        std::env::set_var("TERMIHUB_SOCKET_PATH", "/tmp/test-daemon.sock");
        std::env::set_var("TERMIHUB_BUFFER_SIZE", "2097152");

        let config = DaemonConfig::from_env("test-456").unwrap();
        assert_eq!(config.session_id, "test-456");
        assert_eq!(config.type_id, "ssh");
        assert_eq!(config.settings["host"], "192.168.1.1");
        assert_eq!(config.settings["port"], 22);
        assert_eq!(config.endpoint, "/tmp/test-daemon.sock");
        assert_eq!(config.buffer_size, 2097152);

        // Clean up
        std::env::remove_var("TERMIHUB_TYPE_ID");
        std::env::remove_var("TERMIHUB_SETTINGS");
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");
    }

    #[test]
    fn daemon_config_defaults() {
        let _guard = ENV_LOCK.lock().unwrap();

        std::env::set_var("TERMIHUB_TYPE_ID", "local");
        std::env::remove_var("TERMIHUB_SETTINGS");
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");

        let config = DaemonConfig::from_env("test-789").unwrap();
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
    // `TERMIHUB_SETTINGS` transport untouched and, fed to the core parser
    // exactly as the daemon feeds it at connect time, yields an SshConfig with
    // forwarding enabled. The connector request, the handler bridge, and the
    // no-agent-available no-op themselves are covered by core unit tests.

    /// `forwardAgent: true` in the connection settings survives the env-var
    /// transport into the daemon and maps to `SshConfig.forward_agent`, so the
    /// reused core SSH backend requests forwarding on the agent's SSH leg.
    #[test]
    fn daemon_ssh_settings_carry_forward_agent() {
        let _guard = ENV_LOCK.lock().unwrap();

        std::env::set_var("TERMIHUB_TYPE_ID", "ssh");
        std::env::set_var(
            "TERMIHUB_SETTINGS",
            r#"{"host":"target.example","username":"me","authMethod":"agent","forwardAgent":true}"#,
        );
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");

        let config = DaemonConfig::from_env("fwd-agent-1").unwrap();
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
        std::env::remove_var("TERMIHUB_SETTINGS");
    }

    /// With `forwardAgent` absent (every pre-#1699 saved connection), the
    /// agent's SSH leg leaves forwarding off — a graceful default, so those
    /// connections behave exactly as before.
    #[test]
    fn daemon_ssh_settings_default_forward_agent_off() {
        let _guard = ENV_LOCK.lock().unwrap();

        std::env::set_var("TERMIHUB_TYPE_ID", "ssh");
        std::env::set_var(
            "TERMIHUB_SETTINGS",
            r#"{"host":"target.example","username":"me"}"#,
        );
        std::env::remove_var("TERMIHUB_SOCKET_PATH");
        std::env::remove_var("TERMIHUB_BUFFER_SIZE");

        let config = DaemonConfig::from_env("fwd-agent-2").unwrap();
        let ssh = termihub_core::backends::ssh::parse_ssh_settings(&config.settings);
        assert!(
            !ssh.forward_agent,
            "an absent forwardAgent must leave the agent's SSH leg unforwarded"
        );

        std::env::remove_var("TERMIHUB_TYPE_ID");
        std::env::remove_var("TERMIHUB_SETTINGS");
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

    // ── AGT-015: owner-scoped recovery guard ────────────────────────────
    //
    // These drive the real `daemon_loop` over a real endpoint with real
    // `DaemonClient` connects, proving the daemon never evicts a live writer for
    // a recovery connect (the second-desktop data-loss bug) while still allowing
    // a fresh worker to recover a truly-orphaned session and a deliberate
    // takeover to replace a live writer.
    mod recovery_guard {
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
        async fn spawn_daemon(endpoint: &str) -> tokio::task::JoinHandle<()> {
            let mut listener = DaemonListener::bind(endpoint)
                .await
                .expect("bind daemon endpoint");
            let (out_tx, out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
            tokio::spawn(async move {
                // Keep the output sender alive for the life of the loop: dropping
                // it would close the output channel and make `daemon_loop` exit.
                let _out_tx = out_tx;
                let conn: Box<dyn ConnectionType> = Box::new(FakeConnection);
                let _ = super::super::daemon_loop("test-session", conn, out_rx, &mut listener, 4096)
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
    }
}

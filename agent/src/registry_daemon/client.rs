//! Worker-side client for the host-wide registry daemon (ADR-11).
//!
//! Every agent worker owns one [`RegistryClient`]. It announces the worker's
//! client, answers "who else is attached to this host?", and carries
//! cross-worker broadcasts.
//!
//! # The registry is optional, always
//!
//! The single hardest requirement here is that **a missing or restarting
//! registry must never degrade a working agent**. A desktop's terminal must keep
//! working on a host where the registry failed to spawn, crashed, or is mid
//! restart. So every method on [`RegistryClient`] is infallible and
//! non-blocking: they hand a command to a background supervisor task and return.
//! The supervisor owns all the fallibility —
//!
//! - **Absent** → connecting fails, the supervisor spawns a registry and retries;
//!   if that fails too it backs off and tries again, forever, silently.
//! - **Restarting** → the connection drops, the supervisor reconnects and
//!   **re-sends the registration it is holding**, which is what makes a restart
//!   invisible to the worker and self-healing without any explicit resync.
//! - **Never available** → [`list`](RegistryClient::list) times out and returns
//!   `None`, and the caller falls back to its own per-process registry. A lone
//!   worker still reports itself; it just cannot see peers, which is exactly the
//!   pre-registry behaviour.
//!
//! Nothing here ever returns an error to the RPC layer, and nothing here is on
//! a session's I/O path.
//!
//! ```text
//!   RegistryClient::register/list/broadcast   (never blocks, never fails)
//!            │ command channel
//!            ▼
//!    supervisor task ──connect or spawn──► registry daemon
//!            │  ▲            reconnect + re-register on drop
//!            ▼  │
//!     MSG_EVENT │──► notification_tx ──► this worker's own client
//! ```

use std::collections::VecDeque;
use std::time::Duration;

use termihub_core::ipc;
use termihub_core::protocol::messages::JsonRpcNotification;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::daemon::protocol::{read_frame_async, write_frame_async};
use crate::daemon::transport::{registry_endpoint, BoxedReader, BoxedWriter};
use crate::io::transport::NotificationSender;
use crate::registry_daemon::protocol::{
    BroadcastEnvelope, ClientRecord, MSG_BROADCAST, MSG_CLIENTS, MSG_DEREGISTER, MSG_EVENT,
    MSG_LIST, MSG_REGISTER,
};

/// How long [`RegistryClient::list`] waits for the registry to answer before
/// giving up and letting the caller fall back to its per-process view.
///
/// A local socket round-trip to a process that holds everything in memory is
/// sub-millisecond; this bound exists only so a wedged registry cannot stall an
/// `agent.list_connections` RPC. It is deliberately far below any desktop-side
/// RPC timeout, so the fallback answer arrives well before the caller gives up.
const LIST_TIMEOUT: Duration = Duration::from_secs(2);

/// How long to wait for a freshly spawned registry to bind its endpoint.
///
/// Much shorter than the session daemon's 30 s: a registry binds a socket and
/// nothing else — no PTY, no shell, no ConPTY — so if it has not appeared in a
/// few seconds it is not coming, and the worker is better off proceeding
/// without it than blocking.
const SPAWN_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// How often to retry while a freshly spawned registry binds its endpoint.
const CONNECT_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// How long the supervisor waits after a failed or dropped connection before
/// trying again. Bounds the respawn rate when a registry cannot start at all.
const RECONNECT_DELAY: Duration = Duration::from_secs(2);

/// Env var that suppresses the detached registry-daemon spawn (#2480).
///
/// A `--stdio` agent serving a **single** desktop client does not need the
/// ADR-11 cross-worker "who is attached" registry — that only matters when
/// several agent processes on one host must see each other. The system-test
/// harness stands up exactly one throwaway-sshd agent per session, so it sets
/// this to opt that session out of spawning the detached registry daemon.
///
/// When set to a truthy value (`1` / `true` / `yes`) [`RegistryConfig::default`]
/// disables [`auto_spawn`](RegistryConfig::auto_spawn): the worker still connects
/// to a registry that already happens to be listening, but it never *spawns* one,
/// and [`list`](RegistryClient::list) falls back to the per-process view — the
/// same behaviour as a host where no registry is reachable. Unset (the
/// production default) the behaviour is byte-identical to before this flag
/// existed.
pub const SKIP_REGISTRY_DAEMON_ENV: &str = "TERMIHUB_AGENT_SKIP_REGISTRY_DAEMON";

/// Parse a [`SKIP_REGISTRY_DAEMON_ENV`]-style value into a skip decision.
///
/// Truthy (`1` / `true` / `yes`) → skip the spawn. Anything else — absent,
/// empty, or any other string — means "do not skip", so production (env unset)
/// is byte-identical to the pre-flag behaviour. Pulled out as a pure function so
/// the decision is unit-testable without mutating the process environment.
fn skip_from_env(raw: Option<&str>) -> bool {
    matches!(raw, Some("1") | Some("true") | Some("yes"))
}

/// Whether this process should suppress the registry-daemon spawn, read from
/// [`SKIP_REGISTRY_DAEMON_ENV`].
fn skip_registry_daemon() -> bool {
    skip_from_env(std::env::var(SKIP_REGISTRY_DAEMON_ENV).ok().as_deref())
}

/// How the worker reaches its registry.
#[derive(Debug, Clone)]
pub struct RegistryConfig {
    /// Endpoint to connect to (unix socket path / windows pipe name).
    pub endpoint: String,
    /// Whether a failed connect may spawn a registry daemon.
    ///
    /// `true` in production by default. Tests that run the registry in-process
    /// set it to `false` so a failure surfaces as a failure rather than silently
    /// spawning a real detached process from the test binary. It is also forced
    /// to `false` when [`SKIP_REGISTRY_DAEMON_ENV`] is set (single-client
    /// sessions that do not need the ADR-11 registry — see that constant).
    pub auto_spawn: bool,
}

impl Default for RegistryConfig {
    fn default() -> Self {
        Self {
            endpoint: registry_endpoint(),
            // A single-client session (the system-test harness) opts out of the
            // detached registry-daemon spawn via the env var; production leaves
            // it unset, so this is `true` exactly as before (#2480).
            auto_spawn: !skip_registry_daemon(),
        }
    }
}

/// A command from a [`RegistryClient`] handle to its supervisor task.
enum Command {
    Register(Box<ClientRecord>),
    Deregister,
    List(oneshot::Sender<Vec<ClientRecord>>),
    Broadcast(Box<BroadcastEnvelope>),
}

/// Handle to this worker's registry connection.
///
/// Cheap to clone-by-`Arc` and safe to use from any task. Dropping the handle
/// does not stop the supervisor; cancel the [`CancellationToken`] passed to
/// [`start`](Self::start) for that (the transport loops pass their shutdown
/// token, so the supervisor dies with the worker).
pub struct RegistryClient {
    cmd_tx: mpsc::UnboundedSender<Command>,
}

impl RegistryClient {
    /// Start a registry client and its background supervisor.
    ///
    /// Returns immediately — the supervisor connects (spawning a registry if
    /// needed) in the background, so a slow or missing registry never delays
    /// worker startup. `notification_tx` is this worker's existing notification
    /// channel: broadcasts from *other* workers are delivered into it, which is
    /// how a cross-worker event reaches this worker's client.
    pub fn start(
        config: RegistryConfig,
        notification_tx: NotificationSender,
        shutdown: CancellationToken,
    ) -> Self {
        // Diagnostic for #2480: make the single-client opt-out visible at INFO in
        // the agent's stderr so a full-app display run can confirm the harness
        // env reached the agent and the registry-daemon spawn was suppressed.
        if !config.auto_spawn {
            info!(
                "Registry-daemon auto-spawn disabled ({} set) — single-client session, \
                 not spawning the host-wide registry",
                SKIP_REGISTRY_DAEMON_ENV
            );
        }
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        tokio::spawn(supervise(config, cmd_rx, notification_tx, shutdown));
        Self { cmd_tx }
    }

    /// Announce this worker's client to the host.
    ///
    /// Called when `initialize` completes — never when a session is created —
    /// which is precisely why a desktop **holding no sessions** is still
    /// visible to its peers. Sent again automatically after any reconnect.
    pub fn register(&self, record: ClientRecord) {
        let _ = self.cmd_tx.send(Command::Register(Box::new(record)));
    }

    /// Withdraw this worker's client (its connection ended).
    pub fn deregister(&self) {
        let _ = self.cmd_tx.send(Command::Deregister);
    }

    /// Every client attached to this host, or `None` when the registry could not
    /// answer in [`LIST_TIMEOUT`].
    ///
    /// `None` means "no host-wide view available", not "nobody is connected" —
    /// callers must fall back to their per-process registry rather than report
    /// an empty host.
    pub async fn list(&self) -> Option<Vec<ClientRecord>> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(Command::List(tx)).ok()?;
        match tokio::time::timeout(LIST_TIMEOUT, rx).await {
            Ok(Ok(clients)) => Some(clients),
            // Timed out, or the supervisor dropped the responder because the
            // connection died before it could answer.
            _ => None,
        }
    }

    /// Fan a notification out to every *other* worker on this host.
    ///
    /// The cross-worker half of the notification path: the local per-process
    /// channel ([`io/tcp.rs`](crate::io::tcp)'s `mpsc`) is multi-producer but
    /// **single-consumer**, so it can only ever reach this worker's own client.
    /// Anything that must reach the host's *other* desktops goes through here.
    ///
    /// # Callers
    ///
    /// The coordinated update (#1351) is the production caller — it broadcasts
    /// [`agent.update_pending`](crate::protocol::methods::AGENT_UPDATE_PENDING)
    /// so every other host can leave before the binary is swapped. It reaches
    /// here through the `PeerCoordinator` trait in [`crate::update`], which is
    /// implemented for this type.
    ///
    /// The round trip is proven across two processes on a real socket by
    /// `agent/tests/registry_daemon_integration.rs`, on top of the fan-out and
    /// delivery unit tests here and in [`super::process`].
    pub fn broadcast(&self, envelope: BroadcastEnvelope) {
        let _ = self.cmd_tx.send(Command::Broadcast(Box::new(envelope)));
    }
}

/// State the supervisor keeps **across** reconnects.
struct Supervisor {
    /// The registration to (re-)send on every connection. Holding it here is
    /// what makes a registry restart self-healing.
    desired: Option<ClientRecord>,
    /// `list` responders awaiting a `MSG_CLIENTS`, in send order.
    ///
    /// A single connection delivers frames in order, so the registry answers
    /// `MSG_LIST`s in the order it received them and FIFO matching is exact —
    /// no correlation ids needed on the wire.
    pending_lists: VecDeque<oneshot::Sender<Vec<ClientRecord>>>,
    notification_tx: NotificationSender,
}

/// Own the registry connection for the worker's whole life: connect, serve,
/// reconnect, forever, until `shutdown`.
async fn supervise(
    config: RegistryConfig,
    mut cmd_rx: mpsc::UnboundedReceiver<Command>,
    notification_tx: NotificationSender,
    shutdown: CancellationToken,
) {
    let mut sup = Supervisor {
        desired: None,
        pending_lists: VecDeque::new(),
        notification_tx,
    };

    while !shutdown.is_cancelled() {
        match connect_or_spawn(&config).await {
            Ok((reader, writer)) => {
                debug!("Registry client connected to {}", config.endpoint);
                run_session(&mut sup, &mut cmd_rx, reader, writer, &shutdown).await;
                debug!("Registry client session ended");
            }
            Err(e) => {
                // Not an error the worker should care about — it just means no
                // host-wide view for now. Everything else keeps working.
                debug!("Registry unavailable at {}: {e}", config.endpoint);
            }
        }

        // The connection is gone; nobody is going to answer these.
        sup.pending_lists.clear();

        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = tokio::time::sleep(RECONNECT_DELAY) => {}
        }
    }
    debug!("Registry client supervisor stopped");
}

/// Connect to the registry, spawning one if nothing is listening.
///
/// Probes with a fail-fast connect first: on the overwhelmingly common path a
/// registry is already up and this is a single syscall with no process spawn.
async fn connect_or_spawn(config: &RegistryConfig) -> std::io::Result<(BoxedReader, BoxedWriter)> {
    if let Ok(halves) = ipc::connect(&config.endpoint).await {
        return Ok(halves);
    }
    if !config.auto_spawn {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotConnected,
            "registry not running and auto-spawn is disabled",
        ));
    }

    // Nothing listening — start one. Several workers may reach this at once;
    // the losers' daemons exit on `AddrInUse` and everyone connects to the
    // winner, so no locking is needed (see `process::run_registry_daemon`).
    if let Err(e) = spawn_registry_daemon() {
        warn!("Failed to spawn registry daemon: {e}");
    }
    ipc::connect_with_retry(
        &config.endpoint,
        SPAWN_CONNECT_TIMEOUT,
        CONNECT_POLL_INTERVAL,
    )
    .await
}

/// Spawn `termihub-agent --registry-daemon`, detached.
///
/// Uses the **same** detachment path as the session daemons
/// ([`crate::daemon::spawn`]) — that shared path is what gives the registry the
/// survives-an-agent-binary-swap property ADR-11's deferred-update approach
/// leans on, rather than a second, subtly different daemonization.
fn spawn_registry_daemon() -> std::io::Result<()> {
    let agent_exe = std::env::current_exe()?;
    let mut command = std::process::Command::new(&agent_exe);
    command
        .arg("--registry-daemon")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null());

    #[cfg(unix)]
    let log = crate::daemon::transport::open_registry_log();
    #[cfg(not(unix))]
    let log = None;
    crate::daemon::spawn::configure_detached_stderr(&mut command, log);
    crate::daemon::spawn::configure_detachment(&mut command);

    // Detached and never waited on: the child reparents to init and outlives us
    // by design, so there is no zombie to reap.
    command.spawn()?;
    info!("Spawned registry daemon");
    Ok(())
}

/// Drive one registry connection until it fails or the worker shuts down.
async fn run_session(
    sup: &mut Supervisor,
    cmd_rx: &mut mpsc::UnboundedReceiver<Command>,
    mut reader: BoxedReader,
    mut writer: BoxedWriter,
    shutdown: &CancellationToken,
) {
    // Re-announce whatever we are holding. On a first connection this is
    // usually `None` (nobody has called `initialize` yet) and the register
    // arrives as a command moments later; on a reconnect it is the whole point.
    if let Some(record) = sup.desired.clone() {
        if send_json(&mut writer, MSG_REGISTER, &record).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => {
                // Say goodbye so peers see us leave immediately rather than
                // when the OS eventually tears the socket down.
                let _ = write_frame_async(&mut writer, MSG_DEREGISTER, &[]).await;
                return;
            }

            cmd = cmd_rx.recv() => {
                let Some(cmd) = cmd else { return };
                if handle_command(sup, &mut writer, cmd).await.is_err() {
                    return;
                }
            }

            frame = read_frame_async(&mut reader) => {
                match frame {
                    Ok(Some(frame)) => handle_frame(sup, frame),
                    Ok(None) => {
                        debug!("Registry closed the connection");
                        return;
                    }
                    Err(e) => {
                        debug!("Registry read error: {e}");
                        return;
                    }
                }
            }
        }
    }
}

/// Apply one command, writing whatever it implies to the registry.
///
/// `Err` means the connection is unusable and the session must end (the
/// supervisor then reconnects and replays `desired`).
async fn handle_command(
    sup: &mut Supervisor,
    writer: &mut BoxedWriter,
    cmd: Command,
) -> std::io::Result<()> {
    match cmd {
        Command::Register(record) => {
            // Remember before sending: if the write fails, the reconnect must
            // still know what to announce.
            sup.desired = Some(*record.clone());
            send_json(writer, MSG_REGISTER, &*record).await
        }
        Command::Deregister => {
            sup.desired = None;
            write_frame_async(writer, MSG_DEREGISTER, &[]).await
        }
        Command::List(responder) => {
            write_frame_async(writer, MSG_LIST, &[]).await?;
            sup.pending_lists.push_back(responder);
            Ok(())
        }
        Command::Broadcast(envelope) => send_json(writer, MSG_BROADCAST, &*envelope).await,
    }
}

/// Apply one frame from the registry.
fn handle_frame(sup: &mut Supervisor, frame: crate::daemon::protocol::Frame) {
    match frame.msg_type {
        MSG_CLIENTS => match serde_json::from_slice::<Vec<ClientRecord>>(&frame.payload) {
            Ok(clients) => {
                if let Some(responder) = sup.pending_lists.pop_front() {
                    // `Err` just means the caller already timed out and walked
                    // away — its fallback answer is already on its way back.
                    let _ = responder.send(clients);
                }
            }
            Err(e) => warn!("Registry sent an undecodable client list: {e}"),
        },
        MSG_EVENT => match serde_json::from_slice::<BroadcastEnvelope>(&frame.payload) {
            Ok(envelope) => {
                debug!(
                    "Registry event {} from {}",
                    envelope.method, envelope.origin_client_id
                );
                // Hand it to the worker's own notification channel — the last
                // hop to this worker's client. A closed channel means the client
                // is already gone; the event is simply not needed.
                let _ = sup
                    .notification_tx
                    .send(JsonRpcNotification::new(envelope.method, envelope.params));
            }
            Err(e) => warn!("Registry sent an undecodable event: {e}"),
        },
        // `MSG_ACK` needs no action — `register` is fire-and-forget by design.
        // Unknown types are ignored: this worker may be older or newer than the
        // registry it found, which is normal across a binary swap.
        _ => {}
    }
}

/// Write a JSON-payload frame.
async fn send_json<T: serde::Serialize>(
    writer: &mut BoxedWriter,
    msg_type: u8,
    value: &T,
) -> std::io::Result<()> {
    let payload = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    write_frame_async(writer, msg_type, &payload).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(client_id: &str) -> ClientRecord {
        ClientRecord {
            client_id: client_id.into(),
            client: "termihub-desktop".into(),
            client_version: "1.0.0".into(),
            connected_since: "2026-07-17T10:00:00+00:00".into(),
            pid: std::process::id(),
        }
    }

    fn supervisor() -> (Supervisor, mpsc::UnboundedReceiver<JsonRpcNotification>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Supervisor {
                desired: None,
                pending_lists: VecDeque::new(),
                notification_tx: tx,
            },
            rx,
        )
    }

    /// A broadcast from another worker must arrive on this worker's own
    /// notification channel — that hop is what makes the registry a real
    /// cross-worker notification path rather than just a directory.
    #[test]
    fn an_event_is_delivered_to_this_workers_notification_channel() {
        let (mut sup, mut rx) = supervisor();
        let envelope = BroadcastEnvelope {
            origin_client_id: "other".into(),
            method: "agent.update_pending".into(),
            params: serde_json::json!({"version": "2.0.0"}),
        };

        handle_frame(
            &mut sup,
            crate::daemon::protocol::Frame {
                msg_type: MSG_EVENT,
                payload: serde_json::to_vec(&envelope).unwrap(),
            },
        );

        let notification = rx.try_recv().expect("notification forwarded");
        assert_eq!(notification.method, "agent.update_pending");
        assert_eq!(notification.params, serde_json::json!({"version": "2.0.0"}));
        assert_eq!(notification.jsonrpc, "2.0");
    }

    #[test]
    fn client_lists_are_matched_to_waiters_in_order() {
        let (mut sup, _rx) = supervisor();
        let (tx1, rx1) = oneshot::channel();
        let (tx2, rx2) = oneshot::channel();
        sup.pending_lists.push_back(tx1);
        sup.pending_lists.push_back(tx2);

        for ids in [vec![record("a")], vec![record("b")]] {
            handle_frame(
                &mut sup,
                crate::daemon::protocol::Frame {
                    msg_type: MSG_CLIENTS,
                    payload: serde_json::to_vec(&ids).unwrap(),
                },
            );
        }

        assert_eq!(rx1.blocking_recv().unwrap(), vec![record("a")]);
        assert_eq!(rx2.blocking_recv().unwrap(), vec![record("b")]);
    }

    /// The registration must be remembered, not just sent — a reconnect replays
    /// it, and that replay is the entire "survives a registry restart" story.
    #[tokio::test]
    async fn register_is_remembered_for_replay_and_deregister_forgets_it() {
        let (mut sup, _rx) = supervisor();
        let mut sink: BoxedWriter = Box::new(tokio::io::sink());

        handle_command(
            &mut sup,
            &mut sink,
            Command::Register(Box::new(record("a"))),
        )
        .await
        .expect("register");
        assert_eq!(sup.desired, Some(record("a")));

        handle_command(&mut sup, &mut sink, Command::Deregister)
            .await
            .expect("deregister");
        assert_eq!(sup.desired, None, "a withdrawn client must not be replayed");
    }

    /// With no registry reachable and no spawning allowed, `list` must return
    /// `None` — the signal that tells `agent.list_connections` to fall back to
    /// its per-process view instead of reporting an empty host.
    #[tokio::test]
    async fn list_returns_none_when_the_registry_never_answers() {
        let client = RegistryClient::start(
            RegistryConfig {
                endpoint: crate::daemon::transport::session_endpoint("nonexistent-registry-probe"),
                auto_spawn: false,
            },
            mpsc::unbounded_channel().0,
            CancellationToken::new(),
        );

        assert_eq!(client.list().await, None);
    }

    /// The single-client opt-out (#2480): a truthy [`SKIP_REGISTRY_DAEMON_ENV`]
    /// value disables the spawn, everything else leaves it enabled — so an unset
    /// env (production) is byte-identical to the pre-flag default.
    #[test]
    fn skip_from_env_only_trips_on_truthy_values() {
        for truthy in ["1", "true", "yes"] {
            assert!(
                skip_from_env(Some(truthy)),
                "{truthy:?} should suppress the registry-daemon spawn"
            );
        }
        for falsy in [
            None,
            Some(""),
            Some("0"),
            Some("false"),
            Some("no"),
            Some("on"),
        ] {
            assert!(
                !skip_from_env(falsy),
                "{falsy:?} must not suppress the spawn (production default is unset)"
            );
        }
    }

    /// With the skip env unset, [`RegistryConfig::default`] must keep
    /// `auto_spawn` on — the production path is unchanged by the new flag.
    #[test]
    fn default_config_keeps_auto_spawn_on_without_the_skip_env() {
        // This test process does not set the env var, so the default must spawn.
        assert!(
            RegistryConfig::default().auto_spawn,
            "production default (env unset) must still auto-spawn the registry"
        );
    }

    #[test]
    fn unknown_frames_from_a_skewed_registry_are_ignored() {
        let (mut sup, mut rx) = supervisor();
        handle_frame(
            &mut sup,
            crate::daemon::protocol::Frame {
                msg_type: 0xEE,
                payload: b"from a newer registry".to_vec(),
            },
        );
        assert!(rx.try_recv().is_err());
    }
}

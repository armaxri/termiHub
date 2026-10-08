//! [`SandboxedPlugin`]: the host's handle on one running
//! `termihub-plugin-runner` (#4182).
//!
//! Spawn → handshake (bounded by deadlines) → a reader thread that demultiplexes
//! runner frames onto sessions. The runner is an **untrusted peer**: every
//! frame is validated (length cap and known kind in the codec; direction, known
//! session id, log bounds here), and any violation kills the runner. Its
//! sessions then report not-alive; the host and every other plugin keep running.
//!
//! Each runner also gets a watchdog (#4184, [`super::watchdog`]) for hangs and
//! memory, and its stderr is forwarded through the host so an allocation
//! failure under `RLIMIT_AS` is recognised as out of memory.

#[cfg(unix)]
use std::io::Write;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use termihub_plugin_api::PluginError;
use termihub_plugin_runner::ipc::{Configure, FrameReader, Message, SandboxReport, Sender};
#[cfg(unix)]
use termihub_plugin_runner::ipc::{ProtocolError, PROTOCOL_VERSION};
#[cfg(unix)]
use termihub_plugin_runner::loader::check_library_abi;
use termihub_plugin_runner::loader::LoadedPluginInfo;

use crate::connection::OutputSender;
use crate::plugin::log_rate_limit::PluginLogLimiter;
use crate::plugin::HostError;

use super::bridge::{BridgeDenial, BridgeGrant};
use super::exit::RunnerExitCause;
use super::handle::PluginRunnerConfig;
use super::peer::{ExitHook, Reply, SessionSlot, Shared};
use super::spawn::{spawn_runner, Spawned};
use super::writer::ChannelWriter;

/// How long the runner may take to say `Hello` after spawn.
#[cfg(unix)]
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the runner may take to load the plugin (digest, `dlopen`, init).
#[cfg(unix)]
const LOAD_TIMEOUT: Duration = Duration::from_secs(15);
/// Deadline for a `Close` reply (the concept's 2 s close budget).
pub(super) const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
/// Deadline for a `CreateSession` reply. Generous: a plugin's
/// `create_backend` may legitimately connect to a device or a server first.
pub(super) const CREATE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a write to a stalled runner may block before it is killed.
#[cfg(unix)]
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the runner gets to exit after `Shutdown` before it is killed.
pub(super) const EXIT_TIMEOUT: Duration = Duration::from_secs(2);
/// A running plugin runner, after a successful handshake.
pub struct SandboxedPlugin {
    info: LoadedPluginInfo,
    sandbox: SandboxReport,
    writer: Arc<ChannelWriter>,
    shared: Arc<Shared>,
}

impl std::fmt::Debug for SandboxedPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SandboxedPlugin")
            .field("info", &self.info)
            .field("alive", &self.is_alive())
            .finish_non_exhaustive()
    }
}

impl SandboxedPlugin {
    /// No runner transport on this platform yet (Windows: next slice of #4182).
    #[cfg(not(unix))]
    pub(super) fn spawn(
        config: &PluginRunnerConfig,
        _configure: &Configure,
        _log_limiter: Arc<PluginLogLimiter>,
    ) -> Result<Arc<Self>, HostError> {
        let Spawned { mut child } = spawn_runner(&config.runner_path)?;
        let _ = child.kill();
        let _ = child.wait();
        Err(HostError::RunnerUnavailable {
            path: config.runner_path.clone(),
            detail: "no runner transport on this platform".to_owned(),
        })
    }

    /// Spawn `runner`, hand it `configure`, and wait (bounded) until the plugin
    /// is loaded. The runner's report is re-checked against this host's ABI and
    /// the manifest mirror (untrusted peer). Any failure kills the runner.
    #[cfg(unix)]
    pub(super) fn spawn(
        config: &PluginRunnerConfig,
        configure: &Configure,
        log_limiter: Arc<PluginLogLimiter>,
    ) -> Result<Arc<Self>, HostError> {
        let Spawned { mut child, stream } = spawn_runner(&config.runner_path)?;
        let stderr = child.stderr.take();
        let shared = Shared::new(configure.plugin_id.clone(), Some(child), log_limiter);
        if let Some(stderr) = stderr {
            shared.expect_stderr();
            let forwarder = Arc::clone(&shared);
            let spawned = std::thread::Builder::new()
                .name(format!("plugin-runner-stderr-{}", configure.plugin_id))
                .spawn(move || forwarder.forward_stderr(stderr));
            if spawned.is_err() {
                shared.kill();
                return Err(HostError::RunnerProtocol("stderr thread".to_owned()));
            }
        }
        match handshake(&stream, configure) {
            Ok((info, sandbox)) => {
                let _ = stream.set_read_timeout(None);
                let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
                let reader = stream
                    .try_clone()
                    .map_err(|e| HostError::RunnerProtocol(format!("clone channel: {e}")))
                    .inspect_err(|_| shared.kill())?;
                let writer = ChannelWriter::unix(stream)
                    .map(Arc::new)
                    .map_err(|e| HostError::RunnerProtocol(format!("clone channel: {e}")))
                    .inspect_err(|_| shared.kill())?;
                // The bridge service answers requests from the reader thread on,
                // so it is wired up before that thread starts.
                shared.bridge.attach(
                    Arc::clone(&writer),
                    info.abi_version,
                    Arc::downgrade(&shared),
                );
                let reader_shared = Arc::clone(&shared);
                std::thread::Builder::new()
                    .name(format!("plugin-runner-{}", configure.plugin_id))
                    .spawn(move || reader_shared.read_loop(reader))
                    .map_err(|e| HostError::RunnerProtocol(format!("reader thread: {e}")))
                    .inspect_err(|_| shared.kill())?;
                let plugin = Arc::new(Self {
                    info,
                    sandbox,
                    writer,
                    shared,
                });
                super::watchdog::spawn(
                    Arc::downgrade(&plugin),
                    config.watchdog,
                    configure.limits.address_space_bytes,
                    &configure.plugin_id,
                );
                Ok(plugin)
            }
            Err(err) => {
                shared.kill();
                Err(err)
            }
        }
    }

    /// Metadata the plugin reported at load (re-validated by the host).
    #[must_use]
    pub fn info(&self) -> &LoadedPluginInfo {
        &self.info
    }

    /// What OS confinement the runner reported before it loaded the plugin
    /// (#4186): the enforced layers, or empty when none was requested or this
    /// platform has none yet.
    #[must_use]
    pub fn sandbox_report(&self) -> &SandboxReport {
        &self.sandbox
    }

    /// Why the runner ended, once it did (or while the host is ending it).
    #[must_use]
    pub fn exit_cause(&self) -> Option<RunnerExitCause> {
        self.shared.exit_cause()
    }

    /// Install the hook that receives the final exit cause (runs at once if
    /// the runner already ended).
    pub(super) fn set_exit_hook(&self, hook: ExitHook) {
        self.shared.set_exit_hook(hook);
    }

    /// The peer state (watchdog).
    pub(super) fn shared(&self) -> &Shared {
        &self.shared
    }

    /// Kill the runner for `cause` (a missed call deadline, …).
    pub(super) fn kill_for(&self, cause: RunnerExitCause) {
        self.shared.kill_for(cause);
    }

    /// Count a request with its own deadline as in flight until the guard
    /// drops: the hang verdict waits for it.
    pub(super) fn call_in_flight(&self) -> CallGuard<'_> {
        self.shared.calls_in_flight.fetch_add(1, Ordering::SeqCst);
        CallGuard(&self.shared)
    }

    /// Whether the runner is still running and talking.
    #[must_use]
    pub fn is_alive(&self) -> bool {
        !self.shared.dead.load(Ordering::SeqCst)
    }

    /// The runner's process id, while it runs (diagnostics and tests).
    #[must_use]
    pub fn pid(&self) -> Option<u32> {
        self.shared
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(Child::id)
    }

    /// Number of open sessions.
    #[must_use]
    pub fn session_count(&self) -> usize {
        self.shared
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    /// When the plugin last became session-free, if it is session-free now.
    pub(super) fn idle_since(&self) -> Option<Instant> {
        *self
            .shared
            .idle_since
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// Send one encoded message. A failed write (the runner is stalled past
    /// [`WRITE_TIMEOUT`] or gone) kills the runner.
    pub(super) fn send(&self, message: &Message) -> Result<(), PluginError> {
        let frame = message
            .encode()
            .map_err(|e| PluginError::Other(e.to_string()))?;
        self.send_encoded(&frame)
    }

    /// Send one already-encoded frame (the `Input` hot path).
    pub(super) fn send_encoded(&self, frame: &[u8]) -> Result<(), PluginError> {
        if !self.is_alive() {
            return Err(PluginError::NotAlive);
        }
        self.writer.write_frame(frame).map_err(|e| {
            if matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) {
                // Stalled past the write timeout: it stopped reading.
                self.shared.kill_for(RunnerExitCause::NotResponding);
            } else {
                // The channel broke: the runner is gone or going. Its reader
                // thread classifies the exit; make sure it does end.
                self.shared.kill();
            }
            PluginError::NotAlive
        })
    }

    /// Register a new session slot and return its id plus the reply receiver.
    pub(super) fn register_session(
        &self,
        output: Arc<Mutex<Option<OutputSender>>>,
        alive: Arc<AtomicBool>,
    ) -> (u32, Receiver<Reply>) {
        let id = self.shared.next_session.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = sync_channel(1);
        let mut sessions = self
            .shared
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        sessions.insert(
            id,
            SessionSlot {
                output,
                alive,
                reply: Some(tx),
            },
        );
        *self
            .shared
            .idle_since
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        (id, rx)
    }

    /// Serve session `id`'s capability bridge with `grant` (#4183). Called
    /// before `CreateSession`, since a plugin may use the bridge from inside
    /// `create_backend`.
    pub(super) fn grant_bridge(&self, id: u32, grant: BridgeGrant) {
        self.shared.bridge.open_session(id, grant);
    }

    /// The capability-bridge requests this runner's plugin was refused (oldest
    /// first, bounded) — what the UI phase turns into toasts.
    #[must_use]
    pub fn bridge_denials(&self) -> Vec<BridgeDenial> {
        self.shared.bridge.denials()
    }

    /// Bridge connections currently handed to the plugin.
    #[must_use]
    pub fn bridge_connections(&self) -> usize {
        self.shared.bridge.open_connections()
    }

    /// Relay every new bridge connection through the host (`StreamData`)
    /// instead of passing the socket — the fallback path, forced for tests.
    #[doc(hidden)]
    pub fn force_stream_proxy(&self, on: bool) {
        self.shared.bridge.set_force_proxy(on);
    }

    /// Arm a reply waiter on an existing session (for `Close`).
    pub(super) fn expect_reply(&self, id: u32) -> Option<Receiver<Reply>> {
        let mut sessions = self
            .shared
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let slot = sessions.get_mut(&id)?;
        let (tx, rx) = sync_channel(1);
        slot.reply = Some(tx);
        Some(rx)
    }

    /// Forget a session (closed, failed or timed out). Late frames for it are
    /// ignored from now on.
    pub(super) fn retire_session(&self, id: u32) {
        self.shared.retire(id);
    }

    /// Wind the runner down within bounded time: cancel everything, `Close`
    /// every session, `Shutdown`, then kill whatever is still running. The
    /// host never waits on a plugin without a deadline.
    pub fn shutdown(&self) {
        // Whatever happens from here on is the host's doing, not a crash
        // (unless the runner already ended with a recorded cause).
        self.shared.set_pending_cause(RunnerExitCause::Stopped);
        if self.is_alive() {
            let _ = self.send(&Message::Cancel(termihub_plugin_runner::ipc::Cancel {
                session_id: None,
            }));
            let ids: Vec<u32> = self
                .shared
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .keys()
                .copied()
                .collect();
            let deadline = Instant::now() + REQUEST_TIMEOUT;
            let waits: Vec<_> = ids
                .into_iter()
                .filter_map(|id| {
                    let rx = self.expect_reply(id)?;
                    self.send(&Message::Close(termihub_plugin_runner::ipc::SessionRef {
                        session_id: id,
                    }))
                    .ok()?;
                    Some(rx)
                })
                .collect();
            for rx in waits {
                let left = deadline.saturating_duration_since(Instant::now());
                let _ = rx.recv_timeout(left);
            }
            let _ = self.send(&Message::Shutdown);
        }
        self.shared.reap(EXIT_TIMEOUT);
    }
}

impl Drop for SandboxedPlugin {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Marks a request with its own deadline as in flight (see
/// [`SandboxedPlugin::call_in_flight`]).
pub(super) struct CallGuard<'a>(&'a Shared);

impl Drop for CallGuard<'_> {
    fn drop(&mut self) {
        self.0.calls_in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Run the startup sequence on the calling thread, bounded by deadlines.
#[cfg(unix)]
fn handshake(
    stream: &std::os::unix::net::UnixStream,
    configure: &Configure,
) -> Result<(LoadedPluginInfo, SandboxReport), HostError> {
    let protocol = |what: &str| HostError::RunnerProtocol(what.to_owned());
    let mut frames = FrameReader::new(stream);
    let mut next = |timeout: Duration, waiting_for: &str| -> Result<Message, HostError> {
        // macOS refuses socket options once the peer is gone (EINVAL), so a
        // runner that already exited can fail here rather than at the read.
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|e| protocol(&format!("waiting for {waiting_for}: {e}")))?;
        match frames.read_frame() {
            Ok(Some(frame)) => Message::decode_from_peer(frame, Sender::Host)
                .map_err(|e| protocol(&format!("waiting for {waiting_for}: {e}"))),
            Ok(None) => Err(protocol(&format!(
                "the runner exited while the host was waiting for {waiting_for}"
            ))),
            Err(ProtocolError::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                Err(protocol(&format!("timed out waiting for {waiting_for}")))
            }
            Err(e) => Err(protocol(&format!("waiting for {waiting_for}: {e}"))),
        }
    };

    match next(HELLO_TIMEOUT, "Hello")? {
        Message::Hello(hello) if hello.protocol_version == PROTOCOL_VERSION => {}
        Message::Hello(hello) => {
            return Err(protocol(&format!(
                "runner speaks protocol {}, the host speaks {PROTOCOL_VERSION}",
                hello.protocol_version
            )))
        }
        other => return Err(protocol(&format!("expected Hello, got {:?}", other.kind()))),
    }
    let frame = Message::Configure(configure.clone())
        .encode()
        .map_err(|e| protocol(&e.to_string()))?;
    let mut writer = stream;
    writer
        .write_all(&frame)
        .map_err(|e| protocol(&format!("sending Configure: {e}")))?;
    let sandbox = match next(LOAD_TIMEOUT, "SandboxReport")? {
        // A requested sandbox must be in force before the plugin is mapped;
        // the caller kills the runner on `Err`, so it never loads (#4186).
        Message::SandboxReport(report) => {
            if configure.sandbox.is_some() {
                super::policy::check_report(&report, configure.accept_reduced_isolation)?;
            }
            report
        }
        other => {
            return Err(protocol(&format!(
                "expected SandboxReport, got {:?}",
                other.kind()
            )))
        }
    };
    match next(LOAD_TIMEOUT, "Loaded")? {
        Message::Loaded(loaded) => {
            let info = loaded.into_info();
            // Re-apply the ABI gate + manifest mirror host-side: the runner ran
            // them, but the host does not take an untrusted peer's word for it.
            check_library_abi(
                info.abi_version,
                termihub_plugin_api::CURRENT_PLUGIN_ABI_VERSION,
                configure.manifest_api_version.as_deref(),
            )?;
            Ok((info, sandbox))
        }
        Message::LoadFailed(failed) => Err(HostError::RunnerLoad {
            incompatible: failed.incompatible,
            message: failed.message,
        }),
        other => Err(protocol(&format!(
            "expected Loaded, got {:?}",
            other.kind()
        ))),
    }
}

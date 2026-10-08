//! The runner process: handshake, load, then serve sessions until `Shutdown`
//! or end of stream.
//!
//! ```text
//! runner → host  Hello
//! host → runner  Configure
//! runner         pin the library     (digest through a held handle, CORE-034)
//! runner         resource limits     (setrlimit, #4184)
//! runner         OS sandbox          (Configure.sandbox: Seatbelt on macOS, #4186;
//!                                     landlock + seccomp on Linux, #4185)
//! runner → host  SandboxReport      (then exit if the sandbox setup failed)
//! runner         dlopen + gates      (ABI gate, init, toolchain)
//! runner → host  Loaded | LoadFailed (then exit)
//! ...            CreateSession / Input / Resize / Close / Cancel / Ping
//! runner ⇄ host  BridgeRequest / BridgeReply, Stream* (any time, any thread)
//! host → runner  Shutdown            (or EOF: the host is gone)
//! ```
//!
//! The plugin sees the unchanged synchronous ABI: every `Input` / `Resize`
//! becomes a direct `write_input` / `resize` call, and its output callback
//! writes `Output` frames from whatever thread the plugin calls it on.
//!
//! After the handshake a dedicated **reader thread** owns the channel's read
//! half. It answers bridge traffic itself (a `BridgeReply` wakes the plugin
//! thread blocked in the bridge call, `Stream*` frames feed proxied
//! connections) and queues every other frame for the main loop. A plugin may
//! therefore call the bridge from inside `create_backend` or `write_input`
//! — on the main loop's own thread — without deadlocking it (#4183).

mod bridge;
mod channel;
mod confine;
mod limits;
mod shim;

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use termihub_plugin_api::{LoadedBackend, PluginError, PluginHostContext, ABI_1_1};
use termihub_plugin_runner::ipc::{
    Alive, Configure, CreateSession, FrameReader, Heartbeat, Hello, LoadFailed, Loaded, Message,
    Resize, SandboxReport, Sender, SessionError, SessionFailed, SessionRef, WireError,
    MAX_PAYLOAD_LEN, PROTOCOL_VERSION, SESSION_ID_LEN,
};
use termihub_plugin_runner::loader::{
    prepare_plugin_library, BackendLoadOptions, PluginLibrary, PreparedLibrary,
};

use bridge::BridgeClient;
pub(crate) use channel::Channel;
use shim::{SessionOutput, SessionServices};
#[cfg(unix)]
use termihub_plugin_runner::ipc::fd::FdQueue;

/// Largest plugin output chunk carried in one `Output` frame.
pub(crate) const MAX_OUTPUT_CHUNK: usize = MAX_PAYLOAD_LEN - SESSION_ID_LEN;

/// Read buffer of the runner's frame reader.
const READ_BUFFER: usize = 64 * 1024;

/// How often session liveness is re-polled to push `Alive` changes.
const ALIVE_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Process exit codes (documented for the host's diagnostics).
pub(crate) mod exit {
    /// Clean shutdown, or the host closed the channel.
    pub const OK: i32 = 0;
    /// The host violated the protocol (or the channel failed mid-frame).
    pub const PROTOCOL: i32 = 2;
    /// The plugin failed to load; `LoadFailed` was sent first.
    pub const LOAD_FAILED: i32 = 3;
    /// The OS sandbox could not be applied; a failed `SandboxReport` was sent
    /// first and the plugin was never loaded.
    pub const SANDBOX_FAILED: i32 = 4;
    /// Bad command line (wrong protocol version, missing flag).
    pub const USAGE: i32 = 64;
}

/// One live plugin session.
struct Session {
    backend: LoadedBackend,
    output: Arc<SessionOutput>,
    services: Option<Arc<SessionServices>>,
    alive: bool,
}

type Sessions = Arc<Mutex<HashMap<u32, Session>>>;

/// Descriptors the host passes along with frames (Unix handle passing).
#[cfg(unix)]
pub(crate) type PassedFds = Option<FdQueue>;
/// No handle passing over the Windows pipe yet (#4219): every bridge
/// connection is proxied.
#[cfg(not(unix))]
pub(crate) type PassedFds = ();

/// Run the runner over a connected channel; returns the process exit code.
/// `fds` receives the sockets the host passes with bridge replies.
pub(crate) fn run<R: Read + Send + 'static>(
    reader: R,
    channel: Arc<Channel>,
    #[cfg_attr(
        not(unix),
        allow(unused_variables, reason = "no handle passing on Windows yet (#4219)")
    )]
    fds: PassedFds,
) -> i32 {
    // Buffered: a frame is three reads (length, kind, payload); the buffer
    // turns a burst of small frames into one syscall.
    let mut frames = FrameReader::new(std::io::BufReader::with_capacity(READ_BUFFER, reader));
    let hello = Message::Hello(Hello {
        runner_version: env!("CARGO_PKG_VERSION").to_owned(),
        protocol_version: PROTOCOL_VERSION,
        pid: std::process::id(),
    });
    if channel.send(&hello).is_err() {
        return exit::PROTOCOL;
    }
    let configure = match next_message(&mut frames) {
        Ok(Some(Message::Configure(configure))) => configure,
        // EOF before configuring: the host gave up on us.
        Ok(None) => return exit::OK,
        Ok(Some(_)) | Err(()) => return exit::PROTOCOL,
    };
    // Pin the library first (its bytes are verified through a handle the
    // sandbox cannot take away), then bind the resource limits (#4184), then
    // confine this process (#4186) — all before any plugin code is mapped. A
    // pin failure is reported after the sandbox report, as the protocol orders.
    let prepared = prepare(&configure);
    for (limit, error) in limits::apply(&configure.limits) {
        eprintln!("termihub-plugin-runner: could not apply {limit}: {error}");
    }
    let report = match &configure.sandbox {
        Some(policy) => confine::apply(policy),
        None => SandboxReport::default(),
    };
    let sandbox_failed = report.failed.is_some();
    if channel.send(&Message::SandboxReport(report)).is_err() {
        return exit::PROTOCOL;
    }
    if sandbox_failed {
        // Never fall back to loading the plugin unconfined.
        return exit::SANDBOX_FAILED;
    }
    // Report the confined plugin's refused system calls from its first
    // instruction on (`plugin_init` included).
    #[cfg(target_os = "linux")]
    if configure.sandbox.is_some() {
        confine::spawn_denial_reporter(Arc::clone(&channel));
    }
    let library = match prepared.and_then(|p| {
        p.load().map_err(|e| LoadFailed {
            incompatible: e.is_incompatible(),
            message: e.to_string(),
        })
    }) {
        Ok(library) => library,
        Err(failed) => {
            let _ = channel.send(&Message::LoadFailed(failed));
            return exit::LOAD_FAILED;
        }
    };
    if channel
        .send(&Message::Loaded(Loaded::from_info(library.info())))
        .is_err()
    {
        return exit::PROTOCOL;
    }
    #[cfg(unix)]
    let bridge = BridgeClient::new(Arc::clone(&channel), fds);
    #[cfg(not(unix))]
    let bridge = BridgeClient::new(Arc::clone(&channel));
    let host_frames = spawn_reader(frames, Arc::clone(&bridge));
    let server = Server::new(library, configure, Arc::clone(&channel), bridge);
    server.serve(&host_frames)
}

/// What the reader thread hands the main loop.
#[allow(
    clippy::large_enum_variant,
    reason = "one value per host frame, moved once; boxing would allocate per Input frame"
)]
enum Inbound {
    /// A host frame for the main loop.
    Message(Message),
    /// The host closed the channel.
    Eof,
    /// A protocol violation or transport failure.
    Violation,
}

/// Start the reader thread: bridge traffic is answered in place, everything
/// else is queued for the main loop. The queue is unbounded so the reader can
/// always reach the next `BridgeReply`, even while the main loop is blocked
/// inside a plugin call that waits on it; host input is bounded upstream by the
/// host's write deadline on a stalled runner.
fn spawn_reader<R: Read + Send + 'static>(
    mut frames: FrameReader<std::io::BufReader<R>>,
    bridge: Arc<BridgeClient>,
) -> Receiver<Inbound> {
    let (tx, rx) = channel();
    let spawned = std::thread::Builder::new()
        .name("plugin-runner-reader".to_owned())
        .spawn(move || {
            let end = loop {
                match next_message(&mut frames) {
                    Ok(Some(Message::BridgeReply(reply))) => bridge.on_reply(reply),
                    Ok(Some(Message::StreamData(chunk))) => bridge.on_stream_data(chunk),
                    Ok(Some(Message::StreamClosed(conn))) => bridge.on_stream_closed(conn),
                    Ok(Some(Message::StreamWriteAck(ack))) => bridge.on_write_ack(ack),
                    Ok(Some(message)) => {
                        if tx.send(Inbound::Message(message)).is_err() {
                            break None;
                        }
                    }
                    Ok(None) => break Some(Inbound::Eof),
                    Err(()) => break Some(Inbound::Violation),
                }
            };
            bridge.fail_all();
            if let Some(end) = end {
                let _ = tx.send(end);
            }
        });
    if spawned.is_err() {
        // No reader: report a transport failure so the runner winds down.
        let (tx, rx) = channel();
        let _ = tx.send(Inbound::Violation);
        return rx;
    }
    rx
}

/// Read the next valid host frame: `Ok(None)` on a clean end of stream,
/// `Err(())` on any violation or transport failure.
fn next_message<R: Read>(frames: &mut FrameReader<R>) -> Result<Option<Message>, ()> {
    match frames.read_frame() {
        Ok(Some(frame)) => Message::decode_from_peer(frame, Sender::Runner)
            .map(Some)
            .map_err(|_| ()),
        Ok(None) => Ok(None),
        Err(_) => Err(()),
    }
}

/// Pin and verify the plugin library (no plugin code runs yet).
fn prepare(configure: &Configure) -> Result<PreparedLibrary, LoadFailed> {
    let options = BackendLoadOptions {
        expected_digest: configure.expected_digest.as_deref(),
        manifest_api_version: configure.manifest_api_version.as_deref(),
        accept_unverified_toolchain: configure.accept_unverified_toolchain,
    };
    let path = confine::library_path(configure);
    prepare_plugin_library(&path, &options).map_err(|e| LoadFailed {
        incompatible: e.is_incompatible(),
        message: e.to_string(),
    })
}

/// The session server: owns the loaded library and every live session.
struct Server {
    configure: Configure,
    channel: Arc<Channel>,
    bridge: Arc<BridgeClient>,
    sessions: Sessions,
    /// Plugin-wide cancellation (a `Cancel` without a session, or shutdown).
    plugin_shutdown: Arc<AtomicBool>,
    /// Declared last: dropped after every session (`plugin_shutdown`, unmap).
    library: PluginLibrary,
}

impl Server {
    fn new(
        library: PluginLibrary,
        configure: Configure,
        channel: Arc<Channel>,
        bridge: Arc<BridgeClient>,
    ) -> Self {
        Self {
            configure,
            channel,
            bridge,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            plugin_shutdown: Arc::new(AtomicBool::new(false)),
            library,
        }
    }

    fn serve(self, frames: &Receiver<Inbound>) -> i32 {
        let stop = Arc::new(AtomicBool::new(false));
        let poller = spawn_alive_poller(
            Arc::clone(&self.sessions),
            Arc::clone(&self.channel),
            Arc::clone(&stop),
        );
        let code = loop {
            let message = match frames.recv() {
                Ok(Inbound::Message(message)) => message,
                // The host closed the channel (or died): wind down.
                Ok(Inbound::Eof) | Err(_) => break exit::OK,
                Ok(Inbound::Violation) => break exit::PROTOCOL,
            };
            if !self.handle(message) {
                break exit::OK;
            }
        };
        stop.store(true, Ordering::SeqCst);
        let _ = poller.join();
        self.teardown();
        code
    }

    /// Handle one host message; `false` ends the loop (`Shutdown`).
    fn handle(&self, message: Message) -> bool {
        match message {
            Message::CreateSession(create) => self.create_session(create),
            Message::Input { session_id, data } => self.with_session(session_id, |s| {
                let result = s.backend.write_input(&data);
                ("write_input", result)
            }),
            Message::Resize(Resize {
                session_id,
                cols,
                rows,
            }) => self.with_session(session_id, |s| ("resize", s.backend.resize(cols, rows))),
            Message::Close(SessionRef { session_id }) => self.close_session(session_id),
            Message::Cancel(cancel) => match cancel.session_id {
                Some(id) => {
                    let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(services) = sessions.get(&id).and_then(|s| s.services.as_ref()) {
                        services.cancel();
                    }
                }
                None => self.plugin_shutdown.store(true, Ordering::SeqCst),
            },
            // Answered here, on the thread that runs every plugin call, not on
            // the reader thread: a plugin stuck in a call must stop the pongs
            // so the host's hang watchdog sees it (#4184).
            Message::Ping(Heartbeat { nonce }) => {
                let _ = self.channel.send(&Message::Pong(Heartbeat { nonce }));
            }
            Message::Shutdown => return false,
            // `decode_from_peer` already refused every runner-sent kind,
            // `Configure` is only valid once, during the handshake, and the
            // reader thread consumed the bridge kinds.
            _ => {}
        }
        true
    }

    fn create_session(&self, create: CreateSession) {
        let CreateSession {
            session_id,
            config_json,
            settings_json,
            data_dir,
            connect_deadline_ms,
        } = create;
        let output = SessionOutput::new(session_id, Arc::clone(&self.channel));
        let sender = shim::output_sender(&output);
        let connect_deadline = if connect_deadline_ms == 0 {
            bridge::DEFAULT_CONNECT_DEADLINE
        } else {
            Duration::from_millis(connect_deadline_ms)
        };
        let bridge = bridge::session_bridge(session_id, &self.bridge, connect_deadline);
        let (result, services) = if self.library.supports(ABI_1_1) {
            let state = SessionServices::new(
                session_id,
                Arc::clone(&self.channel),
                Arc::clone(&self.plugin_shutdown),
            );
            let handle = SessionServices::handle(&state);
            let context = PluginHostContext::new(&self.configure.host_version, &data_dir, &handle);
            let result = self.library.create_backend_with_context(
                &config_json,
                &settings_json,
                sender,
                bridge,
                Some(&context),
            );
            drop(handle);
            (result, Some(state))
        } else {
            let result = self.library.create_backend_with_context(
                &config_json,
                &settings_json,
                sender,
                bridge,
                None,
            );
            (result, None)
        };
        match result {
            Ok(backend) => {
                let alive = backend.is_alive();
                self.sessions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(
                        session_id,
                        Session {
                            backend,
                            output,
                            services,
                            alive,
                        },
                    );
                let _ = self
                    .channel
                    .send(&Message::SessionCreated(SessionRef { session_id }));
                if !alive {
                    let _ = self.channel.send(&Message::Alive(Alive {
                        session_id,
                        alive: false,
                    }));
                }
            }
            Err(error) => {
                output.mark_closed();
                let _ = self.channel.send(&Message::SessionFailed(SessionFailed {
                    session_id,
                    error: WireError::from_error(&error),
                }));
            }
        }
    }

    /// Run a queued operation on a session, reporting a failure as a
    /// `SessionError`. An unknown session (already closed) is ignored.
    fn with_session(
        &self,
        session_id: u32,
        op: impl FnOnce(&Session) -> (&'static str, Result<(), PluginError>),
    ) {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let Some(session) = sessions.get_mut(&session_id) else {
            return;
        };
        let (operation, result) = op(session);
        if let Err(error) = result {
            let _ = self.channel.send(&Message::SessionError(SessionError {
                session_id,
                operation: operation.to_owned(),
                error: WireError::from_error(&error),
            }));
        }
        push_alive_change(&self.channel, session_id, session);
    }

    fn close_session(&self, session_id: u32) {
        let session = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&session_id);
        if let Some(session) = session {
            finish_session(session);
        }
        let _ = self
            .channel
            .send(&Message::Closed(SessionRef { session_id }));
    }

    /// Cancel and close every session, then let the library drop
    /// (`plugin_shutdown`, unmap).
    fn teardown(self) {
        self.plugin_shutdown.store(true, Ordering::SeqCst);
        let sessions: Vec<Session> = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, s)| s)
            .collect();
        for session in sessions {
            finish_session(session);
        }
    }
}

/// Cancel, close and destroy a session; afterwards its output is dropped.
fn finish_session(session: Session) {
    if let Some(services) = &session.services {
        services.cancel();
    }
    let _ = session.backend.close();
    let output = Arc::clone(&session.output);
    drop(session);
    output.mark_closed();
}

/// Push an `Alive` frame when a session's liveness changed since last seen.
fn push_alive_change(channel: &Channel, session_id: u32, session: &mut Session) {
    let alive = session.backend.is_alive();
    if alive != session.alive {
        session.alive = alive;
        let _ = channel.send(&Message::Alive(Alive { session_id, alive }));
    }
}

fn spawn_alive_poller(
    sessions: Sessions,
    channel: Arc<Channel>,
    stop: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(ALIVE_POLL_INTERVAL);
            let mut sessions = sessions.lock().unwrap_or_else(|e| e.into_inner());
            for (id, session) in sessions.iter_mut() {
                push_alive_change(&channel, *id, session);
            }
        }
    })
}

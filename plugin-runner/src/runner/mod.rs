//! The runner process: handshake, load, then serve sessions until `Shutdown`
//! or end of stream.
//!
//! ```text
//! runner → host  Hello
//! host → runner  Configure
//! runner → host  SandboxReport      (phase 1: nothing enforced yet)
//! runner         resource limits     (setrlimit, #4184)
//! runner         load_plugin_library (digest pin, ABI gate, init, toolchain)
//! runner → host  Loaded | LoadFailed (then exit)
//! ...            CreateSession / Input / Resize / Close / Cancel / Ping
//! host → runner  Shutdown            (or EOF: the host is gone)
//! ```
//!
//! The plugin sees the unchanged synchronous ABI: every `Input` / `Resize`
//! becomes a direct `write_input` / `resize` call, and its output callback
//! writes `Output` frames from whatever thread the plugin calls it on.

mod channel;
mod limits;
mod shim;

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use termihub_plugin_api::{LoadedBackend, PluginError, PluginHostContext, ABI_1_1};
use termihub_plugin_runner::ipc::{
    Alive, Configure, CreateSession, FrameReader, Heartbeat, Hello, LoadFailed, Loaded, Message,
    Resize, SandboxReport, Sender, SessionError, SessionFailed, SessionRef, WireError,
    MAX_PAYLOAD_LEN, PROTOCOL_VERSION, SESSION_ID_LEN,
};
use termihub_plugin_runner::loader::{load_plugin_library, BackendLoadOptions, PluginLibrary};

pub(crate) use channel::Channel;
use shim::{SessionOutput, SessionServices};

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
    /// Bad command line (wrong protocol version, missing flag).
    pub const USAGE: i32 = 64;
    /// This platform has no runner transport yet.
    #[cfg_attr(unix, allow(dead_code, reason = "used by the non-Unix stub only"))]
    pub const UNAVAILABLE: i32 = 69;
}

/// One live plugin session.
struct Session {
    backend: LoadedBackend,
    output: Arc<SessionOutput>,
    services: Option<Arc<SessionServices>>,
    alive: bool,
}

type Sessions = Arc<Mutex<HashMap<u32, Session>>>;

/// Run the runner over a connected channel; returns the process exit code.
pub(crate) fn run<R: Read>(reader: R, channel: Arc<Channel>) -> i32 {
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
    // Phase 1: no confinement yet. The per-OS phases apply it here, after the
    // channel is open and before any plugin code is mapped.
    if channel
        .send(&Message::SandboxReport(SandboxReport::default()))
        .is_err()
    {
        return exit::PROTOCOL;
    }
    // Resource limits (#4184) bind the plugin from its first mapped byte.
    for (limit, error) in limits::apply(&configure.limits) {
        eprintln!("termihub-plugin-runner: could not apply {limit}: {error}");
    }
    let library = match load(&configure) {
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
    let server = Server::new(library, configure, Arc::clone(&channel));
    server.serve(&mut frames)
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

fn load(configure: &Configure) -> Result<PluginLibrary, LoadFailed> {
    let options = BackendLoadOptions {
        expected_digest: configure.expected_digest.as_deref(),
        manifest_api_version: configure.manifest_api_version.as_deref(),
        accept_unverified_toolchain: configure.accept_unverified_toolchain,
    };
    load_plugin_library(Path::new(&configure.library_path), &options).map_err(|e| LoadFailed {
        incompatible: e.is_incompatible(),
        message: e.to_string(),
    })
}

/// The session server: owns the loaded library and every live session.
struct Server {
    configure: Configure,
    channel: Arc<Channel>,
    sessions: Sessions,
    /// Plugin-wide cancellation (a `Cancel` without a session, or shutdown).
    plugin_shutdown: Arc<AtomicBool>,
    /// Declared last: dropped after every session (`plugin_shutdown`, unmap).
    library: PluginLibrary,
}

impl Server {
    fn new(library: PluginLibrary, configure: Configure, channel: Arc<Channel>) -> Self {
        Self {
            configure,
            channel,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            plugin_shutdown: Arc::new(AtomicBool::new(false)),
            library,
        }
    }

    fn serve<R: Read>(self, frames: &mut FrameReader<R>) -> i32 {
        let stop = Arc::new(AtomicBool::new(false));
        let poller = spawn_alive_poller(
            Arc::clone(&self.sessions),
            Arc::clone(&self.channel),
            Arc::clone(&stop),
        );
        let code = loop {
            let message = match next_message(frames) {
                Ok(Some(message)) => message,
                // The host closed the channel (or died): wind down.
                Ok(None) => break exit::OK,
                Err(()) => break exit::PROTOCOL,
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
            Message::Ping(Heartbeat { nonce }) => {
                let _ = self.channel.send(&Message::Pong(Heartbeat { nonce }));
            }
            Message::Shutdown => return false,
            // `decode_from_peer` already refused every runner-sent kind, and
            // `Configure` is only valid once, during the handshake.
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
        } = create;
        let output = SessionOutput::new(session_id, Arc::clone(&self.channel));
        let sender = shim::output_sender(&output);
        let bridge = shim::deny_all_bridge();
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

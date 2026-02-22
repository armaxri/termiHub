//! Transport abstraction traits for session I/O and process management.
//!
//! These traits represent the **only difference** between the desktop and agent
//! runtimes:
//!
//! - **Desktop** delivers output via Tauri events and spawns processes with
//!   `portable-pty`.
//! - **Agent** delivers output via JSON-RPC notifications and spawns processes
//!   through a daemon + Unix socket.
//!
//! The core crate defines *what* to do; consumers inject *how* by implementing
//! these traits. All methods are **synchronous** — the agent wraps calls with
//! `tokio::task::spawn_blocking` where needed (matching its existing pattern).
//!
//! Generics over these traits monomorphize at compile time, so there is no
//! dynamic dispatch overhead in hot paths.

use std::collections::HashMap;
use std::path::Path;

use crate::config::PtySize;
use crate::errors::SessionError;
use crate::session::shell::ShellCommand;

/// Output delivery mechanism — consumers inject their transport.
///
/// Desktop implementations emit Tauri events to the webview frontend.
/// Agent implementations send JSON-RPC notification frames over the
/// transport (stdio or TCP).
///
/// All methods take `&self` and are expected to be cheap (buffered I/O or
/// channel send). Implementations must be `Send + 'static` so the output
/// sink can be moved into a background reader thread.
pub trait OutputSink: Send + 'static {
    /// Deliver terminal output bytes to the frontend.
    ///
    /// `data` contains raw PTY output (potentially including ANSI escape
    /// sequences). The consumer is responsible for encoding (e.g., base64
    /// for JSON-RPC) if its transport requires it.
    fn send_output(&self, session_id: &str, data: Vec<u8>) -> Result<(), SessionError>;

    /// Notify the frontend that the session's process has exited.
    ///
    /// `exit_code` is `None` when the exit code could not be determined
    /// (e.g., the process was killed by a signal on Unix).
    fn send_exit(&self, session_id: &str, exit_code: Option<i32>) -> Result<(), SessionError>;

    /// Notify the frontend of a session-level error.
    ///
    /// This is for errors that occur *after* the session has been
    /// established (e.g., a read failure on the PTY). Pre-session errors
    /// are returned directly from the spawn call.
    fn send_error(&self, session_id: &str, message: &str) -> Result<(), SessionError>;
}

/// Process spawning mechanism — consumers inject their PTY/daemon approach.
///
/// Desktop implementations use `portable-pty` for cross-platform PTY
/// management. Agent implementations spawn a daemon process that manages
/// the PTY and communicates over a Unix socket (binary frame protocol).
///
/// The associated `Handle` type allows each spawner to define its own
/// process handle, avoiding trait-object overhead in the common case.
pub trait ProcessSpawner: Send + Sync {
    /// The handle type returned after a successful spawn.
    type Handle: ProcessHandle;

    /// Spawn an interactive shell session.
    ///
    /// `command` is a fully resolved [`ShellCommand`] (program path,
    /// arguments, environment, working directory, PTY dimensions) built
    /// by [`super::shell::build_shell_command()`].
    ///
    /// `pty_size` provides the initial terminal dimensions. `env` contains
    /// additional environment variables to merge. `cwd` is the working
    /// directory, or `None` to use the system default.
    fn spawn_shell(
        &self,
        command: &ShellCommand,
        pty_size: PtySize,
        env: &HashMap<String, String>,
        cwd: Option<&Path>,
    ) -> Result<Self::Handle, SessionError>;

    /// Spawn an arbitrary command (non-interactive).
    ///
    /// Used for one-shot commands (e.g., monitoring probes, file operations)
    /// that still need PTY allocation for proper terminal handling.
    fn spawn_command(
        &self,
        program: &str,
        args: &[String],
        pty_size: PtySize,
        env: &HashMap<String, String>,
    ) -> Result<Self::Handle, SessionError>;
}

/// Handle to a spawned process — abstracts over `portable-pty` vs daemon.
///
/// Provides the minimal interface needed by the session manager to
/// interact with a running process: writing input, resizing the terminal,
/// checking liveness, and closing the session.
///
/// Implementations must be `Send` so the handle can be stored in the
/// session manager and accessed from Tauri command handlers or JSON-RPC
/// dispatch threads.
pub trait ProcessHandle: Send {
    /// Write input bytes to the process's stdin/PTY.
    ///
    /// `data` contains raw bytes (typically UTF-8 text or control
    /// sequences from the frontend's terminal emulator).
    fn write_input(&self, data: &[u8]) -> Result<(), SessionError>;

    /// Resize the process's PTY to the given dimensions.
    ///
    /// Called when the frontend terminal viewport changes size.
    fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError>;

    /// Gracefully close the process.
    ///
    /// Implementations should attempt a clean shutdown (e.g., closing the
    /// PTY master, sending SIGHUP) before forcefully killing the process.
    fn close(&self) -> Result<(), SessionError>;

    /// Check whether the process is still running.
    fn is_alive(&self) -> bool;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    // -- Mock implementations for compile-time trait verification ----------

    type OutputRecord = Vec<(String, Vec<u8>)>;
    type ExitRecord = Vec<(String, Option<i32>)>;
    type ErrorRecord = Vec<(String, String)>;

    /// Records all output sink calls for assertion.
    struct MockOutputSink {
        outputs: Arc<Mutex<OutputRecord>>,
        exits: Arc<Mutex<ExitRecord>>,
        errors: Arc<Mutex<ErrorRecord>>,
    }

    impl MockOutputSink {
        fn new() -> Self {
            Self {
                outputs: Arc::new(Mutex::new(Vec::new())),
                exits: Arc::new(Mutex::new(Vec::new())),
                errors: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl OutputSink for MockOutputSink {
        fn send_output(&self, session_id: &str, data: Vec<u8>) -> Result<(), SessionError> {
            self.outputs
                .lock()
                .unwrap()
                .push((session_id.to_string(), data));
            Ok(())
        }

        fn send_exit(&self, session_id: &str, exit_code: Option<i32>) -> Result<(), SessionError> {
            self.exits
                .lock()
                .unwrap()
                .push((session_id.to_string(), exit_code));
            Ok(())
        }

        fn send_error(&self, session_id: &str, message: &str) -> Result<(), SessionError> {
            self.errors
                .lock()
                .unwrap()
                .push((session_id.to_string(), message.to_string()));
            Ok(())
        }
    }

    /// Minimal process handle mock.
    struct MockProcessHandle {
        alive: Arc<Mutex<bool>>,
    }

    impl ProcessHandle for MockProcessHandle {
        fn write_input(&self, _data: &[u8]) -> Result<(), SessionError> {
            Ok(())
        }

        fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
            Ok(())
        }

        fn close(&self) -> Result<(), SessionError> {
            *self.alive.lock().unwrap() = false;
            Ok(())
        }

        fn is_alive(&self) -> bool {
            *self.alive.lock().unwrap()
        }
    }

    /// Minimal process spawner mock.
    struct MockProcessSpawner;

    impl ProcessSpawner for MockProcessSpawner {
        type Handle = MockProcessHandle;

        fn spawn_shell(
            &self,
            _command: &ShellCommand,
            _pty_size: PtySize,
            _env: &HashMap<String, String>,
            _cwd: Option<&Path>,
        ) -> Result<Self::Handle, SessionError> {
            Ok(MockProcessHandle {
                alive: Arc::new(Mutex::new(true)),
            })
        }

        fn spawn_command(
            &self,
            _program: &str,
            _args: &[String],
            _pty_size: PtySize,
            _env: &HashMap<String, String>,
        ) -> Result<Self::Handle, SessionError> {
            Ok(MockProcessHandle {
                alive: Arc::new(Mutex::new(true)),
            })
        }
    }

    // -- OutputSink tests -------------------------------------------------

    #[test]
    fn output_sink_send_output() {
        let sink = MockOutputSink::new();
        sink.send_output("s1", b"hello".to_vec()).unwrap();
        let outputs = sink.outputs.lock().unwrap();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].0, "s1");
        assert_eq!(outputs[0].1, b"hello");
    }

    #[test]
    fn output_sink_send_exit_with_code() {
        let sink = MockOutputSink::new();
        sink.send_exit("s1", Some(0)).unwrap();
        let exits = sink.exits.lock().unwrap();
        assert_eq!(exits.len(), 1);
        assert_eq!(exits[0], ("s1".to_string(), Some(0)));
    }

    #[test]
    fn output_sink_send_exit_without_code() {
        let sink = MockOutputSink::new();
        sink.send_exit("s1", None).unwrap();
        let exits = sink.exits.lock().unwrap();
        assert_eq!(exits[0].1, None);
    }

    #[test]
    fn output_sink_send_error() {
        let sink = MockOutputSink::new();
        sink.send_error("s1", "read failed").unwrap();
        let errors = sink.errors.lock().unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0], ("s1".to_string(), "read failed".to_string()));
    }

    // -- ProcessSpawner + ProcessHandle tests -----------------------------

    #[test]
    fn process_spawner_spawn_shell() {
        let spawner = MockProcessSpawner;
        let cmd = ShellCommand {
            program: "/bin/bash".into(),
            args: vec!["--login".into()],
            env: HashMap::new(),
            cwd: None,
            cols: 80,
            rows: 24,
        };
        let handle = spawner
            .spawn_shell(&cmd, PtySize::default(), &HashMap::new(), None)
            .unwrap();
        assert!(handle.is_alive());
    }

    #[test]
    fn process_spawner_spawn_command() {
        let spawner = MockProcessSpawner;
        let handle = spawner
            .spawn_command("ls", &["-la".into()], PtySize::default(), &HashMap::new())
            .unwrap();
        assert!(handle.is_alive());
    }

    #[test]
    fn process_handle_write_input() {
        let handle = MockProcessHandle {
            alive: Arc::new(Mutex::new(true)),
        };
        handle.write_input(b"echo hello\n").unwrap();
    }

    #[test]
    fn process_handle_resize() {
        let handle = MockProcessHandle {
            alive: Arc::new(Mutex::new(true)),
        };
        handle.resize(120, 40).unwrap();
    }

    #[test]
    fn process_handle_close() {
        let handle = MockProcessHandle {
            alive: Arc::new(Mutex::new(true)),
        };
        assert!(handle.is_alive());
        handle.close().unwrap();
        assert!(!handle.is_alive());
    }

    #[test]
    fn process_handle_not_alive_after_close() {
        let handle = MockProcessHandle {
            alive: Arc::new(Mutex::new(true)),
        };
        handle.close().unwrap();
        assert!(!handle.is_alive(), "handle should not be alive after close");
    }

    // -- Trait object safety (OutputSink is object-safe) ------------------

    #[test]
    fn output_sink_is_object_safe() {
        // Verify OutputSink can be used as a trait object (dyn dispatch).
        let sink: Box<dyn OutputSink> = Box::new(MockOutputSink::new());
        sink.send_output("s1", b"data".to_vec()).unwrap();
    }

    // -- Send bound verification ------------------------------------------

    fn _assert_output_sink_send<T: OutputSink>() {}
    fn _assert_process_spawner_send_sync<T: ProcessSpawner>() {}
    fn _assert_process_handle_send<T: ProcessHandle>() {}

    #[test]
    fn trait_bounds_compile() {
        _assert_output_sink_send::<MockOutputSink>();
        _assert_process_spawner_send_sync::<MockProcessSpawner>();
        _assert_process_handle_send::<MockProcessHandle>();
    }
}

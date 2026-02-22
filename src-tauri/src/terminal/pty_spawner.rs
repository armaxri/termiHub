//! Portable-PTY implementation of the core [`ProcessSpawner`] and
//! [`ProcessHandle`] traits.
//!
//! Provides `PtySpawner` (stateless process factory) and `PtyHandle`
//! (running process wrapper) for the desktop crate's local shell backend.
//! These adapters allow the shared core session engine to spawn and manage
//! PTY processes on Windows, macOS, and Linux via `portable-pty`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize as NativePtySize};

use termihub_core::config::PtySize;
use termihub_core::errors::SessionError;
use termihub_core::session::shell::ShellCommand;
use termihub_core::session::traits::{ProcessHandle, ProcessSpawner};

/// Handle to a running PTY process.
///
/// Wraps `portable-pty` primitives and exposes the [`ProcessHandle`] trait
/// for the core session engine. Also provides non-trait methods for output
/// pipeline setup (`try_clone_reader`, `alive_flag`).
pub struct PtyHandle {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
    alive: Arc<AtomicBool>,
}

impl PtyHandle {
    /// Clone the PTY reader for output pipeline setup.
    ///
    /// The caller should spawn a background thread to read from the returned
    /// reader and forward output to the appropriate sink. This method should
    /// be called once after spawning, before entering the output loop.
    pub fn try_clone_reader(&self) -> Result<Box<dyn Read + Send>, SessionError> {
        let master = self
            .master
            .lock()
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to lock master: {e}")))?;
        master
            .try_clone_reader()
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to clone reader: {e}")))
    }

    /// Get a clone of the alive flag for use in the reader thread.
    ///
    /// The reader thread should set this to `false` when it detects EOF,
    /// signaling that the process has exited.
    pub fn alive_flag(&self) -> Arc<AtomicBool> {
        self.alive.clone()
    }
}

impl ProcessHandle for PtyHandle {
    fn write_input(&self, data: &[u8]) -> Result<(), SessionError> {
        let mut writer = self.writer.lock().map_err(|e| {
            SessionError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to lock writer: {e}"),
            ))
        })?;
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        let master = self.master.lock().map_err(|e| {
            SessionError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to lock master: {e}"),
            ))
        })?;
        master
            .resize(NativePtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| {
                SessionError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Resize failed: {e}"),
                ))
            })
    }

    fn close(&self) -> Result<(), SessionError> {
        self.alive.store(false, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

/// Stateless PTY process factory implementing [`ProcessSpawner`].
///
/// Spawns local processes using `portable-pty` for cross-platform PTY
/// management. The returned `PtyHandle` does NOT set up an output reader
/// thread — the caller is responsible for calling `PtyHandle::try_clone_reader()`
/// and driving the output pipeline.
#[derive(Default)]
pub struct PtySpawner;

impl PtySpawner {
    /// Open a PTY and spawn a command, returning the handle.
    fn open_and_spawn(
        &self,
        command: &mut CommandBuilder,
        pty_size: PtySize,
    ) -> Result<PtyHandle, SessionError> {
        let pty_system = native_pty_system();

        let pty_pair = pty_system
            .openpty(NativePtySize {
                rows: pty_size.rows,
                cols: pty_size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to open PTY: {e}")))?;

        let child = pty_pair
            .slave
            .spawn_command(command.clone())
            .map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

        // Drop slave — only the master side is needed
        drop(pty_pair.slave);

        let writer = pty_pair
            .master
            .take_writer()
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to take writer: {e}")))?;

        Ok(PtyHandle {
            master: Arc::new(Mutex::new(pty_pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            child: Arc::new(Mutex::new(child)),
            alive: Arc::new(AtomicBool::new(true)),
        })
    }
}

impl ProcessSpawner for PtySpawner {
    type Handle = PtyHandle;

    fn spawn_shell(
        &self,
        command: &ShellCommand,
        pty_size: PtySize,
        env: &HashMap<String, String>,
        cwd: Option<&Path>,
    ) -> Result<Self::Handle, SessionError> {
        let mut cmd = CommandBuilder::new(&command.program);
        for arg in &command.args {
            cmd.arg(arg);
        }
        // Merge ShellCommand env, then caller-provided overrides
        for (key, value) in &command.env {
            cmd.env(key, value);
        }
        for (key, value) in env {
            cmd.env(key, value);
        }
        // Prefer explicit cwd, then ShellCommand's cwd
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        } else if let Some(ref dir) = command.cwd {
            cmd.cwd(dir);
        }
        self.open_and_spawn(&mut cmd, pty_size)
    }

    fn spawn_command(
        &self,
        program: &str,
        args: &[String],
        pty_size: PtySize,
        env: &HashMap<String, String>,
    ) -> Result<Self::Handle, SessionError> {
        let mut cmd = CommandBuilder::new(program);
        for arg in args {
            cmd.arg(arg);
        }
        for (key, value) in env {
            cmd.env(key, value);
        }
        self.open_and_spawn(&mut cmd, pty_size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compile-time verification that `PtyHandle` satisfies `ProcessHandle`.
    fn _assert_process_handle<T: ProcessHandle>() {}

    /// Compile-time verification that `PtySpawner` satisfies `ProcessSpawner`.
    fn _assert_process_spawner<T: ProcessSpawner>() {}

    #[test]
    fn pty_handle_satisfies_trait_bounds() {
        _assert_process_handle::<PtyHandle>();
    }

    #[test]
    fn pty_spawner_satisfies_trait_bounds() {
        _assert_process_spawner::<PtySpawner>();
    }

    #[test]
    fn pty_spawner_spawn_shell_and_close() {
        let spawner = PtySpawner;
        let shell_cmd = ShellCommand {
            #[cfg(windows)]
            program: "cmd.exe".to_string(),
            #[cfg(not(windows))]
            program: "sh".to_string(),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            cols: 80,
            rows: 24,
        };
        let handle = spawner
            .spawn_shell(
                &shell_cmd,
                PtySize { cols: 80, rows: 24 },
                &HashMap::new(),
                None,
            )
            .expect("spawn_shell should succeed");

        assert!(handle.is_alive(), "handle should be alive after spawn");

        // Verify we can clone a reader (output pipeline setup)
        let _reader = handle
            .try_clone_reader()
            .expect("try_clone_reader should succeed");

        handle.close().expect("close should succeed");
        assert!(!handle.is_alive(), "handle should not be alive after close");
    }
}

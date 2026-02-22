use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tracing::{debug, info};

use termihub_core::config::ShellConfig;
use termihub_core::session::shell::build_shell_command;

use crate::terminal::backend::{OutputSender, TerminalBackend};
use crate::utils::errors::TerminalError;

/// Legacy local shell backend using the `TerminalBackend` trait.
///
/// The canonical implementation is now
/// [`termihub_core::backends::local_shell::LocalShell`] which implements the
/// unified `ConnectionType` trait. This struct will be removed once
/// `TerminalManager` is migrated to use `ConnectionType`.
pub struct LocalShell {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    alive: Arc<AtomicBool>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
}

impl LocalShell {
    /// Spawn a new local shell.
    ///
    /// If `starting_directory` is provided and non-empty, the shell starts in
    /// that directory. Otherwise it defaults to the user's home directory.
    pub fn new(
        shell_type: &str,
        starting_directory: Option<&str>,
        output_tx: OutputSender,
    ) -> Result<Self, TerminalError> {
        info!(shell_type, ?starting_directory, "Spawning local shell");
        let pty_system = native_pty_system();

        let pty_pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let shell_config = ShellConfig {
            shell: Some(shell_type.to_string()),
            starting_directory: starting_directory.map(String::from),
            ..ShellConfig::default()
        };
        let shell_cmd = build_shell_command(&shell_config);

        let mut command = CommandBuilder::new(&shell_cmd.program);
        for arg in &shell_cmd.args {
            command.arg(arg);
        }
        for (key, value) in &shell_cmd.env {
            command.env(key, value);
        }
        if let Some(ref cwd) = shell_cmd.cwd {
            command.cwd(cwd);
        }

        let child = pty_pair
            .slave
            .spawn_command(command)
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        // Drop slave — we only need master
        drop(pty_pair.slave);

        let writer = pty_pair
            .master
            .take_writer()
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let alive = Arc::new(AtomicBool::new(true));

        // Spawn reader thread
        let mut reader = pty_pair
            .master
            .try_clone_reader()
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let alive_clone = alive.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if output_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            alive_clone.store(false, Ordering::SeqCst);
        });

        Ok(Self {
            master: Arc::new(Mutex::new(pty_pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            alive,
            child: Arc::new(Mutex::new(child)),
        })
    }
}

impl TerminalBackend for LocalShell {
    fn write_input(&self, data: &[u8]) -> Result<(), TerminalError> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|e| TerminalError::WriteFailed(format!("Failed to lock writer: {}", e)))?;
        writer
            .write_all(data)
            .map_err(|e| TerminalError::WriteFailed(e.to_string()))?;
        writer
            .flush()
            .map_err(|e| TerminalError::WriteFailed(e.to_string()))?;
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let master = self
            .master
            .lock()
            .map_err(|e| TerminalError::ResizeFailed(format!("Failed to lock master: {}", e)))?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::ResizeFailed(e.to_string()))?;
        Ok(())
    }

    fn close(&self) -> Result<(), TerminalError> {
        debug!("Closing local shell");
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

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    /// Regression test: spawning PowerShell via portable-pty must not produce
    /// WSL error output (see GitHub issue #126).
    #[cfg(windows)]
    #[test]
    fn powershell_spawn_does_not_trigger_wsl() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("failed to open pty");

        let shell_config = ShellConfig {
            shell: Some("powershell".to_string()),
            ..ShellConfig::default()
        };
        let shell_cmd = build_shell_command(&shell_config);
        let mut command = CommandBuilder::new(&shell_cmd.program);
        for arg in &shell_cmd.args {
            command.arg(arg);
        }
        for (key, value) in &shell_cmd.env {
            command.env(key, value);
        }
        if let Some(ref cwd) = shell_cmd.cwd {
            command.cwd(cwd);
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("failed to spawn powershell");
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .expect("failed to clone reader");

        // Give PowerShell a moment to start and produce output
        std::thread::sleep(std::time::Duration::from_secs(3));

        let mut buf = [0u8; 8192];
        let n = reader.read(&mut buf).unwrap_or(0);
        let output = String::from_utf8_lossy(&buf[..n]);

        assert!(
            !output.contains("Linux"),
            "PowerShell produced WSL error output: {}",
            output
        );

        let _ = child.kill();
    }
}

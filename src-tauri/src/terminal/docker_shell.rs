use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use crate::terminal::backend::{DockerConfig, OutputSender, TerminalBackend};
use crate::utils::errors::TerminalError;

/// Docker container shell backend using portable-pty.
///
/// Spawns `docker run -it` through a PTY, giving full interactive terminal
/// support (colors, resize, etc.) without requiring a Docker API crate.
pub struct DockerShell {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    alive: Arc<AtomicBool>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
}

impl DockerShell {
    /// Spawn a new Docker container with an interactive shell.
    pub fn new(config: &DockerConfig, output_tx: OutputSender) -> Result<Self, TerminalError> {
        let pty_system = native_pty_system();

        let pty_pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::DockerError(e.to_string()))?;

        let mut command = CommandBuilder::new("docker");
        command.arg("run");
        command.arg("-it");

        if config.remove_on_exit {
            command.arg("--rm");
        }

        for env in &config.env_vars {
            command.arg("-e");
            command.arg(format!("{}={}", env.key, env.value));
        }

        for vol in &config.volumes {
            command.arg("-v");
            if vol.read_only {
                command.arg(format!("{}:{}:ro", vol.host_path, vol.container_path));
            } else {
                command.arg(format!("{}:{}", vol.host_path, vol.container_path));
            }
        }

        if let Some(ref workdir) = config.working_directory {
            if !workdir.is_empty() {
                command.arg("-w");
                command.arg(workdir);
            }
        }

        command.arg(&config.image);

        if let Some(ref shell) = config.shell {
            if !shell.is_empty() {
                command.arg(shell);
            }
        }

        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");

        let child = pty_pair
            .slave
            .spawn_command(command)
            .map_err(|e| TerminalError::DockerError(e.to_string()))?;

        drop(pty_pair.slave);

        let writer = pty_pair
            .master
            .take_writer()
            .map_err(|e| TerminalError::DockerError(e.to_string()))?;

        let alive = Arc::new(AtomicBool::new(true));

        let mut reader = pty_pair
            .master
            .try_clone_reader()
            .map_err(|e| TerminalError::DockerError(e.to_string()))?;

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

impl TerminalBackend for DockerShell {
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

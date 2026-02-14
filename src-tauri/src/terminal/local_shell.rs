use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use crate::terminal::backend::{OutputSender, TerminalBackend};
use crate::utils::errors::TerminalError;
use crate::utils::shell_detect::shell_to_command;

/// Local shell backend using portable-pty.
pub struct LocalShell {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    alive: Arc<AtomicBool>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
}

impl LocalShell {
    /// Spawn a new local shell.
    pub fn new(shell_type: &str, output_tx: OutputSender) -> Result<Self, TerminalError> {
        let pty_system = native_pty_system();

        let pty_pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let (cmd, args) = shell_to_command(shell_type);
        let mut command = CommandBuilder::new(cmd);
        for arg in args {
            command.arg(arg);
        }

        // Ensure the PTY advertises proper terminal capabilities
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");

        // Start in user's home directory (falls back to process CWD if unavailable)
        #[cfg(unix)]
        if let Ok(home) = std::env::var("HOME") {
            command.cwd(home);
        }
        #[cfg(windows)]
        if let Ok(home) = std::env::var("USERPROFILE") {
            command.cwd(home);
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

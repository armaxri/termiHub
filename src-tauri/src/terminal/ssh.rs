use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use ssh2::Session;
use tracing::warn;

use crate::terminal::backend::{OutputSender, SshConfig, TerminalBackend};
use crate::terminal::x11_forward::X11Forwarder;
use crate::utils::errors::TerminalError;
use crate::utils::ssh_auth::connect_and_authenticate;

/// SSH connection backend.
pub struct SshConnection {
    session: Arc<Session>,
    channel: Arc<Mutex<ssh2::Channel>>,
    alive: Arc<AtomicBool>,
    _x11_forwarder: Option<X11Forwarder>,
}

impl SshConnection {
    /// Connect to an SSH server and open a shell channel.
    pub fn new(config: &SshConfig, output_tx: OutputSender) -> Result<Self, TerminalError> {
        let session = connect_and_authenticate(config)?;

        let alive = Arc::new(AtomicBool::new(true));

        // Start X11 forwarding if enabled (before opening the shell channel)
        let (x11_forwarder, x11_display, x11_cookie) = if config.enable_x11_forwarding {
            match X11Forwarder::start(config, alive.clone()) {
                Ok((forwarder, display_num, cookie)) => {
                    (Some(forwarder), Some(display_num), cookie)
                }
                Err(e) => {
                    warn!("X11 forwarding setup failed, continuing without it: {}", e);
                    (None, None, None)
                }
            }
        } else {
            (None, None, None)
        };

        let mut channel = session
            .channel_session()
            .map_err(|e| TerminalError::SshError(e.to_string()))?;

        // Try to set DISPLAY via setenv before PTY/shell
        let mut display_set_via_env = false;
        if let Some(display_num) = x11_display {
            let display_val = format!("localhost:{}.0", display_num);
            if channel.setenv("DISPLAY", &display_val).is_ok() {
                display_set_via_env = true;
            }
        }

        channel
            .request_pty("xterm-256color", None, Some((80, 24, 0, 0)))
            .map_err(|e| TerminalError::SshError(e.to_string()))?;

        channel
            .shell()
            .map_err(|e| TerminalError::SshError(e.to_string()))?;

        // If setenv failed (most servers reject it), inject export DISPLAY after shell starts
        if let Some(display_num) = x11_display {
            if !display_set_via_env {
                let display_cmd = format!("export DISPLAY=localhost:{}.0\n", display_num);
                let _ = channel.write_all(display_cmd.as_bytes());
            }
            // Inject xauth cookie so the remote can authenticate with the local X server
            if let Some(ref cookie) = x11_cookie {
                let xauth_cmd = format!(
                    "xauth add localhost:{} MIT-MAGIC-COOKIE-1 {} 2>/dev/null\n",
                    display_num, cookie
                );
                let _ = channel.write_all(xauth_cmd.as_bytes());
            }
        }

        // Set non-blocking for reading
        session.set_blocking(false);

        let channel = Arc::new(Mutex::new(channel));
        let session = Arc::new(session);

        // Spawn reader thread
        let channel_clone = channel.clone();
        let alive_clone = alive.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while alive_clone.load(Ordering::SeqCst) {
                let result = {
                    let mut ch = channel_clone.lock().unwrap();
                    ch.read(&mut buf)
                };
                match result {
                    Ok(0) => break,
                    Ok(n) => {
                        if output_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
            alive_clone.store(false, Ordering::SeqCst);
        });

        Ok(Self {
            session,
            channel,
            alive,
            _x11_forwarder: x11_forwarder,
        })
    }
}

impl TerminalBackend for SshConnection {
    fn write_input(&self, data: &[u8]) -> Result<(), TerminalError> {
        // Need blocking for writes
        self.session.set_blocking(true);
        let result = {
            let mut channel = self.channel.lock().unwrap();
            channel.write_all(data)
        };
        self.session.set_blocking(false);
        result.map_err(|e| TerminalError::WriteFailed(e.to_string()))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        self.session.set_blocking(true);
        let result = {
            let mut channel = self.channel.lock().unwrap();
            channel.request_pty_size(cols as u32, rows as u32, None, None)
        };
        self.session.set_blocking(false);
        result.map_err(|e| TerminalError::ResizeFailed(e.to_string()))
    }

    fn close(&self) -> Result<(), TerminalError> {
        self.alive.store(false, Ordering::SeqCst);
        self.session.set_blocking(true);
        let mut channel = self.channel.lock().unwrap();
        let _ = channel.send_eof();
        let _ = channel.close();
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

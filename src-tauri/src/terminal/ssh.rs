use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use ssh2::Session;

use crate::terminal::backend::{OutputSender, SshConfig, TerminalBackend};
use crate::utils::errors::TerminalError;

/// SSH connection backend.
pub struct SshConnection {
    session: Arc<Session>,
    channel: Arc<Mutex<ssh2::Channel>>,
    alive: Arc<AtomicBool>,
}

impl SshConnection {
    /// Connect to an SSH server and open a shell channel.
    pub fn new(config: &SshConfig, output_tx: OutputSender) -> Result<Self, TerminalError> {
        let addr = format!("{}:{}", config.host, config.port);
        let tcp = TcpStream::connect(&addr)
            .map_err(|e| TerminalError::SshError(format!("Connection failed: {}", e)))?;

        let mut session = Session::new()
            .map_err(|e| TerminalError::SshError(e.to_string()))?;

        session.set_tcp_stream(tcp);
        session
            .handshake()
            .map_err(|e| TerminalError::SshError(format!("Handshake failed: {}", e)))?;

        // Authenticate
        match config.auth_method.as_str() {
            "key" => {
                let key_path = config
                    .key_path
                    .as_deref()
                    .unwrap_or("~/.ssh/id_rsa");
                let expanded = shellexpand(key_path);
                session
                    .userauth_pubkey_file(&config.username, None, Path::new(&expanded), None)
                    .map_err(|e| TerminalError::SshError(format!("Key auth failed: {}", e)))?;
            }
            _ => {
                let password = config.password.as_deref().unwrap_or("");
                session
                    .userauth_password(&config.username, password)
                    .map_err(|e| TerminalError::SshError(format!("Password auth failed: {}", e)))?;
            }
        }

        if !session.authenticated() {
            return Err(TerminalError::SshError("Authentication failed".to_string()));
        }

        let mut channel = session
            .channel_session()
            .map_err(|e| TerminalError::SshError(e.to_string()))?;

        channel
            .request_pty("xterm-256color", None, Some((80, 24, 0, 0)))
            .map_err(|e| TerminalError::SshError(e.to_string()))?;

        channel
            .shell()
            .map_err(|e| TerminalError::SshError(e.to_string()))?;

        // Set non-blocking for reading
        session.set_blocking(false);

        let alive = Arc::new(AtomicBool::new(true));
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
        })
    }
}

/// Expand ~ in paths to the home directory.
fn shellexpand(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs_home() {
            return format!("{}/{}", home, rest);
        }
    }
    path.to_string()
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
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

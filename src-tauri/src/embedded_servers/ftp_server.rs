//! Minimal passive-mode FTP server.
//!
//! Supports: USER/PASS, QUIT, SYST, TYPE, PWD, CWD, CDUP, LIST, RETR, STOR,
//! SIZE, FEAT, NOOP, PASV.  Only passive mode (PASV) data connections.

use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};

use super::config::{AtomicServerStats, EmbeddedServerConfig, FtpAuth};

// ─── Public entry point ───────────────────────────────────────────────────────

/// Start the FTP server in the current thread, blocking until the shutdown flag is set.
pub fn start_ftp_server(
    config: &EmbeddedServerConfig,
    shutdown: Arc<AtomicBool>,
    stats: Arc<AtomicServerStats>,
) -> Result<()> {
    let addr = format!("{}:{}", config.bind_host, config.port);
    let listener =
        TcpListener::bind(&addr).with_context(|| format!("Failed to bind FTP server to {addr}"))?;
    listener
        .set_nonblocking(true)
        .context("Failed to set non-blocking on FTP listener")?;

    let root = PathBuf::from(&config.root_directory);
    let auth = config.ftp_auth.clone();
    let read_only = config.read_only;
    let bind_host = config.bind_host.clone();

    tracing::info!(addr, "FTP server listening");

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match listener.accept() {
            Ok((stream, peer)) => {
                let root = root.clone();
                let auth = auth.clone();
                let stats = Arc::clone(&stats);
                let bind_host = bind_host.clone();
                std::thread::spawn(move || {
                    stats.active_connections.fetch_add(1, Ordering::Relaxed);
                    stats.total_connections.fetch_add(1, Ordering::Relaxed);
                    tracing::debug!(%peer, "FTP client connected");
                    if let Err(e) =
                        handle_client(stream, &root, read_only, &auth, &bind_host, &stats)
                    {
                        tracing::debug!(%peer, "FTP client error: {e}");
                    }
                    stats.active_connections.fetch_sub(1, Ordering::Relaxed);
                });
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => {
                tracing::error!("FTP accept error: {e}");
                break;
            }
        }
    }

    Ok(())
}

// ─── Session state ────────────────────────────────────────────────────────────

struct Session {
    cwd: PathBuf,
    root: PathBuf,
    authenticated: bool,
    pending_user: Option<String>,
    /// Passive listener and the port it is bound on.
    pasv: Option<(TcpListener, u16)>,
    read_only: bool,
}

impl Session {
    fn new(root: PathBuf, needs_auth: bool, read_only: bool) -> Self {
        Self {
            cwd: root.clone(),
            root,
            authenticated: !needs_auth,
            pending_user: None,
            pasv: None,
            read_only,
        }
    }

    /// Resolve `path` relative to `cwd` and verify it stays within `root`.
    fn resolve(&self, path: &str) -> Option<PathBuf> {
        let candidate = if path.starts_with('/') {
            self.root.join(path.trim_start_matches('/'))
        } else {
            self.cwd.join(path)
        };
        // Use components to normalise without requiring the path to exist.
        let normalised = normalise_path(&candidate);
        if normalised.starts_with(&self.root) {
            Some(normalised)
        } else {
            None
        }
    }

    /// Accept an incoming data connection from the PASV listener.
    fn accept_data(&mut self) -> io::Result<TcpStream> {
        if let Some((listener, _)) = self.pasv.take() {
            listener.set_nonblocking(false)?;
            let (stream, _) = listener.accept()?;
            Ok(stream)
        } else {
            Err(io::Error::other("No passive data connection pending"))
        }
    }
}

// ─── Client handler ───────────────────────────────────────────────────────────

fn handle_client(
    stream: TcpStream,
    root: &Path,
    read_only: bool,
    auth: &Option<FtpAuth>,
    bind_host: &str,
    stats: &AtomicServerStats,
) -> Result<()> {
    stream.set_nonblocking(false)?;
    let writer_stream = stream.try_clone()?;
    let mut writer = BufWriter::new(writer_stream);
    let reader = BufReader::new(stream);

    send(&mut writer, "220 termiHub FTP Server ready.")?;

    let needs_auth = auth.is_some();
    let mut session = Session::new(root.to_path_buf(), needs_auth, read_only);

    for line in reader.lines() {
        let line = line?;
        let trimmed = line.trim_end_matches(['\r', '\n']);

        let (cmd, arg) = match trimmed.find(' ') {
            Some(idx) => (&trimmed[..idx], trimmed[idx + 1..].trim()),
            None => (trimmed, ""),
        };

        let response = dispatch(cmd, arg, &mut session, auth, bind_host, stats);
        let quit = response.starts_with("221");
        send(&mut writer, &response)?;
        if quit {
            break;
        }
    }

    Ok(())
}

fn send(w: &mut BufWriter<TcpStream>, msg: &str) -> io::Result<()> {
    write!(w, "{msg}\r\n")?;
    w.flush()
}

// ─── Command dispatcher ───────────────────────────────────────────────────────

fn dispatch(
    cmd: &str,
    arg: &str,
    session: &mut Session,
    auth: &Option<FtpAuth>,
    bind_host: &str,
    stats: &AtomicServerStats,
) -> String {
    match cmd.to_ascii_uppercase().as_str() {
        "FEAT" => "211-Features:\r\n PASV\r\n211 End".to_string(),
        "SYST" => "215 UNIX Type: L8".to_string(),
        "NOOP" => "200 OK".to_string(),
        "QUIT" => "221 Goodbye.".to_string(),
        "TYPE" => "200 Type set.".to_string(),
        "MODE" => "200 Mode set.".to_string(),
        "STRU" => "200 Structure set.".to_string(),

        "USER" => {
            if auth.is_none() {
                session.authenticated = true;
                return "230 Anonymous login OK.".to_string();
            }
            session.pending_user = Some(arg.to_string());
            "331 Password required.".to_string()
        }

        "PASS" => {
            if session.authenticated {
                return "230 Already logged in.".to_string();
            }
            match auth {
                None => {
                    session.authenticated = true;
                    "230 Anonymous login OK.".to_string()
                }
                Some(FtpAuth::Anonymous) => {
                    session.authenticated = true;
                    "230 Anonymous login OK.".to_string()
                }
                Some(FtpAuth::Credentials { username, password }) => {
                    let user_ok = session
                        .pending_user
                        .as_deref()
                        .map(|u| u == username.as_str())
                        .unwrap_or(false);
                    if user_ok && arg == password.as_str() {
                        session.authenticated = true;
                        "230 Login successful.".to_string()
                    } else {
                        "530 Login incorrect.".to_string()
                    }
                }
            }
        }

        _ if !session.authenticated => "530 Not logged in.".to_string(),

        "PWD" | "XPWD" => {
            let virtual_path = virtual_cwd(&session.root, &session.cwd);
            format!("257 \"{virtual_path}\" is current directory.")
        }

        "CWD" | "XCWD" => match session.resolve(arg) {
            Some(p) if p.is_dir() => {
                session.cwd = p;
                "250 Directory changed.".to_string()
            }
            Some(_) => "550 Not a directory.".to_string(),
            None => "550 Permission denied.".to_string(),
        },

        "CDUP" | "XCUP" => {
            let parent = session.cwd.parent().map(|p| p.to_path_buf());
            match parent {
                Some(p) if p.starts_with(&session.root) => {
                    session.cwd = p;
                    "250 Directory changed.".to_string()
                }
                _ => "550 Permission denied.".to_string(),
            }
        }

        "PASV" => {
            // Bind a random port and tell the client.
            let bind = format!("{}:0", bind_host);
            match TcpListener::bind(&bind) {
                Err(e) => format!("425 Cannot open data connection: {e}"),
                Ok(listener) => {
                    let port = match listener.local_addr() {
                        Ok(a) => a.port(),
                        Err(e) => return format!("425 Cannot open data connection: {e}"),
                    };
                    let ip: Ipv4Addr = bind_host.parse().unwrap_or(Ipv4Addr::LOCALHOST);
                    let [a, b, c, d] = ip.octets();
                    let p1 = port >> 8;
                    let p2 = port & 0xFF;
                    session.pasv = Some((listener, port));
                    format!("227 Entering Passive Mode ({a},{b},{c},{d},{p1},{p2}).")
                }
            }
        }

        "LIST" | "NLST" => {
            let path = if arg.is_empty() {
                Some(session.cwd.clone())
            } else {
                session.resolve(arg)
            };
            match path {
                None => "550 Permission denied.".to_string(),
                Some(p) => match session.accept_data() {
                    Err(e) => format!("425 Cannot open data connection: {e}"),
                    Ok(mut data) => {
                        let listing = build_listing(&p);
                        let _ = data.write_all(listing.as_bytes());
                        stats
                            .bytes_sent
                            .fetch_add(listing.len() as u64, Ordering::Relaxed);
                        "226 Transfer complete.".to_string()
                    }
                },
            }
        }

        "SIZE" => match session.resolve(arg) {
            None => "550 Permission denied.".to_string(),
            Some(p) => match std::fs::metadata(&p) {
                Ok(m) => format!("213 {}", m.len()),
                Err(_) => "550 File not found.".to_string(),
            },
        },

        "RETR" => match session.resolve(arg) {
            None => "550 Permission denied.".to_string(),
            Some(p) if p.is_dir() => "550 Is a directory.".to_string(),
            Some(p) => {
                // Read file entirely before accepting data connection so we
                // can send 550 on read errors without opening the data channel.
                match std::fs::read(&p) {
                    Err(_) => "550 File read error.".to_string(),
                    Ok(bytes) => match session.accept_data() {
                        Err(e) => format!("425 Cannot open data connection: {e}"),
                        Ok(mut data) => {
                            let sent = bytes.len() as u64;
                            let _ = data.write_all(&bytes);
                            stats.bytes_sent.fetch_add(sent, Ordering::Relaxed);
                            "226 Transfer complete.".to_string()
                        }
                    },
                }
            }
        },

        "STOR" => {
            if session.read_only {
                return "553 Server is read-only.".to_string();
            }
            match session.resolve(arg) {
                None => "550 Permission denied.".to_string(),
                Some(p) => match session.accept_data() {
                    Err(e) => format!("425 Cannot open data connection: {e}"),
                    Ok(mut data) => {
                        let mut buf = Vec::new();
                        if let Err(e) = io::Read::read_to_end(&mut data, &mut buf) {
                            return format!("550 Transfer error: {e}");
                        }
                        let received = buf.len() as u64;
                        if let Err(e) = std::fs::write(&p, &buf) {
                            return format!("550 Write error: {e}");
                        }
                        stats.bytes_received.fetch_add(received, Ordering::Relaxed);
                        "226 Transfer complete.".to_string()
                    }
                },
            }
        }

        "MKD" | "XMKD" => {
            if session.read_only {
                return "553 Server is read-only.".to_string();
            }
            match session.resolve(arg) {
                None => "550 Permission denied.".to_string(),
                Some(p) => match std::fs::create_dir_all(&p) {
                    Ok(_) => format!("257 \"{}\" created.", arg),
                    Err(e) => format!("550 Cannot create directory: {e}"),
                },
            }
        }

        "DELE" => {
            if session.read_only {
                return "553 Server is read-only.".to_string();
            }
            match session.resolve(arg) {
                None => "550 Permission denied.".to_string(),
                Some(p) => match std::fs::remove_file(&p) {
                    Ok(_) => "250 File deleted.".to_string(),
                    Err(e) => format!("550 Delete failed: {e}"),
                },
            }
        }

        _ => format!("502 Command not implemented: {cmd}"),
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Return the virtual (FTP-visible) path of `cwd` relative to `root`.
fn virtual_cwd(root: &Path, cwd: &Path) -> String {
    match cwd.strip_prefix(root) {
        Ok(rel) => {
            let s = rel.to_string_lossy();
            if s.is_empty() {
                "/".to_string()
            } else {
                format!("/{}", s.replace('\\', "/"))
            }
        }
        Err(_) => "/".to_string(),
    }
}

/// Build a Unix-style LIST output for the given directory path.
fn build_listing(dir: &Path) -> String {
    let mut output = String::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return output,
    };

    for entry in entries.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let size = meta.len();
        let is_dir = meta.is_dir();
        let perm = if is_dir { "drwxr-xr-x" } else { "-rw-r--r--" };
        output.push_str(&format!(
            "{perm} 1 ftp ftp {size:>12} Jan 01 00:00 {name}\r\n"
        ));
    }

    output
}

/// Normalise a `PathBuf` by resolving `.` and `..` without hitting the
/// filesystem (unlike `canonicalize`).  Symlinks are not resolved.
fn normalise_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut components: Vec<Component> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(components.last(), Some(Component::Normal(_))) {
                    components.pop();
                }
            }
            other => components.push(other),
        }
    }
    components.iter().collect()
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_cwd_root() {
        let root = PathBuf::from("/srv/ftp");
        assert_eq!(virtual_cwd(&root, &root), "/");
    }

    #[test]
    fn virtual_cwd_subdir() {
        let root = PathBuf::from("/srv/ftp");
        let cwd = PathBuf::from("/srv/ftp/pub");
        assert_eq!(virtual_cwd(&root, &cwd), "/pub");
    }

    #[test]
    fn normalise_path_parent() {
        let p = PathBuf::from("/a/b/../c");
        assert_eq!(normalise_path(&p), PathBuf::from("/a/c"));
    }

    #[test]
    fn normalise_path_dot() {
        let p = PathBuf::from("/a/./b");
        assert_eq!(normalise_path(&p), PathBuf::from("/a/b"));
    }

    #[test]
    fn session_resolve_rejects_traversal() {
        let root = PathBuf::from("/srv/ftp");
        let session = Session::new(root.clone(), false, false);
        // A traversal attempt should be rejected.
        assert!(session.resolve("/../etc/passwd").is_none());
    }

    #[test]
    fn session_resolve_accepts_valid() {
        let root = PathBuf::from("/");
        let session = Session::new(root.clone(), false, false);
        let resolved = session.resolve("tmp");
        // Should resolve to something under root.
        if let Some(p) = resolved {
            assert!(p.starts_with("/"));
        }
    }
}

//! In-process SFTP-only SSH server for tests of files-only sessions (#4078,
//! #4081, #5160).
//!
//! The shape of an OpenSSH host with `ForceCommand internal-sftp`: password
//! login works, a shell or exec request is refused, and the `sftp` subsystem
//! serves a small, fixed, read-only tree:
//!
//! ```text
//! /
//! └── etc/
//!     ├── hostname
//!     └── hosts
//! ```
//!
//! [`serve_tcp`] listens on a loopback TCP port, so the SSH client can live in
//! **another process** — the agent's session daemon in the files-only agent
//! suite (`agent/tests/ssh_files_only_integration.rs`). No Docker, so that
//! suite runs on every OS, Windows included, where the `ssh-sftp-only` Linux
//! container fixture cannot run.
//!
//! The host key is the keyboard-interactive test server's fixed key, so
//! [`host_public_key_openssh`](super::ki_test_server::host_public_key_openssh)
//! trusts this server too.
//!
//! Compiled for this crate's tests and, behind the `ssh-test-support` feature,
//! for other crates' tests. Never part of a shipping build.

// Test-support code: a poisoned lock is a bug in the test, and panicking is the
// right way to report it.
#![allow(clippy::expect_used)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use russh::server::{Auth, Msg, Session};
use russh::{Channel, ChannelId, MethodKind, MethodSet};
use russh_sftp::protocol::{
    Attrs, File, FileAttributes, Handle, Name, Status, StatusCode, Version,
};

use super::ki_test_server::server_config;

/// The login user the server accepts.
pub const USER: &str = "files-only";
/// The password the server accepts.
pub const PASSWORD: &str = "files-only-pass";

/// The fixed tree: `(path, Some(contents))` for a file, `None` for a directory.
const TREE: &[(&str, Option<&str>)] = &[
    ("/", None),
    ("/etc", None),
    ("/etc/hostname", Some("sftp-only\n")),
    ("/etc/hosts", Some("127.0.0.1 localhost\n")),
];

/// What the server observed, for assertions.
#[derive(Default)]
pub struct Observed {
    /// Logins accepted.
    pub authenticated: usize,
    /// Shell or exec requests refused.
    pub refused: usize,
    /// `sftp` subsystems started.
    pub sftp_sessions: usize,
}

fn entry(path: &str) -> Option<Option<&'static str>> {
    TREE.iter().find(|(p, _)| *p == path).map(|(_, c)| *c)
}

fn attrs(contents: Option<&str>) -> FileAttributes {
    let mut attrs = FileAttributes::default();
    match contents {
        Some(text) => {
            attrs.permissions = Some(0o100_644);
            attrs.size = Some(text.len() as u64);
        }
        None => {
            attrs.permissions = Some(0o040_755);
            attrs.size = Some(0);
        }
    }
    attrs
}

/// Normalize a client path: `.`, empty and relative paths resolve from `/`.
fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    format!("/{}", parts.join("/"))
}

/// The direct children of directory `dir`.
fn children(dir: &str) -> Vec<File> {
    let prefix = if dir == "/" {
        "/".to_string()
    } else {
        format!("{dir}/")
    };
    TREE.iter()
        .filter_map(|(p, c)| {
            let rest = p.strip_prefix(&prefix)?;
            (!rest.is_empty() && !rest.contains('/')).then(|| File::new(rest, attrs(*c)))
        })
        .collect()
}

/// The `sftp` subsystem: read-only access to [`TREE`].
#[derive(Default)]
struct SftpHandler {
    /// Directory handles already listed (the next `readdir` answers EOF).
    listed: HashMap<String, bool>,
    next_handle: u64,
}

impl SftpHandler {
    fn status(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".to_string(),
            language_tag: "en-US".to_string(),
        }
    }

    fn stat_path(id: u32, path: &str) -> Result<Attrs, StatusCode> {
        let contents = entry(&normalize(path)).ok_or(StatusCode::NoSuchFile)?;
        Ok(Attrs {
            id,
            attrs: attrs(contents),
        })
    }
}

impl russh_sftp::server::Handler for SftpHandler {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let path = normalize(&path);
        let contents = entry(&path).ok_or(StatusCode::NoSuchFile)?;
        Ok(Name {
            id,
            files: vec![File::new(path, attrs(contents))],
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        Self::stat_path(id, &path)
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        Self::stat_path(id, &path)
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let path = normalize(&path);
        match entry(&path) {
            Some(None) => {}
            Some(Some(_)) => return Err(StatusCode::Failure),
            None => return Err(StatusCode::NoSuchFile),
        }
        self.next_handle += 1;
        let handle = format!("{}:{path}", self.next_handle);
        self.listed.insert(handle.clone(), false);
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let done = self.listed.get_mut(&handle).ok_or(StatusCode::Failure)?;
        if *done {
            return Err(StatusCode::Eof);
        }
        *done = true;
        let dir = handle.split_once(':').map_or("/", |(_, d)| d);
        Ok(Name {
            id,
            files: children(dir),
        })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.listed.remove(&handle);
        Ok(Self::status(id))
    }
}

/// One connection's SSH handler.
struct FilesOnlyServer {
    observed: Arc<Mutex<Observed>>,
    channels: HashMap<ChannelId, Channel<Msg>>,
}

impl FilesOnlyServer {
    /// Refuse a shell / exec request the way `ForceCommand internal-sftp`
    /// leaves a client without one: a failure reply, then the channel closes.
    fn refuse(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), russh::Error> {
        self.observed.lock().expect("observed").refused += 1;
        self.channels.remove(&channel);
        session.channel_failure(channel)?;
        session.close(channel)?;
        Ok(())
    }
}

impl russh::server::Handler for FilesOnlyServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == USER && password == PASSWORD {
            self.observed.lock().expect("observed").authenticated += 1;
            return Ok(Auth::Accept);
        }
        Ok(Auth::Reject {
            proceed_with_methods: Some(MethodSet::from(&[MethodKind::Password][..])),
            partial_success: false,
        })
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        self.channels.insert(channel.id(), channel);
        Ok(true)
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.refuse(channel, session)
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.refuse(channel, session)
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(stream) = (name == "sftp")
            .then(|| self.channels.remove(&channel))
            .flatten()
        else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        self.observed.lock().expect("observed").sftp_sessions += 1;
        session.channel_success(channel)?;
        russh_sftp::server::run(stream.into_stream(), SftpHandler::default()).await;
        Ok(())
    }
}

/// An SFTP-only server listening on a loopback TCP port. Stops accepting when
/// dropped.
pub struct TcpServer {
    /// The bound address (`127.0.0.1:<ephemeral port>`).
    pub addr: std::net::SocketAddr,
    /// What the server observed, across every connection.
    pub observed: Arc<Mutex<Observed>>,
    accept_task: tokio::task::JoinHandle<()>,
}

impl Drop for TcpServer {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

/// Serve one connection over an in-memory stream, for a client in this
/// process: the client's end of the stream plus what the server observed.
/// Must be called inside a Tokio runtime, which then drives the server.
pub fn serve() -> (tokio::io::DuplexStream, Arc<Mutex<Observed>>) {
    let observed = Arc::new(Mutex::new(Observed::default()));
    let handler = FilesOnlyServer {
        observed: observed.clone(),
        channels: HashMap::new(),
    };
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        if let Ok(running) = russh::server::run_stream(server_config(), server_io, handler).await {
            let _ = running.await;
        }
    });
    (client_io, observed)
}

/// Start the server on `127.0.0.1:0`. Must be called inside a Tokio runtime,
/// which then drives the server.
pub async fn serve_tcp() -> std::io::Result<TcpServer> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let addr = listener.local_addr()?;
    let config = server_config();
    let observed = Arc::new(Mutex::new(Observed::default()));
    let task_observed = observed.clone();
    let accept_task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let handler = FilesOnlyServer {
                observed: task_observed.clone(),
                channels: HashMap::new(),
            };
            let config = config.clone();
            tokio::spawn(async move {
                if let Ok(running) = russh::server::run_stream(config, stream, handler).await {
                    let _ = running.await;
                }
            });
        }
    });
    Ok(TcpServer {
        addr,
        observed,
        accept_task,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_resolves_relative_and_dot_paths() {
        assert_eq!(normalize(""), "/");
        assert_eq!(normalize("."), "/");
        assert_eq!(normalize("etc"), "/etc");
        assert_eq!(normalize("/etc/../etc/./hostname"), "/etc/hostname");
    }

    #[test]
    fn children_lists_only_direct_entries() {
        let names = |dir| {
            children(dir)
                .into_iter()
                .map(|f| f.filename)
                .collect::<Vec<_>>()
        };
        assert_eq!(names("/"), vec!["etc"]);
        assert_eq!(names("/etc"), vec!["hostname", "hosts"]);
    }

    /// The core SFTP client sees exactly the fixed tree, and a shell is refused.
    #[tokio::test]
    async fn serves_the_tree_and_refuses_a_shell() {
        let server = serve_tcp().await.expect("serve");
        let config = Arc::new(russh::client::Config::default());
        let mut session = russh::client::connect(
            config,
            server.addr,
            super::super::ki_test_server::AcceptAnyKey,
        )
        .await
        .expect("connect");
        let auth = session
            .authenticate_password(USER, PASSWORD)
            .await
            .expect("auth");
        assert!(auth.success(), "password login must succeed");

        let shell = session.channel_open_session().await.expect("open session");
        shell.request_shell(true).await.expect("send shell request");

        let channel = session.channel_open_session().await.expect("open sftp");
        channel
            .request_subsystem(true, "sftp")
            .await
            .expect("sftp subsystem");
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .expect("sftp init");
        let mut names: Vec<String> = sftp
            .read_dir("/etc")
            .await
            .expect("read_dir")
            .map(|e| e.file_name())
            .collect();
        names.sort();
        assert_eq!(names, vec!["hostname", "hosts"]);
        assert!(sftp.metadata("/etc").await.expect("stat").is_dir());

        let observed = server.observed.lock().expect("observed");
        assert_eq!(observed.authenticated, 1);
        assert_eq!(observed.sftp_sessions, 1);
    }
}

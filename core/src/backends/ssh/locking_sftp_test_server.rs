//! In-process SFTP server for tests of when a remote file is closed (#6040).
//!
//! It keeps its files in memory, and opens them as Win32-OpenSSH does: while a
//! handle is open for writing, no other handle of any session opens the file,
//! and a file with an open handle is not removed. Both answer a bare `Failure`.
//! A close can be slow, or fail.

// Test-support code: a poisoned lock is a bug in the test, and panicking is the
// right way to report it.
#![allow(clippy::expect_used)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::server::{Auth, Msg, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};

use super::ki_test_server::server_config;

/// What the server holds and how it behaves.
#[derive(Default)]
pub(crate) struct Disk {
    pub files: HashMap<String, Vec<u8>>,
    /// Open handles per path: `(readers, writers)`.
    open: HashMap<String, (usize, usize)>,
    /// How long a close takes.
    pub close_lag: Duration,
    /// How many closes of a written file fail (the handle is closed then, as
    /// POSIX `close` does, but the data may not have landed).
    pub failing_closes: usize,
    /// How many writes fail.
    pub failing_writes: usize,
    /// Writes wait while this is set.
    pub hold_writes: bool,
    /// Writes that arrived.
    pub writes: usize,
}

impl Disk {
    /// Open handles of `path`, `(readers, writers)`.
    pub fn open(&self, path: &str) -> (usize, usize) {
        self.open.get(path).copied().unwrap_or_default()
    }

    fn release(&mut self, handle: &Open) {
        let (readers, writers) = self.open.entry(handle.path.clone()).or_default();
        if handle.writes {
            *writers -= 1;
        } else {
            *readers -= 1;
        }
    }
}

pub(crate) type SharedDisk = Arc<Mutex<Disk>>;

struct Open {
    path: String,
    writes: bool,
}

/// One `sftp` subsystem.
struct Subsystem {
    disk: SharedDisk,
    handles: HashMap<String, Open>,
    next: u64,
}

fn status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".to_string(),
        language_tag: "en-US".to_string(),
    }
}

impl Drop for Subsystem {
    /// The session's server process ends: its handles close.
    fn drop(&mut self) {
        let mut disk = self.disk.lock().expect("disk");
        for handle in self.handles.values() {
            disk.release(handle);
        }
    }
}

impl russh_sftp::server::Handler for Subsystem {
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

    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let writes = flags.contains(OpenFlags::WRITE);
        let mut disk = self.disk.lock().expect("disk");
        let (readers, writers) = disk.open(&path);
        if writers > 0 || (writes && readers > 0) {
            return Err(StatusCode::Failure);
        }
        match disk.files.get_mut(&path) {
            Some(data) if flags.contains(OpenFlags::TRUNCATE) => data.clear(),
            Some(_) => {}
            None if flags.contains(OpenFlags::CREATE) => {
                disk.files.insert(path.clone(), Vec::new());
            }
            None => return Err(StatusCode::NoSuchFile),
        }
        let entry = disk.open.entry(path.clone()).or_default();
        if writes {
            entry.1 += 1;
        } else {
            entry.0 += 1;
        }
        self.next += 1;
        let handle = format!("h{}", self.next);
        self.handles.insert(handle.clone(), Open { path, writes });
        Ok(Handle { id, handle })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        let lag = self.disk.lock().expect("disk").close_lag;
        tokio::time::sleep(lag).await;
        let open = self.handles.remove(&handle).ok_or(StatusCode::Failure)?;
        let mut disk = self.disk.lock().expect("disk");
        disk.release(&open);
        if open.writes && disk.failing_closes > 0 {
            disk.failing_closes -= 1;
            return Err(StatusCode::Failure);
        }
        Ok(status(id))
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        bytes: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        self.disk.lock().expect("disk").writes += 1;
        while self.disk.lock().expect("disk").hold_writes {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let path = &self.handles.get(&handle).ok_or(StatusCode::Failure)?.path;
        let mut disk = self.disk.lock().expect("disk");
        if disk.failing_writes > 0 {
            disk.failing_writes -= 1;
            return Err(StatusCode::Failure);
        }
        let file = disk.files.entry(path.clone()).or_default();
        let start = usize::try_from(offset).map_err(|_| StatusCode::Failure)?;
        if file.len() < start + bytes.len() {
            file.resize(start + bytes.len(), 0);
        }
        file[start..start + bytes.len()].copy_from_slice(&bytes);
        Ok(status(id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let path = &self.handles.get(&handle).ok_or(StatusCode::Failure)?.path;
        let disk = self.disk.lock().expect("disk");
        let file = disk.files.get(path).ok_or(StatusCode::NoSuchFile)?;
        let start = usize::try_from(offset).map_err(|_| StatusCode::Failure)?;
        if start >= file.len() {
            return Err(StatusCode::Eof);
        }
        let end = file.len().min(start + len as usize);
        Ok(Data {
            id,
            data: file[start..end].to_vec(),
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let disk = self.disk.lock().expect("disk");
        let file = disk.files.get(&path).ok_or(StatusCode::NoSuchFile)?;
        Ok(Attrs {
            id,
            attrs: FileAttributes {
                size: Some(file.len() as u64),
                permissions: Some(0o100_644),
                mtime: Some(1_762_862_400),
                atime: Some(1_762_862_400),
                ..FileAttributes::default()
            },
        })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.stat(id, path).await
    }

    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let mut disk = self.disk.lock().expect("disk");
        if disk.open(&path).1 > 0 {
            return Err(StatusCode::Failure);
        }
        let file = disk.files.get_mut(&path).ok_or(StatusCode::NoSuchFile)?;
        if let Some(size) = attrs.size {
            file.resize(usize::try_from(size).map_err(|_| StatusCode::Failure)?, 0);
        }
        Ok(status(id))
    }

    async fn remove(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let mut disk = self.disk.lock().expect("disk");
        if disk.open(&path) != (0, 0) {
            return Err(StatusCode::Failure);
        }
        disk.files
            .remove(&path)
            .map(|_| status(id))
            .ok_or(StatusCode::NoSuchFile)
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        Ok(Name {
            id,
            files: vec![File::dummy(path)],
        })
    }
}

struct Server {
    disk: SharedDisk,
    channels: HashMap<ChannelId, Channel<Msg>>,
}

impl russh::server::Handler for Server {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        _name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(stream) = self.channels.remove(&channel) else {
            return session.channel_failure(channel);
        };
        session.channel_success(channel)?;
        let subsystem = Subsystem {
            disk: self.disk.clone(),
            handles: HashMap::new(),
            next: 0,
        };
        russh_sftp::server::run(stream.into_stream(), subsystem).await;
        Ok(())
    }
}

/// Serve one connection to `disk` over an in-memory stream.
pub(crate) fn serve(disk: &SharedDisk) -> tokio::io::DuplexStream {
    let handler = Server {
        disk: disk.clone(),
        channels: HashMap::new(),
    };
    let (client, server) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        if let Ok(running) = russh::server::run_stream(server_config(), server, handler).await {
            let _ = running.await;
        }
    });
    client
}

/// Trusts the test server's key without consulting any trust store.
struct TrustAll;

#[async_trait::async_trait]
impl super::host_key::HostKeyVerifier for TrustAll {
    async fn verify(&self, _info: &super::host_key::HostKeyInfo) -> bool {
        true
    }
}

/// A file browser on its own connection to `disk`.
pub(crate) async fn browser(disk: &SharedDisk) -> Arc<super::SftpFileBrowser> {
    let config = crate::config::SshConfig {
        host: "locking".to_string(),
        port: 22,
        username: "tester".to_string(),
        auth_method: "password".to_string(),
        password: Some("any".to_string()),
        ..crate::config::SshConfig::default()
    };
    let (session, _registry, _liveness) = super::auth::handshake_and_authenticate_with(
        &config,
        serve(disk),
        Some(Arc::new(TrustAll)),
    )
    .await
    .expect("login");
    let browser = super::SftpFileBrowser::from_session(Arc::new(session))
        .await
        .expect("sftp");
    Arc::new(browser)
}

//! In-process SSH server with an SFTP subsystem and a scripted `sudo` (#4007).
//!
//! Lets the sudo-password secrecy assertions run on every PR, not only where
//! the `ssh-sudo` Docker fixture is up. It serves exactly what the elevated
//! save path (`sftp_ops::write_file_content_elevated`) and an SSH terminal
//! session need, on a loopback TCP port:
//!
//! * password auth for [`LOGIN_PASSWORD`];
//! * a PTY + shell that echoes its input (the terminal tab);
//! * an `sftp` subsystem over an in-memory file system (the temp upload);
//! * exec channels that read stdin to EOF, then act like the remote host:
//!   `sudo -S …` checks the stdin line against [`SUDO_PASSWORD`] and, when it
//!   matches, moves the temp upload over the destination the way the fixed
//!   `cat "$1" > "$2" && rm -f "$1"` script does; when it does not, it answers
//!   with sudo's real wrong-password stderr. `rm -f` removes the file and
//!   `echo <marker>` echoes, so the cleanup and exec-capability probe work.
//!
//! What sudo was handed on stdin is recorded in [`Observed`], so a test can
//! prove the password really flowed through the code under test (and so the
//! secrecy check is not vacuous).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use russh::server::{Auth, Msg, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};

/// The account password the server accepts for the SSH login.
pub const LOGIN_PASSWORD: &str = "Sudo-Server-Login-Pw-4c2e17";
/// The only password the scripted `sudo` accepts on stdin.
pub const SUDO_PASSWORD: &str = "Sudo-Server-Sudo-Pw-a9d031";

/// sudo's stderr for a rejected password, as `sudo -S -p ''` prints it.
const SUDO_REJECTED_STDERR: &str = "Sorry, try again.\nsudo: 1 incorrect password attempt\n";

/// What the server saw, shared across every connection.
#[derive(Default)]
pub struct Observed {
    /// Every exec command line, in order.
    pub commands: Vec<String>,
    /// The stdin each `sudo` invocation received, in order.
    pub sudo_stdin: Vec<String>,
    /// The in-memory file system: absolute path → contents.
    pub files: HashMap<String, Vec<u8>>,
}

/// A running server; stops accepting when dropped.
pub struct SudoSftpServer {
    /// The bound `127.0.0.1:<port>` address.
    pub addr: std::net::SocketAddr,
    /// What the server observed.
    pub observed: Arc<Mutex<Observed>>,
    accept_task: tokio::task::JoinHandle<()>,
}

impl Drop for SudoSftpServer {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

/// Start the server on an ephemeral loopback port, with `files` pre-seeded.
/// Must be called inside a Tokio runtime, which then drives the server.
pub async fn serve(files: &[(&str, &str)]) -> SudoSftpServer {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind the test SSH server");
    let addr = listener.local_addr().expect("test server address");
    let observed = Arc::new(Mutex::new(Observed::default()));
    {
        let mut obs = observed.lock().expect("observed");
        for (path, content) in files {
            obs.files
                .insert((*path).to_string(), content.as_bytes().to_vec());
        }
    }
    let config = Arc::new(russh::server::Config {
        keys: vec![russh::keys::PrivateKey::from(
            russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[11u8; 32]),
        )],
        auth_rejection_time: std::time::Duration::ZERO,
        auth_rejection_time_initial: Some(std::time::Duration::ZERO),
        ..Default::default()
    });
    let task_observed = observed.clone();
    let accept_task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let handler = ConnectionHandler {
                observed: task_observed.clone(),
                pending: HashMap::new(),
                exec: HashMap::new(),
            };
            let config = config.clone();
            tokio::spawn(async move {
                if let Ok(running) = russh::server::run_stream(config, stream, handler).await {
                    let _ = running.await;
                }
            });
        }
    });
    SudoSftpServer {
        addr,
        observed,
        accept_task,
    }
}

/// An exec channel's command and the stdin collected so far.
struct ExecState {
    command: String,
    stdin: Vec<u8>,
}

struct ConnectionHandler {
    observed: Arc<Mutex<Observed>>,
    /// Channel objects held until we know what the channel is for: the SFTP
    /// subsystem needs its stream; every other kind is answered through the
    /// handler callbacks, so its object is dropped right away (an unread
    /// channel object would otherwise fill up and stall the connection).
    pending: HashMap<ChannelId, Channel<Msg>>,
    exec: HashMap<ChannelId, ExecState>,
}

impl ConnectionHandler {
    /// Run a finished exec channel's command against the in-memory host.
    fn run_exec(&self, state: &ExecState) -> (String, String, u32) {
        let mut obs = self.observed.lock().expect("observed");
        let command = state.command.as_str();
        if command.starts_with("sudo ") {
            let stdin = String::from_utf8_lossy(&state.stdin).into_owned();
            obs.sudo_stdin.push(stdin.clone());
            if stdin != format!("{SUDO_PASSWORD}\n") {
                return (String::new(), SUDO_REJECTED_STDERR.to_string(), 1);
            }
            // `… sh <temp> <dest>`: the script moves the temp over the dest.
            let words = shell_words(command);
            let [.., temp, dest] = words.as_slice() else {
                return (String::new(), "sh: missing operand\n".into(), 2);
            };
            return match obs.files.remove(temp) {
                Some(content) => {
                    obs.files.insert(dest.clone(), content);
                    (String::new(), String::new(), 0)
                }
                None => (String::new(), format!("cat: {temp}: No such file\n"), 1),
            };
        }
        if let Some(path) = command.strip_prefix("rm -f ") {
            let words = shell_words(path);
            for word in words {
                obs.files.remove(&word);
            }
            return (String::new(), String::new(), 0);
        }
        if let Some(text) = command.strip_prefix("echo ") {
            return (format!("{text}\n"), String::new(), 0);
        }
        (String::new(), format!("sh: {command}: not found\n"), 127)
    }
}

/// Split a POSIX command line into words, as the remote shell would.
fn shell_words(line: &str) -> Vec<String> {
    shlex::split(line).unwrap_or_default()
}

impl russh::server::Handler for ConnectionHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == LOGIN_PASSWORD {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        self.pending.insert(channel.id(), channel);
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
        self.pending.remove(&channel);
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.pending.remove(&channel);
        session.channel_success(channel)?;
        session.data(channel, b"sudo-sftp-server shell ready\r\n".to_vec())?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.pending.remove(&channel);
        let command = String::from_utf8_lossy(data).into_owned();
        self.observed
            .lock()
            .expect("observed")
            .commands
            .push(command.clone());
        self.exec.insert(
            channel,
            ExecState {
                command,
                stdin: Vec::new(),
            },
        );
        session.channel_success(channel)?;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        match (name, self.pending.remove(&channel)) {
            ("sftp", Some(ch)) => {
                session.channel_success(channel)?;
                let handler = MemorySftp {
                    observed: self.observed.clone(),
                    handles: HashMap::new(),
                    next_handle: 0,
                };
                russh_sftp::server::run(ch.into_stream(), handler).await;
            }
            _ => session.channel_failure(channel)?,
        }
        Ok(())
    }

    /// Exec stdin; the shell echoes its input like a terminal.
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        match self.exec.get_mut(&channel) {
            Some(state) => state.stdin.extend_from_slice(data),
            None => session.data(channel, data.to_vec())?,
        }
        Ok(())
    }

    /// The client finished writing stdin: run the command and report back.
    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(state) = self.exec.remove(&channel) else {
            return Ok(());
        };
        let (stdout, stderr, status) = self.run_exec(&state);
        if !stdout.is_empty() {
            session.data(channel, stdout.into_bytes())?;
        }
        if !stderr.is_empty() {
            session.extended_data(channel, 1, stderr.into_bytes())?;
        }
        session.exit_status_request(channel, status)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
}

/// An SFTP server over the shared in-memory file system: enough for the
/// elevated save's temp upload (open/create, write, close) plus stat,
/// realpath and remove.
struct MemorySftp {
    observed: Arc<Mutex<Observed>>,
    /// Open handle → path.
    handles: HashMap<String, String>,
    next_handle: u64,
}

fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".to_string(),
        language_tag: "en-US".to_string(),
    }
}

impl russh_sftp::server::Handler for MemorySftp {
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
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        {
            let mut obs = self.observed.lock().expect("observed");
            let exists = obs.files.contains_key(&filename);
            if pflags.contains(OpenFlags::CREATE) {
                if pflags.contains(OpenFlags::TRUNCATE) || !exists {
                    obs.files.insert(filename.clone(), Vec::new());
                }
            } else if !exists {
                return Err(StatusCode::NoSuchFile);
            }
        }
        self.next_handle += 1;
        let handle = format!("h{}", self.next_handle);
        self.handles.insert(handle.clone(), filename);
        Ok(Handle { id, handle })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles.remove(&handle);
        Ok(ok_status(id))
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let path = self.handles.get(&handle).ok_or(StatusCode::Failure)?;
        let mut obs = self.observed.lock().expect("observed");
        let file = obs.files.entry(path.clone()).or_default();
        let start = usize::try_from(offset).map_err(|_| StatusCode::Failure)?;
        if file.len() < start + data.len() {
            file.resize(start + data.len(), 0);
        }
        file[start..start + data.len()].copy_from_slice(&data);
        Ok(ok_status(id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let path = self.handles.get(&handle).ok_or(StatusCode::Failure)?;
        let obs = self.observed.lock().expect("observed");
        let file = obs.files.get(path).ok_or(StatusCode::NoSuchFile)?;
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
        let obs = self.observed.lock().expect("observed");
        let file = obs.files.get(&path).ok_or(StatusCode::NoSuchFile)?;
        let attrs = FileAttributes {
            size: Some(file.len() as u64),
            ..Default::default()
        };
        Ok(Attrs { id, attrs })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.stat(id, path).await
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let mut obs = self.observed.lock().expect("observed");
        obs.files
            .remove(&filename)
            .map(|_| ok_status(id))
            .ok_or(StatusCode::NoSuchFile)
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let resolved = if path == "." || path.is_empty() {
            "/home/sudo-user".to_string()
        } else {
            path
        };
        Ok(Name {
            id,
            files: vec![File::dummy(resolved)],
        })
    }
}

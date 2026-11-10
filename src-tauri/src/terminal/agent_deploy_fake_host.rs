//! In-process SSH + SFTP host standing in for a remote deploy target (#5162).
//!
//! Lets the agent deploy / update / rollback tests drive the real
//! [`super::install_agent_bytes`] path — `mktemp` upload dir, SFTP upload,
//! `mkdir`/`mv`/`chmod`/`rmdir` install, `--version` verify — on every PR, with
//! no `sshd` binary, no Docker and no agent build. The client side is the real
//! russh session the desktop uses, connected over an in-memory duplex pipe.
//!
//! The host keeps an in-memory file system ([`HostState::files`]) and runs a
//! tiny interpreter for exactly the commands the deploy path issues:
//!
//! * `uname -s` / `uname -m` → `Linux` / `x86_64`;
//! * [`POSIX_PREPARE_UPLOAD_DIR_COMMAND`] → creates
//!   `~/.config/termihub-agent/updates/upload.<n>` and prints it;
//! * the POSIX install chain (`mkdir -p … && mv -f … && chmod +x … && rmdir …`),
//!   step by step with `&&` short-circuiting;
//! * `<path> --version 2>/dev/null` → runs the "binary": a file whose first line
//!   is `termihub-agent <ver>` prints that line, anything else fails like a
//!   binary that refuses to start.
//!
//! Every exec reports stderr and a real exit status, sent after EOF as OpenSSH does.
//! [`Faults`] inject the failures the tests need: an SFTP write that fails after
//! N bytes, a refused create (permission denied), a refused remove (rollback
//! failure), a cancel fired from inside the transfer, and an install step that
//! fails (an install interrupted between staging and the final rename).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::server::{Auth, Msg, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    Attrs, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};
use termihub_core::backends::ssh::handler::{SshSession, TermiHubHandler};
use tokio_util::sync::CancellationToken;

use crate::terminal::agent_install::POSIX_PREPARE_UPLOAD_DIR_COMMAND;

/// The SSH user's home directory on the fake host.
pub(super) const HOME: &str = "/home/deploy";

/// Absolute path of the default install target (`.local/bin/termihub-agent`).
pub(super) const DEFAULT_INSTALLED: &str = "/home/deploy/.local/bin/termihub-agent";

/// Faults the host injects. All default to "behave like a healthy host".
#[derive(Default)]
pub(super) struct Faults {
    /// Fail the SFTP write that would take the uploaded file past this many
    /// bytes; the bytes before it stay on the host (a half-written binary).
    pub fail_write_after: Option<usize>,
    /// Refuse every SFTP create with `PermissionDenied`.
    pub deny_create: bool,
    /// Refuse every SFTP remove with `PermissionDenied` (rollback fails).
    pub deny_remove: bool,
    /// Fire this token when the first SFTP write arrives, then hold the write
    /// back so the client sees the cancel mid-transfer.
    pub cancel_on_first_write: Option<CancellationToken>,
    /// Fail the install step whose command word matches (`"mkdir"`, `"mv"`,
    /// `"chmod"`, `"rmdir"`) with a permission error and exit status 1.
    pub fail_install_step: Option<&'static str>,
    /// Make the upload-dir `mktemp` fail (no writable config dir).
    pub fail_prepare: bool,
}

/// Everything the host holds, shared across every connection.
#[derive(Default)]
pub(super) struct HostState {
    /// The file system: absolute path → contents.
    pub files: BTreeMap<String, Vec<u8>>,
    /// Absolute paths of the directories `mkdir`/`mktemp` created.
    pub dirs: Vec<String>,
    /// Every exec command line, in order.
    pub commands: Vec<String>,
    /// Paths the host was asked to remove over SFTP, in order.
    pub sftp_removes: Vec<String>,
    pub faults: Faults,
    next_upload_dir: u32,
}

impl HostState {
    /// Paths of the files currently inside any prepared upload dir.
    pub fn staged_files(&self) -> Vec<String> {
        self.files
            .keys()
            .filter(|p| p.contains("/termihub-agent/updates/upload."))
            .cloned()
            .collect()
    }
}

/// Contents of a fake agent binary that reports `version`, padded to `size`
/// bytes so the upload spans several SFTP writes.
pub(super) fn fake_binary(version: &str, size: usize) -> Vec<u8> {
    let mut bytes = format!("termihub-agent {version}\n").into_bytes();
    bytes.resize(size.max(bytes.len()), b'#');
    bytes
}

/// A binary that crashes on start (its `--version` prints nothing, exits 1).
pub(super) fn broken_binary(size: usize) -> Vec<u8> {
    let mut bytes = b"\x7fELF not-runnable\n".to_vec();
    bytes.resize(size.max(bytes.len()), 0);
    bytes
}

/// Start a fake host with `seed` files and return a logged-in client session
/// plus the shared host state. Must run inside a multi-thread Tokio runtime.
pub(super) async fn connect(seed: &[(&str, Vec<u8>)]) -> (SshSession, Arc<Mutex<HostState>>) {
    trust_test_host_keys();
    let state = Arc::new(Mutex::new(HostState::default()));
    {
        let mut st = state.lock().expect("host state");
        for (path, content) in seed {
            st.files.insert((*path).to_string(), content.clone());
        }
    }
    let config = Arc::new(russh::server::Config {
        keys: vec![russh::keys::PrivateKey::from(
            russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[51u8; 32]),
        )],
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let handler = HostHandler {
        state: state.clone(),
        pending: HashMap::new(),
    };
    let (client_io, server_io) = tokio::io::duplex(1024 * 1024);
    tokio::spawn(async move {
        if let Ok(running) = russh::server::run_stream(config, server_io, handler).await {
            let _ = running.await;
        }
    });
    let mut session = russh::client::connect_stream(
        Arc::new(russh::client::Config::default()),
        client_io,
        TermiHubHandler::new().0,
    )
    .await
    .expect("client handshake with the fake deploy host");
    let auth = session
        .authenticate_password("deploy", "pw")
        .await
        .expect("password auth");
    assert!(auth.success(), "the fake deploy host accepts any login");
    (session, state)
}

/// Trust the in-process host's key (set-once, first registration wins).
fn trust_test_host_keys() {
    use termihub_core::backends::ssh::host_key::{
        set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
    };

    struct TrustAll;

    #[async_trait::async_trait]
    impl HostKeyVerifier for TrustAll {
        async fn verify(&self, _info: &HostKeyInfo) -> bool {
            true
        }
    }

    let _ = set_host_key_verifier(Arc::new(TrustAll));
}

/// Result of one exec: stdout, stderr, exit status.
type ExecResult = (String, String, u32);

fn ok(stdout: impl Into<String>) -> ExecResult {
    (stdout.into(), String::new(), 0)
}

fn fail(stderr: impl Into<String>, status: u32) -> ExecResult {
    (String::new(), stderr.into(), status)
}

/// Resolve a path the remote shell would see relative to the home directory.
fn resolve(path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{HOME}/{path}")
    }
}

/// Run one exec command line against the host.
fn run_exec(st: &mut HostState, command: &str) -> ExecResult {
    st.commands.push(command.to_string());
    match command {
        "uname -s" => return ok("Linux\n"),
        "uname -m" => return ok("x86_64\n"),
        _ => {}
    }
    if command == POSIX_PREPARE_UPLOAD_DIR_COMMAND {
        if st.faults.fail_prepare {
            return fail("mkdir: cannot create directory: Permission denied\n", 1);
        }
        st.next_upload_dir += 1;
        let dir = format!(
            "{HOME}/.config/termihub-agent/updates/upload.{:06}",
            st.next_upload_dir
        );
        st.dirs.push(dir.clone());
        return ok(format!("{dir}\n"));
    }
    if let Some(binary) = command.strip_suffix(" --version 2>/dev/null") {
        return run_binary(st, &resolve(binary));
    }
    if command.starts_with("mkdir -p ") {
        return run_chain(st, command);
    }
    fail(format!("sh: {command}: not found\n"), 127)
}

/// "Execute" the file at `path` with `--version`.
fn run_binary(st: &HostState, path: &str) -> ExecResult {
    let Some(content) = st.files.get(path) else {
        return fail(format!("sh: {path}: not found\n"), 127);
    };
    let first_line = String::from_utf8_lossy(content)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    if first_line.starts_with("termihub-agent ") {
        ok(format!("{first_line}\n"))
    } else {
        fail("", 1)
    }
}

/// Run an `a && b && …` chain of install steps, stopping at the first failure.
fn run_chain(st: &mut HostState, command: &str) -> ExecResult {
    for step in command.split("&&") {
        let words = shlex::split(step.trim()).unwrap_or_default();
        let Some(verb) = words.first().map(String::as_str) else {
            return fail("sh: syntax error\n", 2);
        };
        if st.faults.fail_install_step == Some(verb) {
            return fail(format!("{verb}: Permission denied\n"), 1);
        }
        let result = match (verb, words.as_slice()) {
            ("mkdir", [_, _, target]) => {
                // `mkdir -p "$(dirname X)"`: the shell expanded `$(dirname X)`.
                let dir = target
                    .strip_prefix("$(dirname ")
                    .and_then(|s| s.strip_suffix(')'))
                    .map(|x| resolve(x.rsplit_once('/').map_or(".", |(d, _)| d)))
                    .unwrap_or_else(|| resolve(target));
                st.dirs.push(dir);
                Ok(())
            }
            ("mv", [_, _, src, dst]) => match st.files.remove(&resolve(src)) {
                Some(content) => {
                    st.files.insert(resolve(dst), content);
                    Ok(())
                }
                None => Err(format!("mv: cannot stat '{src}': No such file\n")),
            },
            ("chmod", [_, _, target]) if st.files.contains_key(&resolve(target)) => Ok(()),
            ("chmod", [_, _, target]) => Err(format!("chmod: cannot access '{target}'\n")),
            ("rmdir", [_, dir]) => {
                let prefix = format!("{}/", resolve(dir));
                if st.files.keys().any(|p| p.starts_with(&prefix)) {
                    Err(format!("rmdir: failed to remove '{dir}': not empty\n"))
                } else {
                    st.dirs.retain(|d| d != &resolve(dir));
                    Ok(())
                }
            }
            _ => Err(format!("sh: {step}: unsupported\n")),
        };
        if let Err(stderr) = result {
            return fail(stderr, 1);
        }
    }
    ok("")
}

struct HostHandler {
    state: Arc<Mutex<HostState>>,
    /// Channel objects held until the SFTP subsystem request claims them.
    pending: HashMap<ChannelId, Channel<Msg>>,
}

impl russh::server::Handler for HostHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        self.pending.insert(channel.id(), channel);
        Ok(true)
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.pending.remove(&channel);
        let command = String::from_utf8_lossy(data).into_owned();
        let (stdout, stderr, status) = run_exec(&mut self.state.lock().expect("host"), &command);
        session.channel_success(channel)?;
        if !stdout.is_empty() {
            session.data(channel, stdout.into_bytes())?;
        }
        if !stderr.is_empty() {
            session.extended_data(channel, 1, stderr.into_bytes())?;
        }
        // OpenSSH's order: EOF first, then the exit status, then close.
        session.eof(channel)?;
        session.exit_status_request(channel, status)?;
        session.close(channel)?;
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
                let handler = HostSftp {
                    state: self.state.clone(),
                    handles: HashMap::new(),
                    next_handle: 0,
                };
                russh_sftp::server::run(ch.into_stream(), handler).await;
            }
            _ => session.channel_failure(channel)?,
        }
        Ok(())
    }
}

/// The SFTP subsystem over the shared in-memory file system.
struct HostSftp {
    state: Arc<Mutex<HostState>>,
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

impl russh_sftp::server::Handler for HostSftp {
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
        let path = resolve(&filename);
        {
            let mut st = self.state.lock().expect("host");
            if pflags.contains(OpenFlags::CREATE) {
                if st.faults.deny_create {
                    return Err(StatusCode::PermissionDenied);
                }
                if pflags.contains(OpenFlags::TRUNCATE) || !st.files.contains_key(&path) {
                    st.files.insert(path.clone(), Vec::new());
                }
            } else if !st.files.contains_key(&path) {
                return Err(StatusCode::NoSuchFile);
            }
        }
        self.next_handle += 1;
        let handle = format!("h{}", self.next_handle);
        self.handles.insert(handle.clone(), path);
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
        let cancel = self
            .state
            .lock()
            .expect("host")
            .faults
            .cancel_on_first_write
            .take();
        if let Some(token) = cancel {
            token.cancel();
            // Hold the write back so the client observes the cancel mid-transfer.
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let path = self
            .handles
            .get(&handle)
            .ok_or(StatusCode::Failure)?
            .clone();
        let mut st = self.state.lock().expect("host");
        let start = usize::try_from(offset).map_err(|_| StatusCode::Failure)?;
        let fail_after = st.faults.fail_write_after;
        // A file removed while a write was in flight stays removed.
        let file = st.files.get_mut(&path).ok_or(StatusCode::NoSuchFile)?;
        let end = start + data.len();
        let keep = match fail_after {
            Some(limit) if end > limit => limit.saturating_sub(start).min(data.len()),
            _ => data.len(),
        };
        if file.len() < start + keep {
            file.resize(start + keep, 0);
        }
        file[start..start + keep].copy_from_slice(&data[..keep]);
        if keep < data.len() {
            return Err(StatusCode::Failure);
        }
        Ok(ok_status(id))
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let st = self.state.lock().expect("host");
        let file = st
            .files
            .get(&resolve(&path))
            .ok_or(StatusCode::NoSuchFile)?;
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
        let path = resolve(&filename);
        let mut st = self.state.lock().expect("host");
        st.sftp_removes.push(path.clone());
        if st.faults.deny_remove {
            return Err(StatusCode::PermissionDenied);
        }
        st.files
            .remove(&path)
            .map(|_| ok_status(id))
            .ok_or(StatusCode::NoSuchFile)
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let resolved = if path == "." || path.is_empty() {
            HOME.to_string()
        } else {
            resolve(&path)
        };
        Ok(Name {
            id,
            files: vec![File::dummy(resolved)],
        })
    }
}

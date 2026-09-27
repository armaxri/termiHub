/// Shared SSH remote execution and SFTP upload utilities.
///
/// All functions accept a [`SshSession`] (russh `Handle`) and bridge the
/// async russh API to synchronous callers via `block_in_place` + `block_on`.
///
/// Every operation is bounded (#3698): an SSH server that accepts the login
/// and then stops responding must never block a caller forever. The connect
/// itself is already bounded by [`SshConfig::connect_timeout`]
/// (`connect_and_authenticate`); the helpers here bound everything that happens
/// on the established session — channel open, exec and output read for
/// [`run_remote_command`], and subsystem open plus every chunk of an SFTP
/// transfer for the upload/remove helpers. On a deadline they close what they
/// opened and return the typed [`TerminalError::Timeout`], whose message the UI
/// shows verbatim.
///
/// [`SshConfig::connect_timeout`]: crate::terminal::backend::SshConfig
use std::fmt;
use std::future::Future;
use std::time::Duration;

use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use tracing::{debug, warn};

use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::backends::ssh::sftp;

use crate::utils::errors::TerminalError;

// ── Deadlines ────────────────────────────────────────────────────────

/// Default overall deadline for [`run_remote_command`]: channel open, exec and
/// reading all output. Every current caller runs a short probe or install step
/// (`uname`, `--version`, `mkdir && mv && chmod`), so 30 s is generous for a
/// slow host yet bounds a frozen one. Callers with a legitimately long command
/// use [`run_remote_command_with_timeout`].
pub const DEFAULT_REMOTE_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Default *stall* deadline for SFTP helpers: the longest any single step
/// (subsystem open, file create, one chunk write, remove) may take. A transfer
/// that keeps making progress is never cut off, however large; one whose server
/// stops acknowledging fails after this long.
pub const DEFAULT_SFTP_STALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Chunk size for SFTP uploads, so the stall deadline applies per chunk rather
/// than to the whole (possibly multi-MB) agent binary.
const SFTP_UPLOAD_CHUNK: usize = 256 * 1024;

/// Upper bound on the best-effort channel close after a timeout, so tearing
/// down a frozen session can never itself hang.
const CLOSE_GRACE: Duration = Duration::from_secs(1);

/// Run `fut` with a deadline, mapping expiry to [`TerminalError::timed_out`].
async fn bounded<T>(
    limit: Duration,
    what: &str,
    fut: impl Future<Output = Result<T, TerminalError>>,
) -> Result<T, TerminalError> {
    match tokio::time::timeout(limit, fut).await {
        Ok(result) => result,
        Err(_) => Err(TerminalError::timed_out(what, limit)),
    }
}

/// Drive `fut` to completion from a synchronous caller on a Tokio worker or
/// `spawn_blocking` thread (see `connect_and_authenticate` for the #828
/// runtime-context requirement).
fn block_on<T>(fut: impl Future<Output = T>) -> T {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(fut))
}

// ── Remote command execution ─────────────────────────────────────────

/// Run a single command on the remote host and return trimmed stdout.
///
/// Bounded by [`DEFAULT_REMOTE_COMMAND_TIMEOUT`]; see
/// [`run_remote_command_with_timeout`].
pub fn run_remote_command(session: &SshSession, command: &str) -> Result<String, TerminalError> {
    run_remote_command_with_timeout(session, command, DEFAULT_REMOTE_COMMAND_TIMEOUT)
}

/// Run a single command on the remote host and return trimmed stdout, failing
/// with [`TerminalError::Timeout`] if channel open, exec and reading the output
/// to EOF do not all complete within `timeout` (#3698). On timeout the exec
/// channel (if it was opened) is closed so nothing is left running on the
/// session.
pub fn run_remote_command_with_timeout(
    session: &SshSession,
    command: &str,
    timeout: Duration,
) -> Result<String, TerminalError> {
    debug!(command, ?timeout, "Executing remote command");
    let result = block_on(run_remote_command_async(session, command, timeout))?;
    debug!(command, result = %result, "Remote command completed");
    Ok(result)
}

/// Async core of [`run_remote_command_with_timeout`].
async fn run_remote_command_async(
    session: &SshSession,
    command: &str,
    timeout: Duration,
) -> Result<String, TerminalError> {
    // The channel lives outside the timed future so a timeout can still close
    // it after the future is dropped.
    let mut opened: Option<russh::Channel<russh::client::Msg>> = None;
    let outcome = tokio::time::timeout(timeout, async {
        let channel = opened.insert(
            session
                .channel_open_session()
                .await
                .map_err(|e| TerminalError::SshError(format!("channel open failed: {e}")))?,
        );

        channel
            .exec(false, command)
            .await
            .map_err(|e| TerminalError::SshError(format!("exec failed: {e}")))?;

        let mut output = String::new();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { ref data }) => {
                    if let Ok(s) = std::str::from_utf8(data) {
                        output.push_str(s);
                    }
                }
                Some(ChannelMsg::ExitStatus { .. }) => {}
                Some(ChannelMsg::Eof) | None => break,
                _ => {}
            }
        }
        Ok::<String, TerminalError>(output.trim().to_string())
    })
    .await;

    match outcome {
        Ok(result) => result,
        Err(_) => {
            warn!(
                command,
                ?timeout,
                "Remote command timed out; closing channel"
            );
            if let Some(channel) = opened.take() {
                let _ = tokio::time::timeout(CLOSE_GRACE, channel.close()).await;
            }
            Err(TerminalError::timed_out("Remote command", timeout))
        }
    }
}

/// Map a probe command's result so a **timeout propagates** while any other
/// failure degrades to empty output (the probe callers treat "no output" as
/// "not this platform"). Without this, a frozen server would be probed again
/// and again, each probe waiting out its own deadline.
fn probe_output(result: Result<String, TerminalError>) -> Result<String, TerminalError> {
    match result {
        Err(e) if e.is_timeout() => Err(e),
        other => Ok(other.unwrap_or_default()),
    }
}

/// Detect the remote OS and architecture via exec channel.
///
/// Tries POSIX `uname` first — it works on Linux, macOS, and MinGW/MSYS/Cygwin
/// shells on Windows. When `uname` is unavailable (the typical case for a
/// Windows host whose default OpenSSH shell is `cmd.exe` or PowerShell), falls
/// back to probing Windows environment variables. Probing `uname` first and
/// only treating recognized output as authoritative ensures a Windows host is
/// never misdetected as Linux by the caller's artifact lookup.
///
/// A timeout on any probe is returned as [`TerminalError::Timeout`] rather than
/// swallowed, so a frozen server fails once instead of per probe (#3698).
pub fn detect_remote_info(session: &SshSession) -> Result<(String, String), TerminalError> {
    let uname_os = probe_output(run_remote_command(session, "uname -s"))?;
    if is_recognized_uname_os(&uname_os) {
        let arch = run_remote_command(session, "uname -m")?;
        debug!(os = %uname_os, arch, "Detected remote system info via uname");
        return Ok((uname_os, arch));
    }

    // No usable `uname` output — probe for a Windows host (cmd.exe / PowerShell).
    if let Some((os, arch)) = detect_windows_info(session)? {
        debug!(os, arch, "Detected remote Windows system info");
        return Ok((os, arch));
    }

    // Host undetermined: surface the raw `uname` output (which may be empty or
    // an error string) so the caller maps it to an unsupported artifact rather
    // than silently treating it as Linux.
    let arch = probe_output(run_remote_command(session, "uname -m"))?;
    debug!(os = %uname_os, arch, "Remote system info undetermined");
    Ok((uname_os, arch))
}

/// Probe a remote Windows host for its CPU architecture.
///
/// Works whether the default OpenSSH shell is `cmd.exe` (which expands
/// `%PROCESSOR_ARCHITECTURE%`) or PowerShell (which expands
/// `$env:PROCESSOR_ARCHITECTURE`). Returns `Some(("Windows_NT", arch))` on
/// success, `None` when neither probe yields an architecture, and propagates a
/// probe timeout (#3698).
fn detect_windows_info(session: &SshSession) -> Result<Option<(String, String)>, TerminalError> {
    // cmd.exe expands `%VAR%`; PowerShell leaves it literal.
    let cmd_arch = probe_output(run_remote_command(session, "echo %PROCESSOR_ARCHITECTURE%"))?;
    if is_windows_arch(&cmd_arch) {
        return Ok(Some(("Windows_NT".to_string(), cmd_arch)));
    }
    // PowerShell expands `$env:VAR`; cmd.exe leaves it literal.
    let ps_arch = probe_output(run_remote_command(
        session,
        "echo $env:PROCESSOR_ARCHITECTURE",
    ))?;
    if is_windows_arch(&ps_arch) {
        return Ok(Some(("Windows_NT".to_string(), ps_arch)));
    }
    Ok(None)
}

/// Returns `true` if a `uname -s` result identifies an OS we recognize: Linux,
/// macOS, or a MinGW/MSYS/Cygwin shell on Windows.
///
/// Rejects the error text a Windows `cmd.exe`/PowerShell host prints when
/// `uname` is absent, so detection can fall through to Windows env probing.
pub fn is_recognized_uname_os(os: &str) -> bool {
    os == "Linux" || os == "Darwin" || crate::terminal::agent_binary::is_windows_os(os)
}

/// Returns `true` if the string looks like a Windows `PROCESSOR_ARCHITECTURE`
/// value (e.g. `AMD64`, `ARM64`, `x86`).
///
/// Used to confirm a Windows host and to reject an unexpanded
/// `%PROCESSOR_ARCHITECTURE%` / `$env:PROCESSOR_ARCHITECTURE` literal echoed
/// back by the wrong shell.
pub fn is_windows_arch(arch: &str) -> bool {
    matches!(
        arch.to_ascii_lowercase().as_str(),
        "amd64" | "x86_64" | "arm64" | "aarch64" | "x86" | "ia64"
    )
}

// ── SFTP upload ──────────────────────────────────────────────────────

/// Upload a local file to a remote path via SFTP.
///
/// Opens a fresh SFTP subsystem on the session for the transfer. This avoids
/// sharing a single SFTP session across threads. Every step is bounded by
/// [`DEFAULT_SFTP_STALL_TIMEOUT`] (#3698).
pub fn upload_via_sftp(
    session: &SshSession,
    local_path: &str,
    remote_path: &str,
) -> Result<u64, TerminalError> {
    debug!(local_path, remote_path, "Uploading file via SFTP");
    block_on(async {
        let data = tokio::fs::read(local_path)
            .await
            .map_err(|e| TerminalError::SpawnFailed(format!("open local file failed: {e}")))?;
        upload_bytes_async(session, &data, remote_path, DEFAULT_SFTP_STALL_TIMEOUT).await
    })
}

/// Upload in-memory bytes to a remote path via SFTP.
///
/// Bounded per step by [`DEFAULT_SFTP_STALL_TIMEOUT`] (#3698).
pub fn upload_bytes_via_sftp(
    session: &SshSession,
    data: &[u8],
    remote_path: &str,
) -> Result<u64, TerminalError> {
    debug!(remote_path, size = data.len(), "Uploading bytes via SFTP");
    block_on(upload_bytes_async(
        session,
        data,
        remote_path,
        DEFAULT_SFTP_STALL_TIMEOUT,
    ))
}

/// Async core of the upload helpers. `stall` bounds each step — subsystem
/// open, create, and every [`SFTP_UPLOAD_CHUNK`] write — so a transfer that
/// keeps progressing is never cut off while one that stops is (#3698).
async fn upload_bytes_async(
    session: &SshSession,
    data: &[u8],
    remote_path: &str,
    stall: Duration,
) -> Result<u64, TerminalError> {
    use tokio::io::AsyncWriteExt;

    let sftp = bounded(stall, "Opening the SFTP session", open_sftp(session)).await?;

    let mut remote = bounded(stall, "Creating the remote file", async {
        sftp.create(remote_path)
            .await
            .map_err(|e| TerminalError::SshError(format!("create remote file failed: {e}")))
    })
    .await?;

    for chunk in data.chunks(SFTP_UPLOAD_CHUNK) {
        bounded(stall, "Uploading via SFTP", async {
            remote
                .write_all(chunk)
                .await
                .map_err(|e| TerminalError::SshError(format!("write failed: {e}")))
        })
        .await?;
    }

    Ok(data.len() as u64)
}

/// Remove a remote file over SFTP (best-effort rollback of a partial upload).
///
/// SFTP works uniformly across POSIX and Windows hosts, so this avoids the shell
/// quoting / `rm` vs `del` differences a remote `exec` would incur. A missing
/// file is not an error the caller needs to distinguish — it returns whatever
/// the server reports. Bounded by [`DEFAULT_SFTP_STALL_TIMEOUT`] (#3698).
pub fn remove_via_sftp(session: &SshSession, remote_path: &str) -> Result<(), TerminalError> {
    debug!(remote_path, "Removing remote file via SFTP");
    block_on(bounded(
        DEFAULT_SFTP_STALL_TIMEOUT,
        "Removing the remote file",
        async {
            let sftp = open_sftp(session).await?;
            sftp.remove_file(remote_path)
                .await
                .map_err(|e| TerminalError::SshError(format!("SFTP remove failed: {e}")))
        },
    ))
}

/// Open a fresh SFTP subsystem on the given session.
///
/// Delegates to the shared core mechanism so every SFTP path opens the
/// subsystem the same way (#2075).
async fn open_sftp(session: &SshSession) -> Result<SftpSession, TerminalError> {
    sftp::open_sftp_subsystem(session)
        .await
        .map_err(|e| TerminalError::SshError(e.to_string()))
}

// ── ELF architecture detection ───────────────────────────────────────

/// CPU architecture of an ELF binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElfArch {
    X86,
    X86_64,
    Arm,
    Aarch64,
    Unknown(u16),
}

impl fmt::Display for ElfArch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ElfArch::X86 => write!(f, "x86 (i386)"),
            ElfArch::X86_64 => write!(f, "x86_64"),
            ElfArch::Arm => write!(f, "arm"),
            ElfArch::Aarch64 => write!(f, "aarch64"),
            ElfArch::Unknown(id) => write!(f, "unknown (e_machine=0x{:04x})", id),
        }
    }
}

/// ELF magic bytes: `\x7fELF`
const ELF_MAGIC: [u8; 4] = [0x7f, b'E', b'L', b'F'];

/// Read the ELF header of a local binary and return its architecture.
pub fn detect_binary_arch(path: &str) -> Result<ElfArch, TerminalError> {
    use std::io::Read;

    let mut file = std::fs::File::open(path)
        .map_err(|e| TerminalError::SpawnFailed(format!("open binary failed: {e}")))?;

    let mut header = [0u8; 20];
    file.read_exact(&mut header)
        .map_err(|e| TerminalError::SpawnFailed(format!("read binary header failed: {e}")))?;

    if header[0..4] != ELF_MAGIC {
        return Err(TerminalError::SpawnFailed(
            "Binary is not a Linux ELF executable (wrong magic bytes). \
             Make sure you selected a Linux binary, not a macOS or Windows one."
                .to_string(),
        ));
    }

    let little_endian = header[5] == 1;
    let e_machine = if little_endian {
        u16::from_le_bytes([header[18], header[19]])
    } else {
        u16::from_be_bytes([header[18], header[19]])
    };

    let arch = match e_machine {
        0x03 => ElfArch::X86,
        0x3E => ElfArch::X86_64,
        0x28 => ElfArch::Arm,
        0xB7 => ElfArch::Aarch64,
        other => ElfArch::Unknown(other),
    };
    debug!(path, %arch, "Detected binary architecture");
    Ok(arch)
}

/// Map `uname -m` output to the expected ELF architecture.
pub fn expected_arch_for_uname(uname_arch: &str) -> Option<ElfArch> {
    match uname_arch {
        "x86_64" | "amd64" => Some(ElfArch::X86_64),
        "aarch64" | "arm64" => Some(ElfArch::Aarch64),
        "armv7l" | "armv6l" | "armhf" => Some(ElfArch::Arm),
        "i686" | "i386" | "i586" => Some(ElfArch::X86),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_elf_header(e_machine: u16, little_endian: bool) -> Vec<u8> {
        let mut h = vec![0u8; 20];
        h[0] = 0x7f;
        h[1] = b'E';
        h[2] = b'L';
        h[3] = b'F';
        h[4] = 2;
        h[5] = if little_endian { 1 } else { 2 };
        let machine_bytes = if little_endian {
            e_machine.to_le_bytes()
        } else {
            e_machine.to_be_bytes()
        };
        h[18] = machine_bytes[0];
        h[19] = machine_bytes[1];
        h
    }

    #[test]
    fn detect_binary_arch_x86_64() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test-binary");
        std::fs::write(&path, make_elf_header(0x3E, true)).unwrap();
        let arch = detect_binary_arch(path.to_str().unwrap()).unwrap();
        assert_eq!(arch, ElfArch::X86_64);
    }

    #[test]
    fn detect_binary_arch_aarch64() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test-binary");
        std::fs::write(&path, make_elf_header(0xB7, true)).unwrap();
        let arch = detect_binary_arch(path.to_str().unwrap()).unwrap();
        assert_eq!(arch, ElfArch::Aarch64);
    }

    #[test]
    fn detect_binary_arch_arm32() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test-binary");
        std::fs::write(&path, make_elf_header(0x28, true)).unwrap();
        let arch = detect_binary_arch(path.to_str().unwrap()).unwrap();
        assert_eq!(arch, ElfArch::Arm);
    }

    #[test]
    fn detect_binary_arch_x86() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test-binary");
        std::fs::write(&path, make_elf_header(0x03, true)).unwrap();
        let arch = detect_binary_arch(path.to_str().unwrap()).unwrap();
        assert_eq!(arch, ElfArch::X86);
    }

    #[test]
    fn detect_binary_arch_big_endian() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test-binary");
        std::fs::write(&path, make_elf_header(0x3E, false)).unwrap();
        let arch = detect_binary_arch(path.to_str().unwrap()).unwrap();
        assert_eq!(arch, ElfArch::X86_64);
    }

    #[test]
    fn detect_binary_arch_not_elf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-elf");
        std::fs::write(&path, b"\xcf\xfa\xed\xfe0000000000000000").unwrap();
        let result = detect_binary_arch(path.to_str().unwrap());
        assert!(result.is_err());
        let err_msg = format!("{}", result.unwrap_err());
        assert!(err_msg.contains("not a Linux ELF executable"));
    }

    #[test]
    fn detect_binary_arch_file_too_small() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tiny");
        std::fs::write(&path, b"\x7fELF").unwrap();
        let result = detect_binary_arch(path.to_str().unwrap());
        assert!(result.is_err());
    }

    #[test]
    fn detect_binary_arch_missing_file() {
        let result = detect_binary_arch("/nonexistent/path/binary");
        assert!(result.is_err());
    }

    #[test]
    fn is_recognized_uname_os_accepts_known() {
        assert!(is_recognized_uname_os("Linux"));
        assert!(is_recognized_uname_os("Darwin"));
        assert!(is_recognized_uname_os("MINGW64_NT-10.0-19045"));
        assert!(is_recognized_uname_os("MSYS_NT-10.0"));
        assert!(is_recognized_uname_os("CYGWIN_NT-10.0"));
    }

    #[test]
    fn is_recognized_uname_os_rejects_missing_uname() {
        // cmd.exe / PowerShell error text when `uname` is not installed.
        assert!(!is_recognized_uname_os(
            "'uname' is not recognized as an internal or external command,"
        ));
        assert!(!is_recognized_uname_os(
            "uname : The term 'uname' is not recognized as the name of a cmdlet"
        ));
        assert!(!is_recognized_uname_os(""));
    }

    #[test]
    fn is_windows_arch_accepts_processor_architecture_values() {
        assert!(is_windows_arch("AMD64"));
        assert!(is_windows_arch("amd64"));
        assert!(is_windows_arch("ARM64"));
        assert!(is_windows_arch("x86_64"));
        assert!(is_windows_arch("aarch64"));
        assert!(is_windows_arch("x86"));
    }

    #[test]
    fn is_windows_arch_rejects_unexpanded_or_empty() {
        // PowerShell echoes a cmd-style `%VAR%` literally; cmd echoes `$env:VAR`
        // literally — neither is a real architecture.
        assert!(!is_windows_arch("%PROCESSOR_ARCHITECTURE%"));
        assert!(!is_windows_arch("$env:PROCESSOR_ARCHITECTURE"));
        assert!(!is_windows_arch(""));
    }

    #[test]
    fn expected_arch_for_uname_known_values() {
        assert_eq!(expected_arch_for_uname("x86_64"), Some(ElfArch::X86_64));
        assert_eq!(expected_arch_for_uname("amd64"), Some(ElfArch::X86_64));
        assert_eq!(expected_arch_for_uname("aarch64"), Some(ElfArch::Aarch64));
        assert_eq!(expected_arch_for_uname("arm64"), Some(ElfArch::Aarch64));
        assert_eq!(expected_arch_for_uname("armv7l"), Some(ElfArch::Arm));
        assert_eq!(expected_arch_for_uname("armv6l"), Some(ElfArch::Arm));
        assert_eq!(expected_arch_for_uname("armhf"), Some(ElfArch::Arm));
        assert_eq!(expected_arch_for_uname("i686"), Some(ElfArch::X86));
        assert_eq!(expected_arch_for_uname("i386"), Some(ElfArch::X86));
        assert_eq!(expected_arch_for_uname("i586"), Some(ElfArch::X86));
    }

    #[test]
    fn expected_arch_for_uname_unknown() {
        assert_eq!(expected_arch_for_uname("sparc64"), None);
        assert_eq!(expected_arch_for_uname("ppc64le"), None);
        assert_eq!(expected_arch_for_uname(""), None);
    }

    #[test]
    fn elf_arch_display() {
        assert_eq!(format!("{}", ElfArch::X86_64), "x86_64");
        assert_eq!(format!("{}", ElfArch::Aarch64), "aarch64");
        assert_eq!(format!("{}", ElfArch::Arm), "arm");
        assert_eq!(format!("{}", ElfArch::X86), "x86 (i386)");
        assert_eq!(
            format!("{}", ElfArch::Unknown(0xFF)),
            "unknown (e_machine=0x00ff)"
        );
    }

    // ── Frozen-server timeout tests (#3698) ──────────────────────────────
    //
    // An in-process russh server over a `tokio::io::duplex` pipe (no sockets,
    // no Docker) that completes the handshake and accepts the login, then
    // freezes in a chosen way. Each test drives the real sync helper from
    // `spawn_blocking` (its production context, #828) under an outer watchdog,
    // so a regression that drops the deadline fails the test instead of
    // hanging the suite.

    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    use russh::server::{Auth, Msg as ServerMsg, Session};
    use russh::{Channel, ChannelId};
    use termihub_core::backends::ssh::handler::TermiHubHandler;

    /// How the fake server behaves once the client is logged in.
    #[derive(Clone, Copy)]
    enum Freeze {
        /// Never answers the channel-open request (the whole connection
        /// handler stalls, like a server that hangs right after login).
        AtChannelOpen,
        /// Opens the channel and acknowledges `exec`, then never sends output,
        /// EOF or exit status.
        AfterExec,
        /// Not frozen: answers `exec` with `hello` and closes (control case).
        Never,
    }

    struct FrozenServer {
        freeze: Freeze,
        /// Set when the client closes the exec channel.
        saw_close: Arc<AtomicBool>,
    }

    impl russh::server::Handler for FrozenServer {
        type Error = russh::Error;

        async fn auth_password(&mut self, _user: &str, _pw: &str) -> Result<Auth, Self::Error> {
            Ok(Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<ServerMsg>,
            _session: &mut Session,
        ) -> Result<bool, Self::Error> {
            if let Freeze::AtChannelOpen = self.freeze {
                std::future::pending::<()>().await;
            }
            Ok(true)
        }

        async fn exec_request(
            &mut self,
            channel: ChannelId,
            _data: &[u8],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            if let Freeze::Never = self.freeze {
                session.data(channel, b"hello\n".to_vec())?;
                session.exit_status_request(channel, 0)?;
                session.eof(channel)?;
                session.close(channel)?;
            }
            Ok(())
        }

        async fn channel_close(
            &mut self,
            _channel: ChannelId,
            _session: &mut Session,
        ) -> Result<(), Self::Error> {
            self.saw_close.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    /// Start a fake server and return a logged-in client session plus the
    /// server's "client closed the channel" flag.
    async fn frozen_session(freeze: Freeze) -> (SshSession, Arc<AtomicBool>) {
        trust_fixture_host_keys();
        let key = russh::keys::PrivateKey::from(
            russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[9u8; 32]),
        );
        let server_config = Arc::new(russh::server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let saw_close = Arc::new(AtomicBool::new(false));
        let handler = FrozenServer {
            freeze,
            saw_close: saw_close.clone(),
        };
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        tokio::spawn(async move {
            if let Ok(running) = russh::server::run_stream(server_config, server_io, handler).await
            {
                let _ = running.await;
            }
        });
        let mut session = russh::client::connect_stream(
            Arc::new(russh::client::Config::default()),
            client_io,
            TermiHubHandler::new().0,
        )
        .await
        .expect("client handshake");
        let auth = session
            .authenticate_password("user", "pw")
            .await
            .expect("password auth");
        assert!(auth.success(), "fake server must accept the login");
        (session, saw_close)
    }

    /// Short per-call deadline for the tests, and the outer watchdog that
    /// turns a missing deadline into a failure rather than a hang.
    const TEST_DEADLINE: Duration = Duration::from_millis(500);
    const WATCHDOG: Duration = Duration::from_secs(10);

    /// Run a sync helper on a blocking-pool thread under the watchdog, and
    /// return its result with the elapsed time.
    async fn run_guarded<T: Send + 'static>(
        f: impl FnOnce() -> Result<T, TerminalError> + Send + 'static,
    ) -> (Result<T, TerminalError>, Duration) {
        let started = Instant::now();
        let joined = tokio::time::timeout(WATCHDOG, tokio::task::spawn_blocking(f))
            .await
            .expect("helper hung past the watchdog — no deadline applied (#3698)")
            .expect("spawn_blocking join");
        (joined, started.elapsed())
    }

    fn assert_timed_out<T: std::fmt::Debug>(result: Result<T, TerminalError>, elapsed: Duration) {
        let err = result.expect_err("a frozen server must fail, not succeed");
        assert!(err.is_timeout(), "expected a typed timeout, got {err:?}");
        assert_eq!(err.code(), crate::utils::errors::IpcErrorCode::Timeout);
        assert!(
            err.to_string().contains("stopped responding"),
            "message should explain the timeout: {err}"
        );
        assert!(
            elapsed < TEST_DEADLINE + Duration::from_secs(3),
            "returned too late: {elapsed:?}"
        );
        assert!(
            elapsed >= TEST_DEADLINE,
            "returned before the deadline: {elapsed:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_remote_command_times_out_when_server_freezes_at_channel_open() {
        let (session, _) = frozen_session(Freeze::AtChannelOpen).await;
        let (result, elapsed) = run_guarded(move || {
            run_remote_command_with_timeout(&session, "uname -s", TEST_DEADLINE)
        })
        .await;
        assert_timed_out(result, elapsed);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_remote_command_times_out_and_closes_channel_when_output_never_arrives() {
        let (session, saw_close) = frozen_session(Freeze::AfterExec).await;
        let (result, elapsed) = run_guarded(move || {
            let r = run_remote_command_with_timeout(&session, "uname -s", TEST_DEADLINE);
            // Keep the session alive until the close has been sent.
            drop(session);
            r
        })
        .await;
        assert_timed_out(result, elapsed);

        // The timed-out exec channel is closed, not leaked on the session.
        let deadline = Instant::now() + Duration::from_secs(3);
        while !saw_close.load(Ordering::SeqCst) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            saw_close.load(Ordering::SeqCst),
            "the timed-out exec channel must be closed"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_remote_command_returns_output_from_a_responsive_server() {
        let (session, _) = frozen_session(Freeze::Never).await;
        let (result, _) = run_guarded(move || {
            run_remote_command_with_timeout(&session, "uname -s", Duration::from_secs(5))
        })
        .await;
        assert_eq!(result.expect("responsive server"), "hello");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn probe_on_a_frozen_server_propagates_the_timeout() {
        // A probe on a frozen host must surface the timeout (not be swallowed
        // into "unknown OS" and re-probed, each probe waiting out a deadline).
        let (session, _) = frozen_session(Freeze::AfterExec).await;
        let (result, elapsed) = run_guarded(move || {
            probe_output(run_remote_command_with_timeout(
                &session,
                "uname -s",
                TEST_DEADLINE,
            ))
        })
        .await;
        assert_timed_out(result, elapsed);
    }

    #[test]
    fn probe_output_degrades_non_timeout_errors_to_empty() {
        let degraded = probe_output(Err(TerminalError::SshError("exec failed".into())));
        assert_eq!(degraded.expect("non-timeout degrades"), "");
        let timeout = probe_output(Err(TerminalError::timed_out("x", TEST_DEADLINE)));
        assert!(timeout.expect_err("timeout propagates").is_timeout());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sftp_upload_times_out_when_server_freezes() {
        let (session, _) = frozen_session(Freeze::AtChannelOpen).await;
        let (result, elapsed) = run_guarded(move || {
            block_on(upload_bytes_async(
                &session,
                b"payload",
                "/tmp/never",
                TEST_DEADLINE,
            ))
        })
        .await;
        assert_timed_out(result, elapsed);
    }

    // ── Docker-backed integration test ───────────────────────────────────
    //
    // Exercises the real agent-deploy SFTP path (`connect_and_authenticate` +
    // `upload_via_sftp` + `run_remote_command`) against a live SSH server. These
    // helpers are the exact #828/#837 crash surface: they bridge async russh to
    // sync callers via `block_in_place` + `Handle::current()`, which require a
    // multi-threaded Tokio runtime worker context. The test runs them from
    // `spawn_blocking` (the context the #837 fix establishes for the agent-setup
    // background phase), so a regression that reintroduces the bad thread context
    // — or breaks the SFTP upload itself — fails here.
    //
    // Lives in-crate (rather than `core/tests/`) because these helpers are in the
    // desktop crate's private `utils` module. Self-skips when the container is not
    // up, mirroring the `require_docker!` convention in `core/tests/common`.
    // Bring the container up with:
    //   docker compose -f tests/docker/docker-compose.yml up -d ssh-password
    //
    // The test is pinned to **password auth** against the `ssh-password` container.
    // The port is per-checkout offset aware (see below) so parallel checkouts each
    // target *their own* ssh-password container instead of colliding on the shared
    // base 2201 (#2448), and every upload targets a UUID-suffixed remote path so
    // concurrent tests never collide on the remote `/tmp` file. (The per-checkout
    // `dev_agent_port` sshd from `dev.local.json` is key-auth only —
    // `PasswordAuthentication no` — so it is deliberately not a target here.)

    /// Base host port of the shared `ssh-password` container (`tests/docker`).
    const DEFAULT_SSH_PASSWORD_PORT: u16 = 2201;

    /// Resolve the `ssh-password` container port (per-checkout offset aware),
    /// matching `core/tests/common`'s `resolve_port` / `port_ssh_password` and
    /// `src-tauri/tests/sftp_transfer.rs`'s `sftp_stress_port`. An explicit
    /// `TERMIHUB_TEST_SSH_PASSWORD_PORT` wins; otherwise the base plus
    /// `TERMIHUB_TEST_PORT_OFFSET` (default offset `0`, i.e. historical 2201).
    /// Both env vars are exported from this checkout's `dev.local.json` by
    /// `scripts/internal/dev-local-env.sh` — see `docs/testing.md` → "Parallel
    /// test isolation". Without them (a lone checkout / bare `cargo test`) the
    /// port falls back to 2201, so single-checkout behaviour is unchanged.
    fn ssh_password_port() -> u16 {
        if let Some(p) = std::env::var("TERMIHUB_TEST_SSH_PASSWORD_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
        {
            return p;
        }
        let offset: u16 = std::env::var("TERMIHUB_TEST_PORT_OFFSET")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        DEFAULT_SSH_PASSWORD_PORT + offset
    }

    /// Register a process-wide host-key verifier that trusts the local Docker
    /// fixture containers, so this test connects deterministically under the
    /// strict default host-key policy (#1969, #2032). Opening a session goes
    /// through the same strict host-key path as the rest of the app: with no
    /// verifier registered it trusts only keys already in the runner's
    /// `~/.ssh/known_hosts` and refuses everything else with "Unknown server
    /// key". CI runners (and any freshly-(re)built fixture image) never have the
    /// generated fixture key recorded, so the handshake fails pre-auth (#2105).
    /// This test connects only to the loopback `ssh-password` fixture, where
    /// there is no man-in-the-middle to guard against, so a test-only verifier
    /// that trusts every fixture key is safe and deterministic. Mirrors core's
    /// `trust_fixture_host_keys()` (`core/tests/common/mod.rs`) and the sibling
    /// desktop `src-tauri/tests/sftp_transfer.rs`. Registration is set-once and
    /// idempotent (first call wins), so calling it here is harmless.
    fn trust_fixture_host_keys() {
        use std::sync::Arc;
        use termihub_core::backends::ssh::host_key::{
            set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
        };

        struct TrustLocalFixtures;

        #[async_trait::async_trait]
        impl HostKeyVerifier for TrustLocalFixtures {
            async fn verify(&self, _info: &HostKeyInfo) -> bool {
                true
            }
        }

        // First registration wins; any later call is a harmless no-op.
        let _ = set_host_key_verifier(Arc::new(TrustLocalFixtures));
    }

    /// Returns `true` if a TCP connection to the SSH server succeeds quickly.
    fn ssh_port_reachable(port: u16) -> bool {
        use std::net::TcpStream;
        use std::time::Duration;
        format!("127.0.0.1:{port}")
            .parse()
            .ok()
            .and_then(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok())
            .is_some()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn agent_deploy_sftp_upload_round_trips_over_real_ssh() {
        let port = ssh_password_port();
        if !ssh_port_reachable(port) {
            eprintln!(
                "SKIPPED: ssh-password container not reachable on port {port} \
                 (start with: docker compose -f tests/docker/docker-compose.yml up -d ssh-password)"
            );
            return;
        }

        // Trust the loopback fixture host key before connecting, so the strict
        // default host-key policy (#1969) does not refuse the fixture container
        // with "Unknown server key" (#2032/#2105).
        trust_fixture_host_keys();

        // Run the whole deploy SFTP path on a `spawn_blocking` thread, exactly as
        // the agent-setup background phase now does (#837). This is the context
        // `block_in_place` requires; a raw `std::thread` would abort the process.
        let result = tokio::task::spawn_blocking(move || {
            use crate::utils::ssh_auth::connect_and_authenticate;

            // Pinned to password auth against the `ssh-password` container.
            let config = crate::terminal::backend::SshConfig {
                host: "127.0.0.1".to_string(),
                port,
                username: "testuser".to_string(),
                auth_method: "password".to_string(),
                password: Some("testpass".to_string()),
                ..Default::default()
            };

            let session = connect_and_authenticate(&config)?;

            // Upload a payload to a unique remote path, then read it back to
            // confirm the bytes landed intact — the same SFTP code path the agent
            // binary upload uses. The UUID suffix keeps concurrent tests (and
            // parallel runs sharing a container) from colliding on the remote file.
            let payload = b"termihub-agent-deploy-integration-payload\n";
            let dir = tempfile::tempdir()
                .map_err(|e| TerminalError::SpawnFailed(format!("tempdir: {e}")))?;
            let local_path = dir.path().join("agent-deploy-payload");
            std::fs::write(&local_path, payload)
                .map_err(|e| TerminalError::SpawnFailed(format!("write local: {e}")))?;

            let remote_path = format!("/tmp/termihub-agent-deploy-test-{}", uuid::Uuid::new_v4());

            let uploaded = upload_via_sftp(
                &session,
                local_path.to_str().expect("utf-8 temp path"),
                &remote_path,
            )?;

            let read_back = run_remote_command(&session, &format!("cat {remote_path}"));
            // Best-effort cleanup before surfacing any read error.
            let _ = run_remote_command(&session, &format!("rm -f {remote_path}"));

            Ok::<_, TerminalError>((uploaded, read_back?))
        })
        .await
        .expect("spawn_blocking join");

        let (uploaded, read_back) = result.expect("agent-deploy SFTP round trip should succeed");
        assert_eq!(
            uploaded as usize,
            "termihub-agent-deploy-integration-payload\n".len(),
            "uploaded byte count should match the payload size"
        );
        assert_eq!(
            read_back.trim(),
            "termihub-agent-deploy-integration-payload",
            "remote file contents should match the uploaded payload"
        );
    }
}

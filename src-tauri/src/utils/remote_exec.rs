/// Shared SSH remote execution and SFTP upload utilities.
///
/// All functions accept a [`SshSession`] (russh `Handle`) and bridge the
/// async russh API to synchronous callers via `block_in_place` + `block_on`.
use std::fmt;

use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use tracing::debug;

use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::backends::ssh::sftp;

use crate::utils::errors::TerminalError;

// ── Remote command execution ─────────────────────────────────────────

/// Run a single command on the remote host and return trimmed stdout.
pub fn run_remote_command(session: &SshSession, command: &str) -> Result<String, TerminalError> {
    debug!(command, "Executing remote command");
    let result = tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            let mut channel = session
                .channel_open_session()
                .await
                .map_err(|e| TerminalError::SshError(format!("channel open failed: {e}")))?;

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
    })?;
    debug!(command, result = %result, "Remote command completed");
    Ok(result)
}

/// Detect the remote OS and architecture via exec channel.
///
/// Tries POSIX `uname` first — it works on Linux, macOS, and MinGW/MSYS/Cygwin
/// shells on Windows. When `uname` is unavailable (the typical case for a
/// Windows host whose default OpenSSH shell is `cmd.exe` or PowerShell), falls
/// back to probing Windows environment variables. Probing `uname` first and
/// only treating recognized output as authoritative ensures a Windows host is
/// never misdetected as Linux by the caller's artifact lookup.
pub fn detect_remote_info(session: &SshSession) -> Result<(String, String), TerminalError> {
    let uname_os = run_remote_command(session, "uname -s").unwrap_or_default();
    if is_recognized_uname_os(&uname_os) {
        let arch = run_remote_command(session, "uname -m")?;
        debug!(os = %uname_os, arch, "Detected remote system info via uname");
        return Ok((uname_os, arch));
    }

    // No usable `uname` output — probe for a Windows host (cmd.exe / PowerShell).
    if let Some((os, arch)) = detect_windows_info(session) {
        debug!(os, arch, "Detected remote Windows system info");
        return Ok((os, arch));
    }

    // Host undetermined: surface the raw `uname` output (which may be empty or
    // an error string) so the caller maps it to an unsupported artifact rather
    // than silently treating it as Linux.
    let arch = run_remote_command(session, "uname -m").unwrap_or_default();
    debug!(os = %uname_os, arch, "Remote system info undetermined");
    Ok((uname_os, arch))
}

/// Probe a remote Windows host for its CPU architecture.
///
/// Works whether the default OpenSSH shell is `cmd.exe` (which expands
/// `%PROCESSOR_ARCHITECTURE%`) or PowerShell (which expands
/// `$env:PROCESSOR_ARCHITECTURE`). Returns `("Windows_NT", arch)` on success.
fn detect_windows_info(session: &SshSession) -> Option<(String, String)> {
    // cmd.exe expands `%VAR%`; PowerShell leaves it literal.
    let cmd_arch = run_remote_command(session, "echo %PROCESSOR_ARCHITECTURE%").unwrap_or_default();
    if is_windows_arch(&cmd_arch) {
        return Some(("Windows_NT".to_string(), cmd_arch));
    }
    // PowerShell expands `$env:VAR`; cmd.exe leaves it literal.
    let ps_arch =
        run_remote_command(session, "echo $env:PROCESSOR_ARCHITECTURE").unwrap_or_default();
    if is_windows_arch(&ps_arch) {
        return Some(("Windows_NT".to_string(), ps_arch));
    }
    None
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
/// sharing a single SFTP session across threads.
pub fn upload_via_sftp(
    session: &SshSession,
    local_path: &str,
    remote_path: &str,
) -> Result<u64, TerminalError> {
    debug!(local_path, remote_path, "Uploading file via SFTP");
    let local_path = local_path.to_string();
    let remote_path = remote_path.to_string();
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            let sftp = open_sftp(session).await?;

            let data = tokio::fs::read(&local_path)
                .await
                .map_err(|e| TerminalError::SpawnFailed(format!("open local file failed: {e}")))?;

            let mut remote = sftp
                .create(&remote_path)
                .await
                .map_err(|e| TerminalError::SshError(format!("create remote file failed: {e}")))?;

            use tokio::io::AsyncWriteExt;
            remote
                .write_all(&data)
                .await
                .map_err(|e| TerminalError::SshError(format!("write failed: {e}")))?;

            Ok::<u64, TerminalError>(data.len() as u64)
        })
    })
}

/// Upload in-memory bytes to a remote path via SFTP.
pub fn upload_bytes_via_sftp(
    session: &SshSession,
    data: &[u8],
    remote_path: &str,
) -> Result<u64, TerminalError> {
    debug!(remote_path, size = data.len(), "Uploading bytes via SFTP");
    let data = data.to_vec();
    let remote_path = remote_path.to_string();
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            let sftp = open_sftp(session).await?;

            let mut remote = sftp
                .create(&remote_path)
                .await
                .map_err(|e| TerminalError::SshError(format!("create remote file failed: {e}")))?;

            use tokio::io::AsyncWriteExt;
            remote
                .write_all(&data)
                .await
                .map_err(|e| TerminalError::SshError(format!("write failed: {e}")))?;

            Ok::<u64, TerminalError>(data.len() as u64)
        })
    })
}

/// Remove a remote file over SFTP (best-effort rollback of a partial upload).
///
/// SFTP works uniformly across POSIX and Windows hosts, so this avoids the shell
/// quoting / `rm` vs `del` differences a remote `exec` would incur. A missing
/// file is not an error the caller needs to distinguish — it returns whatever
/// the server reports.
pub fn remove_via_sftp(session: &SshSession, remote_path: &str) -> Result<(), TerminalError> {
    debug!(remote_path, "Removing remote file via SFTP");
    let remote_path = remote_path.to_string();
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            let sftp = open_sftp(session).await?;
            sftp.remove_file(&remote_path)
                .await
                .map_err(|e| TerminalError::SshError(format!("SFTP remove failed: {e}")))?;
            Ok::<(), TerminalError>(())
        })
    })
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

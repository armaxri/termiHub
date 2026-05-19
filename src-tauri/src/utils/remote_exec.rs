/// Shared SSH remote execution and SFTP upload utilities.
///
/// All functions accept a [`SshSession`] (russh `Handle`) and bridge the
/// async russh API to synchronous callers via `block_in_place` + `block_on`.
use std::fmt;

use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use tracing::debug;

use termihub_core::backends::ssh::handler::SshSession;

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
pub fn detect_remote_info(session: &SshSession) -> Result<(String, String), TerminalError> {
    let os = run_remote_command(session, "uname -s")?;
    let arch = run_remote_command(session, "uname -m")?;
    debug!(os, arch, "Detected remote system info");
    Ok((os, arch))
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

/// Open a fresh SFTP subsystem on the given session.
async fn open_sftp(session: &SshSession) -> Result<SftpSession, TerminalError> {
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| TerminalError::SshError(format!("SFTP channel open failed: {e}")))?;

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| TerminalError::SshError(format!("SFTP subsystem request failed: {e}")))?;

    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| TerminalError::SshError(format!("SFTP init failed: {e}")))
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
}

/// Shared SSH remote execution and SFTP upload utilities.
///
/// Extracted from `agent_setup.rs` so that both setup and deployment
/// modules can reuse the same functions.
use std::fmt;
use std::io::Read;

use ssh2::Session;
use tracing::debug;

use crate::utils::errors::TerminalError;

// ── Remote command execution ─────────────────────────────────────────

/// Run a single command on the remote host and return trimmed stdout.
pub fn run_remote_command(session: &Session, command: &str) -> Result<String, TerminalError> {
    debug!(command, "Executing remote command");
    let mut channel = session
        .channel_session()
        .map_err(|e| TerminalError::SshError(format!("channel open failed: {}", e)))?;
    channel
        .exec(command)
        .map_err(|e| TerminalError::SshError(format!("exec failed: {}", e)))?;

    let mut output = String::new();
    channel
        .read_to_string(&mut output)
        .map_err(|e| TerminalError::SshError(format!("read failed: {}", e)))?;
    channel.wait_close().ok();

    let result = output.trim().to_string();
    debug!(command, result = %result, "Remote command completed");
    Ok(result)
}

/// Detect the remote OS and architecture via exec channel.
pub fn detect_remote_info(session: &Session) -> Result<(String, String), TerminalError> {
    let os = run_remote_command(session, "uname -s")?;
    let arch = run_remote_command(session, "uname -m")?;
    debug!(os, arch, "Detected remote system info");
    Ok((os, arch))
}

// ── SFTP upload ──────────────────────────────────────────────────────

/// Upload a local file to a remote path via SFTP.
pub fn upload_via_sftp(
    session: &Session,
    local_path: &str,
    remote_path: &str,
) -> Result<u64, TerminalError> {
    debug!(local_path, remote_path, "Uploading file via SFTP");
    let sftp = session
        .sftp()
        .map_err(|e| TerminalError::SshError(format!("SFTP init failed: {}", e)))?;

    let remote = std::path::Path::new(remote_path);
    let mut remote_file = sftp
        .create(remote)
        .map_err(|e| TerminalError::SshError(format!("create remote file failed: {}", e)))?;

    let mut local_file = std::fs::File::open(local_path)
        .map_err(|e| TerminalError::SpawnFailed(format!("open local file failed: {}", e)))?;

    let mut buf = [0u8; 32768];
    let mut total: u64 = 0;
    loop {
        let n = local_file
            .read(&mut buf)
            .map_err(|e| TerminalError::SpawnFailed(format!("read failed: {}", e)))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut remote_file, &buf[..n])
            .map_err(|e| TerminalError::SshError(format!("write failed: {}", e)))?;
        total += n as u64;
    }

    Ok(total)
}

/// Upload in-memory bytes to a remote path via SFTP.
pub fn upload_bytes_via_sftp(
    session: &Session,
    data: &[u8],
    remote_path: &str,
) -> Result<u64, TerminalError> {
    debug!(remote_path, size = data.len(), "Uploading bytes via SFTP");
    let sftp = session
        .sftp()
        .map_err(|e| TerminalError::SshError(format!("SFTP init failed: {}", e)))?;

    let remote = std::path::Path::new(remote_path);
    let mut remote_file = sftp
        .create(remote)
        .map_err(|e| TerminalError::SshError(format!("create remote file failed: {}", e)))?;

    std::io::Write::write_all(&mut remote_file, data)
        .map_err(|e| TerminalError::SshError(format!("write failed: {}", e)))?;

    Ok(data.len() as u64)
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
    let mut file = std::fs::File::open(path)
        .map_err(|e| TerminalError::SpawnFailed(format!("open binary failed: {}", e)))?;

    // We need 20 bytes: 16-byte ELF ident + 2-byte e_type + 2-byte e_machine
    let mut header = [0u8; 20];
    file.read_exact(&mut header)
        .map_err(|e| TerminalError::SpawnFailed(format!("read binary header failed: {}", e)))?;

    if header[0..4] != ELF_MAGIC {
        return Err(TerminalError::SpawnFailed(
            "Binary is not a Linux ELF executable (wrong magic bytes). \
             Make sure you selected a Linux binary, not a macOS or Windows one."
                .to_string(),
        ));
    }

    // ELF ident byte 5: data encoding (1 = little-endian, 2 = big-endian)
    let little_endian = header[5] == 1;

    // e_machine is at offset 18 (2 bytes)
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

    // ── ELF architecture detection tests ─────────────────────────────

    /// Helper: build a minimal ELF header with the given e_machine value.
    fn make_elf_header(e_machine: u16, little_endian: bool) -> Vec<u8> {
        let mut h = vec![0u8; 20];
        // Magic
        h[0] = 0x7f;
        h[1] = b'E';
        h[2] = b'L';
        h[3] = b'F';
        // EI_CLASS: 2 = 64-bit
        h[4] = 2;
        // EI_DATA: 1 = LE, 2 = BE
        h[5] = if little_endian { 1 } else { 2 };
        // e_type at offset 16 (don't care)
        // e_machine at offset 18
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
        // Mach-O magic (macOS binary)
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

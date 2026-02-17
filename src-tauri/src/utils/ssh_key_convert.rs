use std::fs;
use std::io::Write;
use std::path::Path;

use crate::utils::errors::TerminalError;

const OPENSSH_HEADER: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";

/// Result of preparing an SSH key for libssh2.
/// If conversion was needed, holds a `TempPemKey` that must stay alive
/// until authentication completes.
pub enum PreparedKey {
    /// The original key path can be used directly (PEM or PKCS#8 format).
    Original,
    /// A converted PEM key written to a secure temp file.
    Converted(TempPemKey),
}

/// A temporary PEM-format key file with restricted permissions.
/// Automatically deleted when dropped.
#[derive(Debug)]
pub struct TempPemKey {
    _temp_file: tempfile::NamedTempFile,
    path: std::path::PathBuf,
}

impl TempPemKey {
    /// Get the path to the temporary PEM key file.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Check if a key file is in OpenSSH format.
pub fn is_openssh_format(path: &Path) -> Result<bool, TerminalError> {
    let content = fs::read_to_string(path)
        .map_err(|e| TerminalError::SshError(format!("Failed to read key file: {}", e)))?;
    Ok(content.starts_with(OPENSSH_HEADER))
}

/// Prepare a key for use with libssh2.
///
/// If the key is in OpenSSH format, converts it to PKCS#8 PEM in a
/// secure temp file. Otherwise returns `Original` to use the key as-is.
pub fn prepare_key(path: &Path, passphrase: Option<&str>) -> Result<PreparedKey, TerminalError> {
    if is_openssh_format(path)? {
        let temp = convert_openssh_to_pem(path, passphrase)?;
        Ok(PreparedKey::Converted(temp))
    } else {
        Ok(PreparedKey::Original)
    }
}

/// Convert an OpenSSH-format key to PKCS#8 PEM format.
fn convert_openssh_to_pem(
    path: &Path,
    passphrase: Option<&str>,
) -> Result<TempPemKey, TerminalError> {
    let key = ssh_key::PrivateKey::read_openssh_file(path)
        .map_err(|e| TerminalError::SshError(format!("Failed to parse OpenSSH key: {}", e)))?;

    let key = if key.is_encrypted() {
        let pass = passphrase.ok_or_else(|| {
            TerminalError::SshError(
                "Key is passphrase-protected but no passphrase was provided".to_string(),
            )
        })?;
        key.decrypt(pass)
            .map_err(|e| TerminalError::SshError(format!("Failed to decrypt key: {}", e)))?
    } else {
        key
    };

    let pem_bytes = key_data_to_pem(key.key_data())?;
    write_temp_pem(&pem_bytes)
}

/// Extract raw key material and convert to PKCS#8 PEM via OpenSSL.
fn key_data_to_pem(key_data: &ssh_key::private::KeypairData) -> Result<Vec<u8>, TerminalError> {
    if let Some(ed25519) = key_data.ed25519() {
        let seed = ed25519.private.to_bytes();
        let pkey =
            openssl::pkey::PKey::private_key_from_raw_bytes(&seed, openssl::pkey::Id::ED25519)
                .map_err(|e| {
                    TerminalError::SshError(format!("Failed to create Ed25519 PKey: {}", e))
                })?;
        pkey.private_key_to_pem_pkcs8()
            .map_err(|e| TerminalError::SshError(format!("Failed to export PEM: {}", e)))
    } else if let Some(rsa) = key_data.rsa() {
        let n = openssl::bn::BigNum::from_slice(rsa.public.n.as_bytes())
            .map_err(|e| TerminalError::SshError(format!("RSA n: {}", e)))?;
        let e = openssl::bn::BigNum::from_slice(rsa.public.e.as_bytes())
            .map_err(|e| TerminalError::SshError(format!("RSA e: {}", e)))?;
        let d = openssl::bn::BigNum::from_slice(rsa.private.d.as_bytes())
            .map_err(|e| TerminalError::SshError(format!("RSA d: {}", e)))?;
        let p = openssl::bn::BigNum::from_slice(rsa.private.p.as_bytes())
            .map_err(|e| TerminalError::SshError(format!("RSA p: {}", e)))?;
        let q = openssl::bn::BigNum::from_slice(rsa.private.q.as_bytes())
            .map_err(|e| TerminalError::SshError(format!("RSA q: {}", e)))?;

        // Compute CRT parameters: dp = d mod (p-1), dq = d mod (q-1)
        let mut ctx = openssl::bn::BigNumContext::new()
            .map_err(|e| TerminalError::SshError(format!("BigNum context: {}", e)))?;
        let one = openssl::bn::BigNum::from_u32(1)
            .map_err(|e| TerminalError::SshError(format!("BigNum: {}", e)))?;

        let mut p_minus_1 = openssl::bn::BigNum::new()
            .map_err(|e| TerminalError::SshError(format!("BigNum: {}", e)))?;
        p_minus_1
            .checked_sub(&p, &one)
            .map_err(|e| TerminalError::SshError(format!("RSA dp: {}", e)))?;

        let mut q_minus_1 = openssl::bn::BigNum::new()
            .map_err(|e| TerminalError::SshError(format!("BigNum: {}", e)))?;
        q_minus_1
            .checked_sub(&q, &one)
            .map_err(|e| TerminalError::SshError(format!("RSA dq: {}", e)))?;

        let mut dp = openssl::bn::BigNum::new()
            .map_err(|e| TerminalError::SshError(format!("BigNum: {}", e)))?;
        dp.checked_rem(&d, &p_minus_1, &mut ctx)
            .map_err(|e| TerminalError::SshError(format!("RSA dp: {}", e)))?;

        let mut dq = openssl::bn::BigNum::new()
            .map_err(|e| TerminalError::SshError(format!("BigNum: {}", e)))?;
        dq.checked_rem(&d, &q_minus_1, &mut ctx)
            .map_err(|e| TerminalError::SshError(format!("RSA dq: {}", e)))?;

        let iqmp = openssl::bn::BigNum::from_slice(rsa.private.iqmp.as_bytes())
            .map_err(|e| TerminalError::SshError(format!("RSA iqmp: {}", e)))?;

        let rsa_key = openssl::rsa::Rsa::from_private_components(n, e, d, p, q, dp, dq, iqmp)
            .map_err(|e| TerminalError::SshError(format!("Failed to build RSA key: {}", e)))?;
        let pkey = openssl::pkey::PKey::from_rsa(rsa_key)
            .map_err(|e| TerminalError::SshError(format!("Failed to create RSA PKey: {}", e)))?;
        pkey.private_key_to_pem_pkcs8()
            .map_err(|e| TerminalError::SshError(format!("Failed to export PEM: {}", e)))
    } else {
        Err(TerminalError::SshError(
            "Unsupported key type for OpenSSH conversion. \
             Supported: Ed25519, RSA. Try converting with: ssh-keygen -p -m pem"
                .to_string(),
        ))
    }
}

/// Write PEM bytes to a secure temporary file.
fn write_temp_pem(pem_bytes: &[u8]) -> Result<TempPemKey, TerminalError> {
    let mut temp = tempfile::NamedTempFile::new()
        .map_err(|e| TerminalError::SshError(format!("Failed to create temp file: {}", e)))?;

    temp.write_all(pem_bytes)
        .map_err(|e| TerminalError::SshError(format!("Failed to write temp key: {}", e)))?;
    temp.flush()
        .map_err(|e| TerminalError::SshError(format!("Failed to flush temp key: {}", e)))?;

    // Set restrictive permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(temp.path(), perms).map_err(|e| {
            TerminalError::SshError(format!("Failed to set key permissions: {}", e))
        })?;
    }

    let path = temp.path().to_path_buf();
    Ok(TempPemKey {
        _temp_file: temp,
        path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp_key(content: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f.flush().unwrap();
        f
    }

    #[test]
    fn detects_openssh_format() {
        let f = write_temp_key(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nbase64data\n-----END OPENSSH PRIVATE KEY-----\n",
        );
        assert!(is_openssh_format(f.path()).unwrap());
    }

    #[test]
    fn detects_pem_rsa_format_as_non_openssh() {
        let f = write_temp_key(
            "-----BEGIN RSA PRIVATE KEY-----\nbase64data\n-----END RSA PRIVATE KEY-----\n",
        );
        assert!(!is_openssh_format(f.path()).unwrap());
    }

    #[test]
    fn detects_pkcs8_format_as_non_openssh() {
        let f =
            write_temp_key("-----BEGIN PRIVATE KEY-----\nbase64data\n-----END PRIVATE KEY-----\n");
        assert!(!is_openssh_format(f.path()).unwrap());
    }

    #[test]
    fn nonexistent_file_returns_error() {
        let result = is_openssh_format(Path::new("/nonexistent/path/key"));
        assert!(result.is_err());
    }

    #[test]
    fn prepare_key_returns_original_for_pem() {
        let f = write_temp_key(
            "-----BEGIN RSA PRIVATE KEY-----\nbase64data\n-----END RSA PRIVATE KEY-----\n",
        );
        let result = prepare_key(f.path(), None).unwrap();
        assert!(matches!(result, PreparedKey::Original));
    }

    #[test]
    fn convert_unencrypted_ed25519_key() {
        // Generate a real Ed25519 key in OpenSSH format
        let key = ssh_key::PrivateKey::random(&mut rand::thread_rng(), ssh_key::Algorithm::Ed25519)
            .unwrap();
        let openssh_pem = key.to_openssh(ssh_key::LineEnding::LF).unwrap();

        let f = write_temp_key(&openssh_pem);
        let result = convert_openssh_to_pem(f.path(), None).unwrap();

        // Verify the converted file contains PKCS#8 PEM
        let converted = fs::read_to_string(result.path()).unwrap();
        assert!(converted.contains("-----BEGIN PRIVATE KEY-----"));
    }

    #[test]
    fn convert_unencrypted_rsa_key() {
        // Generate a real RSA key in OpenSSH format
        let key = ssh_key::PrivateKey::random(
            &mut rand::thread_rng(),
            ssh_key::Algorithm::Rsa { hash: None },
        )
        .unwrap();
        let openssh_pem = key.to_openssh(ssh_key::LineEnding::LF).unwrap();

        let f = write_temp_key(&openssh_pem);
        let result = convert_openssh_to_pem(f.path(), None).unwrap();

        let converted = fs::read_to_string(result.path()).unwrap();
        assert!(converted.contains("-----BEGIN PRIVATE KEY-----"));
    }

    #[test]
    fn prepare_key_converts_openssh_ed25519() {
        let key = ssh_key::PrivateKey::random(&mut rand::thread_rng(), ssh_key::Algorithm::Ed25519)
            .unwrap();
        let openssh_pem = key.to_openssh(ssh_key::LineEnding::LF).unwrap();

        let f = write_temp_key(&openssh_pem);
        let result = prepare_key(f.path(), None).unwrap();
        assert!(matches!(result, PreparedKey::Converted(_)));
    }

    #[cfg(unix)]
    #[test]
    fn temp_file_has_restricted_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let key = ssh_key::PrivateKey::random(&mut rand::thread_rng(), ssh_key::Algorithm::Ed25519)
            .unwrap();
        let openssh_pem = key.to_openssh(ssh_key::LineEnding::LF).unwrap();

        let f = write_temp_key(&openssh_pem);
        let result = convert_openssh_to_pem(f.path(), None).unwrap();

        let metadata = fs::metadata(result.path()).unwrap();
        let mode = metadata.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn temp_file_cleaned_up_on_drop() {
        let key = ssh_key::PrivateKey::random(&mut rand::thread_rng(), ssh_key::Algorithm::Ed25519)
            .unwrap();
        let openssh_pem = key.to_openssh(ssh_key::LineEnding::LF).unwrap();

        let f = write_temp_key(&openssh_pem);
        let result = convert_openssh_to_pem(f.path(), None).unwrap();
        let temp_path = result.path().to_path_buf();
        assert!(temp_path.exists());

        drop(result);
        assert!(!temp_path.exists());
    }

    #[test]
    fn encrypted_key_without_passphrase_fails() {
        let key = ssh_key::PrivateKey::random(&mut rand::thread_rng(), ssh_key::Algorithm::Ed25519)
            .unwrap();
        let encrypted = key
            .encrypt(&mut rand::thread_rng(), "test-passphrase")
            .unwrap();
        let openssh_pem = encrypted.to_openssh(ssh_key::LineEnding::LF).unwrap();

        let f = write_temp_key(&openssh_pem);
        let result = convert_openssh_to_pem(f.path(), None);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("passphrase"));
    }

    #[test]
    fn encrypted_key_with_correct_passphrase() {
        let key = ssh_key::PrivateKey::random(&mut rand::thread_rng(), ssh_key::Algorithm::Ed25519)
            .unwrap();
        let encrypted = key
            .encrypt(&mut rand::thread_rng(), "test-passphrase")
            .unwrap();
        let openssh_pem = encrypted.to_openssh(ssh_key::LineEnding::LF).unwrap();

        let f = write_temp_key(&openssh_pem);
        let result = convert_openssh_to_pem(f.path(), Some("test-passphrase")).unwrap();

        let converted = fs::read_to_string(result.path()).unwrap();
        assert!(converted.contains("-----BEGIN PRIVATE KEY-----"));
    }
}

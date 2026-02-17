use std::fs;
use std::path::Path;

use crate::utils::errors::TerminalError;

const OPENSSH_HEADER: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";

/// Result of preparing an SSH key for libssh2.
pub enum PreparedKey {
    /// The original key path can be used directly (PEM or PKCS#8 format).
    Original,
    /// The key was converted from OpenSSH to PKCS#8 PEM format (in memory).
    /// The PEM bytes are already decrypted — no passphrase is needed.
    ConvertedPem(Vec<u8>),
}

/// Check if a key file is in OpenSSH format.
pub fn is_openssh_format(path: &Path) -> Result<bool, TerminalError> {
    let content = fs::read_to_string(path).map_err(|e| {
        TerminalError::SshError(format!(
            "Failed to read key file '{}': {}",
            path.display(),
            e
        ))
    })?;
    Ok(content.starts_with(OPENSSH_HEADER))
}

/// Prepare a key for use with libssh2.
///
/// If the key is in OpenSSH format, converts it to PKCS#8 PEM bytes
/// in memory. Otherwise returns `Original` to use the key file as-is.
pub fn prepare_key(path: &Path, passphrase: Option<&str>) -> Result<PreparedKey, TerminalError> {
    if is_openssh_format(path)? {
        let pem_bytes = convert_openssh_to_pem_bytes(path, passphrase)?;
        Ok(PreparedKey::ConvertedPem(pem_bytes))
    } else {
        Ok(PreparedKey::Original)
    }
}

/// Convert an OpenSSH-format key to PKCS#8 PEM bytes.
///
/// If the key is encrypted, it is decrypted using the provided passphrase.
/// The returned bytes are always an unencrypted PKCS#8 PEM key.
fn convert_openssh_to_pem_bytes(
    path: &Path,
    passphrase: Option<&str>,
) -> Result<Vec<u8>, TerminalError> {
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

    key_data_to_pem(key.key_data())
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
        let pem_bytes = convert_openssh_to_pem_bytes(f.path(), None).unwrap();

        // Verify the converted bytes contain PKCS#8 PEM
        let converted = std::str::from_utf8(&pem_bytes).unwrap();
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
        let pem_bytes = convert_openssh_to_pem_bytes(f.path(), None).unwrap();

        let converted = std::str::from_utf8(&pem_bytes).unwrap();
        assert!(converted.contains("-----BEGIN PRIVATE KEY-----"));
    }

    #[test]
    fn prepare_key_converts_openssh_ed25519() {
        let key = ssh_key::PrivateKey::random(&mut rand::thread_rng(), ssh_key::Algorithm::Ed25519)
            .unwrap();
        let openssh_pem = key.to_openssh(ssh_key::LineEnding::LF).unwrap();

        let f = write_temp_key(&openssh_pem);
        let result = prepare_key(f.path(), None).unwrap();
        assert!(matches!(result, PreparedKey::ConvertedPem(_)));
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
        let result = convert_openssh_to_pem_bytes(f.path(), None);
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
        let pem_bytes = convert_openssh_to_pem_bytes(f.path(), Some("test-passphrase")).unwrap();

        let converted = std::str::from_utf8(&pem_bytes).unwrap();
        assert!(converted.contains("-----BEGIN PRIVATE KEY-----"));
    }
}

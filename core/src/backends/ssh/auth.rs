//! SSH authentication and key conversion utilities.
//!
//! Provides [`connect_and_authenticate()`] for establishing an authenticated
//! `ssh2::Session`, and [`check_ssh_agent_status()`] for querying agent
//! availability.

use std::fs;
use std::net::TcpStream;
#[cfg(not(target_os = "windows"))]
use std::path::Path;
use std::path::PathBuf;

use crate::config::expand::expand_tilde;
use crate::config::SshConfig;
use crate::errors::SessionError;

const OPENSSH_HEADER: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";

/// Result of preparing an SSH key for libssh2.
pub enum PreparedKey {
    /// The original key path can be used directly (PEM or PKCS#8 format).
    Original,
    /// The key was converted from OpenSSH to PKCS#8 PEM format (in memory).
    /// The PEM bytes are already decrypted — no passphrase is needed.
    ConvertedPem(Vec<u8>),
}

/// Connect to an SSH server, perform handshake, and authenticate.
///
/// Returns an authenticated `Session` in blocking mode.
pub fn connect_and_authenticate(config: &SshConfig) -> Result<ssh2::Session, SessionError> {
    let addr = format!("{}:{}", config.host, config.port);
    let tcp = TcpStream::connect(&addr)
        .map_err(|e| SessionError::SpawnFailed(format!("Connection failed: {e}")))?;

    let mut session = ssh2::Session::new().map_err(|e| SessionError::SpawnFailed(e.to_string()))?;

    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| SessionError::SpawnFailed(format!("Handshake failed: {e}")))?;

    match config.auth_method.as_str() {
        "agent" => {
            session
                .userauth_agent(&config.username)
                .map_err(|e| SessionError::SpawnFailed(format!("Agent auth failed: {e}")))?;
        }
        "key" => {
            let key_path_str = config
                .key_path
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("~/.ssh/id_rsa");
            let expanded = expand_tilde(key_path_str);
            let key_path = PathBuf::from(&expanded);
            let passphrase = config.password.as_deref();

            let prepared = prepare_key(&key_path, passphrase)?;
            match prepared {
                PreparedKey::Original => {
                    session
                        .userauth_pubkey_file(&config.username, None, &key_path, passphrase)
                        .map_err(|e| SessionError::SpawnFailed(format!("Key auth failed: {e}")))?;
                }
                PreparedKey::ConvertedPem(pem_bytes) => {
                    let pem_str = std::str::from_utf8(&pem_bytes).map_err(|e| {
                        SessionError::SpawnFailed(format!("Invalid PEM encoding: {e}"))
                    })?;
                    session
                        .userauth_pubkey_memory(&config.username, None, pem_str, None)
                        .map_err(|e| SessionError::SpawnFailed(format!("Key auth failed: {e}")))?;
                }
            }
        }
        _ => {
            // Default to password auth.
            let password = config.password.as_deref().unwrap_or("");
            session
                .userauth_password(&config.username, password)
                .map_err(|e| SessionError::SpawnFailed(format!("Password auth failed: {e}")))?;
        }
    }

    if !session.authenticated() {
        return Err(SessionError::SpawnFailed(
            "Authentication failed".to_string(),
        ));
    }

    Ok(session)
}

/// Check whether the SSH agent is running or stopped.
///
/// - **Windows**: tries to open the `openssh-ssh-agent` named pipe.
/// - **Unix**: checks if `SSH_AUTH_SOCK` is set and the socket file exists.
///
/// Returns `"running"` or `"stopped"`.
pub fn check_ssh_agent_status() -> String {
    #[cfg(target_os = "windows")]
    {
        use std::fs::OpenOptions;
        let pipe_path = r"\\.\pipe\openssh-ssh-agent";
        match OpenOptions::new().read(true).open(pipe_path) {
            Ok(_) => "running".to_string(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => "stopped".to_string(),
            Err(_) => "running".to_string(),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        match std::env::var("SSH_AUTH_SOCK") {
            Ok(sock_path) if !sock_path.is_empty() => {
                if Path::new(&sock_path).exists() {
                    "running".to_string()
                } else {
                    "stopped".to_string()
                }
            }
            _ => "stopped".to_string(),
        }
    }
}

/// Check if a key file is in OpenSSH format.
pub fn is_openssh_format(path: &std::path::Path) -> Result<bool, SessionError> {
    let content = fs::read_to_string(path).map_err(|e| {
        SessionError::SpawnFailed(format!("Failed to read key file '{}': {e}", path.display()))
    })?;
    Ok(content.starts_with(OPENSSH_HEADER))
}

/// Prepare a key for use with libssh2.
///
/// If the key is in OpenSSH format, converts it to PKCS#8 PEM bytes
/// in memory. Otherwise returns `Original` to use the key file as-is.
pub fn prepare_key(
    path: &std::path::Path,
    passphrase: Option<&str>,
) -> Result<PreparedKey, SessionError> {
    if is_openssh_format(path)? {
        let pem_bytes = convert_openssh_to_pem_bytes(path, passphrase)?;
        Ok(PreparedKey::ConvertedPem(pem_bytes))
    } else {
        Ok(PreparedKey::Original)
    }
}

/// Convert an OpenSSH-format key to PKCS#8 PEM bytes.
fn convert_openssh_to_pem_bytes(
    path: &std::path::Path,
    passphrase: Option<&str>,
) -> Result<Vec<u8>, SessionError> {
    let key = ssh_key::PrivateKey::read_openssh_file(path)
        .map_err(|e| SessionError::SpawnFailed(format!("Failed to parse OpenSSH key: {e}")))?;

    let key = if key.is_encrypted() {
        let pass = passphrase.ok_or_else(|| {
            SessionError::SpawnFailed(
                "Key is passphrase-protected but no passphrase was provided".to_string(),
            )
        })?;
        key.decrypt(pass)
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to decrypt key: {e}")))?
    } else {
        key
    };

    key_data_to_pem(key.key_data())
}

/// Extract raw key material and convert to PKCS#8 PEM via OpenSSL.
fn key_data_to_pem(key_data: &ssh_key::private::KeypairData) -> Result<Vec<u8>, SessionError> {
    if let Some(ed25519) = key_data.ed25519() {
        let seed = ed25519.private.to_bytes();
        let pkey =
            openssl::pkey::PKey::private_key_from_raw_bytes(&seed, openssl::pkey::Id::ED25519)
                .map_err(|e| {
                    SessionError::SpawnFailed(format!("Failed to create Ed25519 PKey: {e}"))
                })?;
        pkey.private_key_to_pem_pkcs8()
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to export PEM: {e}")))
    } else if let Some(rsa) = key_data.rsa() {
        let n = openssl::bn::BigNum::from_slice(rsa.public.n.as_bytes())
            .map_err(|e| SessionError::SpawnFailed(format!("RSA n: {e}")))?;
        let e = openssl::bn::BigNum::from_slice(rsa.public.e.as_bytes())
            .map_err(|e| SessionError::SpawnFailed(format!("RSA e: {e}")))?;
        let d = openssl::bn::BigNum::from_slice(rsa.private.d.as_bytes())
            .map_err(|e| SessionError::SpawnFailed(format!("RSA d: {e}")))?;
        let p = openssl::bn::BigNum::from_slice(rsa.private.p.as_bytes())
            .map_err(|e| SessionError::SpawnFailed(format!("RSA p: {e}")))?;
        let q = openssl::bn::BigNum::from_slice(rsa.private.q.as_bytes())
            .map_err(|e| SessionError::SpawnFailed(format!("RSA q: {e}")))?;

        let mut ctx = openssl::bn::BigNumContext::new()
            .map_err(|e| SessionError::SpawnFailed(format!("BigNum context: {e}")))?;
        let one = openssl::bn::BigNum::from_u32(1)
            .map_err(|e| SessionError::SpawnFailed(format!("BigNum: {e}")))?;

        let mut p_minus_1 = openssl::bn::BigNum::new()
            .map_err(|e| SessionError::SpawnFailed(format!("BigNum: {e}")))?;
        p_minus_1
            .checked_sub(&p, &one)
            .map_err(|e| SessionError::SpawnFailed(format!("RSA dp: {e}")))?;

        let mut q_minus_1 = openssl::bn::BigNum::new()
            .map_err(|e| SessionError::SpawnFailed(format!("BigNum: {e}")))?;
        q_minus_1
            .checked_sub(&q, &one)
            .map_err(|e| SessionError::SpawnFailed(format!("RSA dq: {e}")))?;

        let mut dp = openssl::bn::BigNum::new()
            .map_err(|e| SessionError::SpawnFailed(format!("BigNum: {e}")))?;
        dp.checked_rem(&d, &p_minus_1, &mut ctx)
            .map_err(|e| SessionError::SpawnFailed(format!("RSA dp: {e}")))?;

        let mut dq = openssl::bn::BigNum::new()
            .map_err(|e| SessionError::SpawnFailed(format!("BigNum: {e}")))?;
        dq.checked_rem(&d, &q_minus_1, &mut ctx)
            .map_err(|e| SessionError::SpawnFailed(format!("RSA dq: {e}")))?;

        let iqmp = openssl::bn::BigNum::from_slice(rsa.private.iqmp.as_bytes())
            .map_err(|e| SessionError::SpawnFailed(format!("RSA iqmp: {e}")))?;

        let rsa_key = openssl::rsa::Rsa::from_private_components(n, e, d, p, q, dp, dq, iqmp)
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to build RSA key: {e}")))?;
        let pkey = openssl::pkey::PKey::from_rsa(rsa_key)
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to create RSA PKey: {e}")))?;
        pkey.private_key_to_pem_pkcs8()
            .map_err(|e| SessionError::SpawnFailed(format!("Failed to export PEM: {e}")))
    } else {
        Err(SessionError::SpawnFailed(
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
    fn check_ssh_agent_status_returns_valid_value() {
        let status = check_ssh_agent_status();
        assert!(
            status == "running" || status == "stopped",
            "unexpected status: {status}"
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn check_ssh_agent_status_stopped_when_sock_unset() {
        let orig = std::env::var("SSH_AUTH_SOCK").ok();
        std::env::remove_var("SSH_AUTH_SOCK");
        let status = check_ssh_agent_status();
        assert_eq!(status, "stopped");
        if let Some(val) = orig {
            std::env::set_var("SSH_AUTH_SOCK", val);
        }
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
        let result = is_openssh_format(std::path::Path::new("/nonexistent/path/key"));
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
        let key = ssh_key::PrivateKey::random(&mut rand::thread_rng(), ssh_key::Algorithm::Ed25519)
            .unwrap();
        let openssh_pem = key.to_openssh(ssh_key::LineEnding::LF).unwrap();

        let f = write_temp_key(&openssh_pem);
        let pem_bytes = convert_openssh_to_pem_bytes(f.path(), None).unwrap();

        let converted = std::str::from_utf8(&pem_bytes).unwrap();
        assert!(converted.contains("-----BEGIN PRIVATE KEY-----"));
    }

    /// Pre-generated 2048-bit RSA key in OpenSSH format.
    const TEST_RSA_OPENSSH_KEY: &str = "\
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABFwAAAAdzc2gtcn
NhAAAAAwEAAQAAAQEAyJegcuGHS6FKQsK9HSYC9Yyn8LY9UIDeDqOkvY2AcagyAwjPDvTs
C2lah2fDU3+yO0AQLP18gtNCY1+rEytTOsCZzfnTazXz5V5u1HrmeiS2iq8uwYcxWlgBxo
kT2mCDiD7PIqispyUEpJS2UmDUM9GA4Np7mBDjoFEW1p9Ft5mUiBAs93AT7ry2DsKxHf7j
SsNVrYB6MH+bMF9BR1s5PNVEhwGjAfLYBFje5rv6tFN+Zjelbvbtp8MHlU3lc9RAI0rBHZ
GTqqMbeeNR7Eqeng0UAJfpjIqTQlIhzTlqw3B+k5h7TUOOHofnY7UyoMxEe6zvjnONtOpl
A3Y7LKdRpwAAA8gTIn8cEyJ/HAAAAAdzc2gtcnNhAAABAQDIl6By4YdLoUpCwr0dJgL1jK
fwtj1QgN4Oo6S9jYBxqDIDCM8O9OwLaVqHZ8NTf7I7QBAs/XyC00JjX6sTK1M6wJnN+dNr
NfPlXm7UeuZ6JLaKry7BhzFaWAHGiRPaYIOIPs8iqKynJQSklLZSYNQz0YDg2nuYEOOgUR
bWn0W3mZSIECz3cBPuvLYOwrEd/uNKw1WtgHowf5swX0FHWzk81USHAaMB8tgEWN7mu/q0
U35mN6Vu9u2nwweVTeVz1EAjSsEdkZOqoxt541HsSp6eDRQAl+mMipNCUiHNOWrDcH6TmH
tNQ44eh+djtTKgzER7rO+Oc4206mUDdjssp1GnAAAAAwEAAQAAAQEAhxR8iwBO4OJTpNOJ
EKj5UywOJ+5BKgYuA0O1+6PffCpcy2hSL2tFzYV73jVE9uTGPFouym1FPMBRM6RICxeg66
6ppGh5M/hYLvzBu7qrnFM+zfOck9ybopAjWfQTd3qI+OX7DQbzhXdLQh2XDbCBFggeNs1K
b6Pn9ZzFuW/2PeUwI202kUJE3cHiX5c1B3l26rYH8ShEgIbnqnS1xsZtyotYzK0PlWxKsd
zM4VDrwXHL9faGh7Xs+HXpMijZkCGL7L0yV46nxCinWmeZHAkpQgxc5qrMAyEErdrXtAE3
i4vkEHoPRh7b0HKMYexYtHVTeVCoUoq7WOy/vshq2xyAoQAAAIA2FqhmYtO877yz9sd9rM
1T0UpdY9GTb+Onv9tCX7M07hzxlu5oOXph0yUn0mGsMikzifROsL/6dlIpTskFF2s+Ai+5
Qit2u9m4bWuy1YlRPbGvr2gqrcY48Cvpltn5Ks62AlJBmWOsrL/X8lvQcxZRLNHJuLDUUI
lNOw8avk7MJgAAAIEA6cxD/zWymZAgLTE8B3WfvYbmMhJLwBKDN5o3vF4TSMmrjsw3wGZR
N9GNOq+b6IvkseZdezUQuNNpToDHkfYTTrJZXSawGKPsr5Wt8ulXK9URfbWgS0USx2kPkw
nwE1k6u9CrvhVTCbuPcY1aOH7Y5Efj1zCecx+Lcla16Kl7J1cAAACBANukHgaibd//LMLc
/qsyXESkE5p3XM+8wkVtR+QpL4Duu7vAJjN0XhOYelvFNpsk2EUIUMAjAdqmfz5ZgvUjU6
Whf9wXZ7Azq8S73AVRd4t6K+sam+f1nWWuvnfGl+QBrgcjKCOjtvyXdtz7UZUKQT58Ni8s
bBVwt04qVBuGZUYxAAAADXRlc3RAdGVybWlodWIBAgMEBQ==
-----END OPENSSH PRIVATE KEY-----
";

    #[test]
    fn convert_unencrypted_rsa_key() {
        let f = write_temp_key(TEST_RSA_OPENSSH_KEY);
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

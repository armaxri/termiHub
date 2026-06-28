use std::fs;
use std::path::Path;

use russh::keys::ssh_key::PrivateKey;
use serde::Serialize;

use crate::utils::expand::expand_config_value;

/// Maximum bytes to read from the file for format detection.
const MAX_READ_BYTES: usize = 1024;

/// Known OpenSSH public key prefixes (content-based detection).
const PUBLIC_KEY_PREFIXES: &[&str] = &[
    "ssh-rsa ",
    "ssh-ed25519 ",
    "ssh-dss ",
    "ecdsa-sha2-",
    "sk-ssh-ed25519@",
    "sk-ecdsa-sha2-",
];

/// Known PEM private key headers and their human-readable key type names.
const PRIVATE_KEY_HEADERS: &[(&str, &str)] = &[
    ("BEGIN OPENSSH PRIVATE KEY", "OpenSSH"),
    ("BEGIN RSA PRIVATE KEY", "RSA (PEM)"),
    ("BEGIN EC PRIVATE KEY", "EC (PEM)"),
    ("BEGIN DSA PRIVATE KEY", "DSA (PEM)"),
    ("BEGIN PRIVATE KEY", "PKCS#8"),
    ("BEGIN ENCRYPTED PRIVATE KEY", "PKCS#8 (encrypted)"),
];

/// PuTTY PPK file header.
const PUTTY_HEADER: &str = "PuTTY-User-Key-File-";

/// Validation status level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ValidationStatus {
    Valid,
    Warning,
    Error,
}

/// Result of validating an SSH key file path.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyValidation {
    pub status: ValidationStatus,
    pub message: String,
    /// Detected key type (e.g. "OpenSSH", "RSA (PEM)"), empty when not a valid key.
    pub key_type: String,
}

/// Validate an SSH key file path and return a user-facing hint.
///
/// Reads only the first [`MAX_READ_BYTES`] of the file to detect its format,
/// avoiding issues with large or binary files.
pub fn validate_ssh_key(path: &str) -> SshKeyValidation {
    // Empty path: treat as "no key selected yet" — silently valid.
    if path.trim().is_empty() {
        return SshKeyValidation {
            status: ValidationStatus::Valid,
            message: String::new(),
            key_type: String::new(),
        };
    }

    let file_path = Path::new(path);

    // Check file existence.
    if !file_path.exists() {
        return SshKeyValidation {
            status: ValidationStatus::Error,
            message: "File not found.".to_string(),
            key_type: String::new(),
        };
    }

    // Check that it's a file, not a directory.
    if !file_path.is_file() {
        return SshKeyValidation {
            status: ValidationStatus::Error,
            message: "Path is not a file.".to_string(),
            key_type: String::new(),
        };
    }

    // Check .pub extension before reading content.
    if let Some(ext) = file_path.extension() {
        if ext.eq_ignore_ascii_case("pub") {
            return SshKeyValidation {
                status: ValidationStatus::Warning,
                message: "This looks like a public key (.pub). Select the private key instead \
                          (usually the same filename without the .pub extension)."
                    .to_string(),
                key_type: String::new(),
            };
        }
    }

    // Read first bytes of the file.
    let bytes = match fs::read(file_path) {
        Ok(b) => b,
        Err(e) => {
            return SshKeyValidation {
                status: ValidationStatus::Error,
                message: format!("Cannot read file: {}", e),
                key_type: String::new(),
            };
        }
    };

    let head = &bytes[..bytes.len().min(MAX_READ_BYTES)];
    // Lossy conversion handles binary files gracefully.
    let text = String::from_utf8_lossy(head);

    // Check for public key content (regardless of extension).
    for prefix in PUBLIC_KEY_PREFIXES {
        if text.starts_with(prefix) {
            return SshKeyValidation {
                status: ValidationStatus::Warning,
                message: "This looks like a public key. Select the private key instead \
                          (usually the same filename without the .pub extension)."
                    .to_string(),
                key_type: String::new(),
            };
        }
    }

    // Check for PuTTY PPK format.
    if text.starts_with(PUTTY_HEADER) {
        return SshKeyValidation {
            status: ValidationStatus::Warning,
            message: "This is a PuTTY PPK key. Convert it to OpenSSH format with: \
                      puttygen key.ppk -O private-openssh -o key"
                .to_string(),
            key_type: String::new(),
        };
    }

    // Check for known private key PEM headers.
    for (header, key_type) in PRIVATE_KEY_HEADERS {
        if text.contains(header) {
            return SshKeyValidation {
                status: ValidationStatus::Valid,
                message: format!("{} private key detected.", key_type),
                key_type: (*key_type).to_string(),
            };
        }
    }

    // None of the above matched.
    SshKeyValidation {
        status: ValidationStatus::Warning,
        message: "Not a recognized SSH private key format.".to_string(),
        key_type: String::new(),
    }
}

/// Determine whether an SSH private key file is passphrase-encrypted.
///
/// Used to decide whether to prompt for a key passphrase at connect time
/// based on the key's *actual* encryption rather than the "Save password"
/// flag (#885). Detection is read-only and format-aware:
///
/// - Traditional OpenSSL PEM (`Proc-Type: 4,ENCRYPTED`, used by encrypted
///   `RSA`/`EC`/`DSA PRIVATE KEY` blocks) and explicitly-labelled encrypted
///   PKCS#8 (`BEGIN ENCRYPTED PRIVATE KEY`) carry the fact in their headers.
/// - OpenSSH-format keys are parsed with the `ssh-key` crate, whose
///   [`PrivateKey::is_encrypted`] reads the cipher name authoritatively (an
///   unencrypted key uses the cipher `none`).
/// - Anything else without an encryption header (an unencrypted legacy PEM or
///   PKCS#8 key, or a non-key file) is reported as not encrypted.
///
/// An empty path resolves to the SSH default (`~/.ssh/id_rsa`), mirroring the
/// connect path. Returns `Err` when the file cannot be read so callers can
/// treat that as "uncertain" and prompt anyway — an encrypted key must never
/// fail to connect silently.
pub fn is_ssh_key_encrypted(path: &str) -> Result<bool, String> {
    let key_path = if path.trim().is_empty() {
        "~/.ssh/id_rsa"
    } else {
        path
    };
    let expanded = expand_config_value(key_path);
    let contents =
        fs::read_to_string(&expanded).map_err(|e| format!("Cannot read key file: {e}"))?;

    // Traditional OpenSSL PEM encryption (RSA/EC/DSA): Proc-Type + DEK-Info.
    if contents.contains("Proc-Type:") && contents.contains("ENCRYPTED") {
        return Ok(true);
    }
    // Explicitly-labelled encrypted PKCS#8.
    if contents.contains("BEGIN ENCRYPTED PRIVATE KEY") {
        return Ok(true);
    }
    // OpenSSH format: the cipher name is authoritative ("none" => unencrypted).
    if let Ok(key) = PrivateKey::from_openssh(contents.trim()) {
        return Ok(key.is_encrypted());
    }
    // Unencrypted legacy PEM / PKCS#8 (no encryption header), or a non-key file.
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Absolute path to a checked-in SSH key fixture (workspace `tests/fixtures`).
    fn fixture(name: &str) -> String {
        format!(
            "{}/../tests/fixtures/ssh-keys/{}",
            env!("CARGO_MANIFEST_DIR"),
            name
        )
    }

    fn write_temp(content: &[u8]) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(content).unwrap();
        f.flush().unwrap();
        f
    }

    fn write_temp_with_suffix(content: &[u8], suffix: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::Builder::new().suffix(suffix).tempfile().unwrap();
        f.write_all(content).unwrap();
        f.flush().unwrap();
        f
    }

    #[test]
    fn empty_path_is_silently_valid() {
        let result = validate_ssh_key("");
        assert_eq!(result.status, ValidationStatus::Valid);
        assert!(result.message.is_empty());
    }

    #[test]
    fn whitespace_only_path_is_silently_valid() {
        let result = validate_ssh_key("   ");
        assert_eq!(result.status, ValidationStatus::Valid);
        assert!(result.message.is_empty());
    }

    #[test]
    fn nonexistent_file_returns_error() {
        let result = validate_ssh_key("/nonexistent/path/to/key");
        assert_eq!(result.status, ValidationStatus::Error);
        assert!(result.message.contains("not found"));
    }

    #[test]
    fn directory_path_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let result = validate_ssh_key(dir.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Error);
        assert!(result.message.contains("not a file"));
    }

    #[test]
    fn pub_extension_returns_warning() {
        let f = write_temp_with_suffix(b"ssh-ed25519 AAAA... user@host", ".pub");
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Warning);
        assert!(result.message.contains("public key"));
        assert!(result.message.contains(".pub"));
    }

    #[test]
    fn public_key_content_without_pub_extension_returns_warning() {
        let f = write_temp(b"ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB... user@host");
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Warning);
        assert!(result.message.contains("public key"));
    }

    #[test]
    fn ssh_ed25519_public_key_content_detected() {
        let f = write_temp(b"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 user@host");
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Warning);
        assert!(result.message.contains("public key"));
    }

    #[test]
    fn ecdsa_public_key_content_detected() {
        let f = write_temp(b"ecdsa-sha2-nistp256 AAAAE2VjZHNh user@host");
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Warning);
        assert!(result.message.contains("public key"));
    }

    #[test]
    fn openssh_private_key_detected() {
        let content =
            b"-----BEGIN OPENSSH PRIVATE KEY-----\nbase64data\n-----END OPENSSH PRIVATE KEY-----\n";
        let f = write_temp(content);
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Valid);
        assert_eq!(result.key_type, "OpenSSH");
        assert!(result.message.contains("OpenSSH"));
    }

    #[test]
    fn rsa_pem_private_key_detected() {
        let content =
            b"-----BEGIN RSA PRIVATE KEY-----\nbase64data\n-----END RSA PRIVATE KEY-----\n";
        let f = write_temp(content);
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Valid);
        assert_eq!(result.key_type, "RSA (PEM)");
    }

    #[test]
    fn ec_pem_private_key_detected() {
        let content = b"-----BEGIN EC PRIVATE KEY-----\nbase64data\n-----END EC PRIVATE KEY-----\n";
        let f = write_temp(content);
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Valid);
        assert_eq!(result.key_type, "EC (PEM)");
    }

    #[test]
    fn dsa_pem_private_key_detected() {
        let content =
            b"-----BEGIN DSA PRIVATE KEY-----\nbase64data\n-----END DSA PRIVATE KEY-----\n";
        let f = write_temp(content);
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Valid);
        assert_eq!(result.key_type, "DSA (PEM)");
    }

    #[test]
    fn pkcs8_private_key_detected() {
        let content = b"-----BEGIN PRIVATE KEY-----\nbase64data\n-----END PRIVATE KEY-----\n";
        let f = write_temp(content);
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Valid);
        assert_eq!(result.key_type, "PKCS#8");
    }

    #[test]
    fn pkcs8_encrypted_private_key_detected() {
        let content = b"-----BEGIN ENCRYPTED PRIVATE KEY-----\nbase64data\n-----END ENCRYPTED PRIVATE KEY-----\n";
        let f = write_temp(content);
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Valid);
        assert_eq!(result.key_type, "PKCS#8 (encrypted)");
    }

    #[test]
    fn putty_ppk_returns_warning_with_instructions() {
        let content = b"PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n";
        let f = write_temp(content);
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Warning);
        assert!(result.message.contains("PuTTY"));
        assert!(result.message.contains("puttygen"));
    }

    #[test]
    fn unrecognized_format_returns_warning() {
        let f = write_temp(b"this is not a key file at all");
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Warning);
        assert!(result.message.contains("Not a recognized"));
    }

    #[test]
    fn binary_file_returns_warning() {
        let f = write_temp(&[0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Warning);
        assert!(result.message.contains("Not a recognized"));
    }

    #[test]
    fn sk_ssh_ed25519_fido_key_content_detected() {
        let f = write_temp(b"sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI... user@host");
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Warning);
        assert!(result.message.contains("public key"));
    }

    #[test]
    fn sk_ecdsa_fido_key_content_detected() {
        let f = write_temp(b"sk-ecdsa-sha2-nistp256@openssh.com AAAA... user@host");
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Warning);
        assert!(result.message.contains("public key"));
    }

    #[test]
    fn ssh_dss_public_key_content_detected() {
        let f = write_temp(b"ssh-dss AAAAB3NzaC1kc3MA... user@host");
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Warning);
        assert!(result.message.contains("public key"));
    }

    #[test]
    fn mixed_case_pub_extension_returns_warning() {
        let f = write_temp_with_suffix(b"ssh-ed25519 AAAA... user@host", ".PUB");
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Warning);
        assert!(result.message.contains("public key"));
        assert!(result.message.contains(".pub"));
    }

    #[test]
    fn putty_ppk_v2_detected() {
        let content = b"PuTTY-User-Key-File-2: ssh-rsa\nEncryption: aes256-cbc\n";
        let f = write_temp(content);
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Warning);
        assert!(result.message.contains("PuTTY"));
    }

    #[test]
    fn empty_file_returns_unrecognized_warning() {
        let f = write_temp(b"");
        let result = validate_ssh_key(f.path().to_str().unwrap());
        assert_eq!(result.status, ValidationStatus::Warning);
        assert!(result.message.contains("Not a recognized"));
    }

    // --- is_ssh_key_encrypted (#885) ---

    #[test]
    fn encryption_openssh_passphrase_key_is_encrypted() {
        // OpenSSH-format key created with a passphrase (cipher aes256-ctr).
        assert_eq!(
            is_ssh_key_encrypted(&fixture("ed25519_passphrase")),
            Ok(true)
        );
        assert_eq!(
            is_ssh_key_encrypted(&fixture("rsa_2048_passphrase")),
            Ok(true)
        );
        assert_eq!(
            is_ssh_key_encrypted(&fixture("ecdsa_256_passphrase")),
            Ok(true)
        );
    }

    #[test]
    fn encryption_openssh_unencrypted_key_is_not_encrypted() {
        // OpenSSH-format key with no passphrase (cipher "none").
        assert_eq!(is_ssh_key_encrypted(&fixture("ed25519")), Ok(false));
        assert_eq!(is_ssh_key_encrypted(&fixture("rsa_2048")), Ok(false));
        assert_eq!(is_ssh_key_encrypted(&fixture("ecdsa_256")), Ok(false));
    }

    #[test]
    fn encryption_legacy_pem_proc_type_is_encrypted() {
        // Traditional OpenSSL PEM encryption header (RSA/EC/DSA).
        let content = b"-----BEGIN RSA PRIVATE KEY-----\n\
                        Proc-Type: 4,ENCRYPTED\n\
                        DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF\n\n\
                        c29tZWJhc2U2NGNpcGhlcnRleHQ=\n\
                        -----END RSA PRIVATE KEY-----\n";
        let f = write_temp(content);
        assert_eq!(is_ssh_key_encrypted(f.path().to_str().unwrap()), Ok(true));
    }

    #[test]
    fn encryption_pkcs8_encrypted_label_is_encrypted() {
        let content = b"-----BEGIN ENCRYPTED PRIVATE KEY-----\nYmFzZTY0\n-----END ENCRYPTED PRIVATE KEY-----\n";
        let f = write_temp(content);
        assert_eq!(is_ssh_key_encrypted(f.path().to_str().unwrap()), Ok(true));
    }

    #[test]
    fn encryption_unencrypted_pkcs8_label_is_not_encrypted() {
        let content = b"-----BEGIN PRIVATE KEY-----\nYmFzZTY0\n-----END PRIVATE KEY-----\n";
        let f = write_temp(content);
        assert_eq!(is_ssh_key_encrypted(f.path().to_str().unwrap()), Ok(false));
    }

    #[test]
    fn encryption_missing_file_returns_err() {
        assert!(is_ssh_key_encrypted("/nonexistent/path/to/key").is_err());
    }
}

//! SHA-256 integrity verification for downloaded agent binaries.
//!
//! Mirrors the desktop-side verification introduced in #1350
//! (`src-tauri/src/terminal/agent_binary.rs`) so the agent applies the same
//! fail-closed rule to any binary it downloads for a self-update: a binary is
//! never staged unless its published `.sha256` sidecar matches.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

/// File-name suffix for the SHA-256 checksum sidecar published next to every
/// agent binary release asset (e.g. `termihub-agent-linux-x64.sha256`).
pub const CHECKSUM_EXT: &str = "sha256";

/// Compute the lowercase-hex SHA-256 digest of a file's contents.
///
/// The file is streamed through the hasher, so arbitrarily large binaries are
/// never fully buffered in memory.
pub fn sha256_hex_of_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)
        .with_context(|| format!("Failed to open {} for checksum", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)
        .with_context(|| format!("Failed to read {} for checksum", path.display()))?;
    Ok(hex::encode(hasher.finalize()))
}

/// Parse the expected SHA-256 digest out of a checksum sidecar's contents.
///
/// Accepts both a bare 64-char hex digest and the standard `sha256sum` output
/// format `"<hex>  <filename>"` (text mode) or `"<hex> *<filename>"` (binary
/// mode) — only the first whitespace-delimited token is considered. The digest
/// is normalized to lowercase. Returns `None` when the first token is not a
/// valid 64-character hex string.
pub fn parse_sha256_sidecar(content: &str) -> Option<String> {
    let token = content.split_whitespace().next()?.to_ascii_lowercase();
    if token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(token)
    } else {
        None
    }
}

/// Verify that `path`'s SHA-256 digest equals `expected_hex`.
///
/// The comparison is case-insensitive. On mismatch this returns an error whose
/// message names the file and both digests, so a tampered or corrupted binary
/// is rejected with a clear, actionable message before it is ever staged or
/// executed.
pub fn verify_file_checksum(path: &Path, expected_hex: &str) -> Result<()> {
    let actual = sha256_hex_of_file(path)?;
    let expected = expected_hex.trim().to_ascii_lowercase();
    if actual == expected {
        Ok(())
    } else {
        bail!(
            "Checksum verification failed for {}: expected SHA-256 {expected}, computed {actual}. \
             Refusing to use an agent binary that does not match its published checksum.",
            path.display()
        );
    }
}

/// Return the path of the `.sha256` checksum sidecar for a binary path.
pub fn checksum_sidecar_path(binary_path: &Path) -> PathBuf {
    let mut name = binary_path.as_os_str().to_owned();
    name.push(".");
    name.push(CHECKSUM_EXT);
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Known SHA-256 of the ASCII string "abc" (NIST test vector).
    const SHA256_OF_ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn sha256_hex_of_file_matches_known_vector() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("payload.bin");
        fs::write(&path, b"abc").unwrap();
        assert_eq!(sha256_hex_of_file(&path).unwrap(), SHA256_OF_ABC);
    }

    #[test]
    fn parse_sha256_sidecar_plain_and_sha256sum_formats() {
        assert_eq!(
            parse_sha256_sidecar(SHA256_OF_ABC),
            Some(SHA256_OF_ABC.to_string())
        );
        let line = format!("{SHA256_OF_ABC}  termihub-agent-linux-x64\n");
        assert_eq!(parse_sha256_sidecar(&line), Some(SHA256_OF_ABC.to_string()));
        let bin = format!("{SHA256_OF_ABC} *termihub-agent-linux-x64\n");
        assert_eq!(parse_sha256_sidecar(&bin), Some(SHA256_OF_ABC.to_string()));
    }

    #[test]
    fn parse_sha256_sidecar_rejects_garbage() {
        assert_eq!(parse_sha256_sidecar(""), None);
        assert_eq!(parse_sha256_sidecar("not-a-hash"), None);
        assert_eq!(parse_sha256_sidecar("deadbeef"), None);
        assert_eq!(parse_sha256_sidecar(&"g".repeat(64)), None);
    }

    #[test]
    fn verify_file_checksum_ok_on_match_case_insensitive() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("payload.bin");
        fs::write(&path, b"abc").unwrap();
        assert!(verify_file_checksum(&path, SHA256_OF_ABC).is_ok());
        assert!(verify_file_checksum(&path, &SHA256_OF_ABC.to_ascii_uppercase()).is_ok());
    }

    #[test]
    fn verify_file_checksum_rejects_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("payload.bin");
        fs::write(&path, b"tampered content").unwrap();
        let err = verify_file_checksum(&path, SHA256_OF_ABC).unwrap_err();
        assert!(err.to_string().to_ascii_lowercase().contains("checksum"));
    }

    #[test]
    fn checksum_sidecar_path_appends_sha256() {
        let binary = PathBuf::from("/tmp/updates/termihub-agent-linux-x64");
        assert_eq!(
            checksum_sidecar_path(&binary),
            PathBuf::from("/tmp/updates/termihub-agent-linux-x64.sha256")
        );
    }
}

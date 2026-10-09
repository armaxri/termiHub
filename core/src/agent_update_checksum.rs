//! SHA-256 checksum gate for agent release assets (AGT-004 / AGT-007, #1350).
//!
//! The one fail-closed `.sha256` sidecar check, shared by both ends of an agent
//! update so they can never drift apart (#4365, audit DUP2-005):
//!
//! - the **desktop** verifies every resolved agent binary (cache, bundle,
//!   download) before any deploy path;
//! - the **agent** verifies every binary it downloads for a self-update before
//!   it is staged, and the test-hook re-verifies the staged binary.
//!
//! It is the checksum half of the release-asset contract; the Ed25519 `.sig`
//! half lives next to it in `agent_update_signature` (feature
//! `agent-update-signing`). Hashing goes through the single
//! [`crate::util::sha256`] primitive.
//!
//! # Sidecar format
//!
//! `<binary>.sha256`, published next to `<binary>`: either a bare 64-character
//! hex digest or a `sha256sum` line (`"<hex>  <file>"` / `"<hex> *<file>"`).

use std::path::{Path, PathBuf};

use crate::util::sha256::sha256_hex_of_reader;

/// File-name suffix for the SHA-256 checksum sidecar published next to every
/// agent binary release asset (e.g. `termihub-agent-linux-x64.sha256`).
pub const CHECKSUM_EXT: &str = crate::agent_release_asset::AGENT_CHECKSUM_EXT;

/// Why a file could not be checksummed, or did not match its checksum. Every
/// variant is a **fail-closed** rejection.
#[derive(Debug, thiserror::Error)]
pub enum ChecksumError {
    /// The file could not be opened.
    #[error("Failed to open {} for checksum", path.display())]
    Open {
        /// The file that was to be hashed.
        path: PathBuf,
        /// The underlying I/O error.
        #[source]
        source: std::io::Error,
    },
    /// The file could not be read to the end.
    #[error("Failed to read {} for checksum", path.display())]
    Read {
        /// The file that was being hashed.
        path: PathBuf,
        /// The underlying I/O error.
        #[source]
        source: std::io::Error,
    },
    /// The file's digest does not equal the expected one — a tampered or
    /// corrupted binary.
    #[error(
        "Checksum verification failed for {}: expected SHA-256 {expected}, computed {actual}. \
         Refusing to use an agent binary that does not match its published checksum.",
        path.display()
    )]
    Mismatch {
        /// The file that was verified.
        path: PathBuf,
        /// The expected digest (trimmed, lowercase).
        expected: String,
        /// The computed digest (lowercase).
        actual: String,
    },
}

/// Compute the lowercase-hex SHA-256 digest of a file's contents (streamed), with
/// errors naming the file.
pub fn file_sha256_hex(path: &Path) -> Result<String, ChecksumError> {
    let file = std::fs::File::open(path).map_err(|source| ChecksumError::Open {
        path: path.to_path_buf(),
        source,
    })?;
    sha256_hex_of_reader(file).map_err(|source| ChecksumError::Read {
        path: path.to_path_buf(),
        source,
    })
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
/// The comparison is case-insensitive (and ignores surrounding whitespace in
/// `expected_hex`). On mismatch this returns [`ChecksumError::Mismatch`], whose
/// message names the file and both digests, so a tampered or corrupted binary
/// is rejected with a clear, actionable message before it is ever staged,
/// installed or executed.
pub fn verify_file_checksum(path: &Path, expected_hex: &str) -> Result<(), ChecksumError> {
    let actual = file_sha256_hex(path)?;
    let expected = expected_hex.trim().to_ascii_lowercase();
    if actual == expected {
        Ok(())
    } else {
        Err(ChecksumError::Mismatch {
            path: path.to_path_buf(),
            expected,
            actual,
        })
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
    use std::fs;

    /// Known SHA-256 of the ASCII string "abc" (NIST test vector).
    const SHA256_OF_ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn write_payload(content: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("payload.bin");
        fs::write(&path, content).unwrap();
        (tmp, path)
    }

    #[test]
    fn checksum_ext_is_the_release_asset_scheme() {
        assert_eq!(CHECKSUM_EXT, "sha256");
        assert_eq!(
            crate::agent_release_asset::agent_checksum_asset_name("linux-x64"),
            format!("termihub-agent-linux-x64.{CHECKSUM_EXT}")
        );
    }

    #[test]
    fn file_sha256_hex_matches_known_vector() {
        let (_tmp, path) = write_payload(b"abc");
        assert_eq!(file_sha256_hex(&path).unwrap(), SHA256_OF_ABC);
    }

    #[test]
    fn file_sha256_hex_missing_file_is_an_open_error_naming_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("missing.bin");
        let err = file_sha256_hex(&path).unwrap_err();
        assert!(matches!(err, ChecksumError::Open { .. }));
        assert_eq!(
            err.to_string(),
            format!("Failed to open {} for checksum", path.display())
        );
        assert!(std::error::Error::source(&err).is_some());
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
    fn parse_sha256_sidecar_uppercase_is_normalized() {
        let upper = SHA256_OF_ABC.to_ascii_uppercase();
        assert_eq!(
            parse_sha256_sidecar(&upper),
            Some(SHA256_OF_ABC.to_string())
        );
    }

    #[test]
    fn parse_sha256_sidecar_rejects_garbage() {
        assert_eq!(parse_sha256_sidecar(""), None);
        assert_eq!(parse_sha256_sidecar("   \n"), None);
        assert_eq!(parse_sha256_sidecar("not-a-hash"), None);
        // Right charset, wrong length.
        assert_eq!(parse_sha256_sidecar("deadbeef"), None);
        assert_eq!(parse_sha256_sidecar(&format!("{SHA256_OF_ABC}0")), None);
        // Right length, wrong charset.
        assert_eq!(parse_sha256_sidecar(&"g".repeat(64)), None);
    }

    #[test]
    fn verify_file_checksum_ok_on_match_case_and_whitespace_insensitive() {
        let (_tmp, path) = write_payload(b"abc");
        assert!(verify_file_checksum(&path, SHA256_OF_ABC).is_ok());
        assert!(verify_file_checksum(&path, &SHA256_OF_ABC.to_ascii_uppercase()).is_ok());
        assert!(verify_file_checksum(&path, &format!("  {SHA256_OF_ABC}\n")).is_ok());
    }

    #[test]
    fn verify_file_checksum_rejects_mismatch_with_clear_error() {
        let (_tmp, path) = write_payload(b"tampered content");
        let err = verify_file_checksum(&path, SHA256_OF_ABC).unwrap_err();
        let ChecksumError::Mismatch {
            expected, actual, ..
        } = &err
        else {
            panic!("expected a mismatch, got {err:?}");
        };
        assert_eq!(expected, SHA256_OF_ABC);
        assert_ne!(actual, SHA256_OF_ABC);
        let msg = err.to_string();
        assert!(msg.starts_with("Checksum verification failed for "));
        assert!(msg.contains(&path.display().to_string()));
        assert!(msg.contains(SHA256_OF_ABC));
        assert!(msg.contains(actual.as_str()));
        assert!(msg.ends_with(
            "Refusing to use an agent binary that does not match its published checksum."
        ));
    }

    #[test]
    fn verify_file_checksum_rejects_a_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let err = verify_file_checksum(&tmp.path().join("gone"), SHA256_OF_ABC).unwrap_err();
        assert!(matches!(err, ChecksumError::Open { .. }));
    }

    #[test]
    fn verify_file_checksum_rejects_a_malformed_expected_digest() {
        let (_tmp, path) = write_payload(b"abc");
        assert!(matches!(
            verify_file_checksum(&path, "not-a-digest"),
            Err(ChecksumError::Mismatch { .. })
        ));
        assert!(matches!(
            verify_file_checksum(&path, ""),
            Err(ChecksumError::Mismatch { .. })
        ));
    }

    #[test]
    fn checksum_sidecar_path_appends_sha256() {
        assert_eq!(
            checksum_sidecar_path(Path::new("/tmp/updates/termihub-agent-linux-x64")),
            PathBuf::from("/tmp/updates/termihub-agent-linux-x64.sha256")
        );
        // Appends after an existing extension rather than replacing it.
        assert_eq!(
            checksum_sidecar_path(Path::new("/tmp/termihub-agent-windows-x64.exe")),
            PathBuf::from("/tmp/termihub-agent-windows-x64.exe.sha256")
        );
    }
}

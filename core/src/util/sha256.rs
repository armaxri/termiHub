//! The single streaming SHA-256 primitive (#4365, audit DUP2-005).
//!
//! Every "hash this file / reader / byte slice to lowercase hex" in core goes
//! through here: the agent release-asset checksum gate
//! ([`crate::agent_update_checksum`]), the RDP sidecar pre-spawn integrity check
//! and the plugin package/library digests. Keeping one implementation means the
//! digests those gates compare can never drift apart.

use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

/// Compute the lowercase-hex SHA-256 digest of everything `reader` yields.
///
/// The input is streamed through the hasher, so arbitrarily large inputs are
/// never fully buffered in memory. Reads from the reader's current position.
pub fn sha256_hex_of_reader<R: Read>(mut reader: R) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    std::io::copy(&mut reader, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

/// Compute the lowercase-hex SHA-256 digest of a file's contents (streamed).
pub fn sha256_hex_of_file(path: &Path) -> std::io::Result<String> {
    sha256_hex_of_reader(std::fs::File::open(path)?)
}

/// Compute the lowercase-hex SHA-256 digest of an in-memory byte slice.
pub fn sha256_hex_of_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Compute the raw 32-byte SHA-256 digest of an in-memory byte slice.
pub fn sha256_of_bytes(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SHA-256 of "abc" (NIST test vector).
    const SHA256_OF_ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    /// SHA-256 of the empty input.
    const SHA256_OF_EMPTY: &str =
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn bytes_match_known_vectors() {
        assert_eq!(sha256_hex_of_bytes(b"abc"), SHA256_OF_ABC);
        assert_eq!(sha256_hex_of_bytes(b""), SHA256_OF_EMPTY);
        assert_eq!(
            hex::encode(sha256_of_bytes(b"abc")),
            SHA256_OF_ABC,
            "raw and hex forms agree"
        );
    }

    #[test]
    fn reader_matches_bytes() {
        assert_eq!(sha256_hex_of_reader(&b"abc"[..]).unwrap(), SHA256_OF_ABC);
        assert_eq!(sha256_hex_of_reader(&b""[..]).unwrap(), SHA256_OF_EMPTY);
    }

    #[test]
    fn file_matches_known_vector_and_is_lowercase_hex() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("payload.bin");
        std::fs::write(&path, b"abc").unwrap();
        let digest = sha256_hex_of_file(&path).unwrap();
        assert_eq!(digest, SHA256_OF_ABC);
        assert_eq!(digest.len(), 64);
        assert!(digest
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }

    #[test]
    fn large_file_streams_to_the_same_digest_as_bytes() {
        // Larger than any internal copy buffer, so several reads are needed.
        let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        std::fs::write(&path, &data).unwrap();
        assert_eq!(
            sha256_hex_of_file(&path).unwrap(),
            sha256_hex_of_bytes(&data)
        );
    }

    #[test]
    fn missing_file_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert!(sha256_hex_of_file(&dir.path().join("nope")).is_err());
    }
}

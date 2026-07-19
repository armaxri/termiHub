//! SHA-256 integrity verification for the bundled `termihub-rdp-helper` sidecar.
//!
//! A released build ships the sidecar next to the desktop binary via Tauri
//! `externalBin` (#1754). Before spawning it (#1762) the adapter verifies the
//! resolved binary against a **known-good SHA-256 embedded at build time**, so a
//! tampered, corrupted, or wrong-arch helper is rejected before it ever runs —
//! mirroring the agent-binary checksum verification in `src-tauri`.
//!
//! The expected digest is produced by `core/build.rs`, which hashes the staged
//! `externalBin` (the exact bytes Tauri bundles) and emits it as the
//! `TERMIHUB_RDP_HELPER_SHA256` compile-time env var, read here via
//! [`option_env!`]. When no digest is embedded — per-PR compile/test jobs and
//! plain dev builds never stage the sidecar — the check is **skipped**, exactly
//! as the agent path tolerates a missing checksum sidecar. The
//! `$TERMIHUB_RDP_HELPER` dev/test override also skips the check, so a
//! locally-built helper still runs.

use std::path::Path;

use sha2::{Digest, Sha256};
use tracing::{debug, warn};

/// The known-good sidecar SHA-256 (lowercase hex), embedded at build time by
/// `core/build.rs`. `None` when no digest was staged (dev/branch builds).
pub const EXPECTED_HELPER_SHA256: Option<&str> = option_env!("TERMIHUB_RDP_HELPER_SHA256");

/// Compute the lowercase-hex SHA-256 digest of a file's contents.
///
/// The file is streamed through the hasher, so an arbitrarily large binary is
/// hashed without loading it all into memory.
pub fn sha256_hex_of_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

/// Verify the resolved sidecar binary against its build-time SHA-256 before it
/// is spawned.
///
/// Returns `Ok(())` — the binary may be spawned — when:
/// - `override_active` is set (the `$TERMIHUB_RDP_HELPER` dev/test override is in
///   use, so the operator picked the binary deliberately), or
/// - `expected` is `None` (no digest was embedded — an out-of-scope dev/branch
///   build that does not stage the sidecar), in which case integrity cannot be
///   verified and the connection proceeds with a warning.
///
/// Returns `Err(message)` — refuse to spawn — when a digest is embedded and the
/// binary's actual SHA-256 does not match it, or the binary cannot be read. The
/// message names the file and both digests so the failure is actionable.
pub fn verify_helper_integrity(
    path: &Path,
    override_active: bool,
    expected: Option<&str>,
) -> Result<(), String> {
    if override_active {
        debug!(
            path = %path.display(),
            "TERMIHUB_RDP_HELPER override is set — skipping sidecar integrity check"
        );
        return Ok(());
    }

    let expected = match expected {
        Some(e) if !e.trim().is_empty() => e.trim().to_ascii_lowercase(),
        _ => {
            warn!(
                path = %path.display(),
                "no build-time SHA-256 embedded for the RDP helper — spawning without \
                 integrity verification (dev/branch build)"
            );
            return Ok(());
        }
    };

    let actual = sha256_hex_of_file(path).map_err(|e| {
        format!(
            "failed to read RDP helper '{}' for integrity verification: {e}",
            path.display()
        )
    })?;

    if actual == expected {
        debug!(path = %path.display(), "RDP helper SHA-256 verified");
        Ok(())
    } else {
        Err(format!(
            "RDP helper integrity check failed for '{}': expected SHA-256 {expected}, \
             computed {actual}. Refusing to spawn a sidecar that does not match the digest \
             embedded at build time. Rebuild it with scripts/build-rdp-sidecar.sh, or point \
             {env} at a trusted binary.",
            path.display(),
            env = super::HELPER_PATH_ENV,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// The canonical SHA-256 test vector: `sha256("abc")`.
    const SHA256_OF_ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn write_temp(bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("termihub-rdp-helper");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(bytes).unwrap();
        (dir, path)
    }

    #[test]
    fn sha256_hex_of_file_matches_known_vector() {
        let (_dir, path) = write_temp(b"abc");
        assert_eq!(sha256_hex_of_file(&path).unwrap(), SHA256_OF_ABC);
    }

    #[test]
    fn sha256_hex_of_file_is_lowercase_64_hex() {
        let (_dir, path) = write_temp(b"anything");
        let digest = sha256_hex_of_file(&path).unwrap();
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn sha256_hex_of_file_missing_file_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert!(sha256_hex_of_file(&dir.path().join("nope")).is_err());
    }

    #[test]
    fn verify_accepts_a_matching_digest() {
        let (_dir, path) = write_temp(b"abc");
        assert!(verify_helper_integrity(&path, false, Some(SHA256_OF_ABC)).is_ok());
        // Case-insensitive on the expected side.
        let upper = SHA256_OF_ABC.to_ascii_uppercase();
        assert!(verify_helper_integrity(&path, false, Some(&upper)).is_ok());
    }

    #[test]
    fn verify_rejects_a_mismatched_digest_with_a_clear_error() {
        // A file whose digest is NOT SHA256_OF_ABC.
        let (_dir, path) = write_temp(b"tampered");
        let err = verify_helper_integrity(&path, false, Some(SHA256_OF_ABC)).unwrap_err();
        assert!(err.contains("integrity check failed"), "got: {err}");
        assert!(err.contains(SHA256_OF_ABC), "error should name the expected digest: {err}");
    }

    #[test]
    fn verify_skips_when_no_digest_is_embedded() {
        // No embedded digest (dev/branch build) → cannot verify, must not fail.
        let (_dir, path) = write_temp(b"abc");
        assert!(verify_helper_integrity(&path, false, None).is_ok());
        assert!(verify_helper_integrity(&path, false, Some("   ")).is_ok());
    }

    #[test]
    fn verify_skips_when_override_is_active() {
        // With the $TERMIHUB_RDP_HELPER override in use the check is skipped even
        // when the digest would otherwise mismatch — and even for a missing file.
        let (_dir, path) = write_temp(b"tampered");
        assert!(verify_helper_integrity(&path, true, Some(SHA256_OF_ABC)).is_ok());
        let dir = tempfile::tempdir().unwrap();
        assert!(verify_helper_integrity(&dir.path().join("nope"), true, Some(SHA256_OF_ABC)).is_ok());
    }
}

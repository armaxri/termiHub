//! Build script for `termihub-core`.
//!
//! # RDP sidecar integrity digest (#1762)
//!
//! A released build ships the `termihub-rdp-helper` sidecar next to the desktop
//! binary via Tauri `externalBin` (#1754). The [`rdp_sidecar`] adapter verifies
//! the resolved binary against a known-good SHA-256 before spawning it, so a
//! tampered/corrupted/wrong-arch helper is rejected. This script produces that
//! expected digest and embeds it as the `TERMIHUB_RDP_HELPER_SHA256` env var,
//! which the adapter reads with `option_env!`.
//!
//! The digest is resolved from, in order:
//!   1. `$TERMIHUB_RDP_HELPER_SHA256` — an explicit 64-hex override (CI or manual
//!      testing may set it directly), else
//!   2. the staged `externalBin` at
//!      `src-tauri/binaries/termihub-rdp-helper-<target>[.exe]` — the exact bytes
//!      Tauri bundles, produced by `scripts/build-rdp-sidecar.sh --tauri-externalbin`
//!      before the release/dev-build Tauri step runs. Its contents are hashed here.
//!
//! When neither is present — per-PR compile/test jobs and plain dev builds never
//! stage the sidecar — no digest is emitted, and the runtime check is skipped
//! (exactly how the agent-binary path tolerates a missing checksum sidecar).
//!
//! This script never fails the build: an unreadable or absent staged binary just
//! means "no embedded digest", not a compile error.
//!
//! [`rdp_sidecar`]: crate::backends::rdp_sidecar

use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=TERMIHUB_RDP_HELPER_SHA256");

    let staged = staged_helper_path();
    // Re-run when the staged binary appears/changes (rerun-if-changed on a
    // not-yet-existing path fires once it is created).
    println!("cargo:rerun-if-changed={}", staged.display());

    if let Some(digest) = resolve_digest(&staged) {
        println!("cargo:rustc-env=TERMIHUB_RDP_HELPER_SHA256={digest}");
    }
}

/// Resolve the expected sidecar SHA-256 (lowercase hex), or `None`.
fn resolve_digest(staged: &Path) -> Option<String> {
    if let Ok(raw) = std::env::var("TERMIHUB_RDP_HELPER_SHA256") {
        let v = raw.trim().to_ascii_lowercase();
        if is_sha256_hex(&v) {
            return Some(v);
        }
        if !v.is_empty() {
            println!(
                "cargo:warning=Ignoring TERMIHUB_RDP_HELPER_SHA256: not a 64-char hex SHA-256"
            );
        }
    }

    if staged.is_file() {
        match sha256_hex_of_file(staged) {
            Ok(digest) => return Some(digest),
            Err(e) => println!(
                "cargo:warning=Failed to hash staged RDP helper {}: {e}",
                staged.display()
            ),
        }
    }

    None
}

/// Path to the staged `externalBin` for the target being compiled.
fn staged_helper_path() -> PathBuf {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let target = std::env::var("TARGET").unwrap_or_default();
    let name = if target.contains("windows") {
        format!("termihub-rdp-helper-{target}.exe")
    } else {
        format!("termihub-rdp-helper-{target}")
    };
    // core/ -> repo root -> src-tauri/binaries/<name>
    manifest
        .join("..")
        .join("src-tauri")
        .join("binaries")
        .join(name)
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn sha256_hex_of_file(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

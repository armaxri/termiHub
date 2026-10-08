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
//!
//! # Plugin runner integrity digest (#4202)
//!
//! The out-of-process plugin runner (`termihub-plugin-runner`, #4182) ships the
//! same way, so its expected SHA-256 is embedded the same way, as
//! `TERMIHUB_PLUGIN_RUNNER_SHA256`, from `$TERMIHUB_PLUGIN_RUNNER_SHA256` or the
//! staged `src-tauri/binaries/termihub-plugin-runner-<target>[.exe]` (written by
//! `scripts/build-plugin-runner.sh --tauri-externalbin`). One difference: the
//! staged file is only hashed for a **release** profile. A debug build (`tauri
//! dev`, tests) runs the cargo-built runner, never the staged one, so a digest
//! left behind by an earlier local bundle build must not make it refuse that.
//!
//! # Plugin host target triple (PLG-011)
//!
//! The plugin host picks the native backend library matching its own Rust
//! target triple out of a multi-platform `.termihub-plugin` package
//! (`extensions.terminalBackend.libraries`). Rust does not expose the target
//! triple to the crate itself, so this script forwards cargo's `TARGET` as the
//! `TERMIHUB_TARGET_TRIPLE` env var, read with `env!` in `plugin::platform`.

use std::path::{Path, PathBuf};

/// A sidecar binary staged for Tauri `externalBin` whose SHA-256 the host
/// embeds to verify it before spawning it.
struct Sidecar {
    /// The binary name, without the `-<target>[.exe]` staging suffix.
    bin: &'static str,
    /// The compile-time env var carrying the digest (also the override name).
    env: &'static str,
    /// Hash the staged file only for a release profile (see the module docs).
    release_only: bool,
}

const SIDECARS: [Sidecar; 2] = [
    Sidecar {
        bin: "termihub-rdp-helper",
        env: "TERMIHUB_RDP_HELPER_SHA256",
        release_only: false,
    },
    Sidecar {
        bin: "termihub-plugin-runner",
        env: "TERMIHUB_PLUGIN_RUNNER_SHA256",
        release_only: true,
    },
];

fn main() {
    // Cargo always sets TARGET for build scripts; fall back to "unknown" rather
    // than failing the build (a host that cannot name its triple then simply
    // matches no multi-platform package entry — fail closed).
    let target = std::env::var("TARGET").unwrap_or_else(|_| "unknown".to_owned());
    println!("cargo:rustc-env=TERMIHUB_TARGET_TRIPLE={target}");
    let release = std::env::var("PROFILE").is_ok_and(|p| p == "release");

    let staging = staging_dir();
    // Re-run when a staged binary appears or changes. Watch the staging
    // DIRECTORY, not the file: cargo treats a `rerun-if-changed` path that does
    // not exist as permanently stale, so watching the (normally absent) staged
    // file re-ran this script -- and recompiled termihub-core and every crate
    // above it -- on every cargo invocation (#3909). The directory is kept in
    // git by a placeholder (`src-tauri/binaries/.gitkeep`), and cargo scans a
    // watched directory's files, so staging a helper into it still re-runs this.
    println!("cargo:rerun-if-changed={}", staging.display());

    for sidecar in &SIDECARS {
        println!("cargo:rerun-if-env-changed={}", sidecar.env);
        let staged = staging.join(staged_name(sidecar.bin, &target));
        let hash_staged = release || !sidecar.release_only;
        if let Some(digest) = resolve_digest(sidecar.env, &staged, hash_staged) {
            println!("cargo:rustc-env={}={digest}", sidecar.env);
        }
    }
}

/// Resolve a sidecar's expected SHA-256 (lowercase hex), or `None`: the
/// `env` override, else the staged binary when `hash_staged` is set.
fn resolve_digest(env: &str, staged: &Path, hash_staged: bool) -> Option<String> {
    if let Ok(raw) = std::env::var(env) {
        let v = raw.trim().to_ascii_lowercase();
        if is_sha256_hex(&v) {
            return Some(v);
        }
        if !v.is_empty() {
            println!("cargo:warning=Ignoring {env}: not a 64-char hex SHA-256");
        }
    }

    if hash_staged && staged.is_file() {
        match sha256_hex_of_file(staged) {
            Ok(digest) => return Some(digest),
            Err(e) => println!(
                "cargo:warning=Failed to hash staged sidecar {}: {e}",
                staged.display()
            ),
        }
    }

    None
}

/// `src-tauri/binaries/`, where the `externalBin` sidecars are staged.
fn staging_dir() -> PathBuf {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    // core/ -> repo root -> src-tauri/binaries
    manifest.join("..").join("src-tauri").join("binaries")
}

/// The staged file name Tauri `externalBin` expects for `bin` on `target`.
fn staged_name(bin: &str, target: &str) -> String {
    if target.contains("windows") {
        format!("{bin}-{target}.exe")
    } else {
        format!("{bin}-{target}")
    }
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

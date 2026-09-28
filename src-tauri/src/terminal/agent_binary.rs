//! Agent binary resolution: cache → bundled → download.
//!
//! When the desktop needs to deploy the agent to a remote host, this module
//! figures out where to get the binary from:
//!
//! 1. **Local cache** — `~/.cache/termihub/agent-binaries/<version>/termihub-agent-<arch>`
//! 2. **Bundled resource** — shipped inside the Tauri app bundle
//! 3. **GitHub Releases download** — fetched on demand and cached locally
//!
//! Every resolution is verified before it is handed to a deploy path:
//!
//! - **SHA-256 checksum** against the `.sha256` sidecar (AGT-004 / AGT-007);
//! - **Ed25519 signature** against the `.sig` sidecar and the release key
//!   compiled in from `agent/keys/update-signing.pub.pem` (AGT-005, #3330), using
//!   the same `termihub_core::agent_update_signature` code the agent gates its
//!   own self-updates on.
//!
//! Release builds fail closed on both (missing, malformed or non-verifying
//! sidecars, and the placeholder key, all reject). Dev/branch builds stay
//! relaxed: a missing sidecar is tolerated with a warning, but a present one must
//! still verify. Because verification happens at resolution, it covers every
//! deploy path — the immediate shutdown + install over SSH, the Windows fallback,
//! and the coordinated push.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use termihub_core::agent_update_signature::{
    signature_sidecar_path, SignaturePolicy, SignatureVerdict, SIGNATURE_EXT,
};
use tracing::{debug, info, warn};

use crate::utils::download::download_to_file;
use crate::utils::fs::is_nonempty_file;

/// GitHub repository for release downloads.
const GITHUB_REPO: &str = "armaxri/termiHub";

/// File-name suffix for the SHA-256 checksum sidecar published next to every
/// agent binary release asset (e.g. `termihub-agent-linux-x64.sha256`).
const CHECKSUM_EXT: &str = "sha256";

/// Map a remote OS string and architecture string to the artifact suffix we use.
///
/// The OS string may come from `uname -s` (Linux, macOS, or a MinGW/MSYS/Cygwin
/// shell on Windows) or from Windows environment probing (`%OS%` → `Windows_NT`).
/// The architecture string may come from `uname -m` (e.g. `"x86_64"`) or from
/// `%PROCESSOR_ARCHITECTURE%` (e.g. `"AMD64"`), so the Windows branch matches
/// case-insensitively.
///
/// Returns `None` for unsupported OS/architecture combinations.
pub fn artifact_name_for_os_arch(uname_os: &str, uname_arch: &str) -> Option<&'static str> {
    // Windows must be checked before the Linux fallback so a MinGW/MSYS/Cygwin
    // host (whose `uname -s` is e.g. `"MINGW64_NT-10.0"`) is not misdetected.
    if is_windows_os(uname_os) {
        return match uname_arch.to_ascii_lowercase().as_str() {
            "x86_64" | "amd64" => Some("windows-x64"),
            "aarch64" | "arm64" => Some("windows-arm64"),
            _ => None,
        };
    }
    match uname_os {
        "Darwin" => match uname_arch {
            "x86_64" | "amd64" => Some("macos-x64"),
            "aarch64" | "arm64" => Some("macos-arm64"),
            _ => None,
        },
        _ => match uname_arch {
            "x86_64" | "amd64" => Some("linux-x64"),
            "aarch64" | "arm64" => Some("linux-arm64"),
            "armv7l" | "armhf" => Some("linux-armv7"),
            _ => None,
        },
    }
}

/// Returns `true` if an OS string identifies a Windows host.
///
/// Recognizes the `uname -s` output of MinGW/MSYS/Cygwin shells
/// (e.g. `"MINGW64_NT-10.0"`, `"MSYS_NT-..."`, `"CYGWIN_NT-..."`) as well as the
/// `%OS%` value `"Windows_NT"` reported by `cmd.exe`/PowerShell probing.
pub fn is_windows_os(os: &str) -> bool {
    let upper = os.to_ascii_uppercase();
    upper.starts_with("MINGW")
        || upper.starts_with("MSYS")
        || upper.starts_with("CYGWIN")
        || upper.starts_with("WINDOWS")
}

/// Return the cache directory for agent binaries.
///
/// Defaults to `~/.cache/termihub/agent-binaries/` on Linux/macOS,
/// or the platform-appropriate cache directory via `dirs::cache_dir()`.
pub fn cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("termihub")
        .join("agent-binaries")
}

/// Return the expected path for a cached binary of a given version and arch.
pub fn cached_binary_path(version: &str, arch_suffix: &str) -> PathBuf {
    cache_dir()
        .join(version)
        .join(format!("termihub-agent-{arch_suffix}"))
}

/// Look for a cached binary. Returns `Some(path)` if it exists and is non-empty.
pub fn find_cached_binary(version: &str, arch_suffix: &str) -> Option<PathBuf> {
    let path = cached_binary_path(version, arch_suffix);
    if is_nonempty_file(&path) {
        debug!("Found cached agent binary: {}", path.display());
        Some(path)
    } else {
        None
    }
}

/// Look for a bundled binary in the Tauri resource directory.
///
/// The binary is expected at `resources/termihub-agent-<arch_suffix>` inside
/// the app bundle.
pub fn find_bundled_binary(app_handle: &tauri::AppHandle, arch_suffix: &str) -> Option<PathBuf> {
    use tauri::Manager;

    let resource_dir = app_handle.path().resource_dir().ok()?;
    let binary_name = format!("termihub-agent-{arch_suffix}");
    let path = resource_dir.join(&binary_name);

    if path.is_file() {
        debug!("Found bundled agent binary: {}", path.display());
        Some(path)
    } else {
        debug!(
            "No bundled agent binary at {} (checked {})",
            binary_name,
            path.display()
        );
        None
    }
}

/// Sanitize a git branch name for use as a GitHub release tag component.
///
/// Replaces any character that is not alphanumeric or `-` with `-`, then
/// collapses consecutive dashes and strips leading/trailing dashes.
pub fn sanitize_branch_name(branch: &str) -> String {
    let sanitized: String = branch
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    sanitized
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Build the full GitHub Releases download URL for an agent built from a specific branch.
///
/// Branch release tags follow the pattern `agent-branch-{sanitized-branch}`.
pub fn compute_branch_build_url(branch: &str, arch_suffix: &str) -> String {
    let tag = format!("agent-branch-{}", sanitize_branch_name(branch));
    format!("https://github.com/{GITHUB_REPO}/releases/download/{tag}/termihub-agent-{arch_suffix}")
}

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

/// Compute the lowercase-hex SHA-256 digest of an in-memory byte slice.
///
/// Used by the coordinated update path to hash exactly the bytes it uploads to
/// the agent, so it can send the agent the `expectedSha256` to re-verify the
/// staged binary against before the swap (AGT-004).
pub fn sha256_hex_of_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
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
/// is rejected with a clear, actionable message before it is ever installed or
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
fn checksum_sidecar_path(binary_path: &Path) -> PathBuf {
    let mut name = binary_path.as_os_str().to_owned();
    name.push(".");
    name.push(CHECKSUM_EXT);
    PathBuf::from(name)
}

/// Read the base64 Ed25519 signature from the `.sig` sidecar next to a resolved
/// agent binary, if one exists (AGT-005, #3213).
///
/// Returned verbatim (trimmed) for the `signature` param of
/// `agent.request_update`; the agent re-verifies it before the swap (the desktop
/// has already verified it at resolution, #3330). `None` for local dev builds
/// and unsigned dev/branch downloads — a release desktop never resolves such a
/// binary, and a release-built agent refuses it.
pub fn read_signature_sidecar(binary_path: &Path) -> Option<String> {
    fs::read_to_string(signature_sidecar_path(binary_path))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Best-effort fetch of the `.sig` sidecar published next to `url` into
/// `<dest>.sig`. A missing signature is not an error *here* — the caller then
/// runs [`verify_adjacent_signature`], which fails closed on it for release
/// builds. Any stale sidecar from a previous download is removed first so it can
/// never be paired with new bytes.
fn fetch_signature_sidecar(url: &str, dest: &Path) {
    let sig_sidecar = signature_sidecar_path(dest);
    let _ = fs::remove_file(&sig_sidecar);
    let sig_url = format!("{url}.{SIGNATURE_EXT}");
    if let Err(e) = download_to_file(&sig_url, &sig_sidecar, |_, _| {}) {
        let _ = fs::remove_file(&sig_sidecar);
        debug!("No signature sidecar at {sig_url} ({e})");
    }
}

/// The signature policy for a resolution: the embedded release key(s), with the
/// unsigned allowance on only when `require_verified` is `false` (dev/branch
/// builds — the same rule that relaxes the AGT-007 checksum requirement).
fn signature_policy(require_verified: bool) -> SignaturePolicy {
    SignaturePolicy::embedded(!require_verified)
}

/// Verify the `.sig` sidecar next to `binary_path` over `digest_hex` — the
/// SHA-256 of the exact bytes that will be deployed (AGT-005, #3330).
///
/// Fails closed under a strict (release) policy on a missing, malformed or
/// non-verifying signature and on the placeholder key; a relaxed (dev) policy
/// tolerates only a *missing* signature. Callers that re-read the binary before
/// deploying (the coordinated push) pass the digest of the bytes they actually
/// upload, so a file swapped after resolution is still caught.
pub fn verify_signature_for_digest(
    binary_path: &Path,
    digest_hex: &str,
    policy: &SignaturePolicy,
) -> Result<()> {
    let signature = read_signature_sidecar(binary_path);
    match policy.verify(digest_hex, signature.as_deref()) {
        Ok(SignatureVerdict::Verified) => {
            debug!("Agent binary signature verified: {}", binary_path.display());
            Ok(())
        }
        Ok(SignatureVerdict::UnsignedDevBuild) => {
            warn!(
                "No signature sidecar for {} — deploying an unsigned agent binary (dev build only)",
                binary_path.display()
            );
            Ok(())
        }
        Err(e) => bail!(
            "Signature verification failed for {}: {e}. Refusing to deploy this agent binary.",
            binary_path.display()
        ),
    }
}

/// The signature policy a deploy of the resolved agent binary for `version`
/// must satisfy — strict for release builds, relaxed for dev/branch builds
/// (same rule as [`resolve_agent_binary`]).
pub fn deploy_signature_policy(version: &str) -> SignaturePolicy {
    signature_policy(!is_dev_build(version))
}

/// Re-verify the signature over the exact bytes a deploy path is about to
/// upload (read after resolution), closing the window in which the resolved file
/// could be swapped between verification and upload.
pub fn verify_deploy_bytes(binary_path: &Path, bytes: &[u8], version: &str) -> Result<()> {
    verify_signature_for_digest(
        binary_path,
        &sha256_hex_of_bytes(bytes),
        &deploy_signature_policy(version),
    )
}

/// Verify the `.sig` sidecar next to a resolved binary against the binary's
/// on-disk bytes. See [`verify_signature_for_digest`].
fn verify_adjacent_signature(binary_path: &Path, policy: &SignaturePolicy) -> Result<()> {
    let digest = sha256_hex_of_file(binary_path)?;
    verify_signature_for_digest(binary_path, &digest, policy)
}

/// Verify a resolved binary before it may be deployed: the `.sha256` checksum
/// (AGT-004 / AGT-007) and then the `.sig` signature (AGT-005, #3330).
fn verify_resolved_binary(
    binary_path: &Path,
    require_checksum: bool,
    policy: &SignaturePolicy,
) -> Result<()> {
    verify_with_adjacent_sidecar(binary_path, require_checksum)?;
    verify_adjacent_signature(binary_path, policy)
}

/// Verify a resolved binary against a `.sha256` sidecar sitting next to it.
///
/// - Sidecar present and matching → `Ok(())`.
/// - Sidecar present but the binary does not match, or the sidecar is malformed
///   → `Err` (the binary is rejected; it must never be installed or executed).
/// - Sidecar absent → depends on `require_checksum`:
///   - `true` (release builds, where [`release.yml`] publishes a sidecar for
///     every agent asset) → **fail closed**: a missing sidecar is a hard error,
///     so a cache or bundle entry with no published checksum is never installed
///     or executed. This closes the substitution hole where an attacker could
///     strip the `.sha256` to bypass verification (AGT-007).
///   - `false` (dev/branch builds, which do not publish checksums yet) → tolerate
///     with a warning: integrity cannot be verified but local iteration is not
///     broken (e.g. a legacy cache entry or an out-of-scope dev/branch build).
fn verify_with_adjacent_sidecar(binary_path: &Path, require_checksum: bool) -> Result<()> {
    let sidecar = checksum_sidecar_path(binary_path);
    match fs::read_to_string(&sidecar) {
        Ok(content) => {
            let expected = parse_sha256_sidecar(&content).ok_or_else(|| {
                anyhow::anyhow!(
                    "Malformed checksum sidecar {} — refusing to use an unverifiable agent binary",
                    sidecar.display()
                )
            })?;
            verify_file_checksum(binary_path, &expected)
        }
        Err(_) if require_checksum => {
            // Release build: a published checksum is mandatory. Refuse to use an
            // agent binary whose integrity cannot be verified.
            bail!(
                "No checksum sidecar for {} — refusing to use an unverifiable agent binary in a \
                 release build",
                binary_path.display()
            )
        }
        Err(_) => {
            warn!(
                "No checksum sidecar for {} — skipping integrity verification",
                binary_path.display()
            );
            Ok(())
        }
    }
}

/// Download a binary and verify it against its published `.sha256` sidecar.
///
/// The binary is fetched to `dest`, then the sidecar at `<url>.sha256` is
/// fetched next to it and the binary is verified against it — a mismatch or a
/// malformed sidecar aborts with both files removed, so a tampered download is
/// never left on disk to masquerade as a valid cache hit.
///
/// `require_checksum` controls the missing-sidecar case:
/// - `true` (release `v{version}` downloads, where [`release.yml`] always
///   publishes a sidecar) → a missing sidecar fails closed. This is the primary
///   substitution defense: an attacker cannot bypass verification by simply
///   omitting the `.sha256`.
/// - `false` (out-of-scope dev/branch builds that do not publish checksums yet)
///   → a missing sidecar is tolerated with a warning.
///
/// After the checksum passes, the `.sig` sidecar is fetched and verified under
/// `policy` (AGT-005, #3330); a rejected signature removes the binary and both
/// sidecars, exactly like a checksum mismatch.
fn download_binary_with_checksum<F>(
    url: &str,
    dest: &Path,
    require_checksum: bool,
    policy: &SignaturePolicy,
    progress_cb: F,
) -> Result<()>
where
    F: Fn(u64, u64),
{
    download_to_file(url, dest, progress_cb)?;

    let checksum_url = format!("{url}.{CHECKSUM_EXT}");
    let sidecar = checksum_sidecar_path(dest);
    if let Err(e) = download_to_file(&checksum_url, &sidecar, |_, _| {}) {
        if require_checksum {
            // A release asset must have a published checksum; refusing to
            // install an unverifiable binary is the whole point of the feature.
            let _ = fs::remove_file(dest);
            return Err(e).with_context(|| {
                format!(
                    "No published SHA-256 checksum at {checksum_url} — refusing to install an \
                     unverifiable agent binary"
                )
            });
        }
        // Out-of-scope dev/branch build with no published checksum — keep the
        // binary but warn that integrity could not be verified. Still honour a
        // published signature: a present one must verify.
        warn!(
            "No checksum available at {checksum_url} ({e}) — installing agent binary \
             without integrity verification"
        );
        fetch_signature_sidecar(url, dest);
        if let Err(e) = verify_adjacent_signature(dest, policy) {
            remove_download(dest);
            return Err(e);
        }
        return Ok(());
    }

    // The sidecar was just fetched next to `dest`; verify against it and clean
    // up both files on any mismatch or malformed sidecar.
    if let Err(e) = verify_with_adjacent_sidecar(dest, require_checksum) {
        remove_download(dest);
        return Err(e);
    }
    // AGT-005 (#3330): the binary must also carry a valid release signature
    // (release builds) before it may become a cache hit or be deployed.
    fetch_signature_sidecar(url, dest);
    if let Err(e) = verify_adjacent_signature(dest, policy) {
        remove_download(dest);
        return Err(e);
    }
    Ok(())
}

/// Remove a rejected download and its sidecars so it can never masquerade as a
/// valid cache hit.
fn remove_download(dest: &Path) {
    let _ = fs::remove_file(dest);
    let _ = fs::remove_file(checksum_sidecar_path(dest));
    let _ = fs::remove_file(signature_sidecar_path(dest));
}

/// Download the agent binary from an explicit URL and cache it under `cache_key/termihub-agent-{arch}`.
///
/// When a `.sha256` sidecar is published next to the URL the download is
/// verified against it (see [`download_binary_with_checksum`]). This is used for
/// branch builds, which do not publish checksums yet (out of scope for #1350),
/// so a missing sidecar is tolerated with a warning rather than failing closed.
pub fn download_agent_binary_from_url<F>(
    url: &str,
    cache_key: &str,
    arch_suffix: &str,
    progress_cb: F,
) -> Result<PathBuf>
where
    F: Fn(u64, u64),
{
    let dest = cache_dir()
        .join(cache_key)
        .join(format!("termihub-agent-{arch_suffix}"));
    // Relaxed (dev/branch) posture for both checksum and signature: a missing
    // sidecar is tolerated, a present one must verify.
    download_binary_with_checksum(
        url,
        &dest,
        /* require_checksum */ false,
        &signature_policy(/* require_verified */ false),
        progress_cb,
    )?;
    Ok(dest)
}

/// Resolve the agent binary for a specific branch build.
///
/// Checks the local cache first (under `branch-{sanitized}/termihub-agent-{arch}`),
/// then downloads from the branch release on GitHub.
pub fn resolve_branch_build_binary<F>(
    branch: &str,
    arch_suffix: &str,
    progress_cb: F,
) -> Result<PathBuf>
where
    F: Fn(u64, u64),
{
    let cache_key = format!("branch-{}", sanitize_branch_name(branch));
    let cached = cache_dir()
        .join(&cache_key)
        .join(format!("termihub-agent-{arch_suffix}"));

    if is_nonempty_file(&cached) {
        debug!("Using cached branch build binary: {}", cached.display());
        // Branch builds do not publish checksums yet (out of scope for #1350), so
        // a missing sidecar is tolerated — same relaxed posture as their download.
        verify_resolved_binary(
            &cached,
            /* require_checksum */ false,
            &signature_policy(/* require_verified */ false),
        )?;
        return Ok(cached);
    }

    let url = compute_branch_build_url(branch, arch_suffix);
    download_agent_binary_from_url(&url, &cache_key, arch_suffix, progress_cb)
}

/// Return `true` when the current build downloads agents from a dev/branch tag
/// (`dev-latest` / `dev-develop-latest`) rather than a release `v{version}` tag.
///
/// Dev builds are identified by debug mode, the CI dev-build flag, or a `-dev`
/// version suffix. Release downloads are the negation, and only they are gated
/// on a mandatory checksum and release signature (see
/// [`download_binary_with_checksum`]).
fn is_dev_build(version: &str) -> bool {
    cfg!(debug_assertions) || env!("TERMIHUB_IS_DEV_BUILD") == "1" || version.ends_with("-dev")
}

/// Return the base download URL (without arch suffix) for the current build.
///
/// Dev builds (debug mode, `-dev` version suffix, or CI dev-build flag) use a
/// branch-specific tag: `dev-develop-latest` for develop, `dev-latest` for everything
/// else. Release builds use `v{version}`.
///
/// Append an arch suffix (e.g. `"linux-arm64"`) to obtain the full URL.
pub fn compute_download_base_url(version: &str) -> String {
    let tag = if is_dev_build(version) {
        if env!("TERMIHUB_BUILD_BRANCH") == "develop" {
            "dev-develop-latest".to_string()
        } else {
            "dev-latest".to_string()
        }
    } else {
        format!("v{version}")
    };
    format!("https://github.com/{GITHUB_REPO}/releases/download/{tag}/termihub-agent-")
}

/// Build the full GitHub Releases download URL for a given version and arch suffix.
pub fn compute_download_url(version: &str, arch_suffix: &str) -> String {
    format!("{}{}", compute_download_base_url(version), arch_suffix)
}

// Test helpers with explicit flags so tests are not affected by
// whether the test runner itself is a debug or release build.
#[cfg(test)]
pub(crate) fn compute_download_base_url_impl(
    version: &str,
    is_debug_build: bool,
    branch: &str,
) -> String {
    let is_dev = is_debug_build || version.ends_with("-dev");
    let tag = if is_dev {
        if branch == "develop" {
            "dev-develop-latest".to_string()
        } else {
            "dev-latest".to_string()
        }
    } else {
        format!("v{version}")
    };
    format!("https://github.com/{GITHUB_REPO}/releases/download/{tag}/termihub-agent-")
}

#[cfg(test)]
pub(crate) fn compute_download_url_impl(
    version: &str,
    arch_suffix: &str,
    is_debug_build: bool,
    branch: &str,
) -> String {
    format!(
        "{}{}",
        compute_download_base_url_impl(version, is_debug_build, branch),
        arch_suffix
    )
}

/// Download the agent binary from GitHub Releases and cache it locally.
///
/// `progress_cb` is called with `(bytes_downloaded, total_bytes)` — total may
/// be 0 if the server doesn't send Content-Length.
pub fn download_agent_binary<F>(version: &str, arch_suffix: &str, progress_cb: F) -> Result<PathBuf>
where
    F: Fn(u64, u64),
{
    let url = compute_download_url(version, arch_suffix);
    let dest = cached_binary_path(version, arch_suffix);
    // Release downloads (`v{version}`) must carry a published checksum; dev tags
    // (`dev-latest` / `dev-develop-latest`) do not publish one yet (out of scope).
    // Release downloads must also carry a valid release signature (#3330).
    let require_verified = !is_dev_build(version);
    download_binary_with_checksum(
        &url,
        &dest,
        require_verified,
        &signature_policy(require_verified),
        progress_cb,
    )?;
    Ok(dest)
}

/// Resolve the agent binary through the cache → bundled → download chain.
///
/// Returns the local path to the binary, ready to be uploaded via SFTP.
pub fn resolve_agent_binary<F>(
    app_handle: &tauri::AppHandle,
    version: &str,
    arch_suffix: &str,
    progress_cb: F,
) -> Result<PathBuf>
where
    F: Fn(u64, u64),
{
    // Release builds must fail closed on a missing checksum on every resolution
    // path (cache, bundle, download) — not just the download. Dev/branch builds
    // stay relaxed so local iteration is not broken (AGT-007).
    let require_checksum = !is_dev_build(version);
    // The same rule governs the release signature (AGT-005, #3330): a release
    // desktop deploys only an agent binary signed by the embedded release key.
    let policy = signature_policy(require_checksum);

    // 1. Check local cache
    if let Some(path) = find_cached_binary(version, arch_suffix) {
        info!("Using cached agent binary: {}", path.display());
        // Reject a cache entry that has been tampered with since it was fetched,
        // and (release builds) one that carries no published checksum at all.
        verify_resolved_binary(&path, require_checksum, &policy)?;
        return Ok(path);
    }

    // 2. Check bundled resources
    if let Some(path) = find_bundled_binary(app_handle, arch_suffix) {
        info!("Using bundled agent binary: {}", path.display());
        // Verify against a bundled `.sha256` sidecar; a mismatch rejects the
        // bundle rather than deploying it, and a release build rejects a bundle
        // that ships no sidecar at all. The same holds for the signature.
        verify_resolved_binary(&path, require_checksum, &policy)?;
        // Copy to cache for future use, including the checksum sidecar so later
        // cache hits stay verifiable.
        let cache_path = cached_binary_path(version, arch_suffix);
        if let Some(parent) = cache_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Err(e) = fs::copy(&path, &cache_path) {
            warn!("Failed to cache bundled binary: {}", e);
        } else {
            let bundled_sidecar = checksum_sidecar_path(&path);
            if bundled_sidecar.is_file() {
                let cache_sidecar = checksum_sidecar_path(&cache_path);
                if let Err(e) = fs::copy(&bundled_sidecar, &cache_sidecar) {
                    warn!("Failed to cache bundled checksum sidecar: {}", e);
                }
            }
            // Keep the signature with the bytes it covers (AGT-005).
            let bundled_sig = signature_sidecar_path(&path);
            let cache_sig = signature_sidecar_path(&cache_path);
            let _ = fs::remove_file(&cache_sig);
            if bundled_sig.is_file() {
                if let Err(e) = fs::copy(&bundled_sig, &cache_sig) {
                    warn!("Failed to cache bundled signature sidecar: {}", e);
                }
            }
        }
        return Ok(path);
    }

    // 3. Download from GitHub Releases
    info!(
        "No cached or bundled binary found, downloading v{} for {}",
        version, arch_suffix
    );
    download_agent_binary(version, arch_suffix, progress_cb)
}

#[cfg(test)]
mod tests {
    use super::*;
    use termihub_core::agent_update_signature::test_support::{sign_digest, test_signing_key};

    #[test]
    fn artifact_name_linux_x86_64() {
        assert_eq!(
            artifact_name_for_os_arch("Linux", "x86_64"),
            Some("linux-x64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Linux", "amd64"),
            Some("linux-x64")
        );
    }

    #[test]
    fn artifact_name_linux_aarch64() {
        assert_eq!(
            artifact_name_for_os_arch("Linux", "aarch64"),
            Some("linux-arm64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Linux", "arm64"),
            Some("linux-arm64")
        );
    }

    #[test]
    fn artifact_name_linux_armv7() {
        assert_eq!(
            artifact_name_for_os_arch("Linux", "armv7l"),
            Some("linux-armv7")
        );
        assert_eq!(
            artifact_name_for_os_arch("Linux", "armhf"),
            Some("linux-armv7")
        );
    }

    #[test]
    fn artifact_name_macos() {
        assert_eq!(
            artifact_name_for_os_arch("Darwin", "arm64"),
            Some("macos-arm64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Darwin", "aarch64"),
            Some("macos-arm64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Darwin", "x86_64"),
            Some("macos-x64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Darwin", "amd64"),
            Some("macos-x64")
        );
    }

    #[test]
    fn artifact_name_windows_x64() {
        // `%PROCESSOR_ARCHITECTURE%` reports "AMD64"; `uname -m` reports "x86_64".
        assert_eq!(
            artifact_name_for_os_arch("Windows_NT", "AMD64"),
            Some("windows-x64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Windows_NT", "x86_64"),
            Some("windows-x64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Windows", "amd64"),
            Some("windows-x64")
        );
    }

    #[test]
    fn artifact_name_windows_arm64() {
        assert_eq!(
            artifact_name_for_os_arch("Windows_NT", "ARM64"),
            Some("windows-arm64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Windows_NT", "aarch64"),
            Some("windows-arm64")
        );
        assert_eq!(
            artifact_name_for_os_arch("Windows_NT", "arm64"),
            Some("windows-arm64")
        );
    }

    #[test]
    fn artifact_name_windows_mingw_uname_not_linux() {
        // `uname -s` on MinGW/MSYS/Cygwin shells reports these — must resolve to
        // Windows artifacts, never the Linux fallback.
        assert_eq!(
            artifact_name_for_os_arch("MINGW64_NT-10.0-19045", "x86_64"),
            Some("windows-x64")
        );
        assert_eq!(
            artifact_name_for_os_arch("MSYS_NT-10.0-19045", "x86_64"),
            Some("windows-x64")
        );
        assert_eq!(
            artifact_name_for_os_arch("CYGWIN_NT-10.0-19045", "x86_64"),
            Some("windows-x64")
        );
        assert_eq!(
            artifact_name_for_os_arch("MINGW64_NT-10.0", "aarch64"),
            Some("windows-arm64")
        );
    }

    #[test]
    fn artifact_name_windows_unknown_arch() {
        assert_eq!(artifact_name_for_os_arch("Windows_NT", "mips"), None);
        assert_eq!(artifact_name_for_os_arch("Windows_NT", ""), None);
        // 32-bit x86 Windows has no published artifact.
        assert_eq!(artifact_name_for_os_arch("Windows_NT", "x86"), None);
    }

    #[test]
    fn is_windows_os_recognizes_windows_markers() {
        assert!(is_windows_os("Windows_NT"));
        assert!(is_windows_os("Windows"));
        assert!(is_windows_os("MINGW64_NT-10.0-19045"));
        assert!(is_windows_os("MSYS_NT-10.0"));
        assert!(is_windows_os("CYGWIN_NT-10.0"));
    }

    #[test]
    fn is_windows_os_rejects_posix() {
        assert!(!is_windows_os("Linux"));
        assert!(!is_windows_os("Darwin"));
        assert!(!is_windows_os(""));
    }

    #[test]
    fn artifact_name_unknown_falls_back_to_linux() {
        assert_eq!(
            artifact_name_for_os_arch("FreeBSD", "x86_64"),
            Some("linux-x64")
        );
    }

    #[test]
    fn artifact_name_unknown_arch() {
        assert_eq!(artifact_name_for_os_arch("Linux", "mips"), None);
        assert_eq!(artifact_name_for_os_arch("Linux", ""), None);
        assert_eq!(artifact_name_for_os_arch("Darwin", "mips"), None);
    }

    #[test]
    fn cache_dir_is_under_termihub() {
        let dir = cache_dir();
        assert!(
            dir.ends_with("termihub/agent-binaries"),
            "Expected path ending with termihub/agent-binaries, got: {}",
            dir.display()
        );
    }

    #[test]
    fn cached_binary_path_structure() {
        let path = cached_binary_path("0.1.0", "linux-x64");
        let path_str = path.to_string_lossy();
        assert!(path_str.contains("0.1.0"), "Path should contain version");
        assert!(
            path_str.ends_with("termihub-agent-linux-x64"),
            "Path should end with binary name, got: {path_str}"
        );
    }

    #[test]
    fn find_cached_binary_nonexistent() {
        assert!(find_cached_binary("99.99.99", "linux-x64").is_none());
    }

    #[test]
    fn find_cached_binary_with_tempdir() {
        let tmpdir = tempfile::tempdir().unwrap();
        let version_dir = tmpdir.path().join("0.1.0");
        fs::create_dir_all(&version_dir).unwrap();
        let binary_path = version_dir.join("termihub-agent-linux-x64");
        fs::write(&binary_path, b"fake-binary-content").unwrap();

        // This won't find it because cache_dir() points elsewhere,
        // but we can verify the path construction is correct
        let expected = cached_binary_path("0.1.0", "linux-x64");
        assert!(expected.to_string_lossy().contains("0.1.0"));
    }

    // Tests use compute_download_url_impl with explicit flags so they are not
    // affected by whether the test suite itself runs as a debug or release build.

    #[test]
    fn compute_download_url_release_build_uses_version_tag() {
        let url = compute_download_url_impl("1.2.3", "linux-x64", false, "main");
        assert_eq!(
            url,
            "https://github.com/armaxri/termiHub/releases/download/v1.2.3/termihub-agent-linux-x64"
        );
    }

    #[test]
    fn compute_download_url_debug_build_uses_dev_latest() {
        let url = compute_download_url_impl("1.2.3", "linux-x64", true, "main");
        assert_eq!(
            url,
            "https://github.com/armaxri/termiHub/releases/download/dev-latest/termihub-agent-linux-x64"
        );
    }

    #[test]
    fn compute_download_url_dev_version_suffix_uses_dev_latest() {
        let url = compute_download_url_impl("0.1.0-dev", "linux-arm64", false, "main");
        assert_eq!(
            url,
            "https://github.com/armaxri/termiHub/releases/download/dev-latest/termihub-agent-linux-arm64"
        );
    }

    #[test]
    fn compute_download_url_dev_version_armv7() {
        let url = compute_download_url_impl("2.0.0-dev", "linux-armv7", false, "main");
        assert!(url.contains("dev-latest"));
        assert!(url.contains("linux-armv7"));
        assert!(!url.contains("v2.0.0"));
    }

    #[test]
    fn compute_download_url_release_build_does_not_use_dev_latest() {
        let url = compute_download_url_impl("1.0.0", "linux-x64", false, "main");
        assert!(!url.contains("dev-latest"));
        assert!(url.contains("v1.0.0"));
    }

    #[test]
    fn compute_download_url_develop_branch_debug_uses_dev_develop_latest() {
        let url = compute_download_url_impl("1.2.3", "linux-x64", true, "develop");
        assert_eq!(
            url,
            "https://github.com/armaxri/termiHub/releases/download/dev-develop-latest/termihub-agent-linux-x64"
        );
    }

    #[test]
    fn compute_download_url_develop_branch_dev_version_uses_dev_develop_latest() {
        let url = compute_download_url_impl("0.1.0-dev", "linux-arm64", false, "develop");
        assert_eq!(
            url,
            "https://github.com/armaxri/termiHub/releases/download/dev-develop-latest/termihub-agent-linux-arm64"
        );
    }

    #[test]
    fn compute_download_url_develop_branch_release_build_uses_version_tag() {
        let url = compute_download_url_impl("1.2.3", "linux-x64", false, "develop");
        assert_eq!(
            url,
            "https://github.com/armaxri/termiHub/releases/download/v1.2.3/termihub-agent-linux-x64"
        );
    }

    #[test]
    fn sanitize_branch_name_replaces_slash() {
        assert_eq!(
            sanitize_branch_name("feature/666-my-branch"),
            "feature-666-my-branch"
        );
    }

    #[test]
    fn sanitize_branch_name_replaces_underscores() {
        assert_eq!(sanitize_branch_name("feature_foo_bar"), "feature-foo-bar");
    }

    #[test]
    fn sanitize_branch_name_collapses_dashes() {
        assert_eq!(sanitize_branch_name("foo//bar"), "foo-bar");
        assert_eq!(sanitize_branch_name("foo--bar"), "foo-bar");
    }

    #[test]
    fn sanitize_branch_name_strips_leading_trailing() {
        assert_eq!(sanitize_branch_name("/foo/"), "foo");
    }

    #[test]
    fn compute_branch_build_url_structure() {
        let url = compute_branch_build_url("feature/666-my-feature", "linux-arm64");
        assert_eq!(
            url,
            "https://github.com/armaxri/termiHub/releases/download/agent-branch-feature-666-my-feature/termihub-agent-linux-arm64"
        );
    }

    #[test]
    fn compute_branch_build_url_main() {
        let url = compute_branch_build_url("main", "linux-x64");
        assert!(url.contains("agent-branch-main"));
        assert!(url.contains("linux-x64"));
    }

    // --- SHA-256 integrity verification -----------------------------------

    /// Known SHA-256 of the ASCII string "abc" (NIST test vector), used to pin
    /// the hashing implementation.
    const SHA256_OF_ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn sha256_hex_of_file_matches_known_vector() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("payload.bin");
        fs::write(&path, b"abc").unwrap();

        let digest = sha256_hex_of_file(&path).unwrap();
        assert_eq!(digest, SHA256_OF_ABC);
    }

    #[test]
    fn sha256_hex_of_file_is_lowercase_hex() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("payload.bin");
        fs::write(&path, b"some binary content").unwrap();

        let digest = sha256_hex_of_file(&path).unwrap();
        assert_eq!(digest.len(), 64, "SHA-256 hex must be 64 chars");
        assert!(
            digest
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "digest must be lowercase hex, got: {digest}"
        );
    }

    #[test]
    fn sha256_hex_of_file_missing_file_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("does-not-exist.bin");
        assert!(sha256_hex_of_file(&path).is_err());
    }

    #[test]
    fn parse_sha256_sidecar_plain_hex() {
        assert_eq!(
            parse_sha256_sidecar(SHA256_OF_ABC),
            Some(SHA256_OF_ABC.to_string())
        );
    }

    #[test]
    fn parse_sha256_sidecar_sha256sum_text_format() {
        // Standard `sha256sum` text-mode output: "<hex>  <filename>".
        let line = format!("{SHA256_OF_ABC}  termihub-agent-linux-x64\n");
        assert_eq!(parse_sha256_sidecar(&line), Some(SHA256_OF_ABC.to_string()));
    }

    #[test]
    fn parse_sha256_sidecar_sha256sum_binary_format() {
        // Binary-mode output prefixes the filename with '*'.
        let line = format!("{SHA256_OF_ABC} *termihub-agent-windows-x64.exe\n");
        assert_eq!(parse_sha256_sidecar(&line), Some(SHA256_OF_ABC.to_string()));
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
        // Too short.
        assert_eq!(parse_sha256_sidecar("deadbeef"), None);
        // 64 chars but contains a non-hex char ('g').
        assert_eq!(parse_sha256_sidecar(&"g".repeat(64)), None);
    }

    #[test]
    fn verify_file_checksum_ok_on_match() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("payload.bin");
        fs::write(&path, b"abc").unwrap();

        assert!(verify_file_checksum(&path, SHA256_OF_ABC).is_ok());
        // Case-insensitive on the expected side too.
        assert!(verify_file_checksum(&path, &SHA256_OF_ABC.to_ascii_uppercase()).is_ok());
    }

    #[test]
    fn verify_file_checksum_rejects_mismatch_with_clear_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("payload.bin");
        // Content whose digest is NOT SHA256_OF_ABC.
        fs::write(&path, b"tampered content").unwrap();

        let err = verify_file_checksum(&path, SHA256_OF_ABC).unwrap_err();
        let msg = err.to_string().to_ascii_lowercase();
        assert!(
            msg.contains("checksum"),
            "error should mention checksum, got: {err}"
        );
        assert!(
            msg.contains(SHA256_OF_ABC),
            "error should include the expected checksum, got: {err}"
        );
    }

    #[test]
    fn checksum_sidecar_path_appends_sha256() {
        let binary = PathBuf::from("/cache/0.1.0/termihub-agent-linux-x64");
        let sidecar = checksum_sidecar_path(&binary);
        assert_eq!(
            sidecar,
            PathBuf::from("/cache/0.1.0/termihub-agent-linux-x64.sha256")
        );
    }

    #[test]
    fn verify_with_adjacent_sidecar_ok_when_matching() {
        let tmp = tempfile::tempdir().unwrap();
        let binary = tmp.path().join("termihub-agent-linux-x64");
        fs::write(&binary, b"abc").unwrap();
        fs::write(
            checksum_sidecar_path(&binary),
            format!("{SHA256_OF_ABC}  termihub-agent-linux-x64\n"),
        )
        .unwrap();

        // A present, matching sidecar is accepted in both postures — including a
        // release build (require_checksum = true), which is the valid case.
        assert!(verify_with_adjacent_sidecar(&binary, false).is_ok());
        assert!(verify_with_adjacent_sidecar(&binary, true).is_ok());
    }

    #[test]
    fn verify_with_adjacent_sidecar_rejects_tampered_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let binary = tmp.path().join("termihub-agent-linux-x64");
        // Sidecar claims the "abc" digest, but the binary has been tampered with.
        fs::write(&binary, b"tampered").unwrap();
        fs::write(checksum_sidecar_path(&binary), SHA256_OF_ABC).unwrap();

        // A checksum mismatch is rejected regardless of posture — dev and release.
        assert!(
            verify_with_adjacent_sidecar(&binary, false).is_err(),
            "a binary that does not match its sidecar must be rejected"
        );
        assert!(
            verify_with_adjacent_sidecar(&binary, true).is_err(),
            "a release build must reject a binary that does not match its sidecar"
        );
    }

    #[test]
    fn verify_with_adjacent_sidecar_dev_ok_when_sidecar_absent() {
        // Dev/branch posture (require_checksum = false): no sidecar present →
        // cannot verify, but must not fail (legacy cache entries and out-of-scope
        // dev builds have no published checksum yet).
        let tmp = tempfile::tempdir().unwrap();
        let binary = tmp.path().join("termihub-agent-linux-x64");
        fs::write(&binary, b"abc").unwrap();

        assert!(verify_with_adjacent_sidecar(&binary, false).is_ok());
    }

    #[test]
    fn verify_with_adjacent_sidecar_release_fails_closed_when_sidecar_absent() {
        // Release posture (require_checksum = true): a missing sidecar is a hard
        // failure so an unverifiable cache/bundle entry is never used (AGT-007).
        let tmp = tempfile::tempdir().unwrap();
        let binary = tmp.path().join("termihub-agent-linux-x64");
        fs::write(&binary, b"abc").unwrap();

        let err = verify_with_adjacent_sidecar(&binary, true).unwrap_err();
        assert!(
            err.to_string().to_ascii_lowercase().contains("checksum"),
            "error should explain the missing checksum, got: {err}"
        );
    }

    #[test]
    fn verify_with_adjacent_sidecar_errors_on_malformed_sidecar() {
        let tmp = tempfile::tempdir().unwrap();
        let binary = tmp.path().join("termihub-agent-linux-x64");
        fs::write(&binary, b"abc").unwrap();
        fs::write(checksum_sidecar_path(&binary), "this-is-not-a-checksum").unwrap();

        // A malformed sidecar is an integrity failure even in the relaxed posture.
        assert!(
            verify_with_adjacent_sidecar(&binary, false).is_err(),
            "a malformed sidecar must be treated as an integrity failure"
        );
    }

    // --- download + verify integration ------------------------------------

    /// A loopback HTTP server serving the agent binary plus optional `.sha256`
    /// and `.sig` sidecars, so `download_binary_with_checksum` can be exercised
    /// end-to-end. The response is chosen by the requested path's suffix; an
    /// absent sidecar answers 404. The server stops (and its thread is joined)
    /// when the guard drops, however many requests the code under test made.
    struct AgentDownloadServer {
        url: String,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl Drop for AgentDownloadServer {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn serve_agent_download(
        binary: &'static [u8],
        sidecar: Option<String>,
        signature: Option<String>,
    ) -> AgentDownloadServer {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            while !stop_thread.load(Ordering::SeqCst) {
                let mut stream = match listener.accept() {
                    Ok((s, _)) => s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => return,
                };
                let _ = stream.set_nonblocking(false);
                let mut buf = [0u8; 1024];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("")
                    .to_string();

                let served = if path.ends_with(".sha256") {
                    sidecar.clone().map(String::into_bytes)
                } else if path.ends_with(".sig") {
                    signature.clone().map(String::into_bytes)
                } else {
                    Some(binary.to_vec())
                };
                let (status, body) = match served {
                    Some(body) => ("200 OK", body),
                    None => ("404 Not Found", Vec::new()),
                };
                let header = format!(
                    "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
                let _ = stream.flush();
            }
        });
        AgentDownloadServer {
            url: format!("http://{addr}/termihub-agent-linux-x64"),
            stop,
            handle: Some(handle),
        }
    }

    /// Seed of the test signing key the download/resolution tests trust.
    const TEST_KEY_SEED: u8 = 7;

    /// A strict (release) policy trusting only the test key.
    fn release_policy() -> SignaturePolicy {
        SignaturePolicy::strict(vec![test_signing_key(TEST_KEY_SEED).verifying_key()])
    }

    /// A relaxed (dev/branch) policy trusting only the test key.
    fn dev_policy() -> SignaturePolicy {
        SignaturePolicy::new(vec![test_signing_key(TEST_KEY_SEED).verifying_key()], true)
    }

    /// The test key's signature over the SHA-256 of `abc`.
    fn sig_of_abc() -> String {
        sign_digest(&test_signing_key(TEST_KEY_SEED), SHA256_OF_ABC)
    }

    #[test]
    fn download_with_checksum_accepts_matching_sidecar() {
        let server = serve_agent_download(
            b"abc",
            Some(format!("{SHA256_OF_ABC}  bin\n")),
            Some(sig_of_abc()),
        );
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");

        download_binary_with_checksum(&server.url, &dest, true, &release_policy(), |_, _| {})
            .unwrap();

        assert_eq!(fs::read(&dest).unwrap(), b"abc");
        assert!(
            checksum_sidecar_path(&dest).is_file(),
            "the verified sidecar must be cached next to the binary"
        );
        assert!(
            signature_sidecar_path(&dest).is_file(),
            "the verified signature must be cached next to the binary"
        );
    }

    #[test]
    fn download_with_checksum_rejects_mismatched_sidecar_and_removes_binary() {
        // Sidecar advertises a digest the body does not have.
        let wrong = "0".repeat(64);
        let server = serve_agent_download(b"abc", Some(wrong), Some(sig_of_abc()));
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");

        let err =
            download_binary_with_checksum(&server.url, &dest, true, &release_policy(), |_, _| {})
                .unwrap_err();

        assert!(
            err.to_string().to_ascii_lowercase().contains("checksum"),
            "error should mention checksum, got: {err}"
        );
        assert!(
            !dest.exists(),
            "a mismatched download must be removed, not left as a cache hit"
        );
        assert!(!checksum_sidecar_path(&dest).exists());
    }

    #[test]
    fn download_with_checksum_fails_closed_when_release_sidecar_missing() {
        let server = serve_agent_download(b"abc", None, Some(sig_of_abc()));
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");

        // require_checksum = true (a release download) → a missing sidecar is a
        // hard failure and the binary must not be left on disk.
        let err =
            download_binary_with_checksum(&server.url, &dest, true, &release_policy(), |_, _| {})
                .unwrap_err();

        assert!(
            err.to_string().contains("checksum"),
            "error should explain the missing checksum, got: {err}"
        );
        assert!(
            !dest.exists(),
            "a release binary with no checksum must not be installed"
        );
    }

    #[test]
    fn download_with_checksum_tolerates_missing_sidecar_for_dev_builds() {
        let server = serve_agent_download(b"abc", None, None);
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");

        // require_checksum = false (dev/branch build) → a missing sidecar (and
        // a missing signature) is tolerated and the binary is kept.
        download_binary_with_checksum(&server.url, &dest, false, &dev_policy(), |_, _| {}).unwrap();

        assert_eq!(fs::read(&dest).unwrap(), b"abc");
    }

    // ── AGT-005: desktop-side signature verification (#3330) ──────────────

    /// Download under the release policy with a valid checksum and the given
    /// `.sig` body; returns the result and whether anything was left on disk.
    fn release_download_with_sig(signature: Option<String>) -> (Result<()>, bool) {
        let server =
            serve_agent_download(b"abc", Some(format!("{SHA256_OF_ABC}  bin\n")), signature);
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");
        let result =
            download_binary_with_checksum(&server.url, &dest, true, &release_policy(), |_, _| {});
        let left = dest.exists()
            || checksum_sidecar_path(&dest).exists()
            || signature_sidecar_path(&dest).exists();
        (result, left)
    }

    #[test]
    fn release_download_rejects_missing_signature_and_removes_everything() {
        let (result, left) = release_download_with_sig(None);
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Signature verification failed"), "got: {err}");
        assert!(
            !left,
            "an unsigned release download must not become a cache hit"
        );
    }

    #[test]
    fn release_download_rejects_tampered_or_foreign_signature() {
        // Signature over a different binary ("abd") — i.e. the bytes were swapped.
        let over_other = sign_digest(
            &test_signing_key(TEST_KEY_SEED),
            "a52d159f262b2c6ddb724a61840befc36eb30c88877a4030b65cbe86298449c9",
        );
        // Signature by a key the build does not trust.
        let foreign = sign_digest(&test_signing_key(99), SHA256_OF_ABC);
        for sig in [over_other, foreign, "not base64!!".to_string()] {
            let (result, left) = release_download_with_sig(Some(sig));
            assert!(result.is_err());
            assert!(!left, "a rejected download must be removed");
        }
    }

    #[test]
    fn dev_download_rejects_a_present_but_bad_signature() {
        let server = serve_agent_download(
            b"abc",
            Some(format!("{SHA256_OF_ABC}  bin\n")),
            Some(sign_digest(&test_signing_key(99), SHA256_OF_ABC)),
        );
        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");
        assert!(
            download_binary_with_checksum(&server.url, &dest, false, &dev_policy(), |_, _| {})
                .is_err()
        );
        assert!(!dest.exists());
    }

    /// Write `abc` + a matching checksum sidecar (+ optional `.sig`) into a
    /// temp dir, as a cache or bundle entry would look.
    fn resolved_entry(signature: Option<&str>) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("termihub-agent-linux-x64");
        fs::write(&bin, b"abc").unwrap();
        fs::write(checksum_sidecar_path(&bin), format!("{SHA256_OF_ABC}\n")).unwrap();
        if let Some(sig) = signature {
            fs::write(signature_sidecar_path(&bin), sig).unwrap();
        }
        (tmp, bin)
    }

    #[test]
    fn resolved_entry_with_valid_signature_is_accepted() {
        let (_tmp, bin) = resolved_entry(Some(&sig_of_abc()));
        verify_resolved_binary(&bin, true, &release_policy()).unwrap();
    }

    #[test]
    fn resolved_entry_with_tampered_binary_is_rejected() {
        let (_tmp, bin) = resolved_entry(Some(&sig_of_abc()));
        // Tamper the bytes AND the checksum sidecar consistently — only the
        // signature can catch this substitution.
        fs::write(&bin, b"abd").unwrap();
        fs::write(
            checksum_sidecar_path(&bin),
            "a52d159f262b2c6ddb724a61840befc36eb30c88877a4030b65cbe86298449c9",
        )
        .unwrap();
        let err = verify_resolved_binary(&bin, true, &release_policy()).unwrap_err();
        assert!(err.to_string().contains("does not verify"), "got: {err}");
    }

    #[test]
    fn resolved_entry_without_signature_fails_closed_for_release_only() {
        let (_tmp, bin) = resolved_entry(None);
        let err = verify_resolved_binary(&bin, true, &release_policy()).unwrap_err();
        assert!(err.to_string().contains("no signature"), "got: {err}");
        // Dev/branch builds stay relaxed.
        verify_resolved_binary(&bin, false, &dev_policy()).unwrap();
    }

    #[test]
    fn placeholder_key_refuses_every_release_deploy() {
        let (_tmp, bin) = resolved_entry(Some(&sig_of_abc()));
        // A build made from the placeholder key file trusts no key: signed or
        // not, nothing verifies.
        let no_key = SignaturePolicy::strict(Vec::new());
        let err = verify_resolved_binary(&bin, true, &no_key).unwrap_err();
        assert!(err.to_string().contains("placeholder"), "got: {err}");
        let (_tmp2, unsigned) = resolved_entry(None);
        assert!(verify_resolved_binary(&unsigned, true, &no_key).is_err());

        // The committed key file is still the placeholder until the maintainer
        // generates the real key; while it is, the embedded release policy must
        // refuse even a validly test-signed binary.
        let embedded = signature_policy(/* require_verified */ true);
        if !embedded.has_trusted_keys() {
            assert!(verify_resolved_binary(&bin, true, &embedded).is_err());
        }
    }

    #[test]
    fn signature_is_checked_over_the_deployed_bytes() {
        let (_tmp, bin) = resolved_entry(Some(&sig_of_abc()));
        verify_signature_for_digest(&bin, SHA256_OF_ABC, &release_policy()).unwrap();
        // The file on disk still verifies, but the bytes about to be uploaded
        // were swapped after resolution — refused.
        assert!(
            verify_signature_for_digest(&bin, &sha256_hex_of_bytes(b"abd"), &release_policy())
                .is_err()
        );
    }

    #[test]
    fn deploy_policy_follows_the_dev_build_rule() {
        assert_eq!(
            deploy_signature_policy("1.2.3").allows_unsigned(),
            is_dev_build("1.2.3")
        );
        assert!(deploy_signature_policy("1.2.3-dev").allows_unsigned());
        assert!(!signature_policy(true).allows_unsigned());
    }

    // ── AGT-005: signature sidecar forwarding (#3213) ─────────────────────

    #[test]
    fn signature_sidecar_path_appends_sig() {
        assert_eq!(
            signature_sidecar_path(Path::new("/c/termihub-agent-linux-x64")),
            PathBuf::from("/c/termihub-agent-linux-x64.sig")
        );
    }

    #[test]
    fn read_signature_sidecar_trims_and_tolerates_absence() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("termihub-agent-linux-x64");
        std::fs::write(&bin, b"abc").unwrap();
        assert_eq!(read_signature_sidecar(&bin), None);

        std::fs::write(signature_sidecar_path(&bin), "  c2lnbmF0dXJl\n").unwrap();
        assert_eq!(
            read_signature_sidecar(&bin).as_deref(),
            Some("c2lnbmF0dXJl")
        );

        std::fs::write(signature_sidecar_path(&bin), "\n").unwrap();
        assert_eq!(
            read_signature_sidecar(&bin),
            None,
            "blank sidecar = unsigned"
        );
    }
}

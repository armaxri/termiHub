//! VcXsrv acquisition: cache → bundled → download → verify → extract.
//!
//! Windows-only component that makes a known-good VcXsrv install available on
//! disk without the user running any installer. Mirrors the agent-binary
//! resolution pattern in [`crate::terminal::agent_binary`]:
//!
//! 1. **Cache** — a pinned version already extracted under the app data dir.
//! 2. **Bundled** — a `.zip` shipped inside the Tauri app bundle (offline).
//! 3. **Download** — the pinned `.zip` fetched from termiHub's GitHub releases,
//!    SHA-256 verified, then extracted with an atomic rename so a partially
//!    written tree is never mistaken for a good install.
//!
//! VcXsrv (GPL-3.0) is redistributed as a pinned, pre-extracted minimal tree
//! (`vcxsrv.exe` + required DLLs + `fonts/`) hosted as a versioned `.zip`. It
//! runs strictly as a separate process, so termiHub's own license is unaffected
//! (see the licensing issue #1056).
//!
// The public surface here is consumed by the X server lifecycle manager (#1049)
// and the provisioning orchestrator + Tauri commands (#1052), which are not yet
// wired up. Allow dead code until those land so the foundation can ship and be
// tested on its own.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use tracing::{debug, info};

use crate::utils::download::download_to_file;
use crate::utils::fs::is_nonempty_file;
use crate::utils::portable::AppMode;

/// The executable name inside the extracted VcXsrv tree.
pub const VCXSRV_EXE: &str = "vcxsrv.exe";

/// A pinned, checksum-verified VcXsrv release hosted on termiHub's own GitHub
/// releases (same host as the agent binaries).
///
/// Compiled into the app so a clean box needs no external configuration to know
/// which build to fetch and how to verify it. Version-keyed storage dirs make
/// upgrades, rollbacks, and pruning safe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PinnedVcxsrv {
    /// Upstream VcXsrv version, used as the storage dir suffix (`vcxsrv-<version>`).
    pub version: &'static str,
    /// Fully-qualified download URL for the pre-extracted minimal `.zip`.
    pub zip_url: &'static str,
    /// Lowercase hex SHA-256 of the `.zip` at `zip_url`.
    pub sha256: &'static str,
}

/// The VcXsrv build termiHub provisions.
///
/// NOTE: `sha256` is a placeholder until the minimal `.zip` artifact is built
/// and published to termiHub's GitHub releases (#1076). Build it reproducibly
/// from an installed VcXsrv with `scripts/internal/package-vcxsrv.ps1`, which
/// prints the SHA-256 to paste here (or run it with `-UpdateAcquire` to patch
/// this field), then publish the printed artifact. Until then a real download
/// is *rejected* by verification and never executed — the safe failure mode.
/// The offline unit tests exercise verification and extraction against synthetic
/// archives, so they do not depend on this value; the networked
/// `pinned_artifact_downloads_verifies_and_contains_exe` test (`#[ignore]`)
/// confirms the real artifact once it is published.
pub const PINNED_VCXSRV: PinnedVcxsrv = PinnedVcxsrv {
    version: "21.1.13",
    zip_url: "https://github.com/armaxri/termiHub/releases/download/vcxsrv-21.1.13/vcxsrv-21.1.13-minimal.zip",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
};

/// Progress reported while acquiring VcXsrv.
///
/// Mirrors the agent-deploy progress shape so the orchestrator (#1052) can map
/// these onto the existing `download` / `verifying` Tauri events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcquireProgress {
    /// Downloading the `.zip`. `total` is 0 if the server omits Content-Length.
    Downloading { received: u64, total: u64 },
    /// Verifying the downloaded `.zip` against the pinned SHA-256.
    Verifying,
    /// Extracting the verified `.zip` into the install directory.
    Extracting,
}

/// Root directory that holds every version-keyed VcXsrv install.
///
/// - Portable → `<data>/xserver/`
/// - Installed → `dirs::data_local_dir()/termiHub/xserver/`
pub fn xserver_base_dir(app_mode: &AppMode) -> Result<PathBuf> {
    match app_mode.data_dir() {
        Some(data_dir) => Ok(data_dir.join("xserver")),
        None => {
            let base = dirs::data_local_dir()
                .context("Failed to resolve local data directory for VcXsrv storage")?;
            Ok(base.join("termiHub").join("xserver"))
        }
    }
}

/// Directory a specific VcXsrv version is (or will be) extracted into.
pub fn install_dir(app_mode: &AppMode, version: &str) -> Result<PathBuf> {
    Ok(xserver_base_dir(app_mode)?.join(format!("vcxsrv-{version}")))
}

/// Full path to `vcxsrv.exe` for a specific version.
pub fn installed_exe(app_mode: &AppMode, version: &str) -> Result<PathBuf> {
    Ok(install_dir(app_mode, version)?.join(VCXSRV_EXE))
}

/// Return the extracted `vcxsrv.exe` for `version` if it already exists on disk
/// and is non-empty.
pub fn find_installed(app_mode: &AppMode, version: &str) -> Option<PathBuf> {
    let exe = installed_exe(app_mode, version).ok()?;
    if is_nonempty_file(&exe) {
        debug!("Found extracted VcXsrv: {}", exe.display());
        Some(exe)
    } else {
        None
    }
}

/// Look for a bundled VcXsrv `.zip` inside the Tauri resource directory.
///
/// Expected at `resources/vcxsrv-<version>.zip` inside the app bundle.
pub fn find_bundled_zip(app_handle: &tauri::AppHandle, version: &str) -> Option<PathBuf> {
    use tauri::Manager;

    let resource_dir = app_handle.path().resource_dir().ok()?;
    let path = resource_dir.join(format!("vcxsrv-{version}.zip"));
    if is_nonempty_file(&path) {
        debug!("Found bundled VcXsrv zip: {}", path.display());
        Some(path)
    } else {
        None
    }
}

/// Verify that the file at `path` hashes to `expected_sha256` (lowercase hex).
///
/// Returns an error (without side effects) on any mismatch, so a corrupted
/// download is never extracted or executed.
pub fn verify_sha256(path: &Path, expected_sha256: &str) -> Result<()> {
    use sha2::{Digest, Sha256};

    let mut file = fs::File::open(path)
        .with_context(|| format!("Failed to open {} for checksum", path.display()))?;
    let mut hasher = Sha256::new();
    // `Sha256` implements `io::Write`, so this streams the file through the
    // hasher with a small internal buffer — no full read into memory.
    std::io::copy(&mut file, &mut hasher)
        .with_context(|| format!("Failed to read {} for checksum", path.display()))?;
    let actual = hex::encode(hasher.finalize());
    if actual.eq_ignore_ascii_case(expected_sha256) {
        debug!("VcXsrv checksum ok: {actual}");
        Ok(())
    } else {
        bail!(
            "VcXsrv checksum mismatch for {}: expected {expected_sha256}, got {actual}",
            path.display()
        )
    }
}

/// Extract every entry of `zip_path` into `dest_dir` (created if missing).
///
/// Rejects entries whose normalized path escapes `dest_dir` (zip-slip).
pub fn extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<()> {
    let file = fs::File::open(zip_path)
        .with_context(|| format!("Failed to open zip {}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .with_context(|| format!("Failed to read zip {}", zip_path.display()))?;

    fs::create_dir_all(dest_dir)
        .with_context(|| format!("Failed to create {}", dest_dir.display()))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .with_context(|| format!("Failed to read zip entry {i}"))?;
        // `enclosed_name` rejects absolute paths and `..` traversal (zip-slip).
        let rel = match entry.enclosed_name() {
            Some(name) => name,
            None => bail!("Refusing unsafe zip entry path: {}", entry.name()),
        };
        let out_path = dest_dir.join(rel);

        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .with_context(|| format!("Failed to create {}", out_path.display()))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create {}", parent.display()))?;
        }
        let mut out_file = fs::File::create(&out_path)
            .with_context(|| format!("Failed to create {}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out_file)
            .with_context(|| format!("Failed to write {}", out_path.display()))?;
    }
    Ok(())
}

/// Download the `.zip` at `url` to `dest`, reporting progress via `progress_cb`.
///
/// Internal step of [`resolve_vcxsrv`]; callers acquire via `resolve_vcxsrv` or
/// [`install_from_zip`], never a bare download.
fn download_zip<F>(url: &str, dest: &Path, progress_cb: &F) -> Result<()>
where
    F: Fn(AcquireProgress),
{
    download_to_file(url, dest, |received, total| {
        progress_cb(AcquireProgress::Downloading { received, total })
    })
}

/// Verify a `.zip` against `expected_sha256`, then extract it into `install_dir`
/// via an atomic rename. On checksum mismatch the archive is rejected and
/// `install_dir` is left untouched. Returns the path to the extracted
/// `vcxsrv.exe`.
pub fn install_from_zip<F>(
    zip_path: &Path,
    expected_sha256: &str,
    install_dir: &Path,
    progress_cb: &F,
) -> Result<PathBuf>
where
    F: Fn(AcquireProgress),
{
    // Verify first — a mismatched archive is rejected before `install_dir` is
    // touched, so a corrupted download is never extracted or executed.
    progress_cb(AcquireProgress::Verifying);
    verify_sha256(zip_path, expected_sha256)?;

    progress_cb(AcquireProgress::Extracting);
    let parent = install_dir
        .parent()
        .context("VcXsrv install dir has no parent")?;
    let name = install_dir
        .file_name()
        .context("VcXsrv install dir has no final component")?
        .to_string_lossy();

    // Extract into a sibling `.partial` dir, then atomically rename it into
    // place so a half-written tree is never mistaken for a good install.
    let partial = parent.join(format!(".{name}.partial"));
    if partial.exists() {
        fs::remove_dir_all(&partial)
            .with_context(|| format!("Failed to clear stale {}", partial.display()))?;
    }
    extract_zip(zip_path, &partial)?;

    if install_dir.exists() {
        fs::remove_dir_all(install_dir)
            .with_context(|| format!("Failed to replace {}", install_dir.display()))?;
    }
    fs::rename(&partial, install_dir).with_context(|| {
        format!(
            "Failed to move {} into place at {}",
            partial.display(),
            install_dir.display()
        )
    })?;

    let exe = install_dir.join(VCXSRV_EXE);
    if !is_nonempty_file(&exe) {
        bail!(
            "VcXsrv archive did not contain {VCXSRV_EXE} at {}",
            install_dir.display()
        );
    }
    info!("VcXsrv installed at {}", install_dir.display());
    Ok(exe)
}

/// Resolve a runnable `vcxsrv.exe`, downloading and extracting the pinned build
/// on demand. Returns the local path to `vcxsrv.exe`.
///
/// Resolution order: extracted-for-pinned-version → bundled-with-app → download.
pub fn resolve_vcxsrv<F>(
    app_handle: &tauri::AppHandle,
    app_mode: &AppMode,
    pinned: &PinnedVcxsrv,
    progress_cb: F,
) -> Result<PathBuf>
where
    F: Fn(AcquireProgress),
{
    // 1. Already extracted for the pinned version → nothing to do (offline-safe).
    if let Some(exe) = find_installed(app_mode, pinned.version) {
        info!(
            "Using extracted VcXsrv {}: {}",
            pinned.version,
            exe.display()
        );
        return Ok(exe);
    }

    let dir = install_dir(app_mode, pinned.version)?;

    // 2. Bundled with the app → verify + extract, no network required.
    if let Some(zip) = find_bundled_zip(app_handle, pinned.version) {
        info!("Installing bundled VcXsrv {}", pinned.version);
        return install_from_zip(&zip, pinned.sha256, &dir, &progress_cb);
    }

    // 3. Download the pinned `.zip`, verify, extract.
    let base = xserver_base_dir(app_mode)?;
    fs::create_dir_all(&base).with_context(|| format!("Failed to create {}", base.display()))?;
    let tmp_zip = base.join(format!(".vcxsrv-{}.zip.partial", pinned.version));
    download_zip(pinned.zip_url, &tmp_zip, &progress_cb)?;
    let result = install_from_zip(&tmp_zip, pinned.sha256, &dir, &progress_cb);
    let _ = fs::remove_file(&tmp_zip);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    fn hex_sha256(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hex::encode(hasher.finalize())
    }

    /// Build a minimal VcXsrv-shaped zip in memory: `vcxsrv.exe`, a DLL, and a
    /// nested font file. Returns the zip bytes.
    fn make_vcxsrv_zip() -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut zip = zip::ZipWriter::new(cursor);
            let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default();
            zip.start_file("vcxsrv.exe", opts).unwrap();
            zip.write_all(b"MZ fake vcxsrv exe").unwrap();
            zip.start_file("libX11.dll", opts).unwrap();
            zip.write_all(b"fake dll").unwrap();
            zip.start_file("fonts/misc/fonts.dir", opts).unwrap();
            zip.write_all(b"0\n").unwrap();
            zip.finish().unwrap();
        }
        buf
    }

    fn no_progress(_p: AcquireProgress) {}

    // ----- path resolution: portable vs installed --------------------------

    #[test]
    fn base_dir_portable_uses_data_dir() {
        let mode = AppMode::Portable {
            data_dir: PathBuf::from("C:\\usb\\termiHub\\data"),
        };
        let base = xserver_base_dir(&mode).unwrap();
        assert_eq!(
            base,
            PathBuf::from("C:\\usb\\termiHub\\data").join("xserver")
        );
    }

    #[test]
    fn base_dir_installed_under_termihub() {
        let base = xserver_base_dir(&AppMode::Installed).unwrap();
        assert!(
            base.ends_with(Path::new("termiHub").join("xserver")),
            "expected .../termiHub/xserver, got {}",
            base.display()
        );
    }

    #[test]
    fn install_dir_is_version_keyed() {
        let mode = AppMode::Portable {
            data_dir: PathBuf::from("C:\\usb\\data"),
        };
        let dir = install_dir(&mode, "21.1.13").unwrap();
        assert!(dir.ends_with("vcxsrv-21.1.13"), "got {}", dir.display());
        let exe = installed_exe(&mode, "21.1.13").unwrap();
        assert!(exe.ends_with(Path::new("vcxsrv-21.1.13").join("vcxsrv.exe")));
    }

    // ----- find_installed ---------------------------------------------------

    #[test]
    fn find_installed_none_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let mode = AppMode::Portable {
            data_dir: tmp.path().to_path_buf(),
        };
        assert!(find_installed(&mode, "21.1.13").is_none());
    }

    #[test]
    fn find_installed_some_when_present() {
        let tmp = tempfile::tempdir().unwrap();
        let mode = AppMode::Portable {
            data_dir: tmp.path().to_path_buf(),
        };
        let exe = installed_exe(&mode, "21.1.13").unwrap();
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"MZ fake").unwrap();
        assert_eq!(find_installed(&mode, "21.1.13"), Some(exe));
    }

    #[test]
    fn find_installed_none_for_empty_exe() {
        let tmp = tempfile::tempdir().unwrap();
        let mode = AppMode::Portable {
            data_dir: tmp.path().to_path_buf(),
        };
        let exe = installed_exe(&mode, "21.1.13").unwrap();
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"").unwrap();
        assert!(find_installed(&mode, "21.1.13").is_none());
    }

    // ----- verify_sha256 ----------------------------------------------------

    #[test]
    fn verify_sha256_accepts_matching_digest() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("blob.bin");
        let data = b"the quick brown fox";
        fs::write(&file, data).unwrap();
        verify_sha256(&file, &hex_sha256(data)).unwrap();
    }

    #[test]
    fn verify_sha256_is_case_insensitive() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("blob.bin");
        let data = b"payload";
        fs::write(&file, data).unwrap();
        let upper = hex_sha256(data).to_uppercase();
        verify_sha256(&file, &upper).unwrap();
    }

    #[test]
    fn verify_sha256_rejects_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("blob.bin");
        fs::write(&file, b"real content").unwrap();
        let err = verify_sha256(&file, &hex_sha256(b"different content")).unwrap_err();
        assert!(
            err.to_string().to_lowercase().contains("checksum")
                || err.to_string().to_lowercase().contains("sha")
                || err.to_string().to_lowercase().contains("mismatch"),
            "unexpected error: {err}"
        );
    }

    // ----- extract_zip ------------------------------------------------------

    #[test]
    fn extract_zip_produces_expected_file_set() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("vcxsrv.zip");
        fs::write(&zip_path, make_vcxsrv_zip()).unwrap();
        let dest = tmp.path().join("out");

        extract_zip(&zip_path, &dest).unwrap();

        assert_eq!(
            fs::read(dest.join("vcxsrv.exe")).unwrap(),
            b"MZ fake vcxsrv exe"
        );
        assert!(dest.join("libX11.dll").is_file());
        assert!(dest.join("fonts").join("misc").join("fonts.dir").is_file());
    }

    // ----- install_from_zip (verify + atomic extract) -----------------------

    #[test]
    fn install_from_zip_extracts_on_matching_checksum() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_bytes = make_vcxsrv_zip();
        let zip_path = tmp.path().join("vcxsrv.zip");
        fs::write(&zip_path, &zip_bytes).unwrap();
        let dir = tmp.path().join("vcxsrv-21.1.13");

        let exe = install_from_zip(&zip_path, &hex_sha256(&zip_bytes), &dir, &no_progress).unwrap();

        assert_eq!(exe, dir.join("vcxsrv.exe"));
        assert!(exe.is_file());
        assert!(dir.join("fonts").join("misc").join("fonts.dir").is_file());
    }

    #[test]
    fn install_from_zip_rejects_mismatch_and_leaves_no_install() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("vcxsrv.zip");
        fs::write(&zip_path, make_vcxsrv_zip()).unwrap();
        let dir = tmp.path().join("vcxsrv-21.1.13");

        let wrong = "0000000000000000000000000000000000000000000000000000000000000000";
        let err = install_from_zip(&zip_path, wrong, &dir, &no_progress).unwrap_err();

        assert!(
            err.to_string().to_lowercase().contains("checksum")
                || err.to_string().to_lowercase().contains("sha")
                || err.to_string().to_lowercase().contains("mismatch")
        );
        // Never extracted → no install dir on disk.
        assert!(
            !dir.exists(),
            "install dir must not exist after a rejected archive"
        );
    }

    #[test]
    fn install_from_zip_cleans_stale_partial() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_bytes = make_vcxsrv_zip();
        let zip_path = tmp.path().join("vcxsrv.zip");
        fs::write(&zip_path, &zip_bytes).unwrap();
        let dir = tmp.path().join("vcxsrv-21.1.13");

        // A leftover partial dir from a crashed prior run.
        let partial = tmp.path().join(".vcxsrv-21.1.13.partial");
        fs::create_dir_all(&partial).unwrap();
        fs::write(partial.join("garbage"), b"stale").unwrap();

        let exe = install_from_zip(&zip_path, &hex_sha256(&zip_bytes), &dir, &no_progress).unwrap();
        assert!(exe.is_file());
        assert!(
            !dir.join("garbage").exists(),
            "stale partial contents must not survive"
        );
        assert!(
            !partial.exists(),
            "partial dir must be renamed away, not left behind"
        );
    }

    #[test]
    fn install_from_zip_reports_verify_then_extract() {
        use std::cell::RefCell;
        let tmp = tempfile::tempdir().unwrap();
        let zip_bytes = make_vcxsrv_zip();
        let zip_path = tmp.path().join("vcxsrv.zip");
        fs::write(&zip_path, &zip_bytes).unwrap();
        let dir = tmp.path().join("vcxsrv-21.1.13");

        let steps: RefCell<Vec<AcquireProgress>> = RefCell::new(Vec::new());
        let cb = |p: AcquireProgress| steps.borrow_mut().push(p);
        install_from_zip(&zip_path, &hex_sha256(&zip_bytes), &dir, &cb).unwrap();

        let seen = steps.borrow();
        let verify_idx = seen.iter().position(|p| *p == AcquireProgress::Verifying);
        let extract_idx = seen.iter().position(|p| *p == AcquireProgress::Extracting);
        assert!(verify_idx.is_some(), "expected a Verifying step");
        assert!(extract_idx.is_some(), "expected an Extracting step");
        assert!(verify_idx < extract_idx, "verify must precede extract");
    }

    // ----- pinned table -----------------------------------------------------

    #[test]
    fn pinned_table_is_well_formed() {
        assert!(!PINNED_VCXSRV.version.is_empty());
        assert!(PINNED_VCXSRV.zip_url.starts_with("https://"));
        assert!(PINNED_VCXSRV.zip_url.contains(PINNED_VCXSRV.version));
        // A SHA-256 is 64 lowercase hex chars.
        assert_eq!(PINNED_VCXSRV.sha256.len(), 64);
        assert!(PINNED_VCXSRV
            .sha256
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    /// Release-verification (networked, `#[ignore]` by default): fetch the
    /// published pinned `.zip`, confirm it matches `PINNED_VCXSRV.sha256`, and
    /// that it extracts a runnable `vcxsrv.exe`. This is the automated half of
    /// issue #1076's acceptance criteria — run it once the artifact is published
    /// and the SHA-256 filled in:
    ///
    /// ```text
    /// cargo test -p termihub -- --ignored pinned_artifact_downloads_verifies_and_contains_exe
    /// ```
    ///
    /// It stays ignored so the normal offline test run never reaches the network
    /// and never fails on the placeholder SHA before the artifact exists.
    #[test]
    #[ignore = "networked release-verification: requires the published VcXsrv artifact (#1076)"]
    fn pinned_artifact_downloads_verifies_and_contains_exe() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("vcxsrv-pinned.zip");

        let bytes = reqwest::blocking::get(PINNED_VCXSRV.zip_url)
            .expect("request pinned VcXsrv zip")
            .error_for_status()
            .expect("pinned VcXsrv URL must resolve to a published asset")
            .bytes()
            .expect("read pinned VcXsrv zip body");
        fs::write(&zip, &bytes).unwrap();

        verify_sha256(&zip, PINNED_VCXSRV.sha256)
            .expect("published artifact must match PINNED_VCXSRV.sha256");

        let out = tmp.path().join("tree");
        extract_zip(&zip, &out).unwrap();
        assert!(
            is_nonempty_file(&out.join(VCXSRV_EXE)),
            "published artifact must contain a non-empty {VCXSRV_EXE} at its root"
        );
    }

    // ----- licensing / compliance (GPL-3.0, #1056) --------------------------

    /// Path to a file at the repository root (parent of this crate's manifest
    /// dir, `src-tauri/`).
    fn repo_root_file(rel: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(rel)
    }

    /// GPL-3.0 requires shipping the license text and a source offer for the
    /// *exact* redistributed version. This guards against the pinned VcXsrv
    /// version drifting away from what `THIRD_PARTY_LICENSES.md` attributes —
    /// the automated half of the release compliance checklist in
    /// `docs/licensing.md` (#1056).
    #[test]
    fn third_party_licenses_match_pinned_vcxsrv() {
        let path = repo_root_file("THIRD_PARTY_LICENSES.md");
        let text =
            fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        assert!(
            text.contains(PINNED_VCXSRV.version),
            "THIRD_PARTY_LICENSES.md must attribute the pinned VcXsrv version {}",
            PINNED_VCXSRV.version
        );
        assert!(
            text.contains("GPL-3.0"),
            "VcXsrv GPL-3.0 attribution missing"
        );
        assert!(
            text.contains("github.com/marchaesen/vcxsrv"),
            "VcXsrv corresponding-source link missing"
        );
    }

    /// The GPL-3.0 text we redistribute alongside VcXsrv must actually be
    /// vendored in the repo (not just linked).
    #[test]
    fn gpl3_license_text_is_vendored() {
        let path = repo_root_file("licenses/GPL-3.0.txt");
        let text =
            fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        assert!(text.contains("GNU GENERAL PUBLIC LICENSE"));
        assert!(text.contains("Version 3"));
    }
}

//! `.termihub-plugin` package-structure validation.
//!
//! A package is a ZIP archive (see the module-level docs on [`crate::plugin`]
//! for the layout). [`validate_package`] performs the full format contract
//! check: enforce the size limit *before* opening, open the archive, read and
//! parse the required `manifest.json`, run semantic manifest validation, and
//! finally confirm API-version compatibility as a distinct outcome.

use std::io::Read;
use std::path::Path;

use thiserror::Error;
use zip::ZipArchive;

use super::manifest::{
    parse_manifest, ApiCompatibility, ManifestParseError, ManifestValidationError, PluginManifest,
    CURRENT_PLUGIN_API_VERSION,
};

/// The required manifest entry at the root of every package.
pub const MANIFEST_FILE_NAME: &str = "manifest.json";

/// Maximum accepted `.termihub-plugin` file size: 50 MB (concept "Edge Cases").
/// Enforced against the on-disk file length *before* the archive is opened, so
/// an oversize package is rejected without any decompression.
pub const MAX_PACKAGE_SIZE_BYTES: u64 = 50 * 1024 * 1024;

/// Maximum accepted *decompressed* size of a single package entry: 128 MB.
///
/// The [`MAX_PACKAGE_SIZE_BYTES`] cap is on the *compressed* archive only, so it
/// does nothing against a zip bomb — a 50 MB archive can inflate to many GB. This
/// per-entry cap bounds how much any one entry may expand to while it is being
/// read into memory, so a single crafted entry cannot exhaust the host's RAM.
pub const MAX_DECOMPRESSED_ENTRY_BYTES: u64 = 128 * 1024 * 1024;

/// Maximum accepted *total* decompressed size of a whole package: 256 MB.
///
/// Complements [`MAX_DECOMPRESSED_ENTRY_BYTES`]: even if every entry is
/// individually under the per-entry cap, their sum is bounded so an archive of
/// many medium entries cannot exhaust memory or disk on the digest/trust and
/// extraction paths. Both caps are enforced *while reading* (see
/// [`read_entry_bounded`]), so an over-budget entry aborts mid-read rather than
/// after it has already been fully materialized.
pub const MAX_DECOMPRESSED_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

/// Compile-time sanity on the decompression caps: the per-entry cap must not
/// exceed the whole-package budget, and the package can legitimately expand past
/// its compressed-size cap, so the decompressed budget is the larger of the two.
const _: () = {
    assert!(MAX_DECOMPRESSED_ENTRY_BYTES <= MAX_DECOMPRESSED_TOTAL_BYTES);
    assert!(MAX_DECOMPRESSED_TOTAL_BYTES >= MAX_PACKAGE_SIZE_BYTES);
};

/// Read `reader` fully into `buf`, enforcing a per-entry decompression cap and
/// decrementing a shared whole-package budget.
///
/// This is the single choke point that bounds decompression on every path that
/// reads a `.termihub-plugin` entry (trust assessment / digesting, manifest
/// parsing, and extraction). It reads at most `per_entry_limit` bytes *and* at
/// most `*remaining_total` bytes — whichever is smaller — plus one probe byte, so
/// an entry that would exceed either budget is detected and rejected **while
/// reading**, before the whole (bomb) entry is materialized. On success
/// `*remaining_total` is reduced by the number of bytes read.
///
/// Returns [`std::io::ErrorKind::InvalidData`] when a limit is exceeded; callers
/// map that into their own error type (`?` converts it via the standard
/// `From<std::io::Error>` impls).
pub(crate) fn read_entry_bounded<R: Read>(
    reader: R,
    per_entry_limit: u64,
    remaining_total: &mut u64,
    buf: &mut Vec<u8>,
) -> std::io::Result<()> {
    // Cap at the smaller of this entry's own limit and what remains of the
    // whole-package budget; read one extra byte so hitting the cap is detectable.
    let cap = per_entry_limit.min(*remaining_total);
    let read = reader.take(cap.saturating_add(1)).read_to_end(buf)? as u64;
    if read > cap {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "plugin package entry exceeds the decompression limit \
                 (per-entry cap {per_entry_limit} bytes, remaining package \
                 budget {remaining_total} bytes)"
            ),
        ));
    }
    *remaining_total -= read;
    Ok(())
}

/// Reject a package whose on-disk (compressed) size exceeds
/// [`MAX_PACKAGE_SIZE_BYTES`], without opening or decompressing it.
///
/// This is the cheap gate meant to run **before trust assessment**: trust
/// assessment opens the archive and reads its entries, so the size guard must
/// precede it rather than living only inside [`validate_package`] (which runs
/// after the trust gate). Decompression itself is separately bounded per entry
/// via [`read_entry_bounded`].
pub fn check_package_size(path: &Path) -> Result<(), PluginPackageError> {
    check_size_with_limit(path, MAX_PACKAGE_SIZE_BYTES)
}

/// Shared on-disk size check. Factored out so the limit can be exercised in tests
/// without materializing a 50 MB fixture.
fn check_size_with_limit(path: &Path, max_bytes: u64) -> Result<(), PluginPackageError> {
    let metadata = std::fs::metadata(path)?;
    if metadata.len() > max_bytes {
        return Err(PluginPackageError::TooLarge {
            actual: metadata.len(),
            max: max_bytes,
        });
    }
    Ok(())
}

/// Everything that can go wrong validating a `.termihub-plugin` package.
///
/// [`IncompatibleApiVersion`](PluginPackageError::IncompatibleApiVersion) is a
/// deliberately distinct outcome from the other, structural failures: the
/// package is well-formed but targets an API this host cannot load.
#[derive(Debug, Error)]
pub enum PluginPackageError {
    /// The package file could not be read from disk.
    #[error("could not read plugin package: {0}")]
    Io(#[from] std::io::Error),

    /// The file is larger than [`MAX_PACKAGE_SIZE_BYTES`].
    #[error("plugin package is {actual} bytes, exceeding the {max}-byte limit")]
    TooLarge {
        /// Actual on-disk size in bytes.
        actual: u64,
        /// The enforced maximum in bytes.
        max: u64,
    },

    /// The file is not a readable ZIP archive.
    #[error("plugin package is not a valid ZIP archive: {0}")]
    InvalidArchive(String),

    /// The archive has no `manifest.json` at its root.
    #[error("plugin package is missing the required `{MANIFEST_FILE_NAME}` entry")]
    MissingManifest,

    /// `manifest.json` could not be deserialized/validated (malformed JSON,
    /// unknown/missing field, unknown permission, …).
    #[error(transparent)]
    ManifestParse(#[from] ManifestParseError),

    /// `manifest.json` deserialized but failed semantic validation.
    #[error(transparent)]
    ManifestInvalid(#[from] ManifestValidationError),

    /// The manifest is valid but its `apiVersion` is incompatible with the host.
    #[error("plugin targets API version `{declared}` but this host supports `{supported}`")]
    IncompatibleApiVersion {
        /// The version the plugin declared.
        declared: String,
        /// The version this host supports ([`CURRENT_PLUGIN_API_VERSION`]).
        supported: String,
    },
}

/// Open and fully validate a `.termihub-plugin` package at `path`, returning its
/// trusted [`PluginManifest`] on success.
///
/// This does **not** extract the archive; it only reads `manifest.json`. The
/// order of checks is deliberate — the size limit is enforced before the
/// archive is even opened.
pub fn validate_package(path: &Path) -> Result<PluginManifest, PluginPackageError> {
    validate_package_with_limit(path, MAX_PACKAGE_SIZE_BYTES)
}

/// [`validate_package`] with an explicit size limit. Factored out so the size
/// enforcement can be exercised without materializing a 50 MB fixture.
fn validate_package_with_limit(
    path: &Path,
    max_bytes: u64,
) -> Result<PluginManifest, PluginPackageError> {
    check_size_with_limit(path, max_bytes)?;

    let file = std::fs::File::open(path)?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| PluginPackageError::InvalidArchive(e.to_string()))?;

    let manifest_json = {
        let mut entry = match archive.by_name(MANIFEST_FILE_NAME) {
            Ok(entry) => entry,
            Err(zip::result::ZipError::FileNotFound) => {
                return Err(PluginPackageError::MissingManifest)
            }
            Err(e) => return Err(PluginPackageError::InvalidArchive(e.to_string())),
        };
        // Bound the manifest read too: `manifest.json` is decompressed here, so an
        // unbounded read would be a zip-bomb vector of its own.
        let mut bytes = Vec::new();
        let mut remaining = MAX_DECOMPRESSED_ENTRY_BYTES;
        read_entry_bounded(
            &mut entry,
            MAX_DECOMPRESSED_ENTRY_BYTES,
            &mut remaining,
            &mut bytes,
        )?;
        String::from_utf8(bytes).map_err(|e| {
            PluginPackageError::InvalidArchive(format!(
                "`{MANIFEST_FILE_NAME}` is not valid UTF-8: {e}"
            ))
        })?
    };

    let manifest = parse_manifest(&manifest_json)?;
    manifest.validate()?;

    match manifest.api_compatibility() {
        ApiCompatibility::Compatible => Ok(manifest),
        ApiCompatibility::Incompatible => Err(PluginPackageError::IncompatibleApiVersion {
            declared: manifest.api_version.clone(),
            supported: CURRENT_PLUGIN_API_VERSION.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn good_manifest_json() -> String {
        r#"{
            "id": "k8s-exec",
            "name": "Kubernetes Exec",
            "version": "1.2.0",
            "author": "k8s-contrib",
            "description": "Terminal backend for Kubernetes pod exec sessions",
            "license": "MIT",
            "apiVersion": "1.0",
            "platforms": ["linux", "macos"],
            "permissions": ["terminal", "network"],
            "extensions": {
                "terminalBackend": {
                    "connectionType": "k8s-exec",
                    "displayName": "Kubernetes Exec",
                    "configSchema": {}
                }
            }
        }"#
        .to_string()
    }

    /// Build a ZIP package on disk. `manifest` is written as `manifest.json`
    /// when `Some`; extra entries let a test add non-manifest files.
    fn make_package(manifest: Option<&str>, extra: &[(&str, &[u8])]) -> NamedTempFile {
        let file = NamedTempFile::new().unwrap();
        let mut zip = ZipWriter::new(file.reopen().unwrap());
        let opts = SimpleFileOptions::default();
        if let Some(m) = manifest {
            zip.start_file(MANIFEST_FILE_NAME, opts).unwrap();
            zip.write_all(m.as_bytes()).unwrap();
        }
        for (name, bytes) in extra {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        file
    }

    #[test]
    fn accepts_a_valid_package() {
        let pkg = make_package(
            Some(&good_manifest_json()),
            &[("README.md", b"# hi"), ("themes/dracula.json", b"{}")],
        );
        let manifest = validate_package(pkg.path()).expect("valid package");
        assert_eq!(manifest.id, "k8s-exec");
    }

    #[test]
    fn rejects_missing_manifest() {
        let pkg = make_package(None, &[("README.md", b"# hi")]);
        let err = validate_package(pkg.path()).unwrap_err();
        assert!(
            matches!(err, PluginPackageError::MissingManifest),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_non_zip_file() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"this is definitely not a zip archive")
            .unwrap();
        file.flush().unwrap();
        let err = validate_package(file.path()).unwrap_err();
        assert!(
            matches!(err, PluginPackageError::InvalidArchive(_)),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_malformed_manifest_json() {
        let pkg = make_package(Some("{ not valid json"), &[]);
        let err = validate_package(pkg.path()).unwrap_err();
        assert!(
            matches!(err, PluginPackageError::ManifestParse(_)),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_unknown_permission() {
        let bad = good_manifest_json()
            .replace("[\"terminal\", \"network\"]", "[\"terminal\", \"kernel\"]");
        let pkg = make_package(Some(&bad), &[]);
        let err = validate_package(pkg.path()).unwrap_err();
        assert!(
            matches!(&err, PluginPackageError::ManifestParse(e) if e.to_string().contains("kernel")),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_semantically_invalid_manifest() {
        let bad = good_manifest_json().replace("\"id\": \"k8s-exec\"", "\"id\": \"../escape\"");
        let pkg = make_package(Some(&bad), &[]);
        let err = validate_package(pkg.path()).unwrap_err();
        assert!(
            matches!(
                err,
                PluginPackageError::ManifestInvalid(ManifestValidationError::InvalidId(_))
            ),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_incompatible_api_version() {
        let bad =
            good_manifest_json().replace("\"apiVersion\": \"1.0\"", "\"apiVersion\": \"2.0\"");
        let pkg = make_package(Some(&bad), &[]);
        let err = validate_package(pkg.path()).unwrap_err();
        match err {
            PluginPackageError::IncompatibleApiVersion {
                declared,
                supported,
            } => {
                assert_eq!(declared, "2.0");
                assert_eq!(supported, CURRENT_PLUGIN_API_VERSION);
            }
            other => panic!("expected IncompatibleApiVersion, got: {other}"),
        }
    }

    #[test]
    fn rejects_oversize_package_before_opening() {
        // A well-formed package, rejected purely on the size limit — proving the
        // 50 MB check happens before the archive is opened/parsed.
        let pkg = make_package(Some(&good_manifest_json()), &[]);
        let actual = std::fs::metadata(pkg.path()).unwrap().len();
        let err = validate_package_with_limit(pkg.path(), 8).unwrap_err();
        match err {
            PluginPackageError::TooLarge { actual: a, max } => {
                assert_eq!(a, actual);
                assert_eq!(max, 8);
            }
            other => panic!("expected TooLarge, got: {other}"),
        }
    }

    #[test]
    fn size_limit_constant_is_50_mb() {
        assert_eq!(MAX_PACKAGE_SIZE_BYTES, 50 * 1024 * 1024);
    }

    #[test]
    fn check_package_size_accepts_a_normal_package() {
        let pkg = make_package(Some(&good_manifest_json()), &[]);
        check_package_size(pkg.path()).expect("a small package is under the size cap");
    }

    #[test]
    fn check_size_with_limit_rejects_oversize_before_opening() {
        // The pre-trust size gate rejects on on-disk length alone, without opening
        // the archive — proven with a tiny injected limit (#2046).
        let pkg = make_package(Some(&good_manifest_json()), &[]);
        let actual = std::fs::metadata(pkg.path()).unwrap().len();
        let err = check_size_with_limit(pkg.path(), 8).unwrap_err();
        match err {
            PluginPackageError::TooLarge { actual: a, max } => {
                assert_eq!(a, actual);
                assert_eq!(max, 8);
            }
            other => panic!("expected TooLarge, got: {other}"),
        }
    }

    #[test]
    fn read_entry_bounded_accepts_within_budget_and_tracks_total() {
        use std::io::Cursor;
        let mut remaining = 1_000u64;
        let mut buf = Vec::new();
        read_entry_bounded(Cursor::new(vec![0u8; 300]), 500, &mut remaining, &mut buf)
            .expect("300 bytes is within both budgets");
        assert_eq!(buf.len(), 300);
        assert_eq!(
            remaining, 700,
            "the total budget must be decremented by bytes read"
        );
    }

    #[test]
    fn read_entry_bounded_rejects_over_per_entry_cap() {
        use std::io::Cursor;
        let mut remaining = 1_000_000u64;
        let mut buf = Vec::new();
        let err = read_entry_bounded(Cursor::new(vec![0u8; 4096]), 64, &mut remaining, &mut buf)
            .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn read_entry_bounded_rejects_when_total_budget_exhausted() {
        use std::io::Cursor;
        // Under the per-entry cap but over what remains of the whole-package budget.
        let mut remaining = 100u64;
        let mut buf = Vec::new();
        let err = read_entry_bounded(
            Cursor::new(vec![0u8; 400]),
            10_000,
            &mut remaining,
            &mut buf,
        )
        .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }
}

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
    let metadata = std::fs::metadata(path)?;
    if metadata.len() > max_bytes {
        return Err(PluginPackageError::TooLarge {
            actual: metadata.len(),
            max: max_bytes,
        });
    }

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
        let mut buf = String::new();
        entry.read_to_string(&mut buf)?;
        buf
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
}

//! Packaging-time check that a native plugin's manifest `apiVersion` mirrors
//! the ABI its library actually exports (#3372, PLG-002).
//!
//! The host already refuses a mismatch at **load** time
//! (`HostError::ManifestAbiMismatch`), but by then the package has been built,
//! signed and installed. This check moves the failure to [`super::pack_plugin`].
//!
//! # Reading the ABI without loading the library
//!
//! The library's version is read from the **ABI marker** that
//! `termihub_plugin_api::export_plugin_abi_version!` embeds (see
//! `termihub_plugin_api::marker`): a fixed magic byte string followed by the
//! version, found by a plain byte scan. This is deliberate:
//!
//! * **No code runs.** Calling `termihub_plugin_abi_version` would mean
//!   `dlopen`ing the library, which runs its initializers inside the packaging
//!   tool — untrusted code in a build/CI step.
//! * **Every target, from any host.** The packer builds packages for platforms
//!   other than the one it runs on (`--target`, `--merge`); a foreign `.dll` or
//!   `.dylib` cannot be loaded at all, but its bytes can be scanned. A macOS
//!   universal binary carries one marker per slice; all must agree.
//!
//! A library without a marker (a plugin that hand-writes the entry point and
//! skips `embed_plugin_abi_marker!`) cannot be verified. It is **not** refused —
//! the marker is not part of the frozen ABI — but the packer reports a
//! [`PackWarning::UnverifiedLibraryAbi`], never silently passing it.

use std::fmt;
use std::fs;
use std::path::Path;

use termihub_plugin_api::{AbiVersion, ABI_MARKER_MAGIC};

use super::pack::PluginPackError;
use super::platform::BACKEND_DIR;

/// Dynamic-library extensions scanned under `backend/`.
const LIBRARY_EXTENSIONS: &[&str] = &["dll", "so", "dylib"];

/// A non-fatal packaging finding the author should see.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackWarning {
    /// The library carries no ABI marker, so the manifest `apiVersion` could not
    /// be checked against it at packaging time (it still is at load time).
    UnverifiedLibraryAbi {
        /// The library's `/`-separated path inside the package.
        library: String,
        /// The manifest's `apiVersion`.
        manifest: String,
    },
}

impl fmt::Display for PackWarning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnverifiedLibraryAbi { library, manifest } => write!(
                f,
                "cannot verify manifest `apiVersion` \"{manifest}\" against `{library}`: the \
                 library embeds no ABI marker. Export the version with \
                 `termihub_plugin_api::export_plugin_abi_version!()` (or add \
                 `embed_plugin_abi_marker!`) so packaging can check it; a mismatch is \
                 otherwise only refused when termiHub loads the plugin"
            ),
        }
    }
}

/// Check every native library under `source_dir/backend/` against the manifest
/// `apiVersion`, returning the warnings for libraries that could not be checked.
///
/// Fails with [`PluginPackError::LibraryAbiMismatch`] when a library's marker
/// names another version, and [`PluginPackError::AmbiguousLibraryAbi`] when one
/// library carries markers that disagree.
pub(super) fn check_backend_abi(
    source_dir: &Path,
    manifest_api_version: &str,
) -> Result<Vec<PackWarning>, PluginPackError> {
    let mut libraries = Vec::new();
    collect_libraries(&source_dir.join(BACKEND_DIR), BACKEND_DIR, &mut libraries)?;

    let declared = AbiVersion::parse(manifest_api_version);
    let mut warnings = Vec::new();
    for (library, path) in libraries {
        let markers = find_abi_markers(&fs::read(&path)?);
        let Some(&library_abi) = markers.first() else {
            warnings.push(PackWarning::UnverifiedLibraryAbi {
                library,
                manifest: manifest_api_version.to_owned(),
            });
            continue;
        };
        if markers.iter().any(|m| *m != library_abi) {
            let found = markers.iter().map(ToString::to_string).collect();
            return Err(PluginPackError::AmbiguousLibraryAbi { library, found });
        }
        if declared != Some(library_abi) {
            return Err(PluginPackError::LibraryAbiMismatch {
                library,
                manifest: manifest_api_version.to_owned(),
                library_abi,
            });
        }
    }
    Ok(warnings)
}

/// Every ABI marker in `bytes` (a library's raw contents), in file order.
fn find_abi_markers(bytes: &[u8]) -> Vec<AbiVersion> {
    let magic = &ABI_MARKER_MAGIC[..];
    let mut found = Vec::new();
    let mut start = 0;
    while let Some(offset) = bytes
        .get(start..)
        .and_then(|rest| rest.windows(magic.len()).position(|w| w == magic))
    {
        let at = start + offset + magic.len();
        if let Some(&[a, b, c, d]) = bytes.get(at..at + 4) {
            found.push(AbiVersion::new(
                u16::from_be_bytes([a, b]),
                u16::from_be_bytes([c, d]),
            ));
        }
        start = at;
    }
    found
}

/// Recursively collect `(package path, filesystem path)` for every library file
/// under `dir`, skipping dotfiles and symlinks exactly as the archive writer
/// does, so only what is packaged is checked.
fn collect_libraries(
    dir: &Path,
    prefix: &str,
    out: &mut Vec<(String, std::path::PathBuf)>,
) -> Result<(), PluginPackError> {
    if !dir.is_dir() {
        return Ok(());
    }
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry.file_type()?;
        if name.starts_with('.') || file_type.is_symlink() {
            continue;
        }
        let package_path = format!("{prefix}/{name}");
        if file_type.is_dir() {
            collect_libraries(&entry.path(), &package_path, out)?;
        } else if Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| LIBRARY_EXTENSIONS.contains(&e))
        {
            out.push((package_path, entry.path()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use termihub_plugin_api::abi_marker;

    /// Fake library bytes carrying one marker per version.
    fn library(versions: &[AbiVersion]) -> Vec<u8> {
        let mut bytes = b"\x7fELF code".to_vec();
        for v in versions {
            bytes.extend_from_slice(&abi_marker(*v));
            bytes.extend_from_slice(b"padding");
        }
        bytes
    }

    fn source(files: &[(&str, Vec<u8>)]) -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().unwrap();
        for (path, bytes) in files {
            let path = dir.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        dir
    }

    const V1_0: AbiVersion = AbiVersion::new(1, 0);
    const V1_1: AbiVersion = AbiVersion::new(1, 1);

    #[test]
    fn scan_finds_markers_and_ignores_a_truncated_one() {
        assert_eq!(find_abi_markers(&library(&[V1_1])), vec![V1_1]);
        assert_eq!(find_abi_markers(&library(&[V1_1, V1_0])), vec![V1_1, V1_0]);
        assert!(find_abi_markers(b"no marker here").is_empty());
        let mut truncated = b"x".to_vec();
        truncated.extend_from_slice(&ABI_MARKER_MAGIC);
        truncated.extend_from_slice(&[0, 1]);
        assert!(find_abi_markers(&truncated).is_empty());
    }

    #[test]
    fn matching_library_passes_without_warnings() {
        let src = source(&[("backend/libp.so", library(&[V1_1]))]);
        assert_eq!(check_backend_abi(src.path(), "1.1").unwrap(), vec![]);
    }

    #[test]
    fn mismatch_in_any_platform_directory_is_refused() {
        let src = source(&[
            ("backend/x86_64-unknown-linux-gnu/libp.so", library(&[V1_1])),
            ("backend/x86_64-pc-windows-msvc/p.dll", library(&[V1_0])),
        ]);
        let err = check_backend_abi(src.path(), "1.1").unwrap_err();
        match err {
            PluginPackError::LibraryAbiMismatch {
                ref library,
                ref manifest,
                library_abi,
            } => {
                assert_eq!(library, "backend/x86_64-pc-windows-msvc/p.dll");
                assert_eq!(manifest, "1.1");
                assert_eq!(library_abi, V1_0);
            }
            other => panic!("expected LibraryAbiMismatch, got {other:?}"),
        }
        assert_eq!(
            err.to_string(),
            "manifest `apiVersion` is \"1.1\" but `backend/x86_64-pc-windows-msvc/p.dll` \
             exports plugin ABI 1.0; set `apiVersion` to \"1.0\" (the library's ABI is \
             authoritative)"
        );
    }

    #[test]
    fn a_universal_binary_must_agree_across_slices() {
        let same = source(&[("backend/libp.dylib", library(&[V1_1, V1_1]))]);
        assert!(check_backend_abi(same.path(), "1.1").unwrap().is_empty());

        let mixed = source(&[("backend/libp.dylib", library(&[V1_1, V1_0]))]);
        assert!(matches!(
            check_backend_abi(mixed.path(), "1.1"),
            Err(PluginPackError::AmbiguousLibraryAbi { .. })
        ));
    }

    #[test]
    fn unmarked_library_is_a_warning_not_an_error() {
        let src = source(&[("backend/libp.so", b"\x7fELF plain".to_vec())]);
        let warnings = check_backend_abi(src.path(), "1.1").unwrap();
        assert_eq!(
            warnings,
            vec![PackWarning::UnverifiedLibraryAbi {
                library: "backend/libp.so".into(),
                manifest: "1.1".into(),
            }]
        );
        assert!(warnings[0]
            .to_string()
            .contains("export_plugin_abi_version!"));
    }

    #[test]
    fn non_library_files_and_dotfiles_are_not_checked() {
        let src = source(&[
            ("backend/README.txt", library(&[V1_0])),
            ("backend/.hidden.so", library(&[V1_0])),
            ("themes/t.json", b"{}".to_vec()),
        ]);
        assert!(check_backend_abi(src.path(), "1.1").unwrap().is_empty());
    }

    #[test]
    fn no_backend_directory_is_fine() {
        let src = source(&[("manifest.json", b"{}".to_vec())]);
        assert!(check_backend_abi(src.path(), "1.1").unwrap().is_empty());
    }
}

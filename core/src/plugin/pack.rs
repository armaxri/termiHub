//! `.termihub-plugin` package **builder** — the write side of the format that
//! [`super::package`] validates.
//!
//! [`pack_plugin`] takes a plugin *source directory* (a manifest plus the
//! optional `backend/`, `frontend/`, `themes/` subtrees and a `README.md`) and
//! emits a `<id>-<version>.termihub-plugin` ZIP with the concept §1 layout. It is
//! deliberately the mirror image of [`validate_package`]: after writing the
//! archive it runs the very same validator over it, so the packaging tool can
//! never produce an artifact the host would reject. This is what makes the
//! package → validate round trip a single, self-checking step.
//!
//! Only the manifest and the three well-known subtrees are packaged; anything
//! else in the source directory (a `Cargo.toml`, `src/`, a `target/` dir, editor
//! dotfiles) is ignored. That keeps a Rust backend plugin's crate scaffolding out
//! of the shipped artifact without the caller having to stage a clean tree first.
//! The native dynamic library itself is expected to already sit in `backend/`;
//! building the crate and staging its `.dll`/`.so`/`.dylib` there is the job of
//! the `scripts/package-plugin.{sh,cmd}` wrapper, which this function backs.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use thiserror::Error;
use zip::write::{SimpleFileOptions, ZipWriter};

use super::manifest::{
    parse_manifest, ManifestParseError, ManifestValidationError, PluginManifest,
};
use super::package::{validate_package, PluginPackageError, MANIFEST_FILE_NAME};
use super::signature::{
    now_rfc3339, sign_digests, signing_key_from_base64, verify_reader, PackageVerification,
    SignatureError, SigningKeyFile, SIGNATURE_FILE_NAME,
};

/// Subtrees copied verbatim from the source directory into the package, matching
/// the concept §1 layout. Everything else in the source directory is ignored.
const PACKAGED_DIRS: &[&str] = &["backend", "frontend", "themes"];

/// Optional top-level files copied into the package alongside the manifest.
const PACKAGED_FILES: &[&str] = &["README.md"];

/// The package's file extension (without the dot).
const PACKAGE_EXTENSION: &str = "termihub-plugin";

/// Everything that can go wrong turning a source directory into a package.
#[derive(Debug, Error)]
pub enum PluginPackError {
    /// A filesystem operation on the source or output failed.
    #[error("plugin packaging i/o error: {0}")]
    Io(#[from] io::Error),

    /// The source directory has no `manifest.json` at its root.
    #[error("plugin source `{}` is missing the required `{MANIFEST_FILE_NAME}`", .0.display())]
    MissingManifest(PathBuf),

    /// `manifest.json` could not be deserialized (malformed JSON, unknown field,
    /// unknown permission/platform, …).
    #[error(transparent)]
    ManifestParse(#[from] ManifestParseError),

    /// `manifest.json` deserialized but failed semantic validation.
    #[error(transparent)]
    ManifestInvalid(#[from] ManifestValidationError),

    /// Writing the ZIP archive failed.
    #[error("could not write plugin package: {0}")]
    Zip(String),

    /// The package was written but then failed the real [`validate_package`]
    /// check — a bug in the packaging path, surfaced loudly rather than shipping
    /// an artifact the host would reject.
    #[error("the produced package did not pass validation: {0}")]
    ProducedPackageInvalid(#[from] PluginPackageError),

    /// The supplied signing key file could not be decoded to a usable key.
    #[error("invalid signing key: {0}")]
    InvalidSigningKey(#[from] SignatureError),

    /// The freshly-signed package did not verify as signed — a bug in the signing
    /// path, surfaced loudly rather than shipping a broken signature.
    #[error("the signed package did not verify: {0:?}")]
    SigningRoundTripFailed(PackageVerification),
}

impl From<zip::result::ZipError> for PluginPackError {
    fn from(e: zip::result::ZipError) -> Self {
        PluginPackError::Zip(e.to_string())
    }
}

/// Package the plugin source tree at `source_dir` into a validated
/// `.termihub-plugin` archive written under `output_dir`, returning its path.
///
/// The steps are, in order:
///
/// 1. read and fully validate `source_dir/manifest.json` (reusing the same
///    parser and validator the host applies), so a broken manifest fails *before*
///    any archive is written;
/// 2. write a ZIP containing `manifest.json`, an optional `README.md`, and the
///    `backend/`, `frontend/` and `themes/` subtrees if present — nothing else;
/// 3. re-open the written archive with [`validate_package`] and propagate any
///    failure as [`PluginPackError::ProducedPackageInvalid`].
///
/// The output file is named `<id>-<version>.termihub-plugin` from the manifest's
/// (already-validated, filesystem-safe) `id` and its `version`.
pub fn pack_plugin(source_dir: &Path, output_dir: &Path) -> Result<PathBuf, PluginPackError> {
    let manifest_path = source_dir.join(MANIFEST_FILE_NAME);
    if !manifest_path.is_file() {
        return Err(PluginPackError::MissingManifest(source_dir.to_path_buf()));
    }

    // Validate the manifest up front so we never write a package for a manifest
    // the host would reject.
    let manifest_json = fs::read_to_string(&manifest_path)?;
    let manifest = parse_manifest(&manifest_json)?;
    manifest.validate()?;

    fs::create_dir_all(output_dir)?;
    let out_path = output_dir.join(package_file_name(&manifest));

    write_archive(source_dir, &manifest_json, &out_path)?;

    // Round-trip: the artifact we just produced must pass the real validator.
    validate_package(&out_path)?;
    Ok(out_path)
}

/// Package the plugin source tree at `source_dir` and, when `signing_key` is
/// supplied, sign the produced archive in place (concept "signing is a distinct
/// step from packing" — `termihub-plugin-pack --sign`). With `None` this is
/// exactly [`pack_plugin`]; with a key it additionally writes `signature.json`
/// after the unsigned round-trip validate.
pub fn pack_plugin_signed(
    source_dir: &Path,
    output_dir: &Path,
    signing_key: Option<&SigningKeyFile>,
) -> Result<PathBuf, PluginPackError> {
    let out_path = pack_plugin(source_dir, output_dir)?;
    if let Some(key) = signing_key {
        sign_package(&out_path, key)?;
    }
    Ok(out_path)
}

/// Sign an already-built `.termihub-plugin` in place: compute the per-entry
/// SHA-256 digest map, build the [`super::signature::PackageSignature`], and
/// rewrite the archive with an added (or replaced) `signature.json` entry.
///
/// Re-signing is idempotent in structure: any existing `signature.json` is
/// dropped before the new one is written, so the digest map never covers a stale
/// signature entry. After writing, the package is re-validated *and* re-verified
/// as signed, so a broken signing pass fails loudly rather than shipping.
pub fn sign_package(package_path: &Path, key: &SigningKeyFile) -> Result<(), PluginPackError> {
    let signing_key = signing_key_from_base64(&key.private_key)?;

    // Read every entry (except any prior signature) into memory, preserving order.
    let file = File::open(package_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.is_dir() || entry.name() == SIGNATURE_FILE_NAME {
            continue;
        }
        let name = entry.name().to_owned();
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)?;
        entries.push((name, buf));
    }
    drop(archive);

    // Digest map over exactly the entries we will re-emit.
    let digests = entries
        .iter()
        .map(|(name, bytes)| (name.clone(), super::signature::sha256_digest(bytes)))
        .collect();
    let signature = sign_digests(&signing_key, digests, now_rfc3339());
    let sig_json = serde_json::to_vec_pretty(&signature)
        .map_err(|e| PluginPackError::Zip(format!("serialize signature.json: {e}")))?;

    // Rewrite the archive to a temp file, then swap it into place.
    let tmp = package_path.with_extension("termihub-plugin.signing.tmp");
    {
        let out = File::create(&tmp)?;
        let mut zip = ZipWriter::new(out);
        let opts = SimpleFileOptions::default();
        for (name, bytes) in &entries {
            zip.start_file(name, opts)?;
            zip.write_all(bytes)?;
        }
        zip.start_file(SIGNATURE_FILE_NAME, opts)?;
        zip.write_all(&sig_json)?;
        zip.finish()?;
    }
    fs::rename(&tmp, package_path)?;

    // Round-trip: the manifest must still validate and the signature must verify.
    validate_package(package_path)?;
    let verification = verify_reader(File::open(package_path)?)
        .map_err(|e| PluginPackError::Zip(format!("re-open signed package: {e}")))?;
    if !matches!(verification, PackageVerification::Signed(_)) {
        return Err(PluginPackError::SigningRoundTripFailed(verification));
    }
    Ok(())
}

/// The `<id>-<version>.termihub-plugin` file name for a validated manifest.
///
/// The `id` is already guaranteed filesystem-safe by [`PluginManifest::validate`];
/// the free-form `version` is sanitized so an unusual version string can never
/// introduce a path separator or other awkward filename character.
fn package_file_name(manifest: &PluginManifest) -> String {
    format!(
        "{}-{}.{}",
        manifest.id,
        sanitize_version(&manifest.version),
        PACKAGE_EXTENSION
    )
}

/// Replace any character that is not an ASCII alphanumeric, `.`, `_` or `-` with
/// a single `-`, so the version segment is always a safe filename component.
fn sanitize_version(version: &str) -> String {
    version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Write the ZIP archive: manifest at the root, then the optional files and
/// well-known subtrees.
fn write_archive(
    source_dir: &Path,
    manifest_json: &str,
    out_path: &Path,
) -> Result<(), PluginPackError> {
    let file = File::create(out_path)?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default();

    zip.start_file(MANIFEST_FILE_NAME, opts)?;
    zip.write_all(manifest_json.as_bytes())?;

    for file_name in PACKAGED_FILES {
        let path = source_dir.join(file_name);
        if path.is_file() {
            add_file(&mut zip, &path, file_name, opts)?;
        }
    }

    for dir_name in PACKAGED_DIRS {
        let path = source_dir.join(dir_name);
        if path.is_dir() {
            add_dir(&mut zip, &path, dir_name, opts)?;
        }
    }

    zip.finish()?;
    Ok(())
}

/// Recursively add a directory's files to the archive under `zip_prefix`.
///
/// Entries are added in sorted order for a deterministic archive, and dotfiles
/// (e.g. `.DS_Store`) are skipped.
fn add_dir(
    zip: &mut ZipWriter<File>,
    abs_dir: &Path,
    zip_prefix: &str,
    opts: SimpleFileOptions,
) -> Result<(), PluginPackError> {
    let mut entries: Vec<_> = fs::read_dir(abs_dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let raw_name = entry.file_name();
        let name = raw_name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let abs = entry.path();
        let zip_path = format!("{zip_prefix}/{name}");
        if abs.is_dir() {
            add_dir(zip, &abs, &zip_path, opts)?;
        } else {
            add_file(zip, &abs, &zip_path, opts)?;
        }
    }
    Ok(())
}

/// Add a single file to the archive at `zip_path`.
fn add_file(
    zip: &mut ZipWriter<File>,
    abs: &Path,
    zip_path: &str,
    opts: SimpleFileOptions,
) -> Result<(), PluginPackError> {
    zip.start_file(zip_path, opts)?;
    let mut buf = Vec::new();
    File::open(abs)?.read_to_end(&mut buf)?;
    zip.write_all(&buf)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use tempfile::TempDir;
    use zip::ZipArchive;

    /// A minimal, valid theme-plugin manifest (no dylib needed).
    fn theme_manifest() -> String {
        r#"{
            "id": "solarized-night",
            "name": "Solarized Night",
            "version": "1.0.0",
            "author": "termihub-examples",
            "description": "An example theme plugin",
            "license": "MIT",
            "apiVersion": "1.0",
            "platforms": ["windows", "linux", "macos"],
            "permissions": [],
            "extensions": {
                "theme": {
                    "themes": [
                        { "id": "solarized-night", "name": "Solarized Night", "file": "solarized-night.json" }
                    ]
                }
            }
        }"#
        .to_string()
    }

    /// Lay out a plugin source directory in a fresh tempdir and return it.
    fn source_tree(manifest: &str) -> TempDir {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(MANIFEST_FILE_NAME), manifest).unwrap();
        fs::write(dir.path().join("README.md"), b"# Example").unwrap();
        fs::create_dir(dir.path().join("themes")).unwrap();
        fs::write(dir.path().join("themes/solarized-night.json"), b"{}").unwrap();
        dir
    }

    /// Collect the entry names of a produced package.
    fn entry_names(pkg: &Path) -> BTreeSet<String> {
        let mut archive = ZipArchive::new(File::open(pkg).unwrap()).unwrap();
        (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect()
    }

    #[test]
    fn packs_and_round_trip_validates() {
        let src = source_tree(&theme_manifest());
        let out = TempDir::new().unwrap();

        let pkg = pack_plugin(src.path(), out.path()).expect("packaging should succeed");

        // Named from id + version.
        assert_eq!(
            pkg.file_name().unwrap().to_str().unwrap(),
            "solarized-night-1.0.0.termihub-plugin"
        );

        // The archive holds exactly the manifest, the README and the theme file.
        let names = entry_names(&pkg);
        assert!(names.contains("manifest.json"));
        assert!(names.contains("README.md"));
        assert!(names.contains("themes/solarized-night.json"));

        // And it passes the real validator (pack_plugin already asserts this, but
        // prove it independently for clarity).
        let manifest = validate_package(&pkg).expect("produced package must validate");
        assert_eq!(manifest.id, "solarized-night");
    }

    #[test]
    fn ignores_crate_scaffolding_and_dotfiles() {
        let src = source_tree(&theme_manifest());
        // Backend-crate scaffolding and build junk that must NOT be packaged.
        fs::write(src.path().join("Cargo.toml"), b"[package]").unwrap();
        fs::create_dir(src.path().join("src")).unwrap();
        fs::write(src.path().join("src/lib.rs"), b"// code").unwrap();
        fs::create_dir(src.path().join("target")).unwrap();
        fs::write(src.path().join("target/junk"), b"junk").unwrap();
        fs::write(src.path().join(".DS_Store"), b"junk").unwrap();

        let out = TempDir::new().unwrap();
        let pkg = pack_plugin(src.path(), out.path()).unwrap();

        let names = entry_names(&pkg);
        assert!(
            names
                .iter()
                .all(|n| !n.starts_with("src/") && !n.starts_with("target/")),
            "crate scaffolding leaked into the package: {names:?}"
        );
        assert!(!names.contains("Cargo.toml"));
        assert!(!names.iter().any(|n| n.contains(".DS_Store")));
    }

    #[test]
    fn packages_backend_subtree() {
        let src = source_tree(&theme_manifest());
        fs::create_dir(src.path().join("backend")).unwrap();
        // A stand-in for a staged dynamic library.
        fs::write(src.path().join("backend/libexample.so"), b"\x7fELF").unwrap();

        let out = TempDir::new().unwrap();
        let pkg = pack_plugin(src.path(), out.path()).unwrap();
        assert!(entry_names(&pkg).contains("backend/libexample.so"));
    }

    #[test]
    fn missing_manifest_is_reported() {
        let empty = TempDir::new().unwrap();
        let out = TempDir::new().unwrap();
        let err = pack_plugin(empty.path(), out.path()).unwrap_err();
        assert!(
            matches!(err, PluginPackError::MissingManifest(_)),
            "got: {err}"
        );
    }

    #[test]
    fn invalid_manifest_fails_before_writing() {
        // A syntactically fine manifest whose id is not a safe slug.
        let bad = theme_manifest().replace("\"solarized-night\"", "\"../escape\"");
        let src = TempDir::new().unwrap();
        fs::write(src.path().join(MANIFEST_FILE_NAME), &bad).unwrap();
        let out = TempDir::new().unwrap();

        let err = pack_plugin(src.path(), out.path()).unwrap_err();
        assert!(
            matches!(
                err,
                PluginPackError::ManifestInvalid(ManifestValidationError::InvalidId(_))
            ),
            "got: {err}"
        );
        // No package should have been written.
        assert!(fs::read_dir(out.path()).unwrap().next().is_none());
    }

    #[test]
    fn sanitizes_version_in_file_name() {
        assert_eq!(sanitize_version("1.2.0"), "1.2.0");
        assert_eq!(sanitize_version("1.0-beta+build"), "1.0-beta-build");
        assert_eq!(sanitize_version("a/b\\c"), "a-b-c");
    }

    #[test]
    fn signed_package_verifies_and_stays_valid() {
        use super::super::signature::{generate_keypair, verify_reader, PackageVerification};

        let src = source_tree(&theme_manifest());
        let out = TempDir::new().unwrap();
        let key = generate_keypair("Test Publisher");

        let pkg = pack_plugin_signed(src.path(), out.path(), Some(&key)).unwrap();

        // The signed archive carries signature.json alongside the content.
        let names = entry_names(&pkg);
        assert!(names.contains("signature.json"));
        assert!(names.contains("manifest.json"));

        // It still validates as a package, and verifies as signed by our key.
        assert!(validate_package(&pkg).is_ok());
        match verify_reader(File::open(&pkg).unwrap()).unwrap() {
            PackageVerification::Signed(id) => assert_eq!(id.key_id, key.key_id),
            other => panic!("expected Signed, got {other:?}"),
        }
    }

    #[test]
    fn unsigned_pack_has_no_signature_entry() {
        let src = source_tree(&theme_manifest());
        let out = TempDir::new().unwrap();
        let pkg = pack_plugin_signed(src.path(), out.path(), None).unwrap();
        assert!(!entry_names(&pkg).contains("signature.json"));
    }

    #[test]
    fn re_signing_replaces_the_prior_signature() {
        use super::super::signature::generate_keypair;

        let src = source_tree(&theme_manifest());
        let out = TempDir::new().unwrap();
        let key1 = generate_keypair("First");
        let key2 = generate_keypair("Second");

        let pkg = pack_plugin_signed(src.path(), out.path(), Some(&key1)).unwrap();
        // Re-sign with a different key; the archive must end up with exactly one
        // signature.json and verify under the new key.
        sign_package(&pkg, &key2).unwrap();

        let names = entry_names(&pkg);
        assert_eq!(names.iter().filter(|n| *n == "signature.json").count(), 1);
        match super::super::signature::verify_reader(File::open(&pkg).unwrap()).unwrap() {
            super::super::signature::PackageVerification::Signed(id) => {
                assert_eq!(id.key_id, key2.key_id)
            }
            other => panic!("expected Signed by key2, got {other:?}"),
        }
    }
}

//! Multi-platform ("fat") package **building** (PLG-011): the packer side of
//! the `backend/<target-triple>/` layout that [`super::platform`] describes.
//!
//! Three operations back the `termihub-plugin-pack` binary and the
//! `scripts/package-plugin.{sh,cmd}` wrapper:
//!
//! * [`platform_library_map`] — when a plugin source's `backend/` holds one
//!   sub-directory per target triple, derive the manifest `libraries` map from
//!   it; [`super::pack_plugin`] injects that map into the packaged manifest, so
//!   an author never writes it by hand.
//! * [`merge_packages`] — combine per-platform packages (each built on its own
//!   OS with `--target`) into one fat package, refusing inputs that disagree on
//!   anything but their native libraries, then re-verify every platform entry's
//!   SHA-256 against its input.
//! * [`package_platform_entries`] — list a package's platform entries with
//!   their SHA-256, for CI and for authors checking what a package carries.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::path::{Path, PathBuf};

use serde_json::Value;
use thiserror::Error;
use zip::ZipArchive;

use super::manifest::parse_manifest;
use super::pack::{pack_plugin, PluginPackError};
use super::package::{
    read_entry_bounded, validate_package, MANIFEST_FILE_NAME, MAX_DECOMPRESSED_ENTRY_BYTES,
    MAX_DECOMPRESSED_TOTAL_BYTES,
};
use super::platform::{is_valid_target_triple, BACKEND_DIR};
use super::signature::{sha256_digest, SIGNATURE_FILE_NAME};

/// Everything specific to multi-platform packaging that can go wrong.
#[derive(Debug, Error)]
pub enum MultiPlatformPackError {
    /// A `backend/` sub-directory is not named after a valid target triple.
    #[error(
        "`backend/{0}` is not a target-triple directory (multi-platform layout is \
         `backend/<target-triple>/<library>`)"
    )]
    InvalidPlatformDir(String),

    /// A `backend/<triple>/` directory holds no library for that platform, or
    /// more than one.
    #[error("`backend/{triple}/` must contain exactly one `.{ext}` library (found {found})")]
    PlatformLibraryCount {
        /// The target-triple directory.
        triple: String,
        /// The dynamic-library extension expected for that triple.
        ext: &'static str,
        /// How many candidates were found.
        found: usize,
    },

    /// `backend/` mixes flat libraries (legacy) with target-triple directories.
    #[error(
        "`backend/` mixes a flat library (`{0}`) with target-triple directories; use one layout"
    )]
    MixedBackendLayout(String),

    /// Target-triple directories exist but the manifest declares no
    /// `terminalBackend` to attach the libraries to.
    #[error("`backend/` holds platform libraries but the manifest declares no `terminalBackend`")]
    LibrariesWithoutBackend,

    /// The manifest declares a `libraries` map that disagrees with the
    /// `backend/<triple>/` tree.
    #[error(
        "manifest `terminalBackend.libraries` does not match the `backend/` tree \
         (manifest: {declared}; tree: {detected})"
    )]
    LibraryMapMismatch {
        /// The manifest's map, rendered.
        declared: String,
        /// The map derived from the tree, rendered.
        detected: String,
    },

    /// `--merge` was given no input packages.
    #[error("nothing to merge: pass at least one per-platform package")]
    NoMergeInputs,

    /// A merge input is a legacy single-platform package, which does not name
    /// its target triple.
    #[error(
        "`{0}` is a single-platform package without target triples; re-package it with \
         `--target <triple>` before merging"
    )]
    LegacyMergeInput(PathBuf),

    /// Two merge inputs both carry the same platform.
    #[error("platform `{triple}` appears in more than one input (`{first}` and `{second}`)")]
    DuplicatePlatform {
        /// The duplicated target triple.
        triple: String,
        /// The first input carrying it.
        first: PathBuf,
        /// The second input carrying it.
        second: PathBuf,
    },

    /// A merge input differs from the first input in something other than its
    /// native libraries (manifest fields, frontend/theme files, README).
    #[error("`{input}` differs from `{reference}` in `{what}`; only native libraries may differ")]
    MergeInputMismatch {
        /// The differing input.
        input: PathBuf,
        /// The first input it is compared against.
        reference: PathBuf,
        /// The manifest or entry that differs.
        what: String,
    },

    /// The merged package's entry for a platform does not hash to its input's
    /// library.
    #[error("merged package entry for `{triple}` does not match its input library's SHA-256")]
    MergeVerifyFailed {
        /// The platform whose entry failed verification.
        triple: String,
    },
}

/// One platform entry of a package: its target triple, in-package path and the
/// `sha256:`-prefixed digest of the library bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformEntry {
    /// The Rust target triple.
    pub triple: String,
    /// The library's `/`-separated path inside the package.
    pub path: String,
    /// `sha256:<hex>` of the library bytes.
    pub sha256: String,
}

/// The dynamic-library extension for a target triple.
fn dll_extension_for_triple(triple: &str) -> &'static str {
    if triple.contains("windows") {
        "dll"
    } else if triple.contains("apple") || triple.contains("darwin") {
        "dylib"
    } else {
        "so"
    }
}

/// Non-dot, non-symlink entries of `dir`, sorted by name.
fn visible_entries(dir: &Path) -> Result<Vec<fs::DirEntry>, std::io::Error> {
    let mut entries: Vec<_> = fs::read_dir(dir)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter(|e| e.file_type().map(|t| !t.is_symlink()).unwrap_or(false))
        .collect();
    entries.sort_by_key(fs::DirEntry::file_name);
    Ok(entries)
}

/// Derive the `libraries` map from a plugin source's `backend/<triple>/` tree.
///
/// Returns an empty map for a legacy flat `backend/` (or none at all). Each
/// target-triple directory must hold exactly one library with that platform's
/// extension (other files beside it are packaged but not mapped). A
/// sub-directory that is not a valid triple, or a flat library beside triple
/// directories, is refused rather than guessed.
pub fn platform_library_map(
    source_dir: &Path,
) -> Result<BTreeMap<String, String>, PluginPackError> {
    let backend = source_dir.join(BACKEND_DIR);
    if !backend.is_dir() {
        return Ok(BTreeMap::new());
    }
    let mut map = BTreeMap::new();
    let mut flat_library: Option<String> = None;
    for entry in visible_entries(&backend)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type()?.is_dir() {
            let is_library = Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| matches!(e, "dll" | "so" | "dylib"));
            if is_library && flat_library.is_none() {
                flat_library = Some(name);
            }
            continue;
        }
        if !is_valid_target_triple(&name) {
            return Err(MultiPlatformPackError::InvalidPlatformDir(name).into());
        }
        let ext = dll_extension_for_triple(&name);
        let libs: Vec<String> = visible_entries(&entry.path())?
            .into_iter()
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| Path::new(n).extension().and_then(|e| e.to_str()) == Some(ext))
            .collect();
        if libs.len() != 1 {
            return Err(MultiPlatformPackError::PlatformLibraryCount {
                triple: name,
                ext,
                found: libs.len(),
            }
            .into());
        }
        map.insert(name.clone(), format!("{BACKEND_DIR}/{name}/{}", libs[0]));
    }
    if let (Some(flat), false) = (flat_library, map.is_empty()) {
        return Err(MultiPlatformPackError::MixedBackendLayout(flat).into());
    }
    Ok(map)
}

/// Return `manifest_json` with the `libraries` map derived from the source's
/// `backend/<triple>/` tree injected into its terminal backend.
///
/// Unchanged when the tree is a legacy flat layout. A manifest that already
/// declares a map must match the tree exactly.
pub(crate) fn inject_library_map(
    source_dir: &Path,
    manifest_json: &str,
) -> Result<String, PluginPackError> {
    let detected = platform_library_map(source_dir)?;
    if detected.is_empty() {
        return Ok(manifest_json.to_owned());
    }
    let manifest = parse_manifest(manifest_json)?;
    let Some(backend) = manifest.extensions.terminal_backend else {
        return Err(MultiPlatformPackError::LibrariesWithoutBackend.into());
    };
    if !backend.libraries.is_empty() {
        if backend.libraries == detected {
            return Ok(manifest_json.to_owned());
        }
        return Err(MultiPlatformPackError::LibraryMapMismatch {
            declared: format!("{:?}", backend.libraries),
            detected: format!("{detected:?}"),
        }
        .into());
    }
    let mut value: Value = serde_json::from_str(manifest_json)
        .map_err(|e| PluginPackError::Zip(format!("re-read manifest.json: {e}")))?;
    let backend_obj = value
        .pointer_mut("/extensions/terminalBackend")
        .and_then(Value::as_object_mut)
        .ok_or(MultiPlatformPackError::LibrariesWithoutBackend)?;
    backend_obj.insert(
        "libraries".to_owned(),
        Value::Object(
            detected
                .into_iter()
                .map(|(k, v)| (k, Value::String(v)))
                .collect(),
        ),
    );
    let mut out = serde_json::to_string_pretty(&value)
        .map_err(|e| PluginPackError::Zip(format!("serialize manifest.json: {e}")))?;
    out.push('\n');
    Ok(out)
}

/// Every non-directory entry of a package except `signature.json`, read with the
/// package decompression caps.
fn read_entries(package: &Path) -> Result<BTreeMap<String, Vec<u8>>, PluginPackError> {
    let mut archive = ZipArchive::new(File::open(package)?)?;
    let mut remaining = MAX_DECOMPRESSED_TOTAL_BYTES;
    let mut out = BTreeMap::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i)?;
        if entry.is_dir() || entry.name() == SIGNATURE_FILE_NAME {
            continue;
        }
        let name = entry.name().to_owned();
        let mut buf = Vec::new();
        read_entry_bounded(
            entry,
            MAX_DECOMPRESSED_ENTRY_BYTES,
            &mut remaining,
            &mut buf,
        )?;
        out.insert(name, buf);
    }
    Ok(out)
}

/// A manifest with its `terminalBackend.libraries` removed — the part of a
/// per-platform package's manifest every merge input must share.
fn manifest_without_libraries(bytes: &[u8]) -> Result<Value, PluginPackError> {
    let mut value: Value = serde_json::from_slice(bytes)
        .map_err(|e| PluginPackError::Zip(format!("read manifest.json: {e}")))?;
    if let Some(backend) = value
        .pointer_mut("/extensions/terminalBackend")
        .and_then(Value::as_object_mut)
    {
        backend.remove("libraries");
    }
    Ok(value)
}

/// One validated merge input: its manifest (minus libraries), its non-backend
/// entries, and its platform libraries.
struct MergeInput {
    path: PathBuf,
    base_manifest: Value,
    shared: BTreeMap<String, Vec<u8>>,
    /// triple → (library file name, bytes)
    libraries: BTreeMap<String, (String, Vec<u8>)>,
}

fn load_merge_input(path: &Path) -> Result<MergeInput, PluginPackError> {
    let manifest = validate_package(path)?;
    let libraries_map = manifest
        .extensions
        .terminal_backend
        .map(|b| b.libraries)
        .unwrap_or_default();
    if libraries_map.is_empty() {
        return Err(MultiPlatformPackError::LegacyMergeInput(path.to_path_buf()).into());
    }
    let mut entries = read_entries(path)?;
    let manifest_bytes = entries
        .remove(MANIFEST_FILE_NAME)
        .ok_or_else(|| PluginPackError::MissingManifest(path.to_path_buf()))?;
    let mut libraries = BTreeMap::new();
    for (triple, lib_path) in libraries_map {
        let bytes = entries.get(&lib_path).cloned().unwrap_or_default();
        let file_name = lib_path.rsplit('/').next().unwrap_or(&lib_path).to_owned();
        libraries.insert(triple, (file_name, bytes));
    }
    let backend_prefix = format!("{BACKEND_DIR}/");
    entries.retain(|name, _| !name.starts_with(&backend_prefix));
    Ok(MergeInput {
        path: path.to_path_buf(),
        base_manifest: manifest_without_libraries(&manifest_bytes)?,
        shared: entries,
        libraries,
    })
}

/// Check `input` agrees with `reference` on everything but native libraries.
fn check_same_plugin(reference: &MergeInput, input: &MergeInput) -> Result<(), PluginPackError> {
    let mismatch = |what: &str| MultiPlatformPackError::MergeInputMismatch {
        input: input.path.clone(),
        reference: reference.path.clone(),
        what: what.to_owned(),
    };
    if input.base_manifest != reference.base_manifest {
        return Err(mismatch(MANIFEST_FILE_NAME).into());
    }
    if input.shared != reference.shared {
        let what = reference
            .shared
            .keys()
            .chain(input.shared.keys())
            .find(|k| reference.shared.get(*k) != input.shared.get(*k))
            .cloned()
            .unwrap_or_default();
        return Err(mismatch(&what).into());
    }
    Ok(())
}

/// Merge per-platform packages into one multi-platform package written under
/// `output_dir`, returning its path.
///
/// Every input must be a valid package built with `--target` (a `libraries`
/// map), and all inputs must agree on the manifest (apart from `libraries`)
/// and every non-backend file. Each platform may appear once. The merged
/// package is produced by [`pack_plugin`] (so it is round-trip validated), then
/// every platform entry is re-hashed and compared with its input library.
/// Input signatures are dropped: sign the merged package afterwards.
pub fn merge_packages(inputs: &[PathBuf], output_dir: &Path) -> Result<PathBuf, PluginPackError> {
    let Some((first_path, rest)) = inputs.split_first() else {
        return Err(MultiPlatformPackError::NoMergeInputs.into());
    };
    let reference = load_merge_input(first_path)?;
    let mut libraries: BTreeMap<String, (PathBuf, String, Vec<u8>)> = BTreeMap::new();
    let mut add = |input: &MergeInput| -> Result<(), PluginPackError> {
        for (triple, (file_name, bytes)) in &input.libraries {
            if let Some((first, _, _)) = libraries.get(triple) {
                return Err(MultiPlatformPackError::DuplicatePlatform {
                    triple: triple.clone(),
                    first: first.clone(),
                    second: input.path.clone(),
                }
                .into());
            }
            libraries.insert(
                triple.clone(),
                (input.path.clone(), file_name.clone(), bytes.clone()),
            );
        }
        Ok(())
    };
    add(&reference)?;
    for path in rest {
        let input = load_merge_input(path)?;
        check_same_plugin(&reference, &input)?;
        add(&input)?;
    }

    fs::create_dir_all(output_dir)?;
    let staging = output_dir.join(format!(".merge-staging-{}", std::process::id()));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    let result = stage_and_pack(&reference, &libraries, &staging, output_dir);
    let _ = fs::remove_dir_all(&staging);
    let merged = result?;

    let expected: BTreeMap<String, String> = libraries
        .iter()
        .map(|(t, (_, _, bytes))| (t.clone(), sha256_digest(bytes)))
        .collect();
    let actual: BTreeMap<String, String> = package_platform_entries(&merged)?
        .into_iter()
        .map(|e| (e.triple, e.sha256))
        .collect();
    for (triple, digest) in &expected {
        if actual.get(triple) != Some(digest) {
            return Err(MultiPlatformPackError::MergeVerifyFailed {
                triple: triple.clone(),
            }
            .into());
        }
    }
    Ok(merged)
}

/// Lay the merged plugin out as a source tree in `staging` and pack it.
fn stage_and_pack(
    reference: &MergeInput,
    libraries: &BTreeMap<String, (PathBuf, String, Vec<u8>)>,
    staging: &Path,
    output_dir: &Path,
) -> Result<PathBuf, PluginPackError> {
    fs::create_dir_all(staging)?;
    let manifest = serde_json::to_string_pretty(&reference.base_manifest)
        .map_err(|e| PluginPackError::Zip(format!("serialize manifest.json: {e}")))?;
    fs::write(staging.join(MANIFEST_FILE_NAME), manifest)?;
    for (name, bytes) in &reference.shared {
        let dest = name
            .split('/')
            .fold(staging.to_path_buf(), |acc, part| acc.join(part));
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(dest, bytes)?;
    }
    for (triple, (_, file_name, bytes)) in libraries {
        let dir = staging.join(BACKEND_DIR).join(triple);
        fs::create_dir_all(&dir)?;
        fs::write(dir.join(file_name), bytes)?;
    }
    pack_plugin(staging, output_dir)
}

/// List a package's platform entries (target triple, path, SHA-256), sorted by
/// triple. Empty for a legacy single-platform package or one without a native
/// backend. The package is fully validated first.
pub fn package_platform_entries(package: &Path) -> Result<Vec<PlatformEntry>, PluginPackError> {
    let manifest = validate_package(package)?;
    let Some(backend) = manifest.extensions.terminal_backend else {
        return Ok(Vec::new());
    };
    if backend.libraries.is_empty() {
        return Ok(Vec::new());
    }
    let entries = read_entries(package)?;
    Ok(backend
        .libraries
        .into_iter()
        .map(|(triple, path)| {
            let sha256 = entries
                .get(&path)
                .map(|b| sha256_digest(b))
                .unwrap_or_default();
            PlatformEntry {
                triple,
                path,
                sha256,
            }
        })
        .collect())
}

#[cfg(test)]
#[path = "fat_pack_tests.rs"]
mod tests;

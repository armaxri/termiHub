//! The native plugin **host loader** (#1995).
//!
//! Where [`super::manager::PluginManager`] owns what is *installed*, this module
//! owns what is *loaded*. A native plugin's backend dynamic library
//! (`.dll` / `.so` / `.dylib`) is **never loaded into termiHub itself**
//! (ADR-19): [`PluginHost::load`] runs the trust gate, binds the exact library
//! bytes, and starts the plugin's own `termihub-plugin-runner` process, which
//! confines itself with the OS sandbox and only then opens the library with the
//! shared loader ([`termihub_plugin_runner::loader`]) — the stable-ABI entry
//! symbols of [`termihub_plugin_api`], the ABI and toolchain gates, the pinned
//! digest check. The runner-backed plugin is exposed to the rest of termiHub as
//! an ordinary [`ConnectionType`](crate::connection::ConnectionType) (see
//! [`super::connection::PluginConnectionType`]), registered into the shared
//! [`ConnectionTypeRegistry`].
//!
//! # ABI soundness
//!
//! The original plugin-system concept sketched returning
//! `*mut dyn PluginTerminalBackend` across `extern "C"`. A Rust `dyn Trait` fat
//! pointer has **no stable ABI** across separately-compiled dynamic libraries, so
//! that sketch is undefined behavior. The runner instead speaks only the
//! hand-rolled, `#[repr(C)]` opaque-handle ABI established by
//! [`termihub_plugin_api`] (#1990), and the host talks to the runner over the
//! framed IPC protocol of [`termihub_plugin_runner::ipc`].

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use termihub_plugin_api::{AbiIncompatibility, AbiVersion, ToolchainIncompatibility, ABI_1_1};
#[cfg(test)]
use termihub_plugin_api::{Toolchain, CURRENT_PLUGIN_ABI_VERSION};
#[cfg(test)]
use termihub_plugin_runner::loader;
use termihub_plugin_runner::loader::LoadError;
pub use termihub_plugin_runner::loader::{BackendLoadOptions, LoadedPluginInfo};

use crate::connection::{plugin_type_id, ConnectionFactory, ConnectionTypeRegistry};

use super::capabilities::ConnectionPolicy;
use super::connection::PluginConnectionType;
use super::host_context::{prepare_plugin_data_dir, PluginDataDirError};
use super::log_rate_limit::PluginLogLimiter;
use super::manager::InstalledPlugin;
use super::manifest::TerminalBackendExtension;
use super::native_trust::NativeTrustStore;
use super::plugin_state::{self, PluginStateRecord};
use super::sandbox::{
    default_runner_path, AutoDisableHook, PluginHealth, PluginRunnerConfig, PluginSandboxStatus,
    SandboxOutcome, SandboxedPluginHandle, RUNNER_MISSING,
};
use super::security::{PermissionError, PermissionSet, RecoveryAction, RestartTracker};
use super::signer_change::PackageSigner;
use super::trust_store::TrustStore;

/// Everything that can go wrong while loading a plugin's backend library.
#[derive(Debug, thiserror::Error)]
pub enum HostError {
    /// No file with the current platform's dynamic-library extension was found
    /// under the plugin's `backend/` directory.
    #[error("no backend library found in `{0}`")]
    LibraryNotFound(PathBuf),

    /// A multi-platform package (PLG-011) ships no native library for this
    /// host's target triple, so the plugin cannot run here.
    #[error(
        "plugin is not available for this platform ({host}); it ships native libraries for: \
         {available}"
    )]
    PlatformUnavailable {
        /// This host's Rust target triple.
        host: String,
        /// The target triples the package does carry, sorted, comma-joined.
        available: String,
    },

    /// More than one file under `backend/` matches the current platform's
    /// dynamic-library extension, so which one to load is ambiguous. A directory
    /// scan has no defined order, so silently picking one is nondeterministic and
    /// a swap vector; the package must ship exactly one library per platform.
    #[error("ambiguous backend library in `{dir}`: {names} both match `.{ext}`; ship exactly one")]
    AmbiguousLibrary {
        /// The `backend/` directory scanned.
        dir: PathBuf,
        /// The current platform's dynamic-library extension.
        ext: String,
        /// The colliding candidate file names, sorted, comma-joined.
        names: String,
    },

    /// The backend library on disk did not match the signed digest it was
    /// verified against, re-checked immediately before load — its bytes changed
    /// between verification and load (a verify-then-load TOCTOU). Refused rather
    /// than loaded.
    #[error("backend library `{path}` failed its pre-load integrity check")]
    LibraryDigestMismatch {
        /// The library path whose bytes did not match.
        path: PathBuf,
        /// The signed digest expected.
        expected: String,
        /// The digest actually computed from the on-disk file.
        actual: String,
    },

    /// The backend library changed while it was being loaded: after the load,
    /// the pinned handle no longer hashes to the verified digest, or (on
    /// path-loading platforms) the path no longer names the hashed file. The
    /// library is unloaded and refused (#2796).
    #[error("backend library `{path}` changed while it was being loaded: {detail}")]
    LibraryChangedDuringLoad {
        /// The library path.
        path: PathBuf,
        /// What changed.
        detail: String,
    },

    /// The plugin's co-located signature is valid, but its signing key is not
    /// trusted **at load** — it was revoked since install, or it is not the key
    /// the plugin was installed with (a re-signed tree) (#2796). Refused.
    #[error("native plugin `{id}` is signed by a publisher key that is not trusted: {key_id}")]
    SigningKeyNotTrusted {
        /// The plugin id.
        id: String,
        /// The signing key's `sha256:` fingerprint.
        key_id: String,
    },

    /// The extracted plugin no longer matches what the manager verified and
    /// recorded in `plugin-state.json` at install (a different signer, or a
    /// backend library whose digest differs from the install-verified one)
    /// (#2796). Reinstall the plugin to load it.
    #[error("native plugin `{id}` does not match its install record: {detail}")]
    InstallRecordMismatch {
        /// The plugin id.
        id: String,
        /// What differs.
        detail: String,
    },

    /// The extracted plugin carries a `signature.json`, but re-verifying it over
    /// the extracted files at load time failed (tampered content or a broken
    /// signature). The plugin is refused rather than loaded.
    #[error("plugin signature re-verification failed before load: {0}")]
    SignatureReverifyFailed(String),

    /// The dynamic library could not be opened (missing dependency, wrong
    /// architecture, corrupt file, …).
    #[error("failed to open plugin library `{path}`: {source}")]
    Open {
        /// The library path that failed to open.
        path: PathBuf,
        /// The underlying `libloading` error.
        source: libloading::Error,
    },

    /// A required exported symbol was missing from the library.
    #[error("plugin library is missing the required symbol `{0}`")]
    MissingSymbol(String),

    /// The library reported an ABI version this host cannot load: a different
    /// major, or a newer minor than this host's ([`CURRENT_PLUGIN_ABI_VERSION`](termihub_plugin_api::CURRENT_PLUGIN_ABI_VERSION)).
    /// The message names both versions and the fix.
    #[error("{0}")]
    IncompatibleAbi(AbiIncompatibility),

    /// The plugin's manifest `apiVersion` does not mirror the ABI version its
    /// backend library actually reports. The library is the authoritative
    /// number (PLG-002); a package whose two disagree is inconsistent (typically
    /// a stale manifest or a library rebuilt against another SDK) and is refused
    /// rather than loaded under a version it does not declare.
    #[error(
        "plugin manifest declares apiVersion `{manifest}` but its backend library was built \
         for ABI {library}; repackage the plugin so the two match"
    )]
    ManifestAbiMismatch {
        /// The manifest's declared `apiVersion`, verbatim.
        manifest: String,
        /// The ABI version the library reported.
        library: AbiVersion,
    },

    /// The library's `termihub_plugin_abi_version` and the `api_version` in the
    /// `PluginInfo` it filled in disagree — the plugin was assembled from
    /// mismatched parts. Refused.
    #[error(
        "plugin library reports ABI {symbol} from termihub_plugin_abi_version but ABI {info} \
         in its plugin info; rebuild the plugin"
    )]
    InconsistentAbi {
        /// The version `termihub_plugin_abi_version` returned.
        symbol: AbiVersion,
        /// The version reported in `PluginInfo::api_version`.
        info: AbiVersion,
    },

    /// The plugin's `plugin_init` entry point reported a failure.
    #[error("plugin initialization failed: {0}")]
    Init(String),

    /// The plugin reports a build toolchain (ABI 1.1+) that does not match this
    /// host's exactly — a different rustc or panic strategy — or reports none
    /// despite claiming an ABI that records it (PLG-013, ADR-15). Refused: the
    /// host's panic containment and FFI assumptions are only validated for its
    /// own toolchain. The message names both toolchains.
    #[error("{0}")]
    IncompatibleToolchain(ToolchainIncompatibility),

    /// The plugin was built for ABI 1.0, which predates the toolchain record,
    /// so its build toolchain cannot be verified, and the user has not
    /// explicitly accepted that for this exact library (PLG-013, ADR-15).
    /// Refused (fail closed).
    #[error(
        "plugin was built for ABI {abi}, which does not record its build toolchain, so termiHub \
         cannot verify it was built with a compatible compiler; rebuild it for ABI 1.1 or later, \
         or trust it again and explicitly accept the unverified toolchain"
    )]
    UnverifiedToolchain {
        /// The ABI version the plugin reported.
        abi: AbiVersion,
    },

    /// The plugin's private data directory could not be prepared (ABI 1.1 host
    /// context, PLG-014).
    #[error("{0}")]
    DataDir(#[from] PluginDataDirError),

    /// The plugin's declared permissions are inconsistent with what it provides
    /// (e.g. a terminal backend without the `terminal` permission), so it is
    /// refused rather than loaded with a capability it never requested.
    #[error("plugin permission check failed: {0}")]
    Permission(#[from] PermissionError),

    /// A plugin entry point unwound (panicked) across the FFI boundary. The host
    /// contains the unwind and refuses the plugin rather than letting it abort
    /// the process.
    #[error("plugin panicked during `{0}`")]
    Panicked(&'static str),

    /// Native plugins are globally disabled, so no native backend is
    /// loaded regardless of any per-plugin acknowledgment (SEC-002 / PLG-006 /
    /// ARCH-008). The default state; the user must explicitly enable native
    /// plugins first. Fail-closed: this is checked before the library is even
    /// located.
    #[error("native plugins are disabled; enable native plugins and trust this plugin to load it")]
    NativePluginsDisabled,

    /// Native plugins are enabled globally, but *this* plugin has no valid trust
    /// acknowledgment for the exact library on disk — it was never acknowledged,
    /// or its library changed since it was (a stale acknowledgment / hash
    /// mismatch). Refused rather than loaded (SEC-002 / PLG-006 / ARCH-008).
    #[error("native plugin `{id}` is not trusted for its current library; acknowledge it to load")]
    NativePluginNotTrusted {
        /// The plugin id that lacks a valid acknowledgment.
        id: String,
    },

    /// The backend library could not be hashed to check its trust acknowledgment.
    /// Fail-closed: an unreadable library is refused rather than loaded.
    #[error("failed to hash native plugin library `{path}` for the trust check: {detail}")]
    NativeLibraryUnreadable {
        /// The library path that could not be hashed.
        path: PathBuf,
        /// The underlying I/O error rendered as a string.
        detail: String,
    },

    /// The out-of-process plugin runner (#4182) could not be started: the
    /// sidecar binary is missing, tampered with or not executable, or its
    /// channel could not be set up.
    #[error("plugin runner `{path}` could not be started: {detail}")]
    RunnerUnavailable {
        /// The runner binary the host tried to start.
        path: PathBuf,
        /// Why it could not be started.
        detail: String,
    },

    /// The plugin runner violated the IPC protocol, stopped responding during
    /// the handshake, or exited before reporting a result. It was killed.
    #[error("plugin runner failed: {0}")]
    RunnerProtocol(String),

    /// The plugin runner could not confine itself with the OS sandbox (#4186):
    /// the sandbox API failed, or a layer this platform requires was not
    /// enforced. The plugin was never loaded and the runner was stopped; there
    /// is no fallback to running it unconfined.
    #[error("the plugin sandbox could not be set up: {0}")]
    SandboxSetupFailed(String),

    /// This system cannot apply every OS sandbox layer to the plugin (reduced
    /// isolation, e.g. Linux without landlock), and the user has not accepted
    /// that for this exact library (`reducedIsolationAccepted`, #4188). The
    /// plugin was never loaded; it loads once the hash-bound acknowledgement
    /// records the acceptance.
    #[error(
        "isolation unavailable on this system (missing: {}); the plugin loads only after \
         you accept reduced isolation",
        missing.join(", ")
    )]
    ReducedIsolationNotAccepted {
        /// The sandbox layers the runner could not enforce.
        missing: Vec<String>,
    },

    /// The plugin runner refused or failed to load the plugin library. The
    /// message is the runner-side loader's, verbatim; `incompatible` keeps the
    /// ABI/toolchain-vs-load-error distinction the management layer relies on.
    #[error("{message}")]
    RunnerLoad {
        /// Whether the runner reported a version incompatibility.
        incompatible: bool,
        /// The loader's message.
        message: String,
    },
}

impl From<LoadError> for HostError {
    /// Map a shared-loader failure onto the host's error, variant for variant
    /// (same message), so moving the loader (#4182) changed no error the user
    /// or the management layer sees.
    fn from(err: LoadError) -> Self {
        match err {
            LoadError::LibraryDigestMismatch {
                path,
                expected,
                actual,
            } => HostError::LibraryDigestMismatch {
                path,
                expected,
                actual,
            },
            LoadError::LibraryChangedDuringLoad { path, detail } => {
                HostError::LibraryChangedDuringLoad { path, detail }
            }
            LoadError::Open { path, source } => HostError::Open { path, source },
            LoadError::MissingSymbol(name) => HostError::MissingSymbol(name),
            LoadError::IncompatibleAbi(detail) => HostError::IncompatibleAbi(detail),
            LoadError::ManifestAbiMismatch { manifest, library } => {
                HostError::ManifestAbiMismatch { manifest, library }
            }
            LoadError::InconsistentAbi { symbol, info } => {
                HostError::InconsistentAbi { symbol, info }
            }
            LoadError::Init(detail) => HostError::Init(detail),
            LoadError::IncompatibleToolchain(detail) => HostError::IncompatibleToolchain(detail),
            LoadError::UnverifiedToolchain { abi } => HostError::UnverifiedToolchain { abi },
            LoadError::Panicked(entry) => HostError::Panicked(entry),
        }
    }
}

impl HostError {
    /// Whether this failure is specifically an ABI/version incompatibility (or a
    /// multi-platform package lacking this host's platform, PLG-011), as
    /// opposed to a load or initialization error. The management layer maps the
    /// two to different plugin states.
    #[must_use]
    pub fn is_incompatible(&self) -> bool {
        matches!(
            self,
            HostError::IncompatibleAbi(_)
                | HostError::IncompatibleToolchain(_)
                | HostError::PlatformUnavailable { .. }
                | HostError::RunnerLoad {
                    incompatible: true,
                    ..
                }
        )
    }
}

/// Locate the backend dynamic library inside a plugin directory.
///
/// Looks in `<plugin_dir>/backend/` for the file whose extension matches the
/// current platform's dynamic-library extension
/// ([`std::env::consts::DLL_EXTENSION`] — `dll` / `so` / `dylib`). A package may
/// ship all three; this picks the one this OS can load.
///
/// Selection is **deterministic** and **ambiguity-rejecting** (CORE-034): a
/// `read_dir` scan has no defined order, so returning the *first* match made
/// which library loaded unpredictable when more than one matched — both a
/// reproducibility problem and a swap vector. Candidates are collected and
/// sorted; exactly one match is returned, and two-or-more matches for the same
/// platform extension are refused as [`HostError::AmbiguousLibrary`] rather than
/// guessed.
pub fn find_backend_library(plugin_dir: &Path) -> Result<PathBuf, HostError> {
    let backend_dir = plugin_dir.join("backend");
    let ext = std::env::consts::DLL_EXTENSION;
    let entries = std::fs::read_dir(&backend_dir)
        .map_err(|_| HostError::LibraryNotFound(backend_dir.clone()))?;
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some(ext))
        .collect();
    // Deterministic order regardless of the filesystem's scan order.
    candidates.sort();
    if candidates.len() > 1 {
        let names = candidates
            .iter()
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(HostError::AmbiguousLibrary {
            dir: backend_dir,
            ext: ext.to_owned(),
            names,
        });
    }
    candidates
        .into_iter()
        .next()
        .ok_or(HostError::LibraryNotFound(backend_dir))
}

/// Select the backend library an installed plugin must load **on this host**
/// (PLG-011), honouring a multi-platform package's manifest mapping.
///
/// * When the terminal backend declares a `libraries` map, the entry for
///   [`host_target_triple`](super::platform::host_target_triple) is the one and
///   only candidate; a map without that triple is
///   [`HostError::PlatformUnavailable`], and a mapped file missing on disk is
///   [`HostError::LibraryNotFound`]. Other platforms' libraries are never
///   considered, so the trust hash and signed digest bind to exactly this file.
/// * Without a map (a legacy single-platform package) this is
///   [`find_backend_library`]: the one file in `backend/` with this OS's
///   dynamic-library extension.
///
/// The manifest's map is validated at install ([`super::PluginManifest::validate`])
/// to hold only safe relative paths under `backend/`; the join is re-checked here
/// anyway so a hand-edited manifest cannot point the loader outside the plugin.
pub fn select_backend_library(
    plugin_dir: &Path,
    backend: &TerminalBackendExtension,
) -> Result<PathBuf, HostError> {
    if backend.libraries.is_empty() {
        return find_backend_library(plugin_dir);
    }
    let host = super::platform::host_target_triple();
    let Some(rel) = backend.libraries.get(host) else {
        return Err(HostError::PlatformUnavailable {
            host: host.to_owned(),
            available: backend
                .libraries
                .keys()
                .cloned()
                .collect::<Vec<_>>()
                .join(", "),
        });
    };
    if !super::platform::is_valid_library_path(rel) {
        return Err(HostError::LibraryNotFound(plugin_dir.join(rel)));
    }
    let path = rel
        .split('/')
        .fold(plugin_dir.to_path_buf(), |acc, part| acc.join(part));
    if path.is_file() {
        Ok(path)
    } else {
        Err(HostError::LibraryNotFound(path))
    }
}

/// Enforce the toolchain rule (see [`loader::check_library_toolchain`]).
#[cfg(test)]
fn check_library_toolchain(
    info: &LoadedPluginInfo,
    host: &Toolchain,
    accept_unverified_toolchain: bool,
) -> Result<(), HostError> {
    Ok(loader::check_library_toolchain(
        info,
        host,
        accept_unverified_toolchain,
    )?)
}

/// Apply the ABI gate (see [`loader::check_library_abi`]).
#[cfg(test)]
fn check_library_abi(
    found: AbiVersion,
    host: AbiVersion,
    manifest_api_version: Option<&str>,
) -> Result<(), HostError> {
    Ok(loader::check_library_abi(
        found,
        host,
        manifest_api_version,
    )?)
}

/// The co-located signature's verdict on a backend library: who signed the
/// extracted tree and the digest it signed for the library.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SignedBackend {
    /// The signing key's `sha256:` fingerprint.
    key_id: String,
    /// The signed `sha256:` digest of the backend library.
    digest: String,
}

/// Re-verify the *extracted* plugin against its co-located `signature.json`
/// (CORE-034) and return who signed it and the signed digest of the library.
///
/// Returns `Ok(None)` when the plugin is unsigned (no `signature.json`). For a
/// signed plugin it recomputes the digest of every extracted file and re-runs
/// the full Ed25519 verification over that map, so a tampered file, an altered
/// digest map, or a broken signature is caught.
///
/// On its own this only proves the tree is internally consistent with *some*
/// valid signature — a re-signed tree passes. [`resolve_load_binding`] is what
/// anchors it: to the trust store and to the install record (#2796).
fn signed_backend_digest(
    plugin_dir: &Path,
    lib_path: &Path,
) -> Result<Option<SignedBackend>, HostError> {
    let sig_path = plugin_dir.join(super::signature::SIGNATURE_FILE_NAME);
    let raw = match std::fs::read(&sig_path) {
        Ok(bytes) => bytes,
        // No signature entry → unsigned plugin, nothing to bind.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(HostError::SignatureReverifyFailed(e.to_string())),
    };
    let sig: super::signature::PackageSignature = serde_json::from_slice(&raw)
        .map_err(|e| HostError::SignatureReverifyFailed(e.to_string()))?;

    let actual = digest_extracted_dir(plugin_dir)?;
    super::signature::verify(&sig, &actual)
        .map_err(|e| HostError::SignatureReverifyFailed(e.to_string()))?;

    let rel = lib_path
        .strip_prefix(plugin_dir)
        .map_err(|e| HostError::SignatureReverifyFailed(e.to_string()))?;
    let key = rel_to_slash(rel);
    let digest = sig.files.get(&key).cloned().ok_or_else(|| {
        HostError::SignatureReverifyFailed(format!(
            "backend library `{key}` is not covered by the signature"
        ))
    })?;
    Ok(Some(SignedBackend {
        key_id: sig.key_id,
        digest,
    }))
}

/// Decide the digest a backend library must match at load, anchoring the
/// co-located signature to the trust store and to the install record (#2796).
///
/// * **Trust anchor.** A signed plugin's key must be trusted *now*
///   (`is_trusted`). The one exception is an "install once" plugin — installed
///   signed by a key the user chose not to pin, recorded as
///   `signer_trusted: false` — which loads only while it is still signed by that
///   same recorded key. A key revoked since install, a re-sign by any other
///   untrusted key, or a legacy record that cannot say how the key was trusted
///   is refused with [`HostError::SigningKeyNotTrusted`].
/// * **Signer binding.** When the install recorded a signer, the tree must still
///   carry exactly that signer (no stripped, added or changed signature).
/// * **Digest binding.** When the install recorded a verified backend, the
///   selected library must be that same file and the signature (if any) must
///   sign the recorded digest; the recorded digest is what the loader then
///   re-checks. Without a record (pre-#2796 installs) the signed digest is used.
///
/// The trust store and `plugin-state.json` live beside, not inside, the plugin
/// directory. They are written only by the manager, but they are ordinary
/// app-data files: with no bundled first-party key yet, the anchor is
/// trust-on-first-use, not immutable (see `trust_store::BUNDLED_PUBLISHERS`).
fn resolve_load_binding(
    id: &str,
    lib_rel: &str,
    signed: Option<&SignedBackend>,
    record: Option<&PluginStateRecord>,
    is_trusted: impl Fn(&str) -> bool,
) -> Result<Option<String>, HostError> {
    let verified = record.and_then(|r| r.verified_backend.as_ref());
    let recorded_signer = record.and_then(|r| r.signer.as_ref());
    let mismatch = |detail: String| HostError::InstallRecordMismatch {
        id: id.to_owned(),
        detail,
    };

    if let Some(signed) = signed {
        let install_once_same_key = verified.is_some_and(|v| !v.signer_trusted)
            && recorded_signer.and_then(PackageSigner::key_id) == Some(signed.key_id.as_str());
        if !is_trusted(&signed.key_id) && !install_once_same_key {
            return Err(HostError::SigningKeyNotTrusted {
                id: id.to_owned(),
                key_id: signed.key_id.clone(),
            });
        }
    }

    if let Some(recorded) = recorded_signer {
        let current = signed.map(|s| s.key_id.as_str());
        if recorded.key_id() != current {
            return Err(mismatch(format!(
                "installed signer {}, now {}",
                recorded.key_id().unwrap_or("unsigned"),
                current.unwrap_or("unsigned")
            )));
        }
    }

    let Some(verified) = verified else {
        return Ok(signed.map(|s| s.digest.clone()));
    };
    if verified.library != lib_rel {
        return Err(mismatch(format!(
            "installed backend `{}`, now `{lib_rel}`",
            verified.library
        )));
    }
    if let Some(signed) = signed {
        if signed.digest != verified.sha256 {
            return Err(mismatch(format!(
                "backend `{lib_rel}` was installed as {}, now signed as {}",
                verified.sha256, signed.digest
            )));
        }
    }
    Ok(Some(verified.sha256.clone()))
}

/// Recursively digest every file under `plugin_dir` except the signature entry,
/// keyed by its `/`-joined path relative to `plugin_dir` — the exact key shape
/// the signed `files` map uses — so the result can be fed to
/// [`super::signature::verify`].
fn digest_extracted_dir(plugin_dir: &Path) -> Result<BTreeMap<String, String>, HostError> {
    let mut out = BTreeMap::new();
    let mut stack = vec![plugin_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| HostError::SignatureReverifyFailed(e.to_string()))?;
        for entry in entries {
            let entry = entry.map_err(|e| HostError::SignatureReverifyFailed(e.to_string()))?;
            let file_type = entry
                .file_type()
                .map_err(|e| HostError::SignatureReverifyFailed(e.to_string()))?;
            let path = entry.path();
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            let rel = path
                .strip_prefix(plugin_dir)
                .map_err(|e| HostError::SignatureReverifyFailed(e.to_string()))?;
            let key = rel_to_slash(rel);
            // The signature entry itself is not part of the signed set.
            if key == super::signature::SIGNATURE_FILE_NAME {
                continue;
            }
            let digest = super::signature::sha256_file(&path)
                .map_err(|e| HostError::SignatureReverifyFailed(e.to_string()))?;
            out.insert(key, digest);
        }
    }
    Ok(out)
}

/// Join a relative path's normal components with `/`, matching the archive-entry
/// key form used by the signature's `files` map (which always uses `/`).
pub(super) fn rel_to_slash(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Register a plugin's terminal backend into `registry` under its **stable,
/// namespaced** type id and return that id (PLG-007).
///
/// The id is `plugin:<plugin-id>:<connectionType>` — a pure function of the
/// plugin's own manifest, never of load order or of what else is registered.
/// Two plugins declaring the same `connectionType` therefore get distinct ids,
/// and a plugin can neither shadow nor be demoted by a built-in (built-in ids
/// never carry the `plugin:` prefix). A saved connection that references the id
/// keeps resolving to the same plugin across launches.
///
/// The display name is cosmetic (never persisted): when it matches a type that
/// is already registered, the plugin's name is appended so the selector shows
/// distinct labels.
///
/// `factory_for(type_id, display_name)` builds the registry factory, so the
/// registration itself is testable without a native library.
fn register_backend_type(
    registry: &mut ConnectionTypeRegistry,
    plugin_id: &str,
    plugin_name: &str,
    backend: &TerminalBackendExtension,
    factory_for: impl FnOnce(String, String) -> ConnectionFactory,
) -> String {
    let type_id = plugin_type_id(plugin_id, &backend.connection_type);
    let label_taken = registry
        .available_types()
        .iter()
        .any(|t| t.type_id != type_id && t.display_name == backend.display_name);
    let display_name = if label_taken {
        format!("{} ({plugin_name})", backend.display_name)
    } else {
        backend.display_name.clone()
    };
    let factory = factory_for(type_id.clone(), display_name.clone());
    registry.register(&type_id, &display_name, PLUGIN_TYPE_ICON, factory);
    type_id
}

/// The registry icon every plugin-provided connection type carries. The
/// frontend partitions the type list on it (`PLUGIN_CONNECTION_TYPE_ICON`).
const PLUGIN_TYPE_ICON: &str = "puzzle";

/// A record of one loaded plugin: the connection type it registered and the
/// runner serving it.
struct HostEntry {
    connection_type: String,
    /// Held to keep the runner reachable for the plugin's lifetime, and to stop
    /// it (and every session) on unload.
    handle: Arc<SandboxedPluginHandle>,
}

/// The result of driving [`PluginHost::note_failure`]: what the host decided to
/// do with a plugin after a runtime failure, following the concept's recovery
/// policy (auto-restart up to [`MAX_RESTART_ATTEMPTS`], then auto-disable).
///
/// [`MAX_RESTART_ATTEMPTS`]: super::security::MAX_RESTART_ATTEMPTS
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryOutcome {
    /// The plugin should be reloaded; the restart budget is not yet exhausted.
    /// The caller re-enables the plugin (or the host reloads it) to retry.
    Restart,
    /// The restart budget is exhausted; the host has unloaded the plugin and it
    /// should be persisted as disabled and surfaced to the user.
    Disabled,
}

/// The runtime plugin host: loads backend libraries and registers the resulting
/// connection types into a shared [`ConnectionTypeRegistry`].
///
/// This is the object a [`super::PluginLifecycleHook`] drives — enabling a
/// plugin [`load`](PluginHost::load)s it, disabling/uninstalling it
/// [`unload`](PluginHost::unload)s it. The `<app-data>/plugins/` root is used to
/// find each plugin's directory by id.
pub struct PluginHost {
    root: PathBuf,
    registry: Arc<Mutex<ConnectionTypeRegistry>>,
    loaded: Mutex<HashMap<String, HostEntry>>,
    /// Ids the host has successfully activated, so the management layer can
    /// promote them to [`PluginState::Active`](super::PluginState). This is a
    /// superset of [`loaded`](Self::loaded): a **frontend-only** plugin (theme /
    /// JS parser / widget, no `terminalBackend` library) is active once its
    /// [`load`](Self::load) succeeds even though it registers no connection type,
    /// so it is tracked here but not in `loaded`.
    active: Mutex<HashSet<String>>,
    /// Per-plugin error-recovery counters (concept "Error recovery state
    /// machine"). Keyed by plugin id; created lazily on first failure.
    recovery: Mutex<HashMap<String, RestartTracker>>,
    /// The application version handed to ABI 1.1 plugins in their host
    /// context (PLG-014). Defaults to this crate's version; the desktop sets the
    /// app's own via [`with_host_version`](Self::with_host_version).
    host_version: String,
    /// How native plugins are run: every one in its own sandboxed
    /// `termihub-plugin-runner` process (#4182, ADR-19). `None` only when the
    /// runner's location cannot be determined at all, in which case every
    /// native plugin is refused with [`RUNNER_MISSING`]; there is no
    /// in-process fallback.
    runner: Option<PluginRunnerConfig>,
    /// Why the last out-of-process load of a plugin was refused before it
    /// loaded (reduced isolation not accepted, sandbox setup failed, runner
    /// missing), for the Settings row (#4188). Cleared on the next load or
    /// unload of that plugin.
    sandbox_refusals: Mutex<HashMap<String, SandboxOutcome>>,
}

impl PluginHost {
    /// Create a host rooted at `plugins_root` that registers loaded plugin
    /// connection types into `registry`.
    pub fn new(
        plugins_root: impl Into<PathBuf>,
        registry: Arc<Mutex<ConnectionTypeRegistry>>,
    ) -> Self {
        Self {
            root: plugins_root.into(),
            registry,
            loaded: Mutex::new(HashMap::new()),
            active: Mutex::new(HashSet::new()),
            recovery: Mutex::new(HashMap::new()),
            host_version: env!("CARGO_PKG_VERSION").to_owned(),
            runner: default_runner_path().map(PluginRunnerConfig::new),
            sandbox_refusals: Mutex::new(HashMap::new()),
        }
    }

    /// Run native plugin backends with `runner` instead of the default
    /// configuration ([`PluginRunnerConfig::new`] on
    /// [`default_runner_path`](super::sandbox::default_runner_path)): a
    /// different runner binary (debug builds, tests) or different limits.
    #[must_use]
    pub fn with_runner(mut self, runner: PluginRunnerConfig) -> Self {
        self.runner = Some(runner);
        self
    }

    /// The runner serving plugin `id`, when it is loaded.
    #[must_use]
    pub fn sandboxed_plugin(&self, id: &str) -> Option<Arc<SandboxedPluginHandle>> {
        self.loaded
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|entry| Arc::clone(&entry.handle))
    }

    /// Set the application version reported to plugins in their ABI 1.1 host
    /// context (PLG-014).
    #[must_use]
    pub fn with_host_version(mut self, version: impl Into<String>) -> Self {
        self.host_version = version.into();
        self
    }

    /// The shared connection-type registry this host feeds.
    #[must_use]
    pub fn registry(&self) -> &Arc<Mutex<ConnectionTypeRegistry>> {
        &self.registry
    }

    /// Whether a plugin id currently has a loaded **backend library**. A
    /// frontend-only plugin (no `terminalBackend`) is never "loaded" in this
    /// sense even when active — use [`is_active`](Self::is_active) for the
    /// activation state the management layer promotes on.
    #[must_use]
    pub fn is_loaded(&self, id: &str) -> bool {
        let loaded = self
            .loaded
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(id);
        loaded && !self.is_auto_disabled(id)
    }

    /// Whether a plugin id is currently **active** — its [`load`](Self::load)
    /// succeeded and it has not since been unloaded. Unlike
    /// [`is_loaded`](Self::is_loaded) this is `true` for a frontend-only plugin
    /// (theme / JS, no backend library) too. The management layer queries this
    /// to promote an enabled, compatible plugin to
    /// [`PluginState::Active`](super::PluginState).
    #[must_use]
    pub fn is_active(&self, id: &str) -> bool {
        let active = self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(id);
        // An auto-disabled plugin (#4184) is no longer active.
        active && !self.is_auto_disabled(id)
    }

    /// Load a plugin's backend and register its connection type.
    ///
    /// A plugin that declares **no** `terminalBackend` extension has no native
    /// library to load, so this is a no-op success (its themes/JS are handled by
    /// other loaders). If a backend *is* declared, the library is opened,
    /// ABI-checked, and its connection type registered. Re-loading an
    /// already-loaded id unloads the previous instance first.
    ///
    /// The [`HostError`] is returned for the caller to map to a plugin state; an
    /// [`HostError::is_incompatible`] failure is a version problem, everything
    /// else is a load error.
    pub fn load(&self, plugin: &InstalledPlugin) -> Result<(), HostError> {
        // Enforce the permission model before any library is opened: a plugin
        // whose declared extensions need a capability it did not request (e.g. a
        // terminal backend without the `terminal` permission, or `filesystem`
        // without declared paths) is refused. This surfaces as
        // `PluginState::Error` — graceful degradation, not a crash.
        let permissions = PermissionSet::from_manifest(&plugin.manifest);
        permissions.check_consistency(&plugin.manifest.extensions)?;

        let Some(backend) = plugin.manifest.extensions.terminal_backend.as_ref() else {
            // Frontend-only plugin (theme / JS parser / widget): there is no
            // native library to open, but activation still succeeded — the
            // frontend loaders pick it up once its state is `Active`. Record it
            // as active so the management layer promotes it (#2234).
            self.active
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(plugin.manifest.id.clone());
            return Ok(());
        };

        let id = plugin.manifest.id.clone();
        // Replace any prior load of the same id. Done before the trust gate so a
        // re-evaluation with native plugins now disabled (or trust revoked) tears
        // a currently-loaded native plugin down rather than leaving it live.
        self.unload(&id);

        // --- Native-plugin trust gate (SEC-002 / PLG-006 / ARCH-008). ---
        //
        // A native backend is third-party native code. Even though it runs in its
        // own sandboxed runner process (ADR-19), it loads only when the user has
        // (a) enabled native plugins globally AND (b) acknowledged trust for
        // THIS plugin bound to THIS library's content hash. Every branch fails
        // closed: any uncertainty refuses the load. The store load is infallible
        // and itself fails closed on a missing/corrupt file.
        let trust = NativeTrustStore::load(&self.root);
        if !trust.is_native_enabled() {
            return Err(HostError::NativePluginsDisabled);
        }

        let plugin_dir = self.root.join(&id);
        // A multi-platform package resolves to THIS host's entry only (PLG-011);
        // the trust hash and signed digest below bind to that selected file.
        let lib_path = select_backend_library(&plugin_dir, backend)?;

        // Bind consent to the exact bytes: hash the library on disk and require an
        // acknowledgment matching that hash. A missing ack or a changed binary
        // (stale ack / hash mismatch) refuses the load.
        let library_sha256 = super::signature::sha256_file(&lib_path).map_err(|source| {
            HostError::NativeLibraryUnreadable {
                path: lib_path.clone(),
                detail: source.to_string(),
            }
        })?;
        if !trust.is_acknowledged(&id, &library_sha256) {
            return Err(HostError::NativePluginNotTrusted { id });
        }
        // An ABI 1.0 plugin cannot prove its build toolchain; the loader refuses
        // it unless this same hash-bound acknowledgment records the user's
        // explicit acceptance of that (PLG-013, ADR-15). Never relaxes the
        // exact-match check for a plugin that does report its toolchain.
        let accept_unverified_toolchain = trust.accepts_unverified_toolchain(&id, &library_sha256);
        // Reduced sandbox isolation loads only with the same hash-bound
        // acknowledgement's explicit `reducedIsolationAccepted` (#4188); the
        // runner and the host both refuse it otherwise.
        let accept_reduced_isolation = trust.accepts_reduced_isolation(&id, &library_sha256);

        // Bind the exact library bytes about to be loaded (CORE-034, #2796):
        // re-verify the extracted plugin against its co-located signature, anchor
        // that signature to the trust store and the install record persisted in
        // `plugin-state.json`, and have the runner re-check the library through
        // a pinned handle across its `dlopen`. A legacy unsigned plugin with no install record
        // yields `None` — nothing to bind — as before.
        let expected_digest = self.load_binding(&id, &plugin_dir, &lib_path)?;
        let options = BackendLoadOptions {
            expected_digest: expected_digest.as_deref(),
            manifest_api_version: Some(&plugin.manifest.api_version),
            accept_unverified_toolchain,
        };
        // There is no in-process fallback (ADR-19): without a runner the
        // plugin is refused, exactly like a missing bundled runner.
        let handle = match &self.runner {
            Some(config) => {
                self.start_runner(config, &id, &lib_path, &options, accept_reduced_isolation)
            }
            None => Err(HostError::RunnerUnavailable {
                path: PathBuf::from(super::sandbox::RUNNER_BIN_NAME),
                detail: RUNNER_MISSING.to_owned(),
            }),
        }
        .inspect_err(|e| self.record_refusal(&id, e))?;

        // ABI 1.1 host context (PLG-014): a private, host-created data directory
        // handed to every session (the runner supplies the app version and
        // plugin-wide cancellation). Only for a plugin that can read it — a 1.0
        // plugin gets no directory and exactly the 1.0 call.
        if handle.info().abi_version.supports(ABI_1_1) {
            handle.set_data_dir(prepare_plugin_data_dir(&self.root, &id)?);
        }

        // Translate the plugin's declared `configSchema` into the form schema the
        // dynamic connection editor renders (#1999). Derived once here and cloned
        // into every instance the factory produces.
        let settings_schema =
            super::connection::config_schema_to_settings_schema(&backend.config_schema);

        let handle_for_factory = Arc::clone(&handle);
        let schema_for_factory = settings_schema;
        // Each session created for this plugin carries its own permission scope,
        // so a host-mediated capability (filesystem path resolution, network, …)
        // can enforce it per session.
        let perms_for_factory = permissions.clone();
        // Resolve the session connection policy (concurrency ceiling + connect
        // timeout) from the manifest once at load time; every session gets it
        // (#2028).
        let policy_for_factory =
            ConnectionPolicy::from_manifest(plugin.manifest.connection_policy.as_ref());
        // Resolve the plugin-level settings once at load time: the manifest
        // `settings` defaults overlaid with the user's stored overrides. Every
        // session delivers them to the backend so a declared setting (e.g.
        // `defaultNamespace`) takes effect (PLG-008). A plugin that declares no
        // settings and has none stored resolves to `"{}"`, leaving old plugin
        // sessions unchanged.
        let settings_for_factory =
            super::manager::resolve_plugin_settings_json(&self.root, &plugin.manifest);

        // Register under the stable namespaced id `plugin:<id>:<connectionType>`
        // (PLG-007) — never a load-order-dependent disambiguation.
        let connection_type = {
            let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
            register_backend_type(
                &mut registry,
                &id,
                &plugin.manifest.name,
                backend,
                move |ct_for_factory, dn_for_factory| {
                    Box::new(move || {
                        Box::new(
                            PluginConnectionType::new(
                                Arc::clone(&handle_for_factory),
                                ct_for_factory.clone(),
                                dn_for_factory.clone(),
                                schema_for_factory.clone(),
                                perms_for_factory.clone(),
                            )
                            .with_connection_policy(policy_for_factory)
                            .with_plugin_settings(settings_for_factory.clone()),
                        )
                    })
                },
            )
        };

        handle.on_auto_disable(self.auto_disable_hook(&id, &connection_type));
        self.loaded
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id,
                HostEntry {
                    connection_type,
                    handle,
                },
            );
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(plugin.manifest.id.clone());
        // A clean (re)load means the plugin is healthy again: reset any prior
        // recovery counter so a future, unrelated failure gets a full budget.
        self.clear_recovery(&plugin.manifest.id);
        Ok(())
    }

    /// What happens when a plugin spends its crash budget
    /// (#4184): its connection type is unregistered (as on disable) and the
    /// plugin is persisted as disabled with the reason, so it stays off across
    /// restarts until the user re-enables it.
    fn auto_disable_hook(&self, id: &str, connection_type: &str) -> AutoDisableHook {
        let registry = Arc::clone(&self.registry);
        let root = self.root.clone();
        let id = id.to_owned();
        let connection_type = connection_type.to_owned();
        Box::new(move |reason: &str| {
            registry
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .unregister(&connection_type);
            if let Err(e) = plugin_state::record_auto_disable(&root, &id, reason) {
                tracing::warn!(
                    target: super::PLUGIN_LOG_TARGET,
                    "[{id}] could not persist the auto-disable: {e}"
                );
            }
        })
    }

    /// Remember why the load of `id` was refused, when the
    /// Settings row explains that refusal (#4188).
    fn record_refusal(&self, id: &str, error: &HostError) {
        if let Some(outcome) = SandboxOutcome::from_error(error) {
            self.sandbox_refusals
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.to_owned(), outcome);
        }
    }

    /// The sandbox status of native plugin `id` for the Settings row (#4188):
    /// its isolation, runner process state and recent bridge denials while it
    /// is loaded, or why its last load was refused in the sandbox setup.
    /// `None` for a plugin that is neither loaded nor so refused.
    #[must_use]
    pub fn sandbox_status(&self, id: &str) -> Option<PluginSandboxStatus> {
        if let Some(handle) = self.sandboxed_plugin(id) {
            return Some(PluginSandboxStatus::loaded(&handle));
        }
        self.sandbox_refusals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(PluginSandboxStatus::refused)
    }

    /// [`sandbox_status`](Self::sandbox_status) of every plugin that has one —
    /// loaded, or refused before it loaded — sorted by id.
    #[must_use]
    pub fn sandbox_statuses(&self) -> Vec<(String, PluginSandboxStatus)> {
        let mut ids: Vec<String> = self
            .loaded
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        ids.extend(
            self.sandbox_refusals
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .keys()
                .cloned(),
        );
        ids.sort();
        ids.dedup();
        ids.into_iter()
            .filter_map(|id| self.sandbox_status(&id).map(|status| (id, status)))
            .collect()
    }

    /// The health of plugin `id` (crash count, last exit, auto-disable
    /// reason), when it is loaded.
    #[must_use]
    pub fn plugin_health(&self, id: &str) -> Option<PluginHealth> {
        self.sandboxed_plugin(id).map(|handle| handle.health())
    }

    /// Whether plugin `id` spent its crash budget.
    fn is_auto_disabled(&self, id: &str) -> bool {
        self.sandboxed_plugin(id)
            .is_some_and(|handle| handle.auto_disabled().is_some())
    }

    /// Start plugin `id`'s runner and run the load sequence in it. The runner
    /// receives the digest binding, manifest mirror and toolchain acceptance
    /// the host resolved for this library.
    fn start_runner(
        &self,
        config: &PluginRunnerConfig,
        id: &str,
        lib_path: &Path,
        options: &BackendLoadOptions<'_>,
        accept_reduced_isolation: bool,
    ) -> Result<Arc<SandboxedPluginHandle>, HostError> {
        let library_path = lib_path
            .to_str()
            .ok_or_else(|| {
                HostError::RunnerProtocol(format!(
                    "plugin library path `{}` is not valid UTF-8",
                    lib_path.display()
                ))
            })?
            .to_owned();
        // The OS sandbox policy (#4186): install folder read-only, data folder
        // read/write, the user's home denied. Built from the host's own paths,
        // never from the manifest.
        let sandbox = if let Some(policy) = &config.sandbox_policy_override {
            Some(policy.clone())
        } else if config.os_sandbox {
            // Linux landlock can only grant a folder that exists when the
            // sandbox is applied, so the data folder of a plugin whose
            // manifest declares ABI 1.1 is created now. The load gate
            // refuses a library whose ABI differs from the manifest, so a
            // 1.0 plugin still never gets one (#4185).
            if options
                .manifest_api_version
                .and_then(AbiVersion::parse)
                .is_some_and(|abi| abi.supports(ABI_1_1))
            {
                prepare_plugin_data_dir(&self.root, id)?;
            }
            Some(super::sandbox::sandbox_policy(&self.root, id)?)
        } else {
            None
        };
        let configure = termihub_plugin_runner::ipc::Configure {
            sandbox,
            library_path,
            expected_digest: options.expected_digest.map(str::to_owned),
            manifest_api_version: options.manifest_api_version.map(str::to_owned),
            accept_unverified_toolchain: options.accept_unverified_toolchain,
            plugin_id: id.to_owned(),
            host_version: self.host_version.clone(),
            limits: config.limits,
            accept_reduced_isolation,
        };
        SandboxedPluginHandle::start(
            config.clone(),
            configure,
            Arc::new(PluginLogLimiter::default()),
        )
    }

    /// The digest `id`'s backend library at `lib_path` must match at load; see
    /// [`resolve_load_binding`]. Fails closed on an unreadable install record.
    fn load_binding(
        &self,
        id: &str,
        plugin_dir: &Path,
        lib_path: &Path,
    ) -> Result<Option<String>, HostError> {
        let signed = signed_backend_digest(plugin_dir, lib_path)?;
        let record = plugin_state::read_record(&self.root, id).map_err(|e| {
            HostError::InstallRecordMismatch {
                id: id.to_owned(),
                detail: e.to_string(),
            }
        })?;
        let lib_rel = lib_path
            .strip_prefix(plugin_dir)
            .map(rel_to_slash)
            .map_err(|e| HostError::SignatureReverifyFailed(e.to_string()))?;
        // An unreadable trust store degrades to bundled-only: it can only make a
        // key read *untrusted*, never trusted.
        let trust =
            TrustStore::load(&self.root).unwrap_or_else(|_| TrustStore::bundled_only(&self.root));
        resolve_load_binding(id, &lib_rel, signed.as_ref(), record.as_ref(), |key_id| {
            trust.is_trusted(key_id)
        })
    }

    /// Unload a plugin: stop its runner (ending every session) and unregister
    /// its connection type. A no-op if the id is not loaded.
    pub fn unload(&self, id: &str) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        self.sandbox_refusals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        let entry = self
            .loaded
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        if let Some(entry) = entry {
            // The teardown is bounded and complete: cancel, close every
            // session (2 s), `Shutdown` (2 s), kill (concept "Lifecycle"). The
            // plugin's sessions end with it.
            entry.handle.stop();
            self.registry
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .unregister(&entry.connection_type);
        }
    }

    /// Record a runtime failure of a loaded plugin and apply the recovery policy
    /// (concept "Error recovery state machine").
    ///
    /// The plugin's restart counter is advanced. While the restart budget
    /// ([`MAX_RESTART_ATTEMPTS`]) is not exhausted this returns
    /// `RecoveryOutcome::Restart` — the caller reloads the plugin (e.g. via the
    /// manager's enable path) to retry. Once the budget is exhausted the host
    /// **unloads** the plugin and returns `RecoveryOutcome::Disabled`, so the
    /// caller persists it as disabled and notifies the user. A failing plugin can
    /// therefore never spin forever.
    ///
    /// [`MAX_RESTART_ATTEMPTS`]: super::security::MAX_RESTART_ATTEMPTS
    pub fn note_failure(&self, id: &str) -> RecoveryOutcome {
        let action = {
            let mut recovery = self.recovery.lock().unwrap_or_else(|e| e.into_inner());
            recovery.entry(id.to_string()).or_default().record_failure()
        };
        match action {
            RecoveryAction::Restart => RecoveryOutcome::Restart,
            RecoveryAction::Disable => {
                // Budget exhausted: stop the plugin. It stays installed but is not
                // loaded until the user re-enables it (which also clears the
                // counter via `clear_recovery`).
                self.unload(id);
                RecoveryOutcome::Disabled
            }
        }
    }

    /// Clear a plugin's recovery counter — called when it is (re-)enabled or
    /// loads cleanly, so a later, unrelated failure starts from a full budget.
    pub fn clear_recovery(&self, id: &str) {
        self.recovery
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }
}

/// A [`super::PluginLifecycleHook`] that drives a [`PluginHost`], so enabling or
/// disabling a plugin in the [`super::PluginManager`] actually loads or unloads
/// its native backend.
///
/// A load failure is surfaced to the manager as an error message (→
/// [`PluginState::Error`](super::PluginState)); the plugin stays installed and
/// enabled but reports the failure, and the host continues normally.
pub struct HostLifecycleHook {
    host: Arc<PluginHost>,
}

impl HostLifecycleHook {
    /// Wrap a [`PluginHost`] as a lifecycle hook.
    pub fn new(host: Arc<PluginHost>) -> Self {
        Self { host }
    }
}

impl super::manager::PluginLifecycleHook for HostLifecycleHook {
    fn on_enable(&self, plugin: &InstalledPlugin) -> Result<(), String> {
        self.host.load(plugin).map_err(|e| e.to_string())
    }

    fn on_disable(&self, id: &str) -> Result<(), String> {
        self.host.unload(id);
        Ok(())
    }

    fn is_active(&self, id: &str) -> bool {
        self.host.is_active(id)
    }

    fn on_uninstall(&self, id: &str) -> Result<(), String> {
        self.host.unload(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::PluginState;

    /// A host wired to a fresh, empty registry over a temp plugins root.
    /// A host whose runner binary does not exist, so a native load that
    /// passes every host-side gate ends deterministically in
    /// [`HostError::RunnerUnavailable`] — never in an in-process `dlopen`.
    fn test_host() -> (PluginHost, tempfile::TempDir) {
        let tmp = tempfile::TempDir::new().unwrap();
        let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
        let host = PluginHost::new(tmp.path().to_path_buf(), registry)
            .with_runner(PluginRunnerConfig::new(tmp.path().join("no-such-runner")));
        (host, tmp)
    }

    /// Build an [`InstalledPlugin`] from a manifest JSON string (Installed state).
    fn installed(manifest_json: &str) -> InstalledPlugin {
        let manifest = super::super::manifest::parse_manifest(manifest_json).expect("parses");
        InstalledPlugin {
            manifest,
            state: PluginState::Installed,
            error_message: None,
            installed_at: 0,
        }
    }

    fn manifest_json(permissions: &str, fs_paths: &str) -> String {
        let fs_line = if fs_paths.is_empty() {
            String::new()
        } else {
            format!("\"filesystemPaths\": {fs_paths},")
        };
        format!(
            r#"{{
                "id": "host-sec",
                "name": "Host Sec",
                "version": "1.0.0",
                "author": "tester",
                "description": "host security test",
                "license": "MIT",
                "apiVersion": "1.0",
                "platforms": ["linux", "macos", "windows"],
                "permissions": {permissions},
                {fs_line}
                "extensions": {{
                    "terminalBackend": {{
                        "connectionType": "host-sec",
                        "displayName": "Host Sec",
                        "configSchema": {{}}
                    }}
                }}
            }}"#
        )
    }

    #[test]
    fn load_refuses_terminal_backend_without_terminal_permission() {
        let (host, _t) = test_host();
        // Terminal backend but only the `network` permission → refused before any
        // library is opened. Graceful: the manager maps this to Error state.
        let plugin = installed(&manifest_json(r#"["network"]"#, ""));
        let err = host.load(&plugin).unwrap_err();
        assert!(
            matches!(
                err,
                HostError::Permission(PermissionError::TerminalWithoutPermission)
            ),
            "got {err:?}"
        );
        assert!(!host.is_loaded("host-sec"));
    }

    #[test]
    fn load_refuses_filesystem_permission_without_paths() {
        let (host, _t) = test_host();
        let plugin = installed(&manifest_json(r#"["terminal", "filesystem"]"#, ""));
        let err = host.load(&plugin).unwrap_err();
        assert!(
            matches!(
                err,
                HostError::Permission(PermissionError::FilesystemWithoutPaths)
            ),
            "got {err:?}"
        );
    }

    /// The load is refused with a permission error for the single declared
    /// `root`, before any trust gate or library is consulted.
    fn assert_root_refused(host: &PluginHost, root: &Path) {
        let paths = serde_json::to_string(&[root.to_string_lossy()]).unwrap();
        let plugin = installed(&manifest_json(r#"["terminal", "filesystem"]"#, &paths));
        let err = host.load(&plugin).unwrap_err();
        assert!(
            matches!(err, HostError::Permission(_)),
            "root {} must be refused as a permission error, got {err:?}",
            root.display()
        );
        assert!(!host.is_loaded("host-sec"));
    }

    /// Defence in depth for PLG2-001 / SEC2-001: a manifest that reaches the
    /// loader without validation (a pre-fix install, a hand-edited folder) still
    /// cannot declare a root that grants the whole disk.
    #[test]
    fn load_refuses_empty_dot_and_relative_filesystem_roots() {
        let (host, _t) = test_host();
        for root in ["", ".", "./", "relative"] {
            assert_root_refused(&host, Path::new(root));
        }
    }

    /// An over-broad root is refused at load: the user's home folder or any
    /// folder containing it, termiHub's plugins folder or anything in it (other
    /// plugins' files and data), and termiHub's config folder (settings and
    /// credentials) or anything containing it.
    #[test]
    fn load_refuses_over_broad_filesystem_roots() {
        let (host, tmp) = test_host();
        let plugins = tmp.path();
        let config = plugins.parent().expect("the temp root has a parent");
        assert_root_refused(&host, plugins);
        assert_root_refused(&host, &plugins.join("other-plugin"));
        assert_root_refused(&host, &plugins.join(".data").join("other-plugin"));
        assert_root_refused(&host, config);
        assert_root_refused(&host, &config.join("credentials"));
        if let Some(home) = crate::config::home_directory() {
            assert_root_refused(&host, &home);
            if let Some(parent) = home.parent().filter(|p| p.parent().is_some()) {
                assert_root_refused(&host, parent);
            }
        }
    }

    // --- Native-plugin trust gate (SEC-002 / PLG-006 / ARCH-008) ---

    use super::super::native_trust::NativeTrustStore;
    use super::super::signature::sha256_digest;

    /// A frontend-only (theme) plugin manifest — no `terminalBackend`, so it never
    /// reaches the native-plugin trust gate.
    fn theme_manifest_json() -> String {
        r#"{
            "id": "theme-only",
            "name": "Theme Only",
            "version": "1.0.0",
            "author": "tester",
            "description": "frontend-only theme plugin",
            "license": "MIT",
            "apiVersion": "1.0",
            "platforms": ["linux", "macos", "windows"],
            "permissions": [],
            "extensions": {
                "theme": {
                    "themes": [ { "id": "dark", "name": "Dark", "file": "themes/dark.json" } ]
                }
            }
        }"#
        .to_owned()
    }

    /// Write a dummy backend library for `id` under the host root and return its
    /// SHA-256. The bytes are not a real dylib — enough to exercise the trust gate,
    /// which runs before `dlopen`.
    fn write_dummy_backend(root: &Path, id: &str) -> String {
        let backend = root.join(id).join("backend");
        std::fs::create_dir_all(&backend).unwrap();
        let lib_name = format!(
            "{}{id}{}",
            std::env::consts::DLL_PREFIX,
            std::env::consts::DLL_SUFFIX
        );
        let bytes = b"dummy native library bytes";
        std::fs::write(backend.join(lib_name), bytes).unwrap();
        sha256_digest(bytes)
    }

    #[test]
    fn load_refuses_native_plugin_when_globally_disabled() {
        let (host, tmp) = test_host();
        // A valid terminal-backend plugin with a real backend file on disk, but
        // native plugins are OFF by default (no trust store) → refused before the
        // library is even opened. Fail closed.
        write_dummy_backend(tmp.path(), "host-sec");
        let plugin = installed(&manifest_json(r#"["terminal"]"#, ""));
        match host.load(&plugin) {
            Err(HostError::NativePluginsDisabled) => {}
            other => panic!("expected NativePluginsDisabled, got {other:?}"),
        }
        assert!(!host.is_loaded("host-sec"));
    }

    #[test]
    fn load_refuses_native_plugin_without_acknowledgment() {
        let (host, tmp) = test_host();
        write_dummy_backend(tmp.path(), "host-sec");
        // Native plugins enabled globally, but this plugin is not acknowledged.
        NativeTrustStore::load(tmp.path())
            .set_native_enabled(true)
            .unwrap();
        let plugin = installed(&manifest_json(r#"["terminal"]"#, ""));
        match host.load(&plugin) {
            Err(HostError::NativePluginNotTrusted { id }) => assert_eq!(id, "host-sec"),
            other => panic!("expected NativePluginNotTrusted, got {other:?}"),
        }
        assert!(!host.is_loaded("host-sec"));
    }

    #[test]
    fn a_refused_out_of_process_load_is_reported_until_unload() {
        // A trusted native plugin whose runner cannot be started: the Settings
        // row says "Plugin runner is missing" (#4188), until the plugin is
        // unloaded (disabled / revoked).
        let tmp = tempfile::TempDir::new().unwrap();
        let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
        let host = PluginHost::new(tmp.path().to_path_buf(), registry)
            .with_runner(PluginRunnerConfig::new(tmp.path().join("no-such-runner")));
        let hash = write_dummy_backend(tmp.path(), "host-sec");
        let mut trust = NativeTrustStore::load(tmp.path());
        trust.set_native_enabled(true).unwrap();
        trust.acknowledge("host-sec", hash).unwrap();
        let plugin = installed(&manifest_json(r#"["terminal"]"#, ""));
        assert!(matches!(
            host.load(&plugin),
            Err(HostError::RunnerUnavailable { .. })
        ));
        assert!(host.sandbox_status("theme-only").is_none());
        let status = host
            .sandbox_status("host-sec")
            .expect("the refusal is recorded");
        assert_eq!(
            status.isolation,
            super::super::sandbox::IsolationStatus::RunnerMissing
        );
        assert_eq!(host.sandbox_statuses().len(), 1);
        host.unload("host-sec");
        assert!(host.sandbox_status("host-sec").is_none());
        assert!(host.sandbox_statuses().is_empty());
    }

    #[test]
    fn a_trust_gate_refusal_has_no_sandbox_status() {
        let (host, tmp) = test_host();
        write_dummy_backend(tmp.path(), "host-sec");
        NativeTrustStore::load(tmp.path())
            .set_native_enabled(true)
            .unwrap();
        let plugin = installed(&manifest_json(r#"["terminal"]"#, ""));
        // Refused by the trust gate — not a sandbox refusal.
        assert!(host.load(&plugin).is_err());
        assert!(host.sandbox_status("host-sec").is_none());
    }

    #[test]
    fn load_refuses_native_plugin_on_stale_acknowledgment() {
        let (host, tmp) = test_host();
        write_dummy_backend(tmp.path(), "host-sec");
        // Acknowledged, but for a DIFFERENT library hash (the binary changed since
        // it was trusted) → the stale ack does not authorize the current bytes.
        let mut trust = NativeTrustStore::load(tmp.path());
        trust.set_native_enabled(true).unwrap();
        trust.acknowledge("host-sec", "some-other-hash").unwrap();
        let plugin = installed(&manifest_json(r#"["terminal"]"#, ""));
        match host.load(&plugin) {
            Err(HostError::NativePluginNotTrusted { id }) => assert_eq!(id, "host-sec"),
            other => panic!("expected NativePluginNotTrusted on hash mismatch, got {other:?}"),
        }
        assert!(!host.is_loaded("host-sec"));
    }

    #[test]
    fn load_passes_trust_gate_with_a_valid_acknowledgment() {
        let (host, tmp) = test_host();
        let hash = write_dummy_backend(tmp.path(), "host-sec");
        // Enabled globally AND acknowledged for the exact current library hash: the
        // trust gate passes. The test host's runner does not exist, so the load
        // then fails starting it (HostError::RunnerUnavailable) — proving control
        // reached the runner, i.e. the gate did NOT refuse.
        let mut trust = NativeTrustStore::load(tmp.path());
        trust.set_native_enabled(true).unwrap();
        trust.acknowledge("host-sec", hash).unwrap();
        let plugin = installed(&manifest_json(r#"["terminal"]"#, ""));
        match host.load(&plugin) {
            Err(HostError::RunnerUnavailable { .. }) => {}
            Err(HostError::NativePluginsDisabled | HostError::NativePluginNotTrusted { .. }) => {
                panic!("the trust gate must NOT refuse a plugin that is enabled and acknowledged")
            }
            other => panic!("expected the load to reach the runner, got {other:?}"),
        }
    }

    // --- Multi-platform packages (PLG-011) ---

    /// A foreign target triple no host running these tests can be.
    const FOREIGN_TRIPLE: &str = "riscv64gc-unknown-none-elf";

    /// `manifest_json` for `host-sec` with a `libraries` map over `triples`, each
    /// mapped to `backend/<triple>/lib.bin`.
    fn multi_platform_manifest(triples: &[&str]) -> String {
        let entries = triples
            .iter()
            .map(|t| format!("\"{t}\": \"backend/{t}/lib.bin\""))
            .collect::<Vec<_>>()
            .join(", ");
        manifest_json(r#"["terminal"]"#, "").replace(
            "\"configSchema\": {}",
            &format!("\"configSchema\": {{}}, \"libraries\": {{ {entries} }}"),
        )
    }

    /// Write `backend/<triple>/lib.bin` for each triple under `root/host-sec`,
    /// each with distinct bytes, returning `(triple, sha256)` pairs.
    fn write_multi_platform_backend(root: &Path, triples: &[&str]) -> Vec<(String, String)> {
        triples
            .iter()
            .map(|t| {
                let dir = root.join("host-sec").join("backend").join(t);
                std::fs::create_dir_all(&dir).unwrap();
                let bytes = format!("native library for {t}").into_bytes();
                std::fs::write(dir.join("lib.bin"), &bytes).unwrap();
                ((*t).to_owned(), sha256_digest(&bytes))
            })
            .collect()
    }

    fn backend_of(plugin: &InstalledPlugin) -> &TerminalBackendExtension {
        plugin
            .manifest
            .extensions
            .terminal_backend
            .as_ref()
            .unwrap()
    }

    #[test]
    fn select_backend_library_picks_the_host_triple_entry() {
        let tmp = tempfile::TempDir::new().unwrap();
        let host = super::super::platform::host_target_triple();
        write_multi_platform_backend(tmp.path(), &[host, FOREIGN_TRIPLE]);
        let plugin = installed(&multi_platform_manifest(&[host, FOREIGN_TRIPLE]));

        let selected =
            select_backend_library(&tmp.path().join("host-sec"), backend_of(&plugin)).unwrap();
        assert_eq!(
            selected,
            tmp.path()
                .join("host-sec")
                .join("backend")
                .join(host)
                .join("lib.bin")
        );
    }

    #[test]
    fn select_backend_library_reports_a_missing_platform() {
        let tmp = tempfile::TempDir::new().unwrap();
        write_multi_platform_backend(tmp.path(), &[FOREIGN_TRIPLE]);
        let plugin = installed(&multi_platform_manifest(&[FOREIGN_TRIPLE]));

        match select_backend_library(&tmp.path().join("host-sec"), backend_of(&plugin)) {
            Err(err @ HostError::PlatformUnavailable { .. }) => {
                assert!(err.is_incompatible());
                let msg = err.to_string();
                assert!(msg.contains("not available for this platform"), "{msg}");
                assert!(msg.contains(super::super::platform::host_target_triple()));
                assert!(msg.contains(FOREIGN_TRIPLE), "{msg}");
            }
            other => panic!("expected PlatformUnavailable, got {other:?}"),
        }
    }

    #[test]
    fn select_backend_library_mapped_file_missing_is_not_found() {
        let tmp = tempfile::TempDir::new().unwrap();
        let host = super::super::platform::host_target_triple();
        std::fs::create_dir_all(tmp.path().join("host-sec").join("backend")).unwrap();
        let plugin = installed(&multi_platform_manifest(&[host]));
        assert!(matches!(
            select_backend_library(&tmp.path().join("host-sec"), backend_of(&plugin)),
            Err(HostError::LibraryNotFound(_))
        ));
    }

    #[test]
    fn select_backend_library_without_a_map_uses_the_legacy_scan() {
        let (_host, tmp) = test_host();
        write_dummy_backend(tmp.path(), "host-sec");
        let plugin = installed(&manifest_json(r#"["terminal"]"#, ""));
        let dir = tmp.path().join("host-sec");
        assert_eq!(
            select_backend_library(&dir, backend_of(&plugin)).unwrap(),
            find_backend_library(&dir).unwrap()
        );
    }

    #[test]
    fn load_refuses_a_multi_platform_plugin_lacking_this_platform() {
        let (host, tmp) = test_host();
        write_multi_platform_backend(tmp.path(), &[FOREIGN_TRIPLE]);
        NativeTrustStore::load(tmp.path())
            .set_native_enabled(true)
            .unwrap();
        let plugin = installed(&multi_platform_manifest(&[FOREIGN_TRIPLE]));
        assert!(matches!(
            host.load(&plugin),
            Err(HostError::PlatformUnavailable { .. })
        ));
        assert!(!host.is_loaded("host-sec"));
    }

    #[test]
    fn trust_ack_binds_to_the_selected_platform_library() {
        let (host, tmp) = test_host();
        let triple = super::super::platform::host_target_triple();
        let hashes = write_multi_platform_backend(tmp.path(), &[triple, FOREIGN_TRIPLE]);
        let host_hash = hashes.iter().find(|(t, _)| t == triple).unwrap().1.clone();
        let foreign_hash = hashes
            .iter()
            .find(|(t, _)| t == FOREIGN_TRIPLE)
            .unwrap()
            .1
            .clone();
        let manifest = multi_platform_manifest(&[triple, FOREIGN_TRIPLE]);
        std::fs::write(tmp.path().join("host-sec").join("manifest.json"), &manifest).unwrap();
        let plugin = installed(&manifest);

        // The hash the trust UI computes is the SELECTED (host) library's.
        assert_eq!(
            super::super::native_trust::native_library_hash(tmp.path(), "host-sec").unwrap(),
            host_hash
        );

        // Acknowledging ANOTHER platform's library does not authorize this one.
        let mut trust = NativeTrustStore::load(tmp.path());
        trust.set_native_enabled(true).unwrap();
        trust.acknowledge("host-sec", foreign_hash).unwrap();
        assert!(matches!(
            host.load(&plugin),
            Err(HostError::NativePluginNotTrusted { .. })
        ));

        // Acknowledging the selected library passes the gate and reaches the
        // runner (the test host has none, so it fails there).
        trust.acknowledge("host-sec", host_hash).unwrap();
        match host.load(&plugin) {
            Err(HostError::RunnerUnavailable { .. }) => {}
            other => panic!("expected the load to reach the runner, got {other:?}"),
        }
    }

    #[test]
    fn frontend_only_plugin_loads_without_native_trust() {
        let (host, _t) = test_host();
        // A theme (frontend-only) plugin has no native backend, so the native-plugin
        // trust gate does not apply: it loads (activates) even with native plugins
        // globally off. The sandboxed-JS / theme surface is unaffected.
        let plugin = installed(&theme_manifest_json());
        host.load(&plugin)
            .expect("a frontend-only plugin must load");
        assert!(host.is_active("theme-only"));
        assert!(!host.is_loaded("theme-only")); // no backend library
    }

    #[test]
    fn note_failure_restarts_up_to_budget_then_disables() {
        let (host, _t) = test_host();
        // Nothing is loaded, so `unload` on disable is a harmless no-op; we are
        // exercising the recovery counter the host keeps per plugin.
        for _ in 0..super::super::security::MAX_RESTART_ATTEMPTS {
            assert_eq!(host.note_failure("crashy"), RecoveryOutcome::Restart);
        }
        assert_eq!(host.note_failure("crashy"), RecoveryOutcome::Disabled);
        // Latches disabled.
        assert_eq!(host.note_failure("crashy"), RecoveryOutcome::Disabled);

        // Clearing (as a re-enable would) restores the full budget.
        host.clear_recovery("crashy");
        assert_eq!(host.note_failure("crashy"), RecoveryOutcome::Restart);
    }

    use crate::connection::{Capabilities, ConnectionType, OutputReceiver, SettingsSchema};
    use crate::errors::SessionError;
    use crate::files::FileBrowser;
    use crate::monitoring::MonitoringProvider;

    /// A do-nothing connection type, just enough for the registry to register it
    /// so the registration tests see an occupied key.
    struct StubConnection;

    #[async_trait::async_trait]
    impl ConnectionType for StubConnection {
        fn type_id(&self) -> &str {
            "stub"
        }
        fn display_name(&self) -> &str {
            "Stub"
        }
        fn settings_schema(&self) -> SettingsSchema {
            SettingsSchema { groups: vec![] }
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                monitoring: false,
                file_browser: false,
                graphical: false,
                resize: true,
                persistent: false,
                terminal: true,
                tunneling: false,
            }
        }
        async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
            Ok(())
        }
        async fn disconnect(&mut self) -> Result<(), SessionError> {
            Ok(())
        }
        fn is_connected(&self) -> bool {
            false
        }
        fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
            Ok(())
        }
        fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
            Ok(())
        }
        fn subscribe_output(&self) -> OutputReceiver {
            let (_tx, rx) = tokio::sync::mpsc::channel(1);
            rx
        }
        fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
            None
        }
        fn file_browser(&self) -> Option<&dyn FileBrowser> {
            None
        }
    }

    fn register_stub(registry: &mut ConnectionTypeRegistry, type_id: &str) {
        registry.register(
            type_id,
            type_id,
            "puzzle",
            Box::new(|| Box::new(StubConnection)),
        );
    }

    fn backend(connection_type: &str, display_name: &str) -> TerminalBackendExtension {
        TerminalBackendExtension {
            connection_type: connection_type.to_string(),
            display_name: display_name.to_string(),
            config_schema: serde_json::json!({}),
            libraries: Default::default(),
        }
    }

    fn stub_factory(_type_id: String, _display_name: String) -> ConnectionFactory {
        Box::new(|| Box::new(StubConnection))
    }

    /// The `(plugin_id, plugin_name, connectionType, displayName)` fixtures the
    /// load-order tests register: two plugins declaring the same type, one
    /// colliding with a built-in id, one unique.
    const PLUGINS: [(&str, &str, &str, &str); 4] = [
        ("alpha", "Alpha", "k8s", "Kubernetes"),
        ("beta", "Beta", "k8s", "Kubernetes"),
        ("gamma", "Gamma", "ssh", "Fancy SSH"),
        ("delta", "Delta", "mqtt", "MQTT"),
    ];

    /// Register `order` (indices into [`PLUGINS`]) over a registry that already
    /// holds the built-in `ssh`, returning each plugin's registered id.
    fn register_in_order(order: &[usize]) -> BTreeMap<&'static str, String> {
        let mut registry = ConnectionTypeRegistry::new();
        register_stub(&mut registry, "ssh");
        let mut ids = BTreeMap::new();
        for &i in order {
            let (id, name, ct, dn) = PLUGINS[i];
            let type_id =
                register_backend_type(&mut registry, id, name, &backend(ct, dn), stub_factory);
            assert!(registry.has_type(&type_id));
            ids.insert(id, type_id);
        }
        // The built-in is never shadowed or replaced.
        assert!(registry.has_type("ssh"));
        ids
    }

    #[test]
    fn registered_type_id_is_namespaced_by_plugin_id() {
        let ids = register_in_order(&[0, 1, 2, 3]);
        assert_eq!(ids["alpha"], "plugin:alpha:k8s");
        assert_eq!(ids["beta"], "plugin:beta:k8s");
        assert_eq!(ids["gamma"], "plugin:gamma:ssh");
        assert_eq!(ids["delta"], "plugin:delta:mqtt");
    }

    #[test]
    fn registered_type_ids_do_not_depend_on_load_order() {
        let reference = register_in_order(&[0, 1, 2, 3]);
        // Every permutation of the four plugins yields identical ids (PLG-007).
        let mut order = [0usize, 1, 2, 3];
        let mut permutations = 0;
        loop {
            assert_eq!(register_in_order(&order), reference, "order {order:?}");
            permutations += 1;
            if !next_permutation(&mut order) {
                break;
            }
        }
        assert_eq!(permutations, 24);
    }

    /// Lexicographic next permutation; `false` once the last one was reached.
    fn next_permutation(v: &mut [usize]) -> bool {
        let Some(i) = (1..v.len()).rev().find(|&i| v[i - 1] < v[i]) else {
            return false;
        };
        let j = (i..v.len()).rev().find(|&j| v[j] > v[i - 1]).unwrap_or(i);
        v.swap(i - 1, j);
        v[i..].reverse();
        true
    }

    #[test]
    fn two_plugins_with_the_same_connection_type_both_register() {
        let mut registry = ConnectionTypeRegistry::new();
        let a = register_backend_type(
            &mut registry,
            "alpha",
            "Alpha",
            &backend("k8s", "Kubernetes"),
            stub_factory,
        );
        let b = register_backend_type(
            &mut registry,
            "beta",
            "Beta",
            &backend("k8s", "Kubernetes"),
            stub_factory,
        );
        assert_ne!(a, b);
        let types = registry.available_types();
        assert_eq!(types.len(), 2);
        // The cosmetic label of the second is disambiguated; ids never are.
        assert_eq!(types[0].display_name, "Kubernetes");
        assert_eq!(types[1].display_name, "Kubernetes (Beta)");
        assert!(types.iter().all(|t| t.icon == PLUGIN_TYPE_ICON));
    }

    #[test]
    fn a_plugin_declaring_a_builtin_type_does_not_shadow_it() {
        let mut registry = ConnectionTypeRegistry::new();
        register_stub(&mut registry, "ssh");
        let id = register_backend_type(
            &mut registry,
            "gamma",
            "Gamma",
            &backend("ssh", "SSH+"),
            stub_factory,
        );
        assert_eq!(id, "plugin:gamma:ssh");
        // The built-in keeps its id and its entry (the stub's own icon).
        let ssh = registry
            .available_types()
            .into_iter()
            .find(|t| t.type_id == "ssh")
            .unwrap();
        assert_eq!(ssh.display_name, "ssh");
    }

    #[test]
    fn reregistering_the_same_plugin_keeps_its_id() {
        let mut registry = ConnectionTypeRegistry::new();
        let first = register_backend_type(
            &mut registry,
            "alpha",
            "Alpha",
            &backend("k8s", "Kubernetes"),
            stub_factory,
        );
        let second = register_backend_type(
            &mut registry,
            "alpha",
            "Alpha",
            &backend("k8s", "Kubernetes"),
            stub_factory,
        );
        assert_eq!(first, second);
        assert_eq!(registry.available_types().len(), 1);
        // Its own previous registration does not count as a label collision.
        assert_eq!(registry.available_types()[0].display_name, "Kubernetes");
    }

    #[test]
    fn symbol_name_strips_trailing_nul() {
        use termihub_plugin_api::symbols::SYMBOL_PLUGIN_INIT;
        assert_eq!(
            loader::symbol_name(SYMBOL_PLUGIN_INIT),
            "termihub_plugin_init"
        );
        assert_eq!(loader::symbol_name(b"foo\0"), "foo");
        assert_eq!(loader::symbol_name(b"bar"), "bar");
    }

    #[test]
    fn find_backend_library_missing_dir_is_error() {
        let tmp = tempfile::TempDir::new().unwrap();
        let err = find_backend_library(tmp.path()).unwrap_err();
        assert!(matches!(err, HostError::LibraryNotFound(_)));
    }

    #[test]
    fn find_backend_library_picks_current_platform_extension() {
        let tmp = tempfile::TempDir::new().unwrap();
        let backend = tmp.path().join("backend");
        std::fs::create_dir_all(&backend).unwrap();
        // Ship all three platform artifacts; the loader must pick this OS's.
        std::fs::write(backend.join("plugin.dll"), b"").unwrap();
        std::fs::write(backend.join("libplugin.so"), b"").unwrap();
        std::fs::write(backend.join("libplugin.dylib"), b"").unwrap();
        // A non-library file must be ignored.
        std::fs::write(backend.join("README.md"), b"").unwrap();

        let found = find_backend_library(tmp.path()).unwrap();
        let ext = found.extension().and_then(|e| e.to_str()).unwrap();
        assert_eq!(ext, std::env::consts::DLL_EXTENSION);
    }

    #[test]
    fn find_backend_library_rejects_ambiguous_candidates() {
        // Two files matching the current platform's extension make the pick
        // ambiguous: rather than load a nondeterministically-chosen one, the
        // loader refuses (CORE-034).
        let tmp = tempfile::TempDir::new().unwrap();
        let backend = tmp.path().join("backend");
        std::fs::create_dir_all(&backend).unwrap();
        let ext = std::env::consts::DLL_EXTENSION;
        std::fs::write(backend.join(format!("liba.{ext}")), b"").unwrap();
        std::fs::write(backend.join(format!("libb.{ext}")), b"").unwrap();

        match find_backend_library(tmp.path()) {
            Err(HostError::AmbiguousLibrary { names, .. }) => {
                // Deterministically sorted, so both names appear in a stable order.
                assert!(names.contains(&format!("liba.{ext}")));
                assert!(names.contains(&format!("libb.{ext}")));
            }
            other => panic!("expected AmbiguousLibrary, got {other:?}"),
        }
    }

    #[test]
    fn find_backend_library_single_match_is_deterministic() {
        // Exactly one candidate for this platform is returned unambiguously,
        // regardless of any non-matching siblings.
        let tmp = tempfile::TempDir::new().unwrap();
        let backend = tmp.path().join("backend");
        std::fs::create_dir_all(&backend).unwrap();
        let ext = std::env::consts::DLL_EXTENSION;
        std::fs::write(backend.join(format!("libonly.{ext}")), b"").unwrap();
        std::fs::write(backend.join("notes.txt"), b"").unwrap();

        let found = find_backend_library(tmp.path()).unwrap();
        assert_eq!(
            found.file_name().unwrap(),
            format!("libonly.{ext}").as_str()
        );
    }

    #[test]
    fn signed_backend_digest_none_for_unsigned_plugin() {
        // No signature.json → unsigned → nothing to bind (Ok(None)), so the load
        // path is unchanged for unsigned plugins.
        let tmp = tempfile::TempDir::new().unwrap();
        let plugin_dir = tmp.path();
        let lib = plugin_dir.join("backend").join("libfoo.so");
        std::fs::create_dir_all(lib.parent().unwrap()).unwrap();
        std::fs::write(&lib, b"bytes").unwrap();
        assert_eq!(signed_backend_digest(plugin_dir, &lib).unwrap(), None);
    }

    #[test]
    fn signed_backend_digest_returns_signed_lib_digest_and_detects_tampering() {
        use super::super::signature::{sha256_digest, sign_digests, SIGNATURE_FILE_NAME};
        use ed25519_dalek::SigningKey;
        use std::collections::BTreeMap;

        let tmp = tempfile::TempDir::new().unwrap();
        let plugin_dir = tmp.path();
        let backend = plugin_dir.join("backend");
        std::fs::create_dir_all(&backend).unwrap();
        let manifest = b"{\"id\":\"p\"}";
        let lib_bytes = b"\x7fELF real library bytes";
        std::fs::write(plugin_dir.join("manifest.json"), manifest).unwrap();
        let lib = backend.join("libp.so");
        std::fs::write(&lib, lib_bytes).unwrap();

        // Sign the exact extracted set (keys use `/`).
        let mut files = BTreeMap::new();
        files.insert("manifest.json".to_owned(), sha256_digest(manifest));
        files.insert("backend/libp.so".to_owned(), sha256_digest(lib_bytes));
        let key = SigningKey::from_bytes(&[9u8; 32]);
        let sig = sign_digests(&key, files, "t".to_owned());
        std::fs::write(
            plugin_dir.join(SIGNATURE_FILE_NAME),
            serde_json::to_vec(&sig).unwrap(),
        )
        .unwrap();

        // The signed digest of the library is returned.
        let signed = signed_backend_digest(plugin_dir, &lib).unwrap().unwrap();
        assert_eq!(signed.digest, sha256_digest(lib_bytes));
        assert_eq!(
            signed.key_id,
            super::super::signature::key_id_from_public_key(key.verifying_key().as_bytes())
        );

        // Tamper with an extracted file: re-verification now fails.
        std::fs::write(&lib, b"tampered").unwrap();
        assert!(matches!(
            signed_backend_digest(plugin_dir, &lib),
            Err(HostError::SignatureReverifyFailed(_))
        ));
    }

    // --- Load binding: trust anchor + install record (#2796) ---

    mod load_binding {
        use super::super::super::plugin_state::{PluginStateRecord, VerifiedBackend};
        use super::super::super::signer_change::PackageSigner;
        use super::super::{resolve_load_binding, HostError, SignedBackend};

        const LIB: &str = "backend/libp.so";

        fn signed(key: &str, digest: &str) -> SignedBackend {
            SignedBackend {
                key_id: key.into(),
                digest: digest.into(),
            }
        }

        fn record(signer: Option<&str>, digest: &str, signer_trusted: bool) -> PluginStateRecord {
            PluginStateRecord {
                enabled: true,
                signer: Some(PackageSigner::from_key_id(signer)),
                verified_backend: Some(VerifiedBackend {
                    library: LIB.into(),
                    sha256: digest.into(),
                    signer_trusted,
                }),
                ..PluginStateRecord::default()
            }
        }

        fn trusts(keys: &'static [&'static str]) -> impl Fn(&str) -> bool {
            move |k| keys.contains(&k)
        }

        #[test]
        fn trusted_signer_matching_the_record_binds_the_recorded_digest() {
            let got = resolve_load_binding(
                "p",
                LIB,
                Some(&signed("A", "d1")),
                Some(&record(Some("A"), "d1", true)),
                trusts(&["A"]),
            )
            .unwrap();
            assert_eq!(got.as_deref(), Some("d1"));
        }

        #[test]
        fn resigned_by_an_untrusted_key_is_refused() {
            let err = resolve_load_binding(
                "p",
                LIB,
                Some(&signed("EVIL", "d2")),
                Some(&record(Some("A"), "d1", true)),
                trusts(&["A"]),
            )
            .unwrap_err();
            assert!(
                matches!(&err, HostError::SigningKeyNotTrusted { key_id, .. } if key_id == "EVIL"),
                "{err:?}"
            );
        }

        #[test]
        fn a_key_revoked_since_install_is_refused() {
            let err = resolve_load_binding(
                "p",
                LIB,
                Some(&signed("A", "d1")),
                Some(&record(Some("A"), "d1", true)),
                trusts(&[]),
            )
            .unwrap_err();
            assert!(
                matches!(err, HostError::SigningKeyNotTrusted { .. }),
                "{err:?}"
            );
        }

        #[test]
        fn resigned_by_the_trusted_key_over_other_bytes_is_refused() {
            let err = resolve_load_binding(
                "p",
                LIB,
                Some(&signed("A", "d2")),
                Some(&record(Some("A"), "d1", true)),
                trusts(&["A"]),
            )
            .unwrap_err();
            assert!(
                matches!(err, HostError::InstallRecordMismatch { .. }),
                "{err:?}"
            );
        }

        #[test]
        fn install_once_loads_only_with_its_recorded_key() {
            let rec = record(Some("B"), "d1", false);
            let ok =
                resolve_load_binding("p", LIB, Some(&signed("B", "d1")), Some(&rec), trusts(&[]));
            assert_eq!(ok.unwrap().as_deref(), Some("d1"));

            let err =
                resolve_load_binding("p", LIB, Some(&signed("C", "d1")), Some(&rec), trusts(&[]))
                    .unwrap_err();
            assert!(
                matches!(err, HostError::SigningKeyNotTrusted { .. }),
                "{err:?}"
            );
        }

        #[test]
        fn an_untrusted_signer_without_an_install_record_is_refused() {
            let err = resolve_load_binding("p", LIB, Some(&signed("B", "d1")), None, trusts(&[]))
                .unwrap_err();
            assert!(
                matches!(err, HostError::SigningKeyNotTrusted { .. }),
                "{err:?}"
            );
        }

        #[test]
        fn a_trusted_signer_without_an_install_record_binds_the_signed_digest() {
            let got =
                resolve_load_binding("p", LIB, Some(&signed("A", "d1")), None, trusts(&["A"]))
                    .unwrap();
            assert_eq!(got.as_deref(), Some("d1"));
        }

        #[test]
        fn a_stripped_or_added_signature_is_refused() {
            let err = resolve_load_binding(
                "p",
                LIB,
                None,
                Some(&record(Some("A"), "d1", true)),
                trusts(&["A"]),
            )
            .unwrap_err();
            assert!(
                matches!(err, HostError::InstallRecordMismatch { .. }),
                "{err:?}"
            );

            let err = resolve_load_binding(
                "p",
                LIB,
                Some(&signed("A", "d1")),
                Some(&record(None, "d1", false)),
                trusts(&["A"]),
            )
            .unwrap_err();
            assert!(
                matches!(err, HostError::InstallRecordMismatch { .. }),
                "{err:?}"
            );
        }

        #[test]
        fn an_unsigned_plugin_binds_its_recorded_digest() {
            let got = resolve_load_binding(
                "p",
                LIB,
                None,
                Some(&record(None, "d1", false)),
                trusts(&[]),
            )
            .unwrap();
            assert_eq!(got.as_deref(), Some("d1"));
        }

        #[test]
        fn a_legacy_unsigned_plugin_without_a_record_stays_unbound() {
            assert_eq!(
                resolve_load_binding("p", LIB, None, None, trusts(&[])).unwrap(),
                None
            );
        }

        #[test]
        fn a_different_selected_library_is_refused() {
            let err = resolve_load_binding(
                "p",
                "backend/other.so",
                None,
                Some(&record(None, "d1", false)),
                trusts(&[]),
            )
            .unwrap_err();
            assert!(
                matches!(err, HostError::InstallRecordMismatch { .. }),
                "{err:?}"
            );
        }
    }

    #[test]
    fn incompatible_abi_error_is_flagged() {
        let err = HostError::IncompatibleAbi(AbiIncompatibility::UnsupportedMajor {
            plugin: AbiVersion::new(2, 0),
            host: CURRENT_PLUGIN_ABI_VERSION,
        });
        assert!(err.is_incompatible());
        // A load error is not an incompatibility, and neither is an internally
        // inconsistent package (its ABI is loadable; the package is broken).
        assert!(!HostError::MissingSymbol("x".into()).is_incompatible());
        assert!(!HostError::ManifestAbiMismatch {
            manifest: "1.0".into(),
            library: AbiVersion::new(1, 1),
        }
        .is_incompatible());
    }

    // --- ABI gate compatibility matrix (#3367, PLG-001/002/003) ---

    /// A simulated newer host, so "older minor" is expressible while the real
    /// ABI is still 1.0.
    const HOST_1_2: AbiVersion = AbiVersion::new(1, 2);

    #[test]
    fn abi_gate_matrix_against_a_newer_host() {
        // Same version, and every older minor, loads.
        for minor in 0..=2 {
            assert!(
                check_library_abi(AbiVersion::new(1, minor), HOST_1_2, None).is_ok(),
                "1.{minor} should load on a 1.2 host"
            );
        }
        // A newer minor is refused as incompatible, naming both versions.
        let err = check_library_abi(AbiVersion::new(1, 3), HOST_1_2, None).unwrap_err();
        assert!(err.is_incompatible());
        assert_eq!(
            err.to_string(),
            "plugin built for ABI 1.3, this termiHub supports ABI 1.2 — update termiHub"
        );
        // A different major is refused either way.
        let err = check_library_abi(AbiVersion::new(2, 0), HOST_1_2, None).unwrap_err();
        assert!(err.is_incompatible());
        assert!(
            err.to_string().contains("major 2 is not supported"),
            "{err}"
        );
        // A pre-freeze exact-match value (e.g. the old `4`) decodes as 0.4.
        let err = check_library_abi(AbiVersion::from_packed(4), HOST_1_2, None).unwrap_err();
        assert!(err.is_incompatible());
        assert!(err.to_string().contains("ABI 0.4"), "{err}");
    }

    #[test]
    fn abi_gate_requires_the_manifest_to_mirror_the_library() {
        let lib = AbiVersion::new(1, 1);
        assert!(check_library_abi(lib, HOST_1_2, Some("1.1")).is_ok());
        for declared in ["1.0", "1.2", "2.1", "1", "garbage"] {
            match check_library_abi(lib, HOST_1_2, Some(declared)) {
                Err(HostError::ManifestAbiMismatch { manifest, library }) => {
                    assert_eq!(manifest, declared);
                    assert_eq!(library, lib);
                }
                other => panic!("{declared:?}: expected ManifestAbiMismatch, got {other:?}"),
            }
        }
        // An incompatible library is reported as incompatible first, whatever
        // the manifest says.
        assert!(
            check_library_abi(AbiVersion::new(1, 3), HOST_1_2, Some("1.3"))
                .unwrap_err()
                .is_incompatible()
        );
    }

    // --- Toolchain rule (PLG-013, #3576) ---

    fn info_with(abi: AbiVersion, toolchain: Option<Toolchain>) -> LoadedPluginInfo {
        LoadedPluginInfo {
            id: "t".into(),
            name: "T".into(),
            version: "0".into(),
            abi_version: abi,
            toolchain,
        }
    }

    #[test]
    fn toolchain_rule_matrix() {
        let host = Toolchain::current();
        let v1_1 = AbiVersion::new(1, 1);
        // Exact match loads, with or without the 1.0 acceptance.
        for accept in [false, true] {
            assert!(
                check_library_toolchain(&info_with(v1_1, Some(host.clone())), &host, accept)
                    .is_ok()
            );
        }
        // A mismatch or an unknown record is refused even with the acceptance:
        // it only ever covers a 1.0 plugin that cannot report one.
        let other = Toolchain {
            rustc: "0.0.1 (abc)".into(),
            ..host.clone()
        };
        let unknown = Toolchain {
            rustc: String::new(),
            ..host.clone()
        };
        for plugin in [other, unknown] {
            for accept in [false, true] {
                let err =
                    check_library_toolchain(&info_with(v1_1, Some(plugin.clone())), &host, accept)
                        .unwrap_err();
                assert!(
                    matches!(err, HostError::IncompatibleToolchain(_)),
                    "{err:?}"
                );
                assert!(err.is_incompatible());
            }
        }
        // A 1.0 plugin (no record) needs the explicit acceptance.
        let v1_0 = info_with(AbiVersion::new(1, 0), None);
        let err = check_library_toolchain(&v1_0, &host, false).unwrap_err();
        assert!(
            matches!(err, HostError::UnverifiedToolchain { abi } if abi == AbiVersion::new(1, 0))
        );
        assert!(!err.is_incompatible());
        assert!(
            err.to_string().contains("accept the unverified toolchain"),
            "{err}"
        );
        assert!(check_library_toolchain(&v1_0, &host, true).is_ok());
    }
}

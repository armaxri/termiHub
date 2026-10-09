//! The **native-plugin trust gate**: a default-OFF global switch plus a
//! per-plugin, library-hash-bound trust acknowledgment (SEC-002 / PLG-006 /
//! ARCH-008).
//!
//! # Why this exists
//!
//! A native plugin backend is third-party native code. It runs in its own
//! sandboxed runner process ([`super::host::PluginHost`], ADR-19), which limits
//! what it can *reach* — but not what it *shows* in its terminal, and reduced
//! isolation on some hosts is possible. Before this gate, a native plugin
//! loaded automatically as soon as it was installed and enabled — an
//! **inverted trust model** where install-time consent silently authorized
//! arbitrary native code on every later launch.
//!
//! This module inverts that back to *explicit, fail-closed* consent:
//!
//! 1. **Default-OFF global gate.** No native plugin loads at all unless the user
//!    has turned native plugins on ([`NativeTrustStore::is_native_enabled`],
//!    default `false`). Sandboxed-JS / theme (frontend-only) plugins are a
//!    different surface and are unaffected — they never reach this gate.
//! 2. **Per-plugin trust acknowledgment, bound to the exact binary.** Even with
//!    native plugins enabled globally, a *specific* plugin loads only after the
//!    user has acknowledged trust for it, and that acknowledgment is keyed by the
//!    plugin id **and** a SHA-256 content hash of the library. A different or
//!    modified binary does not inherit an old acknowledgment
//!    ([`NativeTrustStore::is_acknowledged`]).
//! 3. **…and to the access the user approved** (#4294). The acknowledgment also
//!    records the [`ApprovedAccess`] the manifest requested when the user
//!    trusted the plugin: its permissions, its normalised `filesystemPaths` and
//!    its `connectionPolicy`. A load is authorized only when the installed
//!    manifest still requests **exactly** that access, so an update or a
//!    reinstall that widens it (adds `network`, a new folder, …) needs fresh
//!    consent. Narrowing needs re-approval too: an exact match is the only
//!    comparison that cannot be fooled by path spelling, symlinks, or another
//!    platform's path form, and the cost is one extra click.
//!    An acknowledgment recorded before this field existed carries no approved
//!    access and therefore fails closed ([`AckStatus::AccessNotRecorded`]).
//!
//! Every check **fails closed**: a missing setting, a missing or stale
//! acknowledgment, a hash mismatch, or an unreadable/corrupt store all resolve to
//! "do not load". A ventilator-grade defect here would be loading an
//! *un*acknowledged native plugin, so ambiguity always denies.
//!
//! # Out of scope
//!
//! The OS-level native sandbox (deferred to pre-v1.0) and the per-plugin
//! capability ceiling (PLG-004) are **not** implemented here — this module is the
//! trust *decision* only, not runtime confinement.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::manifest::{parse_manifest, ConnectionPolicyManifest, PluginManifest, PluginPermission};
use super::package::MANIFEST_FILE_NAME;
use super::signature::now_rfc3339;
use crate::util::persist::{self, OverwriteError};

/// The file, alongside the manager's other plugin state files under the plugins
/// root, that persists the native-plugin trust decisions.
pub const NATIVE_TRUST_FILE_NAME: &str = "native-plugin-trust.json";

/// The schema version of the native trust file this build reads and writes
/// (#4334). An unversioned file is the original v1 shape.
const NATIVE_TRUST_VERSION: u32 = 1;

/// The plain-language informed-consent disclosure the trust-acknowledgment
/// surface shows when native plugins run **out of process in the OS sandbox**
/// (plugin OS-sandbox concept, phase 6, #4188).
///
/// It is honest about both halves: the sandbox limits what a plugin can
/// *reach* (its own data folder plus the access its manifest lists, every
/// network or file request checked by termiHub), but not what it *shows* — a
/// trusted plugin still draws its own terminal and could phish there. The
/// frontend renders this verbatim so the disclosure and the gate cannot drift.
pub const NATIVE_TRUST_DISCLOSURE: &str = "Native plugins run in a separate, sandboxed process. \
     A plugin can only use its own data folder and the access listed below; termiHub checks every \
     network or file request it makes. Only trust plugins from sources you trust: a plugin still \
     controls what appears in its terminal.";

/// Errors persisting the native-plugin trust store. Read failures never surface
/// as an error — an unreadable store **fails closed** to "nothing trusted" (see
/// [`NativeTrustStore::load`]) — so this covers only the write path.
#[derive(Debug, Error)]
pub enum NativeTrustError {
    /// A filesystem operation on the store failed.
    #[error("native-plugin trust-store I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// The store document could not be serialized.
    #[error("native-plugin trust-store serialization error: {0}")]
    Serde(String),

    /// The file on disk may not be overwritten: a newer schema wrote it, or it
    /// is corrupt and could not be backed up (#4334).
    #[error(transparent)]
    Refused(#[from] OverwriteError),
}

/// One per-plugin trust acknowledgment, bound to the exact library bytes the user
/// consented to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAck {
    /// SHA-256 (hex) of the backend library file at the moment it was
    /// acknowledged. A load is authorized only when the on-disk library still
    /// hashes to this — so a swapped or updated binary is *not* covered by the
    /// old acknowledgment and must be re-acknowledged.
    pub library_sha256: String,
    /// RFC 3339-ish timestamp the acknowledgment was recorded. Informational.
    pub acknowledged_at: String,
    /// Whether the user **explicitly accepted** that this plugin's build
    /// toolchain cannot be verified (#3576, ADR-15). Only a plugin built for
    /// native ABI 1.0 needs this: it predates the toolchain record, so the host
    /// cannot prove it was built with a compatible compiler and panic strategy,
    /// and refuses it unless this is set. **Absent → `false`** (fail closed),
    /// including for every acknowledgment recorded before the field existed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unverified_toolchain_accepted: bool,
    /// Whether the user **explicitly accepted** that this system cannot apply
    /// every OS sandbox layer to this plugin (plugin OS-sandbox concept,
    /// "Trust after the sandbox", #4188) — for example Linux without landlock,
    /// where file access cannot be restricted. Without it the host refuses a
    /// plugin whose runner reports reduced isolation. Same fail-closed rules as
    /// [`unverified_toolchain_accepted`](Self::unverified_toolchain_accepted):
    /// **absent → `false`**, a plain or older acknowledgment never carries it,
    /// and a changed binary loses it with the rest of the acknowledgment.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reduced_isolation_accepted: bool,
    /// The access the manifest requested when the user acknowledged trust
    /// (#4294). A load is authorized only when the installed manifest requests
    /// exactly this. **Absent → never authorizes**: every acknowledgment
    /// recorded before the field existed fails closed and must be reviewed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_access: Option<ApprovedAccess>,
}

impl NativeAck {
    /// How this acknowledgment relates to the plugin as it is installed now,
    /// described by `binding`. Ignores the global native-plugin switch.
    #[must_use]
    pub fn status(&self, binding: &TrustBinding) -> AckStatus {
        match &self.approved_access {
            None => AckStatus::AccessNotRecorded,
            Some(approved) if *approved != binding.access => AckStatus::AccessChanged,
            Some(_) if self.library_sha256 != binding.library_sha256 => AckStatus::LibraryChanged,
            Some(_) => AckStatus::Current,
        }
    }
}

/// How a recorded acknowledgment relates to the installed plugin (#4294).
/// Only [`Current`](Self::Current) authorizes a load; every other state needs
/// the user to review and trust the plugin again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AckStatus {
    /// Same library bytes and exactly the approved access.
    Current,
    /// The library changed since the user trusted it; the access did not.
    LibraryChanged,
    /// The manifest now requests different access than the user approved.
    AccessChanged,
    /// The acknowledgment predates access binding, so what the user approved
    /// is unknown. Fails closed.
    AccessNotRecorded,
}

/// The access a native plugin's manifest requests, in a canonical form so two
/// manifests asking for the same access compare equal (#4294).
///
/// This is what the trust surface shows the user ("the access listed below"),
/// and what a trust acknowledgment binds to next to the library hash.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedAccess {
    /// The requested permissions, sorted and without duplicates.
    #[serde(default)]
    pub permissions: Vec<PluginPermission>,
    /// The declared `filesystemPaths`, normalised by
    /// [`normalize_declared_path`], sorted and without duplicates.
    #[serde(default)]
    pub filesystem_paths: Vec<String>,
    /// The declared `connectionPolicy`, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_policy: Option<ConnectionPolicyManifest>,
}

impl ApprovedAccess {
    /// The access `manifest` requests, in canonical form.
    #[must_use]
    pub fn from_manifest(manifest: &PluginManifest) -> Self {
        let mut permissions = manifest.permissions.clone();
        permissions.sort();
        permissions.dedup();
        let mut filesystem_paths: Vec<String> = manifest
            .filesystem_paths
            .iter()
            .map(|p| normalize_declared_path(p))
            .collect();
        filesystem_paths.sort();
        filesystem_paths.dedup();
        Self {
            permissions,
            filesystem_paths,
            connection_policy: manifest.connection_policy.clone(),
        }
    }

    /// What `self` requests that `approved` did not, as short labels for the
    /// trust surface: permission names, folder paths, and `connection policy`
    /// when that changed. `approved = None` (an acknowledgment that predates
    /// access binding) lists everything requested.
    #[must_use]
    pub fn added_since(&self, approved: Option<&Self>) -> Vec<String> {
        let empty = Self::default();
        let approved = approved.unwrap_or(&empty);
        let mut added: Vec<String> = self
            .permissions
            .iter()
            .filter(|p| !approved.permissions.contains(p))
            .map(|p| permission_name(*p).to_owned())
            .collect();
        added.extend(
            self.filesystem_paths
                .iter()
                .filter(|p| !approved.filesystem_paths.contains(p))
                .cloned(),
        );
        if self.connection_policy.is_some() && self.connection_policy != approved.connection_policy
        {
            added.push("connection policy".to_owned());
        }
        added
    }
}

/// The manifest name of `permission` (`"network"`, …).
fn permission_name(permission: PluginPermission) -> &'static str {
    match permission {
        PluginPermission::Terminal => "terminal",
        PluginPermission::Network => "network",
        PluginPermission::Filesystem => "filesystem",
        PluginPermission::Ui => "ui",
        PluginPermission::Settings => "settings",
    }
}

/// The canonical spelling of a declared `filesystemPaths` entry, so that the
/// same folder written two ways (`/data/app/` and `/data/app`, `c:/Logs` and
/// `C:\Logs`) binds to one approval (#4294).
///
/// Purely textual and host-independent, like
/// [`check_declared_filesystem_path`](super::check_declared_filesystem_path):
/// repeated separators collapse, a trailing separator is dropped, and a Windows
/// form (drive letter or `\\server\share`) uses `\` with an upper-case drive
/// letter. An entry that fails validation is kept verbatim (the loader refuses
/// it anyway). Case is otherwise kept, so a case change asks again — the
/// fail-closed direction.
#[must_use]
pub fn normalize_declared_path(raw: &str) -> String {
    if super::check_declared_filesystem_path(raw).is_err() {
        return raw.to_owned();
    }
    let bytes = raw.as_bytes();
    let unc = raw.starts_with("\\\\") || raw.starts_with("//");
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if unc || drive {
        let (prefix, rest) = if unc {
            ("\\\\".to_owned(), &raw[2..])
        } else {
            (
                format!("{}:\\", char::from(bytes[0].to_ascii_uppercase())),
                &raw[2..],
            )
        };
        let segments: Vec<&str> = rest.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
        format!("{prefix}{}", segments.join("\\"))
    } else {
        let segments: Vec<&str> = raw.split('/').filter(|s| !s.is_empty()).collect();
        format!("/{}", segments.join("/"))
    }
}

/// What a trust acknowledgment is checked against: the hash of the library
/// that will load and the access the installed manifest requests (#4294).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustBinding {
    /// SHA-256 (hex) of the backend library this host would load.
    pub library_sha256: String,
    /// The access the installed manifest requests.
    pub access: ApprovedAccess,
}

impl TrustBinding {
    /// A binding for `library_sha256` and the access `manifest` requests.
    #[must_use]
    pub fn new(library_sha256: impl Into<String>, manifest: &PluginManifest) -> Self {
        Self {
            library_sha256: library_sha256.into(),
            access: ApprovedAccess::from_manifest(manifest),
        }
    }
}

/// The explicit risk acceptances a trust acknowledgment records alongside the
/// library hash. Both default to `false` (fail closed).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AckAcceptances {
    /// Accept an unverifiable (ABI 1.0) build toolchain (#3576).
    pub unverified_toolchain: bool,
    /// Accept reduced OS-sandbox isolation on this system (#4188).
    pub reduced_isolation: bool,
}

/// The persisted `native-plugin-trust.json` document: the global default-OFF
/// switch plus the per-plugin acknowledgments keyed by plugin id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeTrustDoc {
    /// Schema version, gated by [`crate::util::persist`]; absent → v1.
    #[serde(default = "native_trust_version")]
    version: u32,
    /// Whether native plugins may load at all. **Absent → `false`**:
    /// the default, and every fail-closed path, is "native plugins off".
    #[serde(default)]
    native_plugins_enabled: bool,
    /// Per-plugin acknowledgments, keyed by plugin id.
    #[serde(default)]
    acks: BTreeMap<String, NativeAck>,
    /// Unknown top-level fields, carried forward unchanged.
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

fn native_trust_version() -> u32 {
    NATIVE_TRUST_VERSION
}

impl Default for NativeTrustDoc {
    fn default() -> Self {
        Self {
            version: NATIVE_TRUST_VERSION,
            native_plugins_enabled: false,
            acks: BTreeMap::new(),
            extra: serde_json::Map::new(),
        }
    }
}

/// Parse a native trust document, **failing closed** to the all-off default
/// for anything this build must not act on: unparseable, the wrong shape, or
/// written by a newer schema (whose consent semantics this build cannot know).
/// Saves over such a file are gated by [`persist::prepare_overwrite`]: a
/// newer file is never overwritten and a corrupt one is backed up first.
fn parse_native_trust_doc(raw: &str) -> NativeTrustDoc {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return NativeTrustDoc::default();
    };
    if persist::check_version(&value, NATIVE_TRUST_FILE_NAME, NATIVE_TRUST_VERSION).is_err() {
        return NativeTrustDoc::default();
    }
    serde_json::from_value(value).unwrap_or_default()
}

/// The native-plugin trust store: the global enable flag plus per-plugin,
/// hash-bound acknowledgments, backed by a JSON file under the plugins root.
///
/// Load is **infallible and fails closed**: a missing, unreadable, or corrupt
/// store yields "native plugins disabled, nothing acknowledged" rather than an
/// error, so a damaged file can never accidentally authorize a native plugin.
#[derive(Debug, Clone)]
pub struct NativeTrustStore {
    path: PathBuf,
    doc: NativeTrustDoc,
}

impl NativeTrustStore {
    /// Load the store rooted at `plugins_root` (its file is
    /// `plugins_root/native-plugin-trust.json`).
    ///
    /// **Fails closed:** a missing file, an I/O error, or an unparseable document
    /// all resolve to the default (native plugins disabled, no acknowledgments) —
    /// never an authorization. This is deliberately infallible so a corrupt store
    /// degrades to the *safe* state instead of leaving callers to decide.
    #[must_use]
    pub fn load(plugins_root: &Path) -> Self {
        let path = plugins_root.join(NATIVE_TRUST_FILE_NAME);
        let doc = match std::fs::read_to_string(&path) {
            Ok(s) => parse_native_trust_doc(&s),
            // Missing file or any read error → the safe default (all-off).
            Err(_) => NativeTrustDoc::default(),
        };
        Self { path, doc }
    }

    /// Whether native plugins are enabled globally. `false` by
    /// default and whenever the store could not be read.
    #[must_use]
    pub fn is_native_enabled(&self) -> bool {
        self.doc.native_plugins_enabled
    }

    /// Whether plugin `id` is acknowledged **for exactly this binding**: the
    /// same library hash and exactly the access the user approved (#4294).
    ///
    /// Returns `false` when native plugins are disabled globally, when there is no
    /// acknowledgment for `id`, or when it is not [`AckStatus::Current`] — a
    /// swapped/updated binary, a manifest requesting different access, or an
    /// acknowledgment recorded before access binding existed. Both the global
    /// flag and a current acknowledgment must hold for a native plugin to load;
    /// this is the fail-closed per-plugin half.
    #[must_use]
    pub fn is_acknowledged(&self, id: &str, binding: &TrustBinding) -> bool {
        self.current_ack(id, binding).is_some()
    }

    /// How plugin `id`'s acknowledgment relates to `binding`, or `None` when
    /// there is none. Ignores the global switch — for the Settings row, which
    /// must say "needs re-approval" rather than "trusted" for a stale one.
    #[must_use]
    pub fn ack_status(&self, id: &str, binding: &TrustBinding) -> Option<AckStatus> {
        self.doc.acks.get(id).map(|ack| ack.status(binding))
    }

    /// The acknowledgment for `id` when native plugins are on and it is current
    /// for `binding`.
    fn current_ack(&self, id: &str, binding: &TrustBinding) -> Option<&NativeAck> {
        if !self.doc.native_plugins_enabled {
            return None;
        }
        self.doc
            .acks
            .get(id)
            .filter(|ack| ack.status(binding) == AckStatus::Current)
    }

    /// Whether plugin `id`'s current acknowledgment for `binding` also records
    /// the user's explicit acceptance of an **unverifiable build toolchain**
    /// (ABI 1.0 plugins, #3576). Implies
    /// [`is_acknowledged`](Self::is_acknowledged); `false` in every other case.
    #[must_use]
    pub fn accepts_unverified_toolchain(&self, id: &str, binding: &TrustBinding) -> bool {
        self.current_ack(id, binding)
            .is_some_and(|ack| ack.unverified_toolchain_accepted)
    }

    /// Whether plugin `id`'s current acknowledgment for `binding` also records
    /// the user's explicit acceptance of **reduced sandbox isolation** (#4188).
    /// Implies [`is_acknowledged`](Self::is_acknowledged); `false` in every
    /// other case, including while native plugins are off.
    #[must_use]
    pub fn accepts_reduced_isolation(&self, id: &str, binding: &TrustBinding) -> bool {
        self.current_ack(id, binding)
            .is_some_and(|ack| ack.reduced_isolation_accepted)
    }

    /// The acknowledgment recorded for `id`, if any (regardless of the global
    /// flag) — for the settings surface that lists trusted native plugins.
    #[must_use]
    pub fn ack(&self, id: &str) -> Option<&NativeAck> {
        self.doc.acks.get(id)
    }

    /// Every recorded acknowledgment as `(plugin id, ack)` pairs, sorted by id —
    /// for the settings surface.
    #[must_use]
    pub fn acknowledgments(&self) -> Vec<(String, NativeAck)> {
        self.doc
            .acks
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Turn the global native-plugin switch on or off and persist. Turning it off
    /// leaves per-plugin acknowledgments intact (so re-enabling does not require
    /// re-acknowledging every plugin) but immediately denies every load while off.
    pub fn set_native_enabled(&mut self, enabled: bool) -> Result<(), NativeTrustError> {
        self.doc.native_plugins_enabled = enabled;
        self.save()
    }

    /// Record (or refresh) the trust acknowledgment for `id`, binding it to the
    /// library hash and the access in `binding`, and persist. Re-acknowledging
    /// replaces the old acknowledgment — the mechanism by which a user re-trusts
    /// a plugin after its library or its requested access legitimately changed.
    ///
    /// A plain acknowledgment does **not** accept an unverifiable build
    /// toolchain; see [`acknowledge_with_toolchain_acceptance`](Self::acknowledge_with_toolchain_acceptance).
    pub fn acknowledge(
        &mut self,
        id: &str,
        binding: &TrustBinding,
    ) -> Result<(), NativeTrustError> {
        self.acknowledge_with_toolchain_acceptance(id, binding, false)
    }

    /// [`acknowledge`](Self::acknowledge), additionally recording whether the
    /// user explicitly accepted that the plugin's build toolchain cannot be
    /// verified (an ABI 1.0 plugin — #3576, ADR-15). The acceptance is part of
    /// the bound acknowledgment, so a changed binary or access loses it too.
    pub fn acknowledge_with_toolchain_acceptance(
        &mut self,
        id: &str,
        binding: &TrustBinding,
        accept_unverified_toolchain: bool,
    ) -> Result<(), NativeTrustError> {
        self.acknowledge_with(
            id,
            binding,
            AckAcceptances {
                unverified_toolchain: accept_unverified_toolchain,
                reduced_isolation: false,
            },
        )
    }

    /// Record (or refresh) the trust acknowledgment for `id` bound to
    /// `binding`, together with the explicit risk `acceptances`, and persist.
    /// Every acceptance is part of the bound acknowledgment, so a changed
    /// binary or access loses all of them; re-acknowledging replaces them.
    pub fn acknowledge_with(
        &mut self,
        id: &str,
        binding: &TrustBinding,
        acceptances: AckAcceptances,
    ) -> Result<(), NativeTrustError> {
        self.doc.acks.insert(
            id.to_owned(),
            NativeAck {
                library_sha256: binding.library_sha256.clone(),
                acknowledged_at: now_rfc3339(),
                unverified_toolchain_accepted: acceptances.unverified_toolchain,
                reduced_isolation_accepted: acceptances.reduced_isolation,
                approved_access: Some(binding.access.clone()),
            },
        );
        self.save()
    }

    /// Remove the acknowledgment for `id` (revoke trust) and persist. An unknown
    /// id is a no-op. The next load attempt for that plugin fails closed.
    pub fn revoke(&mut self, id: &str) -> Result<(), NativeTrustError> {
        if self.doc.acks.remove(id).is_some() {
            self.save()?;
        }
        Ok(())
    }

    /// Persist the document through the shared layer (#4334): refused over a
    /// file a newer schema wrote, a corrupt file is backed up first, and the
    /// bytes land via a unique fsynced temp file renamed over the target.
    fn save(&self) -> Result<(), NativeTrustError> {
        persist::prepare_overwrite::<NativeTrustDoc>(
            &self.path,
            NATIVE_TRUST_FILE_NAME,
            NATIVE_TRUST_VERSION,
        )?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut doc = self.doc.clone();
        doc.version = NATIVE_TRUST_VERSION;
        let json = serde_json::to_string_pretty(&doc)
            .map_err(|e| NativeTrustError::Serde(e.to_string()))?;
        persist::write_atomic(&self.path, json)?;
        Ok(())
    }
}

/// Compute the SHA-256 (hex) of the backend library an installed native plugin
/// would load, so callers can bind a trust acknowledgment to the exact bytes.
///
/// Resolves the plugin's backend library the same way the host loader does
/// ([`super::host::select_backend_library`]) under `plugins_root/<id>/`: for a
/// multi-platform package (PLG-011) that is the entry for **this host's** target
/// triple from the installed manifest, so the acknowledgment binds to the
/// library that will actually be loaded — never another platform's. A plugin
/// dir without a `manifest.json` falls back to the legacy extension scan. Fails
/// when the manifest is unreadable, the plugin has no backend library (not a
/// native plugin, an ambiguous/missing library, or no entry for this platform)
/// or the file cannot be read — callers must treat a failure as "cannot
/// acknowledge", never as consent.
pub fn native_library_hash(plugins_root: &Path, id: &str) -> Result<String, NativeTrustError> {
    let plugin_dir = plugins_root.join(id);
    let not_found =
        |msg: String| NativeTrustError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, msg));
    let lib_path = match std::fs::read_to_string(plugin_dir.join(MANIFEST_FILE_NAME)) {
        Ok(json) => {
            let manifest = parse_manifest(&json).map_err(|e| not_found(e.to_string()))?;
            let backend = manifest
                .extensions
                .terminal_backend
                .ok_or_else(|| not_found(format!("plugin `{id}` declares no native backend")))?;
            super::host::select_backend_library(&plugin_dir, &backend)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            super::host::find_backend_library(&plugin_dir)
        }
        Err(e) => return Err(NativeTrustError::Io(e)),
    }
    .map_err(|e| not_found(e.to_string()))?;
    super::signature::sha256_file(&lib_path).map_err(NativeTrustError::Io)
}

/// The [`TrustBinding`] of the installed native plugin `id`: the hash of the
/// backend library this host would load plus the access its installed
/// manifest requests (#4294). What the trust surface acknowledges and the
/// Settings row compares a recorded acknowledgment against.
///
/// Fails when the plugin has no readable, valid manifest or no backend
/// library for this host — callers must treat a failure as "cannot
/// acknowledge", never as consent.
pub fn native_trust_binding(
    plugins_root: &Path,
    id: &str,
) -> Result<TrustBinding, NativeTrustError> {
    let plugin_dir = plugins_root.join(id);
    let not_found =
        |msg: String| NativeTrustError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, msg));
    let json = std::fs::read_to_string(plugin_dir.join(MANIFEST_FILE_NAME))?;
    let manifest = parse_manifest(&json).map_err(|e| not_found(e.to_string()))?;
    let library_sha256 = native_library_hash(plugins_root, id)?;
    Ok(TrustBinding::new(library_sha256, &manifest))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A binding to library `hash` for a plugin requesting `terminal` only.
    fn b(hash: &str) -> TrustBinding {
        TrustBinding {
            library_sha256: hash.to_owned(),
            access: ApprovedAccess {
                permissions: vec![PluginPermission::Terminal],
                ..ApprovedAccess::default()
            },
        }
    }

    #[test]
    fn native_plugins_are_disabled_by_default() {
        let tmp = tempfile::TempDir::new().unwrap();
        // No store on disk at all: the default must be off.
        let store = NativeTrustStore::load(tmp.path());
        assert!(
            !store.is_native_enabled(),
            "native plugins must be OFF by default (fail closed)"
        );
        assert!(!store.is_acknowledged("anything", &b("deadbeef")));
    }

    #[test]
    fn enabling_persists_across_reload() {
        let tmp = tempfile::TempDir::new().unwrap();
        {
            let mut store = NativeTrustStore::load(tmp.path());
            store.set_native_enabled(true).unwrap();
        }
        let reloaded = NativeTrustStore::load(tmp.path());
        assert!(reloaded.is_native_enabled());
    }

    #[test]
    fn acknowledgment_is_bound_to_the_exact_hash() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut store = NativeTrustStore::load(tmp.path());
        store.set_native_enabled(true).unwrap();
        store.acknowledge("echo", &b("hash-A")).unwrap();

        // The exact acknowledged hash is trusted…
        assert!(store.is_acknowledged("echo", &b("hash-A")));
        // …but a different (modified/swapped) binary is NOT — the ack does not
        // transfer to changed bytes (stale acknowledgment).
        assert!(!store.is_acknowledged("echo", &b("hash-B")));
        // …and an unrelated plugin id is not trusted either.
        assert!(!store.is_acknowledged("other", &b("hash-A")));
    }

    #[test]
    fn acknowledgment_requires_the_global_flag() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut store = NativeTrustStore::load(tmp.path());
        // Acknowledge without enabling the global switch: still not authorized,
        // because BOTH the global flag and the per-plugin ack must hold.
        store.acknowledge("echo", &b("hash-A")).unwrap();
        assert!(!store.is_native_enabled());
        assert!(
            !store.is_acknowledged("echo", &b("hash-A")),
            "a per-plugin ack must not authorize a load while native plugins are globally off"
        );

        // Turning the global switch on makes the existing ack effective.
        store.set_native_enabled(true).unwrap();
        assert!(store.is_acknowledged("echo", &b("hash-A")));
    }

    #[test]
    fn unverified_toolchain_acceptance_is_explicit_hash_bound_and_persisted() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut store = NativeTrustStore::load(tmp.path());
        store.set_native_enabled(true).unwrap();

        // A plain acknowledgment does NOT accept an unverifiable toolchain
        // (ABI 1.0 plugins, #3576): the default fails closed.
        store.acknowledge("old", &b("hash-A")).unwrap();
        assert!(store.is_acknowledged("old", &b("hash-A")));
        assert!(!store.accepts_unverified_toolchain("old", &b("hash-A")));

        // The explicit acceptance is recorded and bound to the same hash.
        store
            .acknowledge_with_toolchain_acceptance("old", &b("hash-A"), true)
            .unwrap();
        assert!(store.accepts_unverified_toolchain("old", &b("hash-A")));
        assert!(!store.accepts_unverified_toolchain("old", &b("hash-B")));
        assert!(!store.accepts_unverified_toolchain("other", &b("hash-A")));

        // It survives a reload…
        let reloaded = NativeTrustStore::load(tmp.path());
        assert!(reloaded.accepts_unverified_toolchain("old", &b("hash-A")));

        // …is withdrawn by a plain re-acknowledgment…
        store.acknowledge("old", &b("hash-A")).unwrap();
        assert!(!store.accepts_unverified_toolchain("old", &b("hash-A")));

        // …and never authorizes anything while native plugins are off.
        store
            .acknowledge_with_toolchain_acceptance("old", &b("hash-A"), true)
            .unwrap();
        store.set_native_enabled(false).unwrap();
        assert!(!store.accepts_unverified_toolchain("old", &b("hash-A")));
    }

    #[test]
    fn reduced_isolation_acceptance_is_explicit_hash_bound_and_persisted() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut store = NativeTrustStore::load(tmp.path());
        store.set_native_enabled(true).unwrap();

        // A plain acknowledgment never accepts reduced isolation (#4188).
        store.acknowledge("p", &b("hash-A")).unwrap();
        assert!(!store.accepts_reduced_isolation("p", &b("hash-A")));
        // Neither does a toolchain-only acceptance.
        store
            .acknowledge_with_toolchain_acceptance("p", &b("hash-A"), true)
            .unwrap();
        assert!(!store.accepts_reduced_isolation("p", &b("hash-A")));

        let both = AckAcceptances {
            unverified_toolchain: true,
            reduced_isolation: true,
        };
        store.acknowledge_with("p", &b("hash-A"), both).unwrap();
        assert!(store.accepts_reduced_isolation("p", &b("hash-A")));
        assert!(store.accepts_unverified_toolchain("p", &b("hash-A")));
        // Bound to the exact library and plugin.
        assert!(!store.accepts_reduced_isolation("p", &b("hash-B")));
        assert!(!store.accepts_reduced_isolation("other", &b("hash-A")));

        // Survives a reload, and serialises under the concept's field name.
        let reloaded = NativeTrustStore::load(tmp.path());
        assert!(reloaded.accepts_reduced_isolation("p", &b("hash-A")));
        let raw = std::fs::read_to_string(tmp.path().join(NATIVE_TRUST_FILE_NAME)).unwrap();
        assert!(raw.contains("\"reducedIsolationAccepted\": true"), "{raw}");

        // Withdrawn by a plain re-acknowledgment, and void while native plugins are off.
        store.acknowledge("p", &b("hash-A")).unwrap();
        assert!(!store.accepts_reduced_isolation("p", &b("hash-A")));
        store.acknowledge_with("p", &b("hash-A"), both).unwrap();
        store.set_native_enabled(false).unwrap();
        assert!(!store.accepts_reduced_isolation("p", &b("hash-A")));
    }

    /// Migration (#4294): an acknowledgment recorded before access binding —
    /// with or without the later acceptance fields — carries no approved
    /// access, so it never authorizes a load and reads as "needs review".
    #[test]
    fn an_acknowledgment_without_approved_access_fails_closed() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join(NATIVE_TRUST_FILE_NAME),
            r#"{"nativePluginsEnabled":true,"acks":{
                "old":{"librarySha256":"hash-A","acknowledgedAt":"t"},
                "p":{"librarySha256":"h","acknowledgedAt":"t",
                     "unverifiedToolchainAccepted":true,"reducedIsolationAccepted":true}}}"#,
        )
        .unwrap();
        let store = NativeTrustStore::load(tmp.path());
        assert!(store.is_native_enabled(), "the global switch is kept");
        for (id, hash) in [("old", "hash-A"), ("p", "h")] {
            assert!(
                !store.is_acknowledged(id, &b(hash)),
                "{id} must fail closed"
            );
            assert!(!store.accepts_unverified_toolchain(id, &b(hash)));
            assert!(!store.accepts_reduced_isolation(id, &b(hash)));
            assert_eq!(
                store.ack_status(id, &b(hash)),
                Some(AckStatus::AccessNotRecorded)
            );
        }
        // The record itself is kept, so the Settings row can offer a review.
        assert_eq!(store.acknowledgments().len(), 2);
    }

    /// A manifest for a native plugin requesting `permissions` (JSON array)
    /// with optional `filesystemPaths` and `connectionPolicy` (JSON values).
    fn manifest(permissions: &str, paths: Option<&str>, policy: Option<&str>) -> PluginManifest {
        let mut extra = String::new();
        if let Some(paths) = paths {
            extra.push_str(&format!(r#""filesystemPaths": {paths},"#));
        }
        if let Some(policy) = policy {
            extra.push_str(&format!(r#""connectionPolicy": {policy},"#));
        }
        parse_manifest(&format!(
            r#"{{
                "id": "p", "name": "P", "version": "1.0.0", "author": "a",
                "description": "d", "license": "MIT", "apiVersion": "1.1",
                "platforms": ["linux", "macos", "windows"],
                "permissions": {permissions}, {extra}
                "extensions": {{ "terminalBackend": {{
                    "connectionType": "p", "displayName": "P", "configSchema": {{}}
                }} }}
            }}"#
        ))
        .expect("test manifest parses")
    }

    /// A store with native plugins on and `p` acknowledged for `binding`.
    fn trusted(binding: &TrustBinding) -> (tempfile::TempDir, NativeTrustStore) {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut store = NativeTrustStore::load(tmp.path());
        store.set_native_enabled(true).unwrap();
        store.acknowledge("p", binding).unwrap();
        (tmp, store)
    }

    #[test]
    fn trust_survives_an_update_requesting_identical_access() {
        let v1 = manifest(
            r#"["terminal", "filesystem"]"#,
            Some(r#"["/data/b", "/data/a/"]"#),
            Some(r#"{"maxConnections": 2}"#),
        );
        let (tmp, store) = trusted(&TrustBinding::new("hash-A", &v1));
        // Same access, listed in another order and spelling, same library.
        let v2 = manifest(
            r#"["filesystem", "terminal", "terminal"]"#,
            Some(r#"["/data/a", "/data//b/"]"#),
            Some(r#"{"maxConnections": 2}"#),
        );
        let same = TrustBinding::new("hash-A", &v2);
        assert!(store.is_acknowledged("p", &same));
        assert_eq!(store.ack_status("p", &same), Some(AckStatus::Current));
        // Also after a reload: the approved access is persisted.
        assert!(NativeTrustStore::load(tmp.path()).is_acknowledged("p", &same));
        let raw = std::fs::read_to_string(tmp.path().join(NATIVE_TRUST_FILE_NAME)).unwrap();
        assert!(raw.contains("\"approvedAccess\""), "{raw}");
        assert!(raw.contains("\"/data/a\""), "{raw}");
    }

    #[test]
    fn an_added_permission_invalidates_trust() {
        let (_tmp, store) = trusted(&TrustBinding::new(
            "hash-A",
            &manifest(r#"["terminal"]"#, None, None),
        ));
        // Same library, but the update adds `network`.
        let wider = TrustBinding::new(
            "hash-A",
            &manifest(r#"["terminal", "network"]"#, None, None),
        );
        assert!(!store.is_acknowledged("p", &wider));
        assert!(!store.accepts_unverified_toolchain("p", &wider));
        assert!(!store.accepts_reduced_isolation("p", &wider));
        assert_eq!(
            store.ack_status("p", &wider),
            Some(AckStatus::AccessChanged)
        );
        let approved = store.ack("p").unwrap().approved_access.as_ref();
        assert_eq!(
            wider.access.added_since(approved),
            vec!["network".to_owned()]
        );
    }

    #[test]
    fn a_widened_filesystem_path_invalidates_trust() {
        let fs = r#"["terminal", "filesystem"]"#;
        let (_tmp, store) = trusted(&TrustBinding::new(
            "hash-A",
            &manifest(fs, Some(r#"["/data/app/logs"]"#), None),
        ));
        for paths in [
            // The parent of the approved folder.
            r#"["/data/app"]"#,
            // An extra folder next to the approved one.
            r#"["/data/app/logs", "/etc"]"#,
        ] {
            let wider = TrustBinding::new("hash-A", &manifest(fs, Some(paths), None));
            assert!(!store.is_acknowledged("p", &wider), "{paths}");
            assert_eq!(
                store.ack_status("p", &wider),
                Some(AckStatus::AccessChanged)
            );
        }
        let extra = TrustBinding::new(
            "hash-A",
            &manifest(fs, Some(r#"["/data/app/logs", "/etc"]"#), None),
        );
        let approved = store.ack("p").unwrap().approved_access.as_ref();
        assert_eq!(extra.access.added_since(approved), vec!["/etc".to_owned()]);
    }

    #[test]
    fn a_changed_connection_policy_invalidates_trust() {
        let (_tmp, store) = trusted(&TrustBinding::new(
            "hash-A",
            &manifest(r#"["terminal"]"#, None, None),
        ));
        let changed = TrustBinding::new(
            "hash-A",
            &manifest(r#"["terminal"]"#, None, Some(r#"{"maxConnections": 64}"#)),
        );
        assert!(!store.is_acknowledged("p", &changed));
        let approved = store.ack("p").unwrap().approved_access.as_ref();
        assert_eq!(
            changed.access.added_since(approved),
            vec!["connection policy".to_owned()]
        );
    }

    /// Narrowing asks again too (#4294): exact match is the rule, so what was
    /// approved is always exactly what is granted.
    #[test]
    fn narrowed_access_also_needs_review() {
        let (_tmp, store) = trusted(&TrustBinding::new(
            "hash-A",
            &manifest(
                r#"["terminal", "network", "filesystem"]"#,
                Some(r#"["/data/app"]"#),
                None,
            ),
        ));
        let narrower = TrustBinding::new("hash-A", &manifest(r#"["terminal"]"#, None, None));
        assert!(!store.is_acknowledged("p", &narrower));
        assert_eq!(
            store.ack_status("p", &narrower),
            Some(AckStatus::AccessChanged)
        );
        let approved = store.ack("p").unwrap().approved_access.as_ref();
        assert!(narrower.access.added_since(approved).is_empty());
    }

    #[test]
    fn a_changed_library_with_the_same_access_reads_as_library_changed() {
        let m = manifest(r#"["terminal"]"#, None, None);
        let (_tmp, store) = trusted(&TrustBinding::new("hash-A", &m));
        let rebuilt = TrustBinding::new("hash-B", &m);
        assert!(!store.is_acknowledged("p", &rebuilt));
        assert_eq!(
            store.ack_status("p", &rebuilt),
            Some(AckStatus::LibraryChanged)
        );
        assert_eq!(store.ack_status("other", &rebuilt), None);
    }

    #[test]
    fn added_since_without_a_recorded_approval_lists_everything() {
        let access = ApprovedAccess::from_manifest(&manifest(
            r#"["terminal", "filesystem"]"#,
            Some(r#"["/data/app"]"#),
            None,
        ));
        assert_eq!(
            access.added_since(None),
            vec![
                "terminal".to_owned(),
                "filesystem".to_owned(),
                "/data/app".to_owned()
            ]
        );
    }

    #[test]
    fn declared_paths_normalise_to_one_spelling() {
        for (raw, normalised) in [
            ("/data/app", "/data/app"),
            ("/data/app/", "/data/app"),
            ("/data///app//", "/data/app"),
            ("C:\\Logs\\app", "C:\\Logs\\app"),
            ("c:/Logs/app/", "C:\\Logs\\app"),
            ("C:\\\\Logs", "C:\\Logs"),
            ("\\\\srv\\share\\x\\", "\\\\srv\\share\\x"),
            ("//srv/share/x", "\\\\srv\\share\\x"),
            // Invalid entries are kept verbatim; the loader refuses them.
            ("relative/", "relative/"),
            ("/a/../b", "/a/../b"),
        ] {
            assert_eq!(normalize_declared_path(raw), normalised, "{raw:?}");
        }
    }

    #[test]
    fn native_trust_binding_reads_the_installed_manifest_and_library() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        let dir = root.join("p");
        std::fs::create_dir_all(dir.join("backend")).unwrap();
        let lib_name = format!(
            "{}p{}",
            std::env::consts::DLL_PREFIX,
            std::env::consts::DLL_SUFFIX
        );
        let bytes = b"library bytes";
        std::fs::write(dir.join("backend").join(lib_name), bytes).unwrap();
        let m = manifest(r#"["terminal", "network"]"#, None, None);
        std::fs::write(
            dir.join(MANIFEST_FILE_NAME),
            serde_json::to_string(&m).unwrap(),
        )
        .unwrap();

        let binding = native_trust_binding(root, "p").unwrap();
        assert_eq!(
            binding,
            TrustBinding::new(super::super::signature::sha256_digest(bytes), &m)
        );
        // No manifest → cannot acknowledge.
        std::fs::remove_file(dir.join(MANIFEST_FILE_NAME)).unwrap();
        assert!(native_trust_binding(root, "p").is_err());
    }

    #[test]
    fn the_disclosure_describes_the_sandbox() {
        assert!(NATIVE_TRUST_DISCLOSURE.contains("sandboxed process"));
        assert!(NATIVE_TRUST_DISCLOSURE.contains("what appears in its terminal"));
    }

    #[test]
    fn revoke_removes_trust_and_persists() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut store = NativeTrustStore::load(tmp.path());
        store.set_native_enabled(true).unwrap();
        store.acknowledge("echo", &b("hash-A")).unwrap();
        store.revoke("echo").unwrap();
        assert!(!store.is_acknowledged("echo", &b("hash-A")));

        // Revocation survives a reload; the global flag is untouched.
        let reloaded = NativeTrustStore::load(tmp.path());
        assert!(reloaded.is_native_enabled());
        assert!(!reloaded.is_acknowledged("echo", &b("hash-A")));
        assert!(reloaded.ack("echo").is_none());
    }

    #[test]
    fn revoke_unknown_id_is_a_noop() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut store = NativeTrustStore::load(tmp.path());
        assert!(store.revoke("ghost").is_ok());
    }

    #[test]
    fn a_corrupt_store_fails_closed() {
        let tmp = tempfile::TempDir::new().unwrap();
        // A garbage file must not throw and must degrade to the safe (all-off)
        // state, never to "enabled" or "acknowledged".
        std::fs::write(
            tmp.path().join(NATIVE_TRUST_FILE_NAME),
            b"{ not valid json ][",
        )
        .unwrap();
        let store = NativeTrustStore::load(tmp.path());
        assert!(!store.is_native_enabled());
        assert!(!store.is_acknowledged("echo", &b("hash-A")));
        assert!(store.acknowledgments().is_empty());
    }

    #[test]
    fn acknowledgments_lists_recorded_acks_sorted() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut store = NativeTrustStore::load(tmp.path());
        store.acknowledge("zeta", &b("h1")).unwrap();
        store.acknowledge("alpha", &b("h2")).unwrap();
        let acks = store.acknowledgments();
        assert_eq!(acks.len(), 2);
        assert_eq!(acks[0].0, "alpha");
        assert_eq!(acks[1].0, "zeta");
        assert_eq!(acks[0].1.library_sha256, "h2");
    }

    #[test]
    fn native_library_hash_matches_the_file_digest() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        let backend = root.join("echo").join("backend");
        std::fs::create_dir_all(&backend).unwrap();
        let lib_name = format!(
            "{}echo{}",
            std::env::consts::DLL_PREFIX,
            std::env::consts::DLL_SUFFIX
        );
        let bytes = b"pretend native library bytes";
        std::fs::write(backend.join(lib_name), bytes).unwrap();

        let hash = native_library_hash(root, "echo").unwrap();
        assert_eq!(hash, super::super::signature::sha256_digest(bytes));
    }

    #[test]
    fn native_library_hash_errors_when_no_backend_library() {
        let tmp = tempfile::TempDir::new().unwrap();
        // A plugin dir with no backend/ library at all cannot be acknowledged.
        std::fs::create_dir_all(tmp.path().join("frontend-only")).unwrap();
        assert!(native_library_hash(tmp.path(), "frontend-only").is_err());
    }
}

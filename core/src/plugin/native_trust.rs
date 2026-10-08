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

use super::manifest::parse_manifest;
use super::package::MANIFEST_FILE_NAME;
use super::signature::now_rfc3339;

/// The file, alongside the manager's other plugin state files under the plugins
/// root, that persists the native-plugin trust decisions.
pub const NATIVE_TRUST_FILE_NAME: &str = "native-plugin-trust.json";

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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeTrustDoc {
    /// Whether native plugins may load at all. **Absent → `false`**:
    /// the default, and every fail-closed path, is "native plugins off".
    #[serde(default)]
    native_plugins_enabled: bool,
    /// Per-plugin acknowledgments, keyed by plugin id.
    #[serde(default)]
    acks: BTreeMap<String, NativeAck>,
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
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
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

    /// Whether plugin `id` is acknowledged **for exactly this library hash**.
    ///
    /// Returns `false` when native plugins are disabled globally, when there is no
    /// acknowledgment for `id`, or when the acknowledged hash does not match
    /// `library_sha256` (a swapped/updated binary — a stale acknowledgment). Both
    /// conditions must hold for a native plugin to load; this is the fail-closed
    /// per-plugin half.
    #[must_use]
    pub fn is_acknowledged(&self, id: &str, library_sha256: &str) -> bool {
        self.doc.native_plugins_enabled
            && self
                .doc
                .acks
                .get(id)
                .is_some_and(|ack| ack.library_sha256 == library_sha256)
    }

    /// Whether plugin `id`'s acknowledgment for exactly this library hash also
    /// records the user's explicit acceptance of an **unverifiable build
    /// toolchain** (ABI 1.0 plugins, #3576). Implies
    /// [`is_acknowledged`](Self::is_acknowledged); `false` in every other case.
    #[must_use]
    pub fn accepts_unverified_toolchain(&self, id: &str, library_sha256: &str) -> bool {
        self.is_acknowledged(id, library_sha256)
            && self
                .doc
                .acks
                .get(id)
                .is_some_and(|ack| ack.unverified_toolchain_accepted)
    }

    /// Whether plugin `id`'s acknowledgment for exactly this library hash also
    /// records the user's explicit acceptance of **reduced sandbox isolation**
    /// (#4188). Implies [`is_acknowledged`](Self::is_acknowledged); `false` in
    /// every other case, including while native plugins are off.
    #[must_use]
    pub fn accepts_reduced_isolation(&self, id: &str, library_sha256: &str) -> bool {
        self.is_acknowledged(id, library_sha256)
            && self
                .doc
                .acks
                .get(id)
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

    /// Record (or refresh) the trust acknowledgment for `id`, binding it to
    /// `library_sha256`, and persist. Re-acknowledging with a new hash replaces
    /// the old one — the mechanism by which a user re-trusts a plugin after its
    /// library legitimately changed.
    ///
    /// A plain acknowledgment does **not** accept an unverifiable build
    /// toolchain; see [`acknowledge_with_toolchain_acceptance`](Self::acknowledge_with_toolchain_acceptance).
    pub fn acknowledge(
        &mut self,
        id: &str,
        library_sha256: impl Into<String>,
    ) -> Result<(), NativeTrustError> {
        self.acknowledge_with_toolchain_acceptance(id, library_sha256, false)
    }

    /// [`acknowledge`](Self::acknowledge), additionally recording whether the
    /// user explicitly accepted that the plugin's build toolchain cannot be
    /// verified (an ABI 1.0 plugin — #3576, ADR-15). The acceptance is part of
    /// the hash-bound acknowledgment, so a changed binary loses it too.
    pub fn acknowledge_with_toolchain_acceptance(
        &mut self,
        id: &str,
        library_sha256: impl Into<String>,
        accept_unverified_toolchain: bool,
    ) -> Result<(), NativeTrustError> {
        self.acknowledge_with(
            id,
            library_sha256,
            AckAcceptances {
                unverified_toolchain: accept_unverified_toolchain,
                reduced_isolation: false,
            },
        )
    }

    /// Record (or refresh) the trust acknowledgment for `id` bound to
    /// `library_sha256`, together with the explicit risk `acceptances`, and
    /// persist. Every acceptance is part of the hash-bound acknowledgment, so a
    /// changed binary loses all of them; re-acknowledging replaces them.
    pub fn acknowledge_with(
        &mut self,
        id: &str,
        library_sha256: impl Into<String>,
        acceptances: AckAcceptances,
    ) -> Result<(), NativeTrustError> {
        self.doc.acks.insert(
            id.to_owned(),
            NativeAck {
                library_sha256: library_sha256.into(),
                acknowledged_at: now_rfc3339(),
                unverified_toolchain_accepted: acceptances.unverified_toolchain,
                reduced_isolation_accepted: acceptances.reduced_isolation,
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

    /// Persist the document atomically: write a sibling temp file, then rename it
    /// over the target so a crash mid-write cannot corrupt the store.
    fn save(&self) -> Result<(), NativeTrustError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&self.doc)
            .map_err(|e| NativeTrustError::Serde(e.to_string()))?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.path)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_plugins_are_disabled_by_default() {
        let tmp = tempfile::TempDir::new().unwrap();
        // No store on disk at all: the default must be off.
        let store = NativeTrustStore::load(tmp.path());
        assert!(
            !store.is_native_enabled(),
            "native plugins must be OFF by default (fail closed)"
        );
        assert!(!store.is_acknowledged("anything", "deadbeef"));
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
        store.acknowledge("echo", "hash-A").unwrap();

        // The exact acknowledged hash is trusted…
        assert!(store.is_acknowledged("echo", "hash-A"));
        // …but a different (modified/swapped) binary is NOT — the ack does not
        // transfer to changed bytes (stale acknowledgment).
        assert!(!store.is_acknowledged("echo", "hash-B"));
        // …and an unrelated plugin id is not trusted either.
        assert!(!store.is_acknowledged("other", "hash-A"));
    }

    #[test]
    fn acknowledgment_requires_the_global_flag() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut store = NativeTrustStore::load(tmp.path());
        // Acknowledge without enabling the global switch: still not authorized,
        // because BOTH the global flag and the per-plugin ack must hold.
        store.acknowledge("echo", "hash-A").unwrap();
        assert!(!store.is_native_enabled());
        assert!(
            !store.is_acknowledged("echo", "hash-A"),
            "a per-plugin ack must not authorize a load while native plugins are globally off"
        );

        // Turning the global switch on makes the existing ack effective.
        store.set_native_enabled(true).unwrap();
        assert!(store.is_acknowledged("echo", "hash-A"));
    }

    #[test]
    fn unverified_toolchain_acceptance_is_explicit_hash_bound_and_persisted() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut store = NativeTrustStore::load(tmp.path());
        store.set_native_enabled(true).unwrap();

        // A plain acknowledgment does NOT accept an unverifiable toolchain
        // (ABI 1.0 plugins, #3576): the default fails closed.
        store.acknowledge("old", "hash-A").unwrap();
        assert!(store.is_acknowledged("old", "hash-A"));
        assert!(!store.accepts_unverified_toolchain("old", "hash-A"));

        // The explicit acceptance is recorded and bound to the same hash.
        store
            .acknowledge_with_toolchain_acceptance("old", "hash-A", true)
            .unwrap();
        assert!(store.accepts_unverified_toolchain("old", "hash-A"));
        assert!(!store.accepts_unverified_toolchain("old", "hash-B"));
        assert!(!store.accepts_unverified_toolchain("other", "hash-A"));

        // It survives a reload…
        let reloaded = NativeTrustStore::load(tmp.path());
        assert!(reloaded.accepts_unverified_toolchain("old", "hash-A"));

        // …is withdrawn by a plain re-acknowledgment…
        store.acknowledge("old", "hash-A").unwrap();
        assert!(!store.accepts_unverified_toolchain("old", "hash-A"));

        // …and never authorizes anything while native plugins are off.
        store
            .acknowledge_with_toolchain_acceptance("old", "hash-A", true)
            .unwrap();
        store.set_native_enabled(false).unwrap();
        assert!(!store.accepts_unverified_toolchain("old", "hash-A"));
    }

    #[test]
    fn a_store_written_before_the_acceptance_field_reads_as_not_accepted() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join(NATIVE_TRUST_FILE_NAME),
            r#"{"nativePluginsEnabled":true,"acks":{"old":{"librarySha256":"hash-A","acknowledgedAt":"t"}}}"#,
        )
        .unwrap();
        let store = NativeTrustStore::load(tmp.path());
        assert!(store.is_acknowledged("old", "hash-A"));
        assert!(!store.accepts_unverified_toolchain("old", "hash-A"));
    }

    #[test]
    fn reduced_isolation_acceptance_is_explicit_hash_bound_and_persisted() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut store = NativeTrustStore::load(tmp.path());
        store.set_native_enabled(true).unwrap();

        // A plain acknowledgment never accepts reduced isolation (#4188).
        store.acknowledge("p", "hash-A").unwrap();
        assert!(!store.accepts_reduced_isolation("p", "hash-A"));
        // Neither does a toolchain-only acceptance.
        store
            .acknowledge_with_toolchain_acceptance("p", "hash-A", true)
            .unwrap();
        assert!(!store.accepts_reduced_isolation("p", "hash-A"));

        let both = AckAcceptances {
            unverified_toolchain: true,
            reduced_isolation: true,
        };
        store.acknowledge_with("p", "hash-A", both).unwrap();
        assert!(store.accepts_reduced_isolation("p", "hash-A"));
        assert!(store.accepts_unverified_toolchain("p", "hash-A"));
        // Bound to the exact library and plugin.
        assert!(!store.accepts_reduced_isolation("p", "hash-B"));
        assert!(!store.accepts_reduced_isolation("other", "hash-A"));

        // Survives a reload, and serialises under the concept's field name.
        let reloaded = NativeTrustStore::load(tmp.path());
        assert!(reloaded.accepts_reduced_isolation("p", "hash-A"));
        let raw = std::fs::read_to_string(tmp.path().join(NATIVE_TRUST_FILE_NAME)).unwrap();
        assert!(raw.contains("\"reducedIsolationAccepted\": true"), "{raw}");

        // Withdrawn by a plain re-acknowledgment, and void while native plugins are off.
        store.acknowledge("p", "hash-A").unwrap();
        assert!(!store.accepts_reduced_isolation("p", "hash-A"));
        store.acknowledge_with("p", "hash-A", both).unwrap();
        store.set_native_enabled(false).unwrap();
        assert!(!store.accepts_reduced_isolation("p", "hash-A"));
    }

    #[test]
    fn an_older_acknowledgment_reads_as_reduced_isolation_not_accepted() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join(NATIVE_TRUST_FILE_NAME),
            r#"{"nativePluginsEnabled":true,"acks":{"p":{"librarySha256":"h","acknowledgedAt":"t","unverifiedToolchainAccepted":true}}}"#,
        )
        .unwrap();
        let store = NativeTrustStore::load(tmp.path());
        assert!(store.is_acknowledged("p", "h"));
        assert!(!store.accepts_reduced_isolation("p", "h"));
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
        store.acknowledge("echo", "hash-A").unwrap();
        store.revoke("echo").unwrap();
        assert!(!store.is_acknowledged("echo", "hash-A"));

        // Revocation survives a reload; the global flag is untouched.
        let reloaded = NativeTrustStore::load(tmp.path());
        assert!(reloaded.is_native_enabled());
        assert!(!reloaded.is_acknowledged("echo", "hash-A"));
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
        assert!(!store.is_acknowledged("echo", "hash-A"));
        assert!(store.acknowledgments().is_empty());
    }

    #[test]
    fn acknowledgments_lists_recorded_acks_sorted() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut store = NativeTrustStore::load(tmp.path());
        store.acknowledge("zeta", "h1").unwrap();
        store.acknowledge("alpha", "h2").unwrap();
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

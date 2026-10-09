//! The persisted per-plugin install state, `<plugins-root>/plugin-state.json`.
//!
//! One record per installed plugin id: its enabled flag, install time, the
//! package digest and signer the version / signer gates compare against
//! (PLG-012, #3489), and — since schema v2 (#2796) — the **install-verified
//! backend binding** the plugin host checks at load time.
//!
//! # Why the load binding lives here
//!
//! The extracted plugin directory is exactly what a local attacker rewrites to
//! swap a backend library, and it carries its own `signature.json`, so a
//! re-verification that only consults the directory can be satisfied by a
//! re-signed tree. The digest of the library the manager verified at install is
//! therefore recorded **outside** the plugin directory, here, and the host
//! refuses a library that no longer matches it (see
//! [`super::host::PluginHost::load`]). Only a manager install rewrites it.
//!
//! # Versioning and downgrade safety
//!
//! The document carries a `version` like the other persisted stores (#2744):
//! a file without one is the pre-versioning v1 shape and is read as-is (the
//! v1 → v2 change is purely additive, so migration is the identity); a file
//! written by a **newer** schema is still read — every field this build knows is
//! optional — but never overwritten ([`write`] refuses); and unknown top-level
//! and per-record fields round-trip unchanged.
//!
//! # Durability and recovery (#4334)
//!
//! Writes go through the shared [`crate::util::persist`] layer: a unique,
//! fsynced temp file renamed over the target, after the version gate. Every
//! read-modify-write — the manager's and the host's crash-handler
//! [`record_auto_disable`] — runs under one lock ([`update`]), so no update is
//! lost. A **corrupt** file is never a hard error: it is backed up to
//! `plugin-state.json.bak[.N]` and the records are rebuilt from the installed
//! plugin directories, every plugin **disabled** and every native plugin's
//! trust acknowledgment revoked, so the recovery fails safe.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::signer_change::PackageSigner;
use crate::util::persist::{self, OverwriteError};

/// The state file name under the plugins root.
pub(crate) const STATE_FILE_NAME: &str = "plugin-state.json";

/// The schema version this build reads and writes.
///
/// * v1 — the unversioned original (enabled, install time, package digest,
///   signer).
/// * v2 (#2796) — adds [`PluginStateRecord::verified_backend`].
pub(crate) const CURRENT_VERSION: u32 = 2;

/// The version an unversioned file is assumed to carry.
const ASSUMED_VERSION: u32 = persist::ASSUMED_VERSION;

/// Why a plugin is disabled after its record was rebuilt from a corrupt
/// `plugin-state.json`.
pub(crate) const RECOVERED_REASON: &str =
    "Disabled because the plugin state file was damaged and has been rebuilt; \
     re-enable it to use it again";

/// What the manager verified about a plugin's **backend library** at install
/// time, persisted so the host can bind a load to it (#2796).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifiedBackend {
    /// The selected host library's path relative to the plugin directory,
    /// `/`-joined (the signature's key form).
    pub library: String,
    /// The `sha256:`-prefixed digest of that library as installed.
    pub sha256: String,
    /// Whether the package's signing key was trusted (bundled or pinned) when
    /// it was installed. `false` for an unsigned or "install once" package.
    /// A key that *was* trusted at install and is no longer (revoked) is refused
    /// at load; one that never was loads only bound to this record.
    pub signer_trusted: bool,
}

/// Per-plugin record persisted in `plugin-state.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginStateRecord {
    /// Whether the user has the plugin enabled.
    pub enabled: bool,
    /// Install time in milliseconds since the Unix epoch.
    pub installed_at: u64,
    /// The `sha256:`-prefixed digest of the package this plugin was installed
    /// from (PLG-012), so a same-version reinstall can tell an identical package
    /// from a different build. Absent for installs that predate it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_sha256: Option<String>,
    /// Who signed the package this plugin was installed from (#3489), so a later
    /// replace can tell "same publisher" from "the publisher key changed". Absent
    /// for installs that predate it — those fall back to the `signature.json`
    /// extracted into the plugin directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer: Option<PackageSigner>,
    /// The install-verified backend binding (#2796). Absent for a plugin
    /// without a native backend and for installs that predate schema v2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_backend: Option<VerifiedBackend>,
    /// Why the host auto-disabled the plugin (#4184, "Disabled after 3
    /// crashes"); set together with `enabled = false`, cleared on re-enable.
    /// An additive optional field: older builds carry it forward unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_disabled_reason: Option<String>,
    /// Unknown per-record fields, carried forward unchanged.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The whole `plugin-state.json` document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StateStore {
    /// Schema version (see [`CURRENT_VERSION`]). Always written as the current
    /// version; read leniently (absent → v1).
    #[serde(default = "assumed_version")]
    pub version: u32,
    /// Records keyed by plugin id.
    #[serde(default)]
    pub plugins: BTreeMap<String, PluginStateRecord>,
    /// Unknown top-level fields, carried forward unchanged.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn assumed_version() -> u32 {
    ASSUMED_VERSION
}

impl Default for StateStore {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            plugins: BTreeMap::new(),
            extra: Map::new(),
        }
    }
}

/// Errors reading or writing the state file.
#[derive(Debug, thiserror::Error)]
pub(crate) enum StateError {
    /// A filesystem operation failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// The file is not a valid state document.
    #[error("plugin-state.json is invalid: {0}")]
    Invalid(String),
    /// The file was written by a newer schema; overwriting it would lose data.
    #[error(
        "plugin-state.json was written by a newer version of termiHub (schema v{found}, this \
         build supports v{CURRENT_VERSION}); refusing to overwrite it"
    )]
    Newer {
        /// The on-disk schema version.
        found: u32,
    },
}

/// The state file path under `plugins_root`.
pub(crate) fn state_path(plugins_root: &Path) -> PathBuf {
    plugins_root.join(STATE_FILE_NAME)
}

/// Serializes every read-modify-write of a `plugin-state.json` in this
/// process: the manager's updates and the host's crash-handler auto-disable
/// (PER2-004). One lock for all roots keeps it simple; the critical sections
/// are short file operations.
static STATE_LOCK: Mutex<()> = Mutex::new(());

fn lock_state() -> MutexGuard<'static, ()> {
    STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Read the state store under `plugins_root`. A missing file is an empty store.
///
/// A file written by a newer schema is still read (for display and the load
/// binding); [`write`] refuses to overwrite it. A corrupt file is recovered
/// (see the module docs), never a hard error.
pub(crate) fn read(plugins_root: &Path) -> Result<StateStore, StateError> {
    let _guard = lock_state();
    read_unlocked(plugins_root)
}

fn read_unlocked(plugins_root: &Path) -> Result<StateStore, StateError> {
    let path = state_path(plugins_root);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(StateStore::default()),
        Err(e) => return Err(StateError::Io(e)),
    };
    match serde_json::from_str::<StateStore>(&raw) {
        Ok(store) => {
            persist::release_unbacked_corrupt(&path);
            Ok(store)
        }
        Err(e) => Ok(recover_corrupt(plugins_root, &e.to_string())),
    }
}

/// Rebuild a corrupt `plugin-state.json` from the installed plugin
/// directories (PER2-004): every plugin disabled with [`RECOVERED_REASON`],
/// every native plugin's trust acknowledgment revoked, the original backed up
/// before the rebuilt store replaces it. When the backup fails the rebuilt
/// store is used in memory only and saves stay refused.
fn recover_corrupt(plugins_root: &Path, detail: &str) -> StateStore {
    let mut store = StateStore::default();
    let mut native = Vec::new();
    for (dir, manifest) in super::manager::installed_manifests(plugins_root) {
        if manifest.extensions.terminal_backend.is_some() {
            native.push(manifest.id.clone());
        }
        store.plugins.insert(
            manifest.id,
            PluginStateRecord {
                enabled: false,
                installed_at: super::manager::dir_install_time(&dir),
                auto_disabled_reason: Some(RECOVERED_REASON.to_owned()),
                ..PluginStateRecord::default()
            },
        );
    }
    // Revoke first: re-enabling a native plugin must ask for trust again even
    // if the rebuilt file cannot be written.
    let mut trust = super::native_trust::NativeTrustStore::load(plugins_root);
    for id in &native {
        if let Err(e) = trust.revoke(id) {
            tracing::warn!(
                target: super::PLUGIN_LOG_TARGET,
                "[{id}] could not revoke native trust after rebuilding plugin state: {e}"
            );
        }
    }
    let written = write_unlocked(plugins_root, &store);
    tracing::error!(
        target: super::PLUGIN_LOG_TARGET,
        "{STATE_FILE_NAME} was corrupt ({detail}); rebuilt {} record(s) from the installed \
         plugins, all disabled: {}",
        store.plugins.len(),
        match &written {
            Ok(()) => "the original was backed up".to_owned(),
            Err(e) => format!("not saved ({e})"),
        }
    );
    store
}

/// Read one plugin's record, or `None` when the store or the record is absent.
pub(crate) fn read_record(
    plugins_root: &Path,
    id: &str,
) -> Result<Option<PluginStateRecord>, StateError> {
    Ok(read(plugins_root)?.plugins.remove(id))
}

/// Write `store` atomically, stamped with the current schema version. Refuses
/// to overwrite a file written by a newer schema; backs up a corrupt one first.
/// Production code goes through [`update`].
#[cfg(test)]
pub(crate) fn write(plugins_root: &Path, store: &StateStore) -> Result<(), StateError> {
    let _guard = lock_state();
    write_unlocked(plugins_root, store)
}

fn write_unlocked(plugins_root: &Path, store: &StateStore) -> Result<(), StateError> {
    let path = state_path(plugins_root);
    persist::prepare_overwrite::<StateStore>(&path, STATE_FILE_NAME, CURRENT_VERSION).map_err(
        |e| match e {
            OverwriteError::Newer(newer) => StateError::Newer { found: newer.found },
            other => StateError::Invalid(other.to_string()),
        },
    )?;
    std::fs::create_dir_all(plugins_root)?;
    let mut out = store.clone();
    out.version = CURRENT_VERSION;
    let json =
        serde_json::to_string_pretty(&out).map_err(|e| StateError::Invalid(e.to_string()))?;
    persist::write_atomic(&path, json)?;
    persist::release_unbacked_corrupt(&path);
    Ok(())
}

/// Read-modify-write the state store under the state lock, so concurrent
/// updates (the manager's, the host's auto-disable) never lose one another.
/// Returns `f`'s result and the store as written.
pub(crate) fn update<R>(
    plugins_root: &Path,
    f: impl FnOnce(&mut StateStore) -> R,
) -> Result<(R, StateStore), StateError> {
    let _guard = lock_state();
    let mut store = read_unlocked(plugins_root)?;
    let out = f(&mut store);
    write_unlocked(plugins_root, &store)?;
    Ok((out, store))
}

/// Persist that the host auto-disabled plugin `id` for `reason` (#4184):
/// `enabled = false` plus the reason. A plugin without a record (installed
/// before records existed) gets one.
///
/// The host calls this from its crash handling, outside the manager's lock;
/// [`update`]'s lock serializes it with the manager's own updates (PER2-004).
pub(crate) fn record_auto_disable(
    plugins_root: &Path,
    id: &str,
    reason: &str,
) -> Result<(), StateError> {
    update(plugins_root, |store| {
        let record = store.plugins.entry(id.to_owned()).or_insert_with(|| {
            let installed_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
            PluginStateRecord {
                installed_at,
                ..PluginStateRecord::default()
            }
        });
        record.enabled = false;
        record.auto_disabled_reason = Some(reason.to_owned());
    })
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> PluginStateRecord {
        PluginStateRecord {
            enabled: true,
            installed_at: 7,
            package_sha256: Some("sha256:pkg".into()),
            signer: Some(PackageSigner::Signed {
                key_id: "sha256:key".into(),
            }),
            verified_backend: Some(VerifiedBackend {
                library: "backend/libp.so".into(),
                sha256: "sha256:lib".into(),
                signer_trusted: true,
            }),
            auto_disabled_reason: None,
            extra: Map::new(),
        }
    }

    #[test]
    fn an_auto_disable_is_persisted_with_its_reason() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut store = StateStore::default();
        store.plugins.insert("p".into(), record());
        write(tmp.path(), &store).unwrap();

        record_auto_disable(tmp.path(), "p", "Disabled after 3 crashes").unwrap();
        let back = read_record(tmp.path(), "p").unwrap().unwrap();
        assert!(!back.enabled);
        assert_eq!(
            back.auto_disabled_reason.as_deref(),
            Some("Disabled after 3 crashes")
        );
        // Everything else is kept.
        assert_eq!(back.verified_backend, record().verified_backend);
        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(state_path(tmp.path())).unwrap())
                .unwrap();
        assert_eq!(
            raw["plugins"]["p"]["autoDisabledReason"],
            "Disabled after 3 crashes"
        );

        // A plugin without a record gets one.
        record_auto_disable(tmp.path(), "q", "r").unwrap();
        let q = read_record(tmp.path(), "q").unwrap().unwrap();
        assert!(!q.enabled);
        assert!(q.installed_at > 0);
    }

    #[test]
    fn missing_file_reads_as_an_empty_current_store() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = read(tmp.path()).unwrap();
        assert!(store.plugins.is_empty());
        assert_eq!(store.version, CURRENT_VERSION);
        assert!(read_record(tmp.path(), "p").unwrap().is_none());
    }

    #[test]
    fn round_trips_the_verified_backend_and_stamps_the_version() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut store = StateStore::default();
        store.plugins.insert("p".into(), record());
        write(tmp.path(), &store).unwrap();

        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(state_path(tmp.path())).unwrap())
                .unwrap();
        assert_eq!(raw["version"], 2);
        assert_eq!(
            raw["plugins"]["p"]["verifiedBackend"]["signerTrusted"],
            true
        );

        let back = read_record(tmp.path(), "p").unwrap().unwrap();
        assert_eq!(back.verified_backend, record().verified_backend);
    }

    #[test]
    fn an_unversioned_v1_file_still_reads() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            state_path(tmp.path()),
            r#"{"plugins":{"p":{"enabled":false,"installedAt":3,"packageSha256":"sha256:x"}}}"#,
        )
        .unwrap();
        let store = read(tmp.path()).unwrap();
        assert_eq!(store.version, 1);
        let rec = &store.plugins["p"];
        assert!(!rec.enabled);
        assert_eq!(rec.package_sha256.as_deref(), Some("sha256:x"));
        assert!(rec.verified_backend.is_none());

        // Re-writing upgrades it to the current version.
        write(tmp.path(), &store).unwrap();
        assert_eq!(read(tmp.path()).unwrap().version, CURRENT_VERSION);
    }

    #[test]
    fn a_newer_file_is_read_but_never_overwritten() {
        let tmp = tempfile::TempDir::new().unwrap();
        let newer = r#"{"version":99,"plugins":{"p":{"enabled":true,"installedAt":1}}}"#;
        std::fs::write(state_path(tmp.path()), newer).unwrap();

        let store = read(tmp.path()).unwrap();
        assert!(store.plugins["p"].enabled);
        assert!(matches!(
            write(tmp.path(), &store),
            Err(StateError::Newer { found: 99 })
        ));
        assert_eq!(
            std::fs::read_to_string(state_path(tmp.path())).unwrap(),
            newer,
            "the newer file is left intact"
        );
    }

    #[test]
    fn unknown_fields_round_trip() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(
            state_path(tmp.path()),
            r#"{"version":2,"future":{"a":1},"plugins":{"p":{"enabled":true,"installedAt":1,"later":"x"}}}"#,
        )
        .unwrap();
        let store = read(tmp.path()).unwrap();
        write(tmp.path(), &store).unwrap();
        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(state_path(tmp.path())).unwrap())
                .unwrap();
        assert_eq!(raw["future"]["a"], 1);
        assert_eq!(raw["plugins"]["p"]["later"], "x");
    }

    /// PER2-004: a corrupt file is recovered (backed up, rebuilt from the
    /// installed plugins — none here), never a hard error.
    #[test]
    fn a_corrupt_file_is_recovered_not_an_error() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(state_path(tmp.path()), "{not json").unwrap();
        assert!(read(tmp.path()).unwrap().plugins.is_empty());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("plugin-state.json.bak")).unwrap(),
            "{not json"
        );
    }
}

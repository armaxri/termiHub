//! Versioned, downgrade-safe persistence for the host-key trust stores (#2745).
//!
//! Shared by the SSH ([`SshTrustStore`](super::ssh_trust_store)) and RDP
//! ([`RdpTrustStore`](super::rdp_trust_store)) trust stores. Both persist a flat
//! JSON object mapping `host:port` → the list of trusted fingerprints:
//!
//! ```json
//! { "server.example:22": ["SHA256:AB…", "SHA256:12…"] }
//! ```
//!
//! ## Why the format version lives in a sidecar file
//!
//! The JSON config stores carry their schema version *inside* the document and
//! go through [`crate::utils::migrate`]. The trust stores cannot: the document
//! *is* the `host → [fingerprint]` map, so a `"version"` key would be a host
//! whose value is not a list. Every termiHub released before this change reads
//! that as a corrupt file, starts with an empty store, and overwrites the file
//! on the next "remember" — losing every trust decision on a downgrade, which
//! is exactly the failure this layer exists to prevent (a user who loses their
//! trusted hosts learns to click through host-key prompts). A comment header is
//! not an option in JSON either.
//!
//! So the format version is recorded in a **sidecar** file next to the store,
//! `<file>.version` (e.g. `ssh_known_hosts.json.version`), holding a single
//! integer. Older builds never look at it, so the store file itself stays
//! byte-compatible with every existing build. A missing sidecar means the
//! baseline format (v1) — every file written before #2745.
//!
//! ## Guarantees
//!
//! * **Never silently trust.** A file this build cannot positively interpret —
//!   a newer format, or an unreadable version marker — contributes *no*
//!   entries. Unknown hosts then prompt; nothing is accepted without the user.
//! * **Never silently discard.** A newer-format file is left byte-for-byte
//!   intact and every write to it is refused (checked again at write time, so a
//!   newer build that wrote the file after this one opened it is honoured too).
//!   A corrupt file is copied to a non-clobbering backup *before* anything may
//!   overwrite it; if that backup cannot be made, writes are refused.
//! * **Salvage per entry.** A readable-but-invalid file keeps every valid
//!   `host → fingerprint` pair and drops only the invalid parts, each reported
//!   as a [`RecoveryWarning`]. Dropping an entry can only make a host prompt
//!   again (or show as changed) — it can never turn a key into a trusted one.
//!
//! ## Future format changes
//!
//! Bump [`TRUST_STORE_FORMAT_VERSION`] and add a step to [`migrate`]. Write the
//! new sidecar value **before** the new-format document, so a crash in between
//! leaves a file older builds refuse rather than misread.

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tracing::{error, warn};

use crate::connection::recovery::RecoveryWarning;
use crate::utils::fs::write_atomic;

/// The trust-store on-disk format version this build reads and writes.
pub const TRUST_STORE_FORMAT_VERSION: u32 = 1;

/// Format version assumed when there is no sidecar (every pre-#2745 file).
const ASSUMED_VERSION: u32 = 1;

/// How many numbered backups of a corrupt file are kept before giving up.
const MAX_BACKUPS: u32 = 100;

/// The in-memory trust entries: `host:port` → trusted fingerprints.
pub type TrustEntries = BTreeMap<String, Vec<String>>;

/// The sidecar holding the store's format version: `<file>.version`.
pub fn version_sidecar_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".version");
    path.with_file_name(name)
}

/// The on-disk format version as recorded by the sidecar.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SidecarVersion {
    /// No sidecar: the baseline format.
    Absent,
    /// A readable version number.
    Known(u32),
    /// The sidecar exists but could not be read or parsed.
    Unreadable(String),
}

fn read_sidecar(path: &Path) -> SidecarVersion {
    match fs::read_to_string(version_sidecar_path(path)) {
        Ok(raw) => match raw.trim().parse::<u32>() {
            Ok(v) => SidecarVersion::Known(v),
            Err(_) => SidecarVersion::Unreadable(format!(
                "unrecognised format version marker {:?}",
                raw.trim()
            )),
        },
        Err(e) if e.kind() == ErrorKind::NotFound => SidecarVersion::Absent,
        Err(e) => SidecarVersion::Unreadable(format!("cannot read format version marker: {e}")),
    }
}

/// The on-disk format version of the trust store at `path`, per its sidecar:
/// the recorded version (the baseline v1 when there is none), or the reason
/// the marker could not be read. Used by the unified backup to stamp and gate
/// the trust-store sections (#2745).
pub fn on_disk_format_version(path: &Path) -> Result<u32, String> {
    match read_sidecar(path) {
        SidecarVersion::Absent => Ok(ASSUMED_VERSION),
        SidecarVersion::Known(v) => Ok(v),
        SidecarVersion::Unreadable(detail) => Err(detail),
    }
}

/// Why this build must not interpret or overwrite the store file, if at all.
fn write_blocker(path: &Path, file_name: &str) -> Option<String> {
    match read_sidecar(path) {
        SidecarVersion::Absent => None,
        SidecarVersion::Known(v) if v <= TRUST_STORE_FORMAT_VERSION => None,
        SidecarVersion::Known(v) => Some(format!(
            "{file_name} was written by a newer version of termiHub (format v{v}, this build \
             supports v{TRUST_STORE_FORMAT_VERSION}); refusing to overwrite it"
        )),
        SidecarVersion::Unreadable(detail) => Some(format!(
            "{file_name} has an unknown format version ({detail}); refusing to overwrite it"
        )),
    }
}

/// The result of loading a trust-store file.
#[derive(Debug)]
pub struct LoadedTrustFile {
    /// The entries this build may act on.
    pub entries: TrustEntries,
    /// `Some(reason)` when this build must never write the file.
    pub write_refused: Option<String>,
    /// Problems found while loading, for the startup recovery notice.
    pub warnings: Vec<RecoveryWarning>,
}

/// Forward-migrate a document from `from_version` to the current format.
///
/// v1 is the only format so far, so this is the identity. Add one step per
/// format bump here.
fn migrate(value: Value, from_version: u32) -> Value {
    let _ = from_version;
    value
}

/// Load the trust store at `path` with version gating, backup and per-entry
/// salvage. Never fails: problems are reported as warnings, and the returned
/// entries are always safe to act on (possibly empty).
pub fn load(path: &Path, file_name: &str) -> LoadedTrustFile {
    // Gate on the format version BEFORE reading the document, so a newer file
    // is never parsed — let alone trusted — under this build's reading of it.
    let version = match read_sidecar(path) {
        SidecarVersion::Absent => ASSUMED_VERSION,
        SidecarVersion::Known(v) if v <= TRUST_STORE_FORMAT_VERSION => v,
        _ => {
            let reason = write_blocker(path, file_name)
                .unwrap_or_else(|| format!("{file_name} has an unknown format version"));
            return refused(
                file_name,
                reason,
                "Your remembered host keys were saved by a newer version of termiHub. The file \
                 was left unchanged and is not used by this version, so hosts you trusted will \
                 ask for confirmation again, and new decisions are kept only until termiHub \
                 closes. Update termiHub to use them.",
            );
        }
    };

    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == ErrorKind::NotFound => return LoadedTrustFile::empty(),
        Err(e) => {
            // The file exists but cannot be read: never overwrite what we
            // cannot see.
            return refused(
                file_name,
                format!("cannot read {file_name}: {e}; refusing to overwrite it"),
                "Your remembered host keys could not be read. The file was left unchanged; \
                 hosts you trusted will ask for confirmation again, and new decisions are kept \
                 only until termiHub closes.",
            );
        }
    };

    let parsed = serde_json::from_slice::<Value>(&bytes)
        .map_err(|e| e.to_string())
        .map(|v| migrate(v, version));

    // Fast path: a well-formed document.
    if let Ok(value) = &parsed {
        if let Ok(entries) = serde_json::from_value::<TrustEntries>(value.clone()) {
            if entries_are_valid(&entries) {
                return LoadedTrustFile {
                    entries,
                    ..LoadedTrustFile::empty()
                };
            }
        }
    }
    recover_corrupt(path, file_name, parsed)
}

impl LoadedTrustFile {
    fn empty() -> Self {
        Self {
            entries: TrustEntries::new(),
            write_refused: None,
            warnings: Vec::new(),
        }
    }
}

/// A load that must not interpret or overwrite the file: no entries, writes
/// refused for `reason`, and one warning carrying `message`.
fn refused(file_name: &str, reason: String, message: &str) -> LoadedTrustFile {
    error!("{reason}");
    LoadedTrustFile {
        entries: TrustEntries::new(),
        warnings: vec![RecoveryWarning {
            file_name: file_name.to_string(),
            message: message.to_string(),
            details: Some(reason.clone()),
        }],
        write_refused: Some(reason),
    }
}

/// Recover a corrupt file: back it up first (refusing writes if that fails),
/// then salvage what `parsed` still holds, or start empty if it is not JSON.
fn recover_corrupt(path: &Path, file_name: &str, parsed: Result<Value, String>) -> LoadedTrustFile {
    let mut out = LoadedTrustFile::empty();
    let backup_note = match backup_corrupt(path) {
        Ok(p) => format!(
            "The original was backed up to {}.",
            p.file_name().unwrap_or_default().to_string_lossy()
        ),
        Err(e) => {
            let reason = format!("{file_name} is corrupt and could not be backed up: {e}");
            error!("{reason}; refusing to overwrite it");
            out.write_refused = Some(reason);
            "It could not be backed up, so it was left unchanged and changes will not be saved \
             over it."
                .to_string()
        }
    };

    let (message, details) = match parsed {
        Ok(value) => {
            let (entries, dropped) = salvage(&value);
            let kept = entries.len();
            out.entries = entries;
            warn!(
                "{file_name} had {} invalid part(s); kept {kept} host(s)",
                dropped.len()
            );
            // Make the salvage durable so the next launch loads cleanly — only
            // once the original is safely backed up.
            if out.write_refused.is_none() {
                if let Err(e) = persist(path, &out.entries, file_name) {
                    warn!("could not persist salvaged {file_name}: {e}");
                }
            }
            (
                format!(
                    "Your remembered host keys contained invalid entries. {kept} host(s) were \
                     kept; the invalid entries were removed, so those hosts will ask for \
                     confirmation again. {backup_note}"
                ),
                dropped.join("\n"),
            )
        }
        Err(detail) => {
            error!("{file_name} is unreadable JSON ({detail}); starting empty");
            (
                format!(
                    "Your remembered host keys were corrupt and could not be read, so hosts you \
                     trusted will ask for confirmation again. {backup_note}"
                ),
                detail,
            )
        }
    };
    out.warnings.push(RecoveryWarning {
        file_name: file_name.to_string(),
        message,
        details: Some(details),
    });
    out
}

/// Whether every host and fingerprint is non-empty (the stores never write
/// empty ones; an empty host list is tolerated as "nothing remembered").
fn entries_are_valid(entries: &TrustEntries) -> bool {
    entries
        .iter()
        .all(|(host, fps)| !host.trim().is_empty() && fps.iter().all(|f| !f.trim().is_empty()))
}

/// Keep every valid `host → fingerprint` pair of a readable document; return
/// the kept entries and a description of each dropped part.
fn salvage(value: &Value) -> (TrustEntries, Vec<String>) {
    let mut entries = TrustEntries::new();
    let mut dropped = Vec::new();
    let Some(map) = value.as_object() else {
        dropped.push("the document is not a host → fingerprints object".to_string());
        return (entries, dropped);
    };
    for (host, fps) in map {
        if host.trim().is_empty() {
            dropped.push("dropped an entry with an empty host name".to_string());
            continue;
        }
        let Some(list) = fps.as_array() else {
            dropped.push(format!("dropped host \"{host}\": its keys are not a list"));
            continue;
        };
        let mut kept: Vec<String> = Vec::new();
        for (i, fp) in list.iter().enumerate() {
            match fp.as_str() {
                Some(s) if !s.trim().is_empty() => {
                    if !kept.iter().any(|k| k == s) {
                        kept.push(s.to_string());
                    }
                }
                _ => dropped.push(format!("dropped invalid key #{i} of host \"{host}\"")),
            }
        }
        if kept.is_empty() {
            dropped.push(format!("dropped host \"{host}\": no valid keys left"));
        } else {
            entries.insert(host.clone(), kept);
        }
    }
    (entries, dropped)
}

/// Copy a corrupt store to the first free `<file>.bak`, `<file>.bak.1`, …, so
/// an earlier backup is never clobbered.
fn backup_corrupt(path: &Path) -> std::io::Result<PathBuf> {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    for n in 0..MAX_BACKUPS {
        let candidate = if n == 0 {
            path.with_file_name(format!("{name}.bak"))
        } else {
            path.with_file_name(format!("{name}.bak.{n}"))
        };
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => {
                if let Err(e) = fs::copy(path, &candidate) {
                    let _ = fs::remove_file(&candidate);
                    return Err(e);
                }
                return Ok(candidate);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other(format!(
        "{MAX_BACKUPS} backups of {name} already exist"
    )))
}

/// Write `entries` to `path` in the current format.
///
/// Refuses (returns an error, writes nothing) when the file on disk is in a
/// newer or unknown format — re-checked here on every write, not only at load.
/// Records the format version in the sidecar before writing the document.
pub fn persist(path: &Path, entries: &TrustEntries, file_name: &str) -> Result<(), PersistError> {
    if let Some(reason) = write_blocker(path, file_name) {
        return Err(PersistError::Refused(reason));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| PersistError::Io(e.to_string()))?;
    }
    let sidecar = version_sidecar_path(path);
    if read_sidecar(path) != SidecarVersion::Known(TRUST_STORE_FORMAT_VERSION) {
        write_atomic(&sidecar, format!("{TRUST_STORE_FORMAT_VERSION}\n"))
            .map_err(|e| PersistError::Io(e.to_string()))?;
    }
    let json =
        serde_json::to_string_pretty(entries).map_err(|e| PersistError::Io(e.to_string()))?;
    // Atomic temp-file + rename: an interrupted write can never truncate the
    // existing store and drop remembered fingerprints (PER-002/PER-003 class).
    write_atomic(path, &json).map_err(|e| PersistError::Io(e.to_string()))
}

/// Why a trust-store write did not happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersistError {
    /// The file on disk must not be overwritten by this build.
    Refused(String),
    /// The write itself failed.
    Io(String),
}

impl std::fmt::Display for PersistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PersistError::Refused(r) => write!(f, "{r}"),
            PersistError::Io(e) => write!(f, "{e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAME: &str = "trust.json";

    #[test]
    fn sidecar_path_appends_version_suffix() {
        assert_eq!(
            version_sidecar_path(Path::new("/cfg/ssh_known_hosts.json")),
            PathBuf::from("/cfg/ssh_known_hosts.json.version")
        );
    }

    #[test]
    fn missing_file_loads_empty_and_writable() {
        let tmp = tempfile::tempdir().unwrap();
        let loaded = load(&tmp.path().join(NAME), NAME);
        assert!(loaded.entries.is_empty());
        assert!(loaded.write_refused.is_none());
        assert!(loaded.warnings.is_empty());
    }

    #[test]
    fn current_version_sidecar_loads_normally() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(NAME);
        fs::write(&path, r#"{"h:22":["SHA256:x"]}"#).unwrap();
        fs::write(version_sidecar_path(&path), "1\n").unwrap();
        let loaded = load(&path, NAME);
        assert_eq!(loaded.entries.get("h:22").unwrap(), &vec!["SHA256:x"]);
        assert!(loaded.write_refused.is_none());
    }

    #[test]
    fn persist_refuses_newer_sidecar_and_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(NAME);
        fs::write(version_sidecar_path(&path), "2").unwrap();
        let err = persist(&path, &TrustEntries::new(), NAME).unwrap_err();
        assert!(matches!(err, PersistError::Refused(_)));
        assert!(!path.exists());
    }

    #[test]
    fn salvage_drops_duplicates_and_invalid_parts_only() {
        let value = serde_json::json!({
            "a:22": ["k1", "k1", null, "k2"],
            "b:22": {"not": "a list"},
            "c:22": [1, 2],
        });
        let (entries, dropped) = salvage(&value);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries.get("a:22").unwrap(), &vec!["k1", "k2"]);
        assert_eq!(dropped.len(), 5);
    }

    #[test]
    fn salvage_non_object_keeps_nothing() {
        let (entries, dropped) = salvage(&serde_json::json!(["a", "b"]));
        assert!(entries.is_empty());
        assert_eq!(dropped.len(), 1);
    }
}

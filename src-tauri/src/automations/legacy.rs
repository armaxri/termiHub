//! Read-only access to the legacy stores for the boot migration (#5818,
//! slice 2).
//!
//! Nothing writes a legacy file: a newer or corrupt one is left as it is, and
//! what can be salvaged of it is salvaged in memory. Both are reported, because
//! nothing else reads these files.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::utils::migrate::{
    load_versioned, read_version, salvage_input, LoadOutcome, Salvage, VersionedStore,
    ASSUMED_VERSION,
};

/// Suffix of the one-time copy of each legacy file taken before the first
/// migration (`macros.json.pre-automations.bak`, …).
pub const BAK_SUFFIX: &str = ".pre-automations.bak";

/// What reading one legacy file produced.
pub enum LegacyRead<T> {
    /// The file does not exist.
    Absent,
    /// The file parsed (possibly after salvaging corrupt entries in memory).
    Read {
        /// The typed store.
        store: T,
        /// The schema version written in the file.
        version: u32,
        /// SHA-256 (hex) of the file's bytes.
        sha256: String,
        /// The corrupt entries that were left out, one message each.
        dropped: Vec<String>,
    },
    /// The file exists but cannot be used by this build (newer schema or
    /// beyond salvage), and why. It is left as it is.
    Unreadable(String),
}

/// Read one legacy store file without ever writing it.
pub fn read_legacy<T: VersionedStore>(path: &Path) -> Result<LegacyRead<T>> {
    if !path.exists() {
        return Ok(LegacyRead::Absent);
    }
    let bytes = fs::read(path).with_context(|| format!("Failed to read {}", path.display()))?;
    let sha256 = sha256_hex(&bytes);
    let raw = match String::from_utf8(bytes) {
        Ok(raw) => raw,
        Err(e) => return Ok(LegacyRead::Unreadable(e.to_string())),
    };
    let version = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| read_version(&v))
        .unwrap_or(ASSUMED_VERSION);
    let (store, dropped) = match load_versioned::<T>(&raw) {
        LoadOutcome::Loaded { data, .. } => (data, Vec::new()),
        LoadOutcome::Newer(err) => {
            tracing::warn!("Automations migration skipped {}: {err}", T::STORE_NAME);
            return Ok(LegacyRead::Unreadable(err.to_string()));
        }
        LoadOutcome::Corrupt(detail) => {
            let salvaged = salvage_input::<T>(&raw).map(|v| T::salvage(v, T::STORE_NAME));
            match salvaged {
                Some(Salvage::Recovered { data, warnings }) => {
                    (data, warnings.into_iter().map(|w| w.message).collect())
                }
                _ => {
                    tracing::warn!(
                        "Automations migration skipped corrupt {}: {detail}",
                        T::STORE_NAME
                    );
                    return Ok(LegacyRead::Unreadable(detail));
                }
            }
        }
    };
    Ok(LegacyRead::Read {
        store,
        version,
        sha256,
        dropped,
    })
}

/// Copy each existing legacy file to `<name>.pre-automations.bak`, unless
/// that copy already exists. A failed copy fails the migration, so nothing
/// is migrated without its safety copy.
pub fn backup_once(dir: &Path, file_names: &[&str]) -> Result<()> {
    for name in file_names {
        let source = dir.join(name);
        let target = dir.join(format!("{name}{BAK_SUFFIX}"));
        if source.exists() && !target.exists() {
            fs::copy(&source, &target)
                .with_context(|| format!("Failed to copy {name} to {}", target.display()))?;
        }
    }
    Ok(())
}

/// SHA-256 (hex) of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// SHA-256 (hex) of a value's canonical JSON, used to fingerprint one entry.
pub fn entry_hash<E: Serialize>(entry: &E) -> String {
    sha256_hex(&serde_json::to_vec(entry).unwrap_or_default())
}

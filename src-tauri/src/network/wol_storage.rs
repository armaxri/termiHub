//! Persistent storage for Wake-on-LAN saved devices.
//!
//! `wol-devices.json` is version-gated and downgrade-safe through the shared
//! schema-migration layer ([`crate::utils::migrate`], #3946): a file with no
//! `version` is legacy v1, a file written by a newer schema is never
//! overwritten, a corrupt file is backed up and salvaged per device, and
//! unknown top-level fields survive a save.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use termihub_core::network::WolDevice;

use crate::connection::recovery::RecoveryResult;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{
    guard_not_newer, load_store_with_recovery, read_unknown_fields, salvage_list_store, Salvage,
    VersionedStore,
};

const WOL_DEVICES_FILE: &str = "wol-devices.json";

/// On-disk shape of `wol-devices.json` (also read by the unified backup, PROD-068).
#[derive(Serialize, Deserialize)]
pub(crate) struct WolDevicesFile {
    /// Schema version. Files written before versioning have none and are read
    /// as v1.
    #[serde(default = "current_version")]
    pub(crate) version: String,
    pub(crate) devices: Vec<WolDevice>,
    /// Unknown top-level fields, carried through a save verbatim (PER-010).
    #[serde(flatten, default)]
    pub(crate) extra: Map<String, Value>,
}

fn current_version() -> String {
    <WolDevicesFile as VersionedStore>::CURRENT_VERSION.to_string()
}

impl Default for WolDevicesFile {
    fn default() -> Self {
        Self {
            version: current_version(),
            devices: Vec::new(),
            extra: Map::new(),
        }
    }
}

impl VersionedStore for WolDevicesFile {
    const STORE_NAME: &'static str = WOL_DEVICES_FILE;
    /// Bump together with a `migrate` step if the shape ever changes; the
    /// unified backup (PROD-068) takes the version from here.
    const CURRENT_VERSION: u32 = 1;

    fn salvage(value: serde_json::Value, file_name: &str) -> Salvage<Self> {
        salvage_list_store::<Self, WolDevice>(value, file_name, "devices")
    }
}

/// Resolve the path to the WoL devices file.
fn devices_path(config_dir: &Path) -> PathBuf {
    config_dir.join(WOL_DEVICES_FILE)
}

/// Load saved WoL devices with recovery: a missing file is an empty list, a
/// newer file is left untouched (empty list + warning), and a corrupt file is
/// backed up and salvaged per device (or reset when even that fails).
pub fn load_wol_devices_with_recovery(config_dir: &Path) -> Result<RecoveryResult<Vec<WolDevice>>> {
    let result =
        load_store_with_recovery::<WolDevicesFile>(&devices_path(config_dir), WOL_DEVICES_FILE)?;
    Ok(RecoveryResult {
        data: result.data.devices,
        warnings: result.warnings,
    })
}

/// Load saved WoL devices, logging (not returning) any recovery warnings.
/// The manager uses [`load_wol_devices_with_recovery`] to surface them.
#[cfg(test)]
pub fn load_wol_devices(config_dir: &Path) -> Result<Vec<WolDevice>> {
    let result = load_wol_devices_with_recovery(config_dir)?;
    for w in &result.warnings {
        tracing::warn!("{}: {}", w.file_name, w.message);
    }
    Ok(result.data)
}

/// Persist the current device list to disk.
///
/// Refuses to overwrite a file written by a newer schema (the version is
/// re-read from disk here, so this holds across restarts), stamps the current
/// version, and carries the file's unknown top-level fields forward.
pub fn save_wol_devices(config_dir: &Path, devices: &[WolDevice]) -> Result<()> {
    let path = devices_path(config_dir);
    guard_not_newer(
        &path,
        WolDevicesFile::STORE_NAME,
        <WolDevicesFile as VersionedStore>::CURRENT_VERSION,
    )?;
    let file = WolDevicesFile {
        version: current_version(),
        devices: devices.to_vec(),
        extra: read_unknown_fields(&path, &["version", "devices"]),
    };
    let content = serde_json::to_string_pretty(&file).context("serialising WoL devices")?;
    write_atomic(&path, &content).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_device(id: &str, name: &str) -> WolDevice {
        WolDevice {
            id: id.to_string(),
            name: name.to_string(),
            mac: "AA:BB:CC:DD:EE:FF".to_string(),
            broadcast: "255.255.255.255".to_string(),
            port: 9,
            extra: Default::default(),
        }
    }

    #[test]
    fn roundtrip_empty() {
        let dir = TempDir::new().unwrap();
        let devices = load_wol_devices(dir.path()).unwrap();
        assert!(devices.is_empty());
    }

    #[test]
    fn roundtrip_with_devices() {
        let dir = TempDir::new().unwrap();
        let original = vec![make_device("1", "Dev Server"), make_device("2", "NAS")];
        save_wol_devices(dir.path(), &original).unwrap();
        let loaded = load_wol_devices(dir.path()).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].name, "Dev Server");
        assert_eq!(loaded[1].name, "NAS");
    }

    /// Regression (#2320): a save that cannot durably complete must fail
    /// **without** clobbering the previously-saved devices. The old
    /// truncate-in-place `fs::write` would succeed by overwriting the existing
    /// file, so this fails red on it; the atomic temp+rename write cannot create
    /// its temp file in a read-only directory and therefore leaves the prior
    /// `wol-devices.json` untouched.
    #[cfg(unix)]
    #[test]
    fn failed_save_preserves_previous_devices() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        save_wol_devices(dir.path(), &[make_device("1", "Original")]).unwrap();
        let path = devices_path(dir.path());
        let before = std::fs::read_to_string(&path).unwrap();

        let restore = std::fs::metadata(dir.path()).unwrap().permissions();
        let mut ro = restore.clone();
        ro.set_mode(0o500);
        std::fs::set_permissions(dir.path(), ro).unwrap();

        // A privileged/root process can create files regardless of mode — skip.
        let probe = dir.path().join(".probe");
        if std::fs::write(&probe, b"x").is_ok() {
            let _ = std::fs::remove_file(&probe);
            std::fs::set_permissions(dir.path(), restore).unwrap();
            return;
        }

        let result = save_wol_devices(dir.path(), &[make_device("2", "Replacement")]);
        std::fs::set_permissions(dir.path(), restore).unwrap();

        assert!(
            result.is_err(),
            "a save that cannot durably complete must report an error"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            before,
            "a failed save must leave the previous devices fully intact"
        );
    }

    #[test]
    fn overwrite_updates_list() {
        let dir = TempDir::new().unwrap();
        save_wol_devices(dir.path(), &[make_device("1", "Old")]).unwrap();
        save_wol_devices(
            dir.path(),
            &[make_device("1", "New"), make_device("2", "Extra")],
        )
        .unwrap();
        let loaded = load_wol_devices(dir.path()).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].name, "New");
    }

    // ── Schema versioning + downgrade safety (#3946, part of #2744) ────────

    fn device_json(id: &str) -> serde_json::Value {
        serde_json::to_value(make_device(id, id)).unwrap()
    }

    /// A file written by a newer schema must never be overwritten by this build.
    #[test]
    fn save_refuses_to_overwrite_newer_file() {
        let dir = TempDir::new().unwrap();
        let path = devices_path(dir.path());
        let newer = serde_json::json!({
            "version": "99",
            "devices": [device_json("future")],
            "fromTheFuture": true,
        })
        .to_string();
        std::fs::write(&path, &newer).unwrap();

        let result = save_wol_devices(dir.path(), &[make_device("1", "Mine")]);
        assert!(result.is_err(), "saving over a newer file must be refused");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), newer);
    }

    /// A newer file is not interpreted by this build, and loading it leaves it
    /// untouched (no backup, no rewrite).
    #[test]
    fn load_leaves_newer_file_intact() {
        let dir = TempDir::new().unwrap();
        let path = devices_path(dir.path());
        let newer = r#"{"version": "99", "devices": "a new shape"}"#;
        std::fs::write(&path, newer).unwrap();

        let result = load_wol_devices_with_recovery(dir.path()).unwrap();
        assert!(result.data.is_empty());
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("newer version"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), newer);
        assert!(!path.with_extension("json.bak").exists());
    }

    /// One corrupt device must not cost the user every other saved device.
    #[test]
    fn corrupt_entry_is_dropped_and_rest_survive() {
        let dir = TempDir::new().unwrap();
        let path = devices_path(dir.path());
        let raw = serde_json::json!({
            "devices": [device_json("good"), {"id": "broken"}],
        })
        .to_string();
        std::fs::write(&path, &raw).unwrap();

        let loaded = load_wol_devices(dir.path()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "good");
        let backup = path.with_extension("json.bak");
        assert_eq!(std::fs::read_to_string(backup).unwrap(), raw);
    }

    /// An unparseable file is backed up before it is reset.
    #[test]
    fn unparseable_file_is_backed_up_and_reset() {
        let dir = TempDir::new().unwrap();
        let path = devices_path(dir.path());
        std::fs::write(&path, "not json {").unwrap();

        let result = load_wol_devices_with_recovery(dir.path()).unwrap();
        assert!(result.data.is_empty());
        assert_eq!(result.warnings.len(), 1);
        let backup = path.with_extension("json.bak");
        assert_eq!(std::fs::read_to_string(backup).unwrap(), "not json {");
    }

    /// A save stamps the schema version and keeps top-level fields this build
    /// does not know (written by a newer same-schema build).
    #[test]
    fn save_stamps_version_and_preserves_unknown_fields() {
        let dir = TempDir::new().unwrap();
        let path = devices_path(dir.path());
        let raw = serde_json::json!({
            "devices": [device_json("1")],
            "futureSetting": {"nested": [1, 2]},
        })
        .to_string();
        std::fs::write(&path, raw).unwrap();

        let devices = load_wol_devices(dir.path()).unwrap();
        save_wol_devices(dir.path(), &devices).unwrap();

        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["version"], "1");
        assert_eq!(
            saved["futureSetting"],
            serde_json::json!({"nested": [1, 2]})
        );
        assert_eq!(saved["devices"].as_array().unwrap().len(), 1);
    }

    /// A pre-versioning (legacy) file has no `version` and loads as v1.
    #[test]
    fn legacy_unversioned_file_loads_as_v1() {
        let dir = TempDir::new().unwrap();
        let path = devices_path(dir.path());
        let raw = serde_json::json!({"devices": [device_json("1"), device_json("2")]});
        std::fs::write(&path, raw.to_string()).unwrap();

        let result = load_wol_devices_with_recovery(dir.path()).unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.len(), 2);
    }

    // ── Unknown per-entry fields (#3951, part of #2744) ────────────────────

    fn saved_devices(dir: &Path) -> Vec<serde_json::Value> {
        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(devices_path(dir)).unwrap()).unwrap();
        saved["devices"].as_array().unwrap().clone()
    }

    /// Fields a newer build wrote into a single device survive an older
    /// build's load → save.
    #[test]
    fn unknown_device_fields_survive_load_save_round_trip() {
        let dir = TempDir::new().unwrap();
        let mut entry = device_json("1");
        entry["futureField"] = serde_json::json!({"nested": [1, 2]});
        let raw = serde_json::json!({"version": "1", "devices": [entry, device_json("2")]});
        std::fs::write(devices_path(dir.path()), raw.to_string()).unwrap();

        let devices = load_wol_devices(dir.path()).unwrap();
        save_wol_devices(dir.path(), &devices).unwrap();

        let saved = saved_devices(dir.path());
        assert_eq!(saved.len(), 2);
        assert_eq!(
            saved[0]["futureField"],
            serde_json::json!({"nested": [1, 2]})
        );
        assert!(saved[1].get("futureField").is_none());
    }

    /// Granular salvage keeps the surviving devices' unknown fields.
    #[test]
    fn salvage_keeps_unknown_device_fields() {
        let dir = TempDir::new().unwrap();
        let mut entry = device_json("good");
        entry["futureField"] = serde_json::json!(7);
        let raw = serde_json::json!({"devices": [entry, {"id": "broken"}]});
        std::fs::write(devices_path(dir.path()), raw.to_string()).unwrap();

        let devices = load_wol_devices(dir.path()).unwrap();
        assert_eq!(devices.len(), 1);
        save_wol_devices(dir.path(), &devices).unwrap();
        assert_eq!(saved_devices(dir.path())[0]["futureField"], 7);
    }
}

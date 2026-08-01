//! Persistent storage for Wake-on-LAN saved devices.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use termihub_core::network::WolDevice;

use crate::utils::fs::write_atomic;

const WOL_DEVICES_FILE: &str = "wol-devices.json";

#[derive(Serialize, Deserialize, Default)]
struct WolDevicesFile {
    devices: Vec<WolDevice>,
}

/// Resolve the path to the WoL devices file.
fn devices_path(config_dir: &std::path::Path) -> PathBuf {
    config_dir.join(WOL_DEVICES_FILE)
}

/// Load saved WoL devices from disk. Returns an empty list if the file doesn't
/// exist yet.
pub fn load_wol_devices(config_dir: &std::path::Path) -> Result<Vec<WolDevice>> {
    let path = devices_path(config_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content =
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let file: WolDevicesFile =
        serde_json::from_str(&content).with_context(|| format!("parsing {}", path.display()))?;
    Ok(file.devices)
}

/// Persist the current device list to disk.
pub fn save_wol_devices(config_dir: &std::path::Path, devices: &[WolDevice]) -> Result<()> {
    let path = devices_path(config_dir);
    let file = WolDevicesFile {
        devices: devices.to_vec(),
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
}

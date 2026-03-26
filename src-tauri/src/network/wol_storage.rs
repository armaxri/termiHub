//! Persistent storage for Wake-on-LAN saved devices.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use termihub_core::network::WolDevice;

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
    std::fs::write(&path, content).with_context(|| format!("writing {}", path.display()))?;
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

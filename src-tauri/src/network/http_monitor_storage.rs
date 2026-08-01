//! Persistent storage for HTTP monitor configurations.
//!
//! Only the monitor **configs** (url, interval, method, expected status,
//! timeout, id) are persisted — never runtime state (last result, running
//! flag). On the next launch [`NetworkManager::init`](super::NetworkManager)
//! reloads these configs and auto-starts a poll loop for each, so a configured
//! monitor survives an app restart instead of silently disappearing.
//!
//! Mirrors the Wake-on-LAN persistence in [`super::wol_storage`].

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::http_monitor::HttpMonitorConfig;
use crate::utils::fs::write_atomic;

const HTTP_MONITORS_FILE: &str = "http-monitors.json";

#[derive(Serialize, Deserialize, Default)]
struct HttpMonitorsFile {
    monitors: Vec<HttpMonitorConfig>,
}

/// Resolve the path to the HTTP monitors file.
fn monitors_path(config_dir: &std::path::Path) -> PathBuf {
    config_dir.join(HTTP_MONITORS_FILE)
}

/// Load saved HTTP monitor configs from disk. Returns an empty list if the file
/// doesn't exist yet.
pub fn load_http_monitors(config_dir: &std::path::Path) -> Result<Vec<HttpMonitorConfig>> {
    let path = monitors_path(config_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content =
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let file: HttpMonitorsFile =
        serde_json::from_str(&content).with_context(|| format!("parsing {}", path.display()))?;
    Ok(file.monitors)
}

/// Persist the current HTTP monitor config list to disk.
pub fn save_http_monitors(
    config_dir: &std::path::Path,
    monitors: &[HttpMonitorConfig],
) -> Result<()> {
    let path = monitors_path(config_dir);
    let file = HttpMonitorsFile {
        monitors: monitors.to_vec(),
    };
    let content = serde_json::to_string_pretty(&file).context("serialising HTTP monitors")?;
    write_atomic(&path, &content).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_config(url: &str) -> HttpMonitorConfig {
        HttpMonitorConfig::new(url.to_string(), 30_000, "GET".into(), 200, 5_000)
    }

    #[test]
    fn roundtrip_empty() {
        let dir = TempDir::new().unwrap();
        let monitors = load_http_monitors(dir.path()).unwrap();
        assert!(monitors.is_empty());
    }

    #[test]
    fn roundtrip_with_monitors() {
        let dir = TempDir::new().unwrap();
        let original = vec![
            make_config("https://a.example.com"),
            make_config("https://b.example.com"),
        ];
        save_http_monitors(dir.path(), &original).unwrap();
        let loaded = load_http_monitors(dir.path()).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].url, "https://a.example.com");
        assert_eq!(loaded[1].url, "https://b.example.com");
        // IDs must survive the round-trip so reloaded monitors keep identity.
        assert_eq!(loaded[0].id, original[0].id);
        assert_eq!(loaded[1].id, original[1].id);
    }

    #[test]
    fn roundtrip_preserves_all_config_fields() {
        let dir = TempDir::new().unwrap();
        let cfg = HttpMonitorConfig::new(
            "https://api.example.com/health".into(),
            15_000,
            "HEAD".into(),
            204,
            8_000,
        );
        save_http_monitors(dir.path(), std::slice::from_ref(&cfg)).unwrap();
        let loaded = load_http_monitors(dir.path()).unwrap();
        assert_eq!(loaded.len(), 1);
        let got = &loaded[0];
        assert_eq!(got.id, cfg.id);
        assert_eq!(got.url, "https://api.example.com/health");
        assert_eq!(got.interval_ms, 15_000);
        assert_eq!(got.method, "HEAD");
        assert_eq!(got.expected_status, 204);
        assert_eq!(got.timeout_ms, 8_000);
    }

    /// Regression (#2320): a save that cannot durably complete must fail
    /// **without** clobbering the previously-saved monitors. The old
    /// truncate-in-place `fs::write` would succeed by overwriting the existing
    /// file, so this fails red on it; the atomic temp+rename write cannot create
    /// its temp file in a read-only directory and therefore leaves the prior
    /// `http-monitors.json` untouched.
    #[cfg(unix)]
    #[test]
    fn failed_save_preserves_previous_monitors() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        save_http_monitors(dir.path(), &[make_config("https://original.example.com")]).unwrap();
        let path = monitors_path(dir.path());
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

        let result = save_http_monitors(
            dir.path(),
            &[make_config("https://replacement.example.com")],
        );
        std::fs::set_permissions(dir.path(), restore).unwrap();

        assert!(
            result.is_err(),
            "a save that cannot durably complete must report an error"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            before,
            "a failed save must leave the previous monitors fully intact"
        );
    }

    #[test]
    fn overwrite_updates_list() {
        let dir = TempDir::new().unwrap();
        save_http_monitors(dir.path(), &[make_config("https://old.example.com")]).unwrap();
        save_http_monitors(
            dir.path(),
            &[
                make_config("https://new.example.com"),
                make_config("https://extra.example.com"),
            ],
        )
        .unwrap();
        let loaded = load_http_monitors(dir.path()).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].url, "https://new.example.com");
    }
}

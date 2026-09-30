//! Persistent storage for HTTP monitor configurations.
//!
//! Only the monitor **configs** (url, interval, method, expected status,
//! timeout, id) are persisted — never runtime state (last result, running
//! flag). On the next launch [`NetworkManager::init`](super::NetworkManager)
//! reloads these configs and auto-starts a poll loop for each, so a configured
//! monitor survives an app restart instead of silently disappearing.
//!
//! Mirrors the Wake-on-LAN persistence in [`super::wol_storage`].

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::http_monitor::HttpMonitorConfig;
use crate::connection::recovery::RecoveryResult;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{
    guard_not_newer, load_store_with_recovery, read_unknown_fields, salvage_list_store, Salvage,
    VersionedStore,
};

const HTTP_MONITORS_FILE: &str = "http-monitors.json";

/// On-disk shape of `http-monitors.json` (also read by the unified backup, PROD-068).
#[derive(Serialize, Deserialize)]
pub(crate) struct HttpMonitorsFile {
    /// Schema version. Files written before versioning have none and are read
    /// as v1.
    #[serde(default = "current_version")]
    pub(crate) version: String,
    pub(crate) monitors: Vec<HttpMonitorConfig>,
    /// Unknown top-level fields, carried through a save verbatim (PER-010).
    #[serde(flatten, default)]
    pub(crate) extra: Map<String, Value>,
}

fn current_version() -> String {
    <HttpMonitorsFile as VersionedStore>::CURRENT_VERSION.to_string()
}

impl Default for HttpMonitorsFile {
    fn default() -> Self {
        Self {
            version: current_version(),
            monitors: Vec::new(),
            extra: Map::new(),
        }
    }
}

impl VersionedStore for HttpMonitorsFile {
    const STORE_NAME: &'static str = HTTP_MONITORS_FILE;
    /// Bump together with a `migrate` step if the shape ever changes; the
    /// unified backup (PROD-068) takes the version from here.
    const CURRENT_VERSION: u32 = 1;

    fn salvage(raw: &str, file_name: &str) -> Salvage<Self> {
        salvage_list_store::<Self, HttpMonitorConfig>(raw, file_name, "monitors")
    }
}

/// Resolve the path to the HTTP monitors file.
fn monitors_path(config_dir: &Path) -> PathBuf {
    config_dir.join(HTTP_MONITORS_FILE)
}

/// Load saved HTTP monitor configs with recovery: a missing file is an empty
/// list, a newer file is left untouched (empty list + warning), and a corrupt
/// file is backed up and salvaged per monitor (or reset when even that fails).
pub fn load_http_monitors_with_recovery(
    config_dir: &Path,
) -> Result<RecoveryResult<Vec<HttpMonitorConfig>>> {
    let result = load_store_with_recovery::<HttpMonitorsFile>(
        &monitors_path(config_dir),
        HTTP_MONITORS_FILE,
    )?;
    Ok(RecoveryResult {
        data: result.data.monitors,
        warnings: result.warnings,
    })
}

/// Load saved HTTP monitor configs, logging (not returning) any recovery
/// warnings.
pub fn load_http_monitors(config_dir: &Path) -> Result<Vec<HttpMonitorConfig>> {
    let result = load_http_monitors_with_recovery(config_dir)?;
    for w in &result.warnings {
        tracing::warn!("{}: {}", w.file_name, w.message);
    }
    Ok(result.data)
}

/// Persist the current HTTP monitor config list to disk.
///
/// Refuses to overwrite a file written by a newer schema (the version is
/// re-read from disk here, so this holds across restarts), stamps the current
/// version, and carries the file's unknown top-level fields forward.
pub fn save_http_monitors(config_dir: &Path, monitors: &[HttpMonitorConfig]) -> Result<()> {
    let path = monitors_path(config_dir);
    guard_not_newer(
        &path,
        HttpMonitorsFile::STORE_NAME,
        <HttpMonitorsFile as VersionedStore>::CURRENT_VERSION,
    )?;
    let file = HttpMonitorsFile {
        version: current_version(),
        monitors: monitors.to_vec(),
        extra: read_unknown_fields(&path, &["version", "monitors"]),
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

    // ── Schema versioning + downgrade safety (#3946, part of #2744) ────────

    fn config_json(url: &str) -> serde_json::Value {
        serde_json::to_value(make_config(url)).unwrap()
    }

    /// A file written by a newer schema must never be overwritten by this build.
    #[test]
    fn save_refuses_to_overwrite_newer_file() {
        let dir = TempDir::new().unwrap();
        let path = monitors_path(dir.path());
        let newer = serde_json::json!({
            "version": "99",
            "monitors": [config_json("https://future.example.com")],
            "fromTheFuture": true,
        })
        .to_string();
        std::fs::write(&path, &newer).unwrap();

        let result = save_http_monitors(dir.path(), &[make_config("https://mine.example.com")]);
        assert!(result.is_err(), "saving over a newer file must be refused");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), newer);
    }

    /// A newer file is not interpreted by this build, and loading it leaves it
    /// untouched (no backup, no rewrite).
    #[test]
    fn load_leaves_newer_file_intact() {
        let dir = TempDir::new().unwrap();
        let path = monitors_path(dir.path());
        let newer = r#"{"version": "99", "monitors": "a new shape"}"#;
        std::fs::write(&path, newer).unwrap();

        let result = load_http_monitors_with_recovery(dir.path()).unwrap();
        assert!(result.data.is_empty());
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("newer version"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), newer);
        assert!(!path.with_extension("json.bak").exists());
    }

    /// One corrupt monitor must not cost the user every other saved monitor.
    #[test]
    fn corrupt_entry_is_dropped_and_rest_survive() {
        let dir = TempDir::new().unwrap();
        let path = monitors_path(dir.path());
        let raw = serde_json::json!({
            "monitors": [config_json("https://good.example.com"), {"id": "broken"}],
        })
        .to_string();
        std::fs::write(&path, &raw).unwrap();

        let loaded = load_http_monitors(dir.path()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].url, "https://good.example.com");
        let backup = path.with_extension("json.bak");
        assert_eq!(std::fs::read_to_string(backup).unwrap(), raw);
    }

    /// An unparseable file is backed up before it is reset.
    #[test]
    fn unparseable_file_is_backed_up_and_reset() {
        let dir = TempDir::new().unwrap();
        let path = monitors_path(dir.path());
        std::fs::write(&path, "not json {").unwrap();

        let result = load_http_monitors_with_recovery(dir.path()).unwrap();
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
        let path = monitors_path(dir.path());
        let raw = serde_json::json!({
            "monitors": [config_json("https://a.example.com")],
            "futureSetting": {"nested": [1, 2]},
        })
        .to_string();
        std::fs::write(&path, raw).unwrap();

        let monitors = load_http_monitors(dir.path()).unwrap();
        save_http_monitors(dir.path(), &monitors).unwrap();

        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["version"], "1");
        assert_eq!(
            saved["futureSetting"],
            serde_json::json!({"nested": [1, 2]})
        );
        assert_eq!(saved["monitors"].as_array().unwrap().len(), 1);
    }

    /// A pre-versioning (legacy) file has no `version` and loads as v1.
    #[test]
    fn legacy_unversioned_file_loads_as_v1() {
        let dir = TempDir::new().unwrap();
        let path = monitors_path(dir.path());
        let raw = serde_json::json!({
            "monitors": [config_json("https://a.example.com"), config_json("https://b.example.com")],
        });
        std::fs::write(&path, raw.to_string()).unwrap();

        let result = load_http_monitors_with_recovery(dir.path()).unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.len(), 2);
    }
}

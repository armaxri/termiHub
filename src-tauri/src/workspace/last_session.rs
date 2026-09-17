use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::config::{WorkspaceTabGroupDef, WorkspaceWindowDef};
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_versioned, LoadOutcome, VersionedStore};

const FILE_NAME: &str = "last-session.json";

/// The automatically persisted "last session": the open tab groups and their
/// panel layout at the time the app last had its state mutated.
///
/// This reuses the same [`WorkspaceTabGroupDef`] serialization format as named
/// workspaces, so the existing capture/restore utilities apply unchanged. Unlike
/// a workspace it has no name/id and is never shown in the workspace list — it is
/// silently saved on every layout change and silently restored on startup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LastSession {
    /// Schema version for forward compatibility.
    pub version: String,
    /// The captured tab groups (panel trees) of the session.
    pub tab_groups: Vec<WorkspaceTabGroupDef>,
    /// Index into `tab_groups` of the group that was active.
    #[serde(default)]
    pub active_group_index: usize,
    /// The set of windows the session spanned, in restore order (multi-window
    /// persistence, #1905). Absent/empty for a legacy single-window session,
    /// which restores entirely into the main window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows: Option<Vec<WorkspaceWindowDef>>,
    /// Unknown top-level keys, captured verbatim so an older app preserves
    /// fields a newer version added rather than dropping them on save (PER-010).
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl crate::utils::migrate::VersionedStore for LastSession {
    const STORE_NAME: &'static str = "last-session.json";
    const CURRENT_VERSION: u32 = 1;
}

impl LastSession {
    /// True when the session holds no tab groups and therefore nothing to restore.
    pub fn is_empty(&self) -> bool {
        self.tab_groups.is_empty()
    }
}

/// Handles reading/writing the last-session JSON file.
pub struct LastSessionStorage {
    file_path: PathBuf,
}

impl LastSessionStorage {
    /// Create a new storage instance, resolving the config directory.
    ///
    /// If `TERMIHUB_CONFIG_DIR` is set, it overrides the default Tauri config directory.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let config_dir = resolve_config_dir(Some(app_handle))?;

        fs::create_dir_all(&config_dir).context("Failed to create config directory")?;

        Ok(Self {
            file_path: config_dir.join(FILE_NAME),
        })
    }

    /// Load the persisted last session, if any.
    ///
    /// Returns `Ok(None)` when the file is missing, unparseable, or written by a
    /// **newer** schema version — a corrupt, stale, or too-new last-session file
    /// should never block startup, so it is treated as "no session to restore".
    /// Crucially, a newer file is only *ignored*, never overwritten: the save
    /// path guards against clobbering it (PER-004).
    ///
    /// A genuinely corrupt file is *preserved* — moved aside to a `<name>.bak`
    /// sidecar — before load proceeds as "no session" (SM-023). Otherwise the
    /// corrupt-but-maybe-recoverable bytes are lost the moment the next layout
    /// change saves over them (the save path's [`guard_not_newer`] deliberately
    /// allows overwriting a file with no readable version, i.e. a corrupt one).
    /// Backing it up on load hands the user/support a chance to recover, matching
    /// the corruption-recovery convention of the other JSON stores.
    pub fn load(&self) -> Result<Option<LastSession>> {
        if !self.file_path.exists() {
            return Ok(None);
        }

        let data =
            fs::read_to_string(&self.file_path).context("Failed to read last-session file")?;

        match load_versioned::<LastSession>(&data) {
            LoadOutcome::Loaded { data, .. } => Ok(Some(data)),
            LoadOutcome::Newer(err) => {
                tracing::warn!("Last-session file written by a newer version, ignoring it: {err}");
                Ok(None)
            }
            LoadOutcome::Corrupt(e) => {
                self.preserve_corrupt_file(&e);
                Ok(None)
            }
        }
    }

    /// Move a corrupt last-session file aside to a `<name>.bak` sidecar so its
    /// bytes are preserved for recovery instead of being silently overwritten by
    /// the next save (SM-023).
    ///
    /// Best-effort: a failure here must never block startup, so it only logs. The
    /// corrupt file is left in place on failure (never deleted without a backup),
    /// and load still proceeds as "no session".
    fn preserve_corrupt_file(&self, detail: &str) {
        let backup = self.file_path.with_extension("json.bak");
        match fs::rename(&self.file_path, &backup) {
            Ok(()) => tracing::error!(
                "Last-session file is corrupt ({detail}); preserved to {} and ignored",
                backup.display()
            ),
            Err(rename_err) => tracing::error!(
                "Last-session file is corrupt ({detail}); failed to preserve it to {} \
                 ({rename_err}); leaving it in place and ignoring it",
                backup.display()
            ),
        }
    }

    /// Save the last session to disk (pretty-printed JSON).
    ///
    /// The write is atomic (temp file in the same directory + rename). This file
    /// is rewritten on every layout change, so a torn write is especially likely;
    /// an atomic replace guarantees the previous session survives an interrupted
    /// save instead of being silently discarded on next startup (#2318). Before
    /// writing, [`guard_not_newer`] refuses to overwrite a file written by a newer
    /// schema version (PER-004).
    pub fn save(&self, session: &LastSession) -> Result<()> {
        guard_not_newer(
            &self.file_path,
            LastSession::STORE_NAME,
            LastSession::CURRENT_VERSION,
        )?;

        let data =
            serde_json::to_string_pretty(session).context("Failed to serialize last session")?;

        write_atomic(&self.file_path, &data).context("Failed to write last-session file")?;

        Ok(())
    }

    /// Remove the persisted last session, if it exists.
    pub fn clear(&self) -> Result<()> {
        if self.file_path.exists() {
            fs::remove_file(&self.file_path).context("Failed to remove last-session file")?;
        }
        Ok(())
    }
}

/// Manages the last-session lifecycle: load on startup, save on change, clear on demand.
pub struct LastSessionManager {
    storage: LastSessionStorage,
}

impl LastSessionManager {
    /// Create a manager backed by on-disk storage.
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        Ok(Self {
            storage: LastSessionStorage::new(app_handle)?,
        })
    }

    /// Load the persisted last session, if any (never errors on corrupt data).
    pub fn load(&self) -> Result<Option<LastSession>> {
        self.storage.load()
    }

    /// Persist the given session, or clear the file when the session is empty.
    pub fn save(&self, session: LastSession) -> Result<()> {
        if session.is_empty() {
            self.storage.clear()
        } else {
            self.storage.save(&session)
        }
    }

    /// Remove the persisted last session.
    pub fn clear(&self) -> Result<()> {
        self.storage.clear()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::config::WorkspaceLayoutNode;
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> LastSessionStorage {
        LastSessionStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    fn sample_session() -> LastSession {
        LastSession {
            version: "1".to_string(),
            tab_groups: vec![WorkspaceTabGroupDef {
                name: "Group 1".to_string(),
                color: None,
                window_id: None,
                layout: WorkspaceLayoutNode::Leaf { tabs: vec![] },
            }],
            active_group_index: 0,
            windows: None,
            extra: Default::default(),
        }
    }

    #[test]
    fn load_missing_file_returns_none() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        assert!(storage.load().unwrap().is_none());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let session = sample_session();

        storage.save(&session).unwrap();
        let loaded = storage.load().unwrap().unwrap();

        assert_eq!(loaded, session);
        assert_eq!(loaded.tab_groups.len(), 1);
        assert_eq!(loaded.tab_groups[0].name, "Group 1");
    }

    #[test]
    fn corrupt_file_is_ignored_returns_none() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        fs::write(&storage.file_path, "this is not valid json {{{").unwrap();

        // Must never error — a corrupt last session should not block startup.
        assert!(storage.load().unwrap().is_none());
    }

    /// SM-023: a corrupt last-session file must be preserved to a `.bak` sidecar
    /// on load, not silently discarded. Without the backup the corrupt-but-maybe-
    /// recoverable data is lost the moment the next layout change overwrites it
    /// (the save path's `guard_not_newer` explicitly allows overwriting a file
    /// with no readable version, i.e. a corrupt one). Preserving it on load gives
    /// the user/support a chance to recover before it is gone.
    #[test]
    fn corrupt_file_is_backed_up_to_bak_on_load() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let corrupt = "this is not valid json {{{";
        fs::write(&storage.file_path, corrupt).unwrap();

        // Load treats it as "no session" (never errors, never blocks startup)...
        assert!(storage.load().unwrap().is_none());

        // ...but the corrupt bytes are preserved to a `.bak` sidecar, not lost.
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists(), "corrupt file must be backed up to a .bak");
        assert_eq!(
            fs::read_to_string(&backup).unwrap(),
            corrupt,
            "the .bak must hold the original corrupt bytes verbatim"
        );

        // The corrupt file is moved aside so the next save writes a fresh file
        // instead of clobbering the still-corrupt original.
        assert!(
            !storage.file_path.exists(),
            "the corrupt file must be moved aside, not left to be overwritten"
        );
    }

    /// A subsequent save after a corrupt load writes a fresh valid file and leaves
    /// the `.bak` backup intact — the recovered data stays available.
    #[test]
    fn save_after_corrupt_load_keeps_backup_intact() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let corrupt = "totally not json !!!";
        fs::write(&storage.file_path, corrupt).unwrap();

        assert!(storage.load().unwrap().is_none());
        storage.save(&sample_session()).unwrap();

        let backup = storage.file_path.with_extension("json.bak");
        assert_eq!(
            fs::read_to_string(&backup).unwrap(),
            corrupt,
            "the corrupt backup must survive a later save"
        );
        // The live file is now a valid, loadable session again.
        assert_eq!(storage.load().unwrap().unwrap(), sample_session());
    }

    #[test]
    fn clear_removes_file() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        storage.save(&sample_session()).unwrap();
        assert!(storage.file_path.exists());

        storage.clear().unwrap();
        assert!(!storage.file_path.exists());
        assert!(storage.load().unwrap().is_none());
    }

    #[test]
    fn clear_on_missing_file_is_ok() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        // Clearing a non-existent file must succeed silently.
        assert!(storage.clear().is_ok());
    }

    /// Regression (#2318): the last-session file is rewritten on every layout
    /// change, so a torn write is especially likely. A save that cannot durably
    /// complete must fail without destroying the previously-saved session. The
    /// old truncate-in-place `fs::write` overwrites the existing file here (red);
    /// the atomic temp+rename write leaves it untouched.
    #[cfg(unix)]
    #[test]
    fn failed_save_preserves_previous_session() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        storage.save(&sample_session()).unwrap();
        let before = fs::read_to_string(&storage.file_path).unwrap();

        let restore = fs::metadata(dir.path()).unwrap().permissions();
        let mut ro = restore.clone();
        ro.set_mode(0o500);
        fs::set_permissions(dir.path(), ro).unwrap();

        // Root can write regardless of mode — skip in that case.
        let probe = dir.path().join(".probe");
        if fs::write(&probe, b"x").is_ok() {
            let _ = fs::remove_file(&probe);
            fs::set_permissions(dir.path(), restore).unwrap();
            return;
        }

        let mut updated = sample_session();
        updated.version = "2".to_string();
        let result = storage.save(&updated);

        fs::set_permissions(dir.path(), restore).unwrap();

        assert!(
            result.is_err(),
            "a save that cannot durably complete must report an error"
        );
        let after = fs::read_to_string(&storage.file_path).unwrap();
        assert_eq!(
            before, after,
            "a failed save must leave the previous session fully intact"
        );
        serde_json::from_str::<LastSession>(&after).expect("preserved session still parses");
    }

    #[test]
    fn deserialize_without_active_group_index_defaults_to_zero() {
        let json = r#"{"version":"1","tabGroups":[]}"#;
        let session: LastSession = serde_json::from_str(json).unwrap();
        assert_eq!(session.active_group_index, 0);
        assert!(session.is_empty());
    }

    #[test]
    fn window_dimension_round_trips() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        let mut session = sample_session();
        session.tab_groups[0].window_id = Some("win-1".to_string());
        session.windows = Some(vec![
            WorkspaceWindowDef {
                id: "main".to_string(),
            },
            WorkspaceWindowDef {
                id: "win-1".to_string(),
            },
        ]);

        storage.save(&session).unwrap();
        let loaded = storage.load().unwrap().unwrap();

        assert_eq!(loaded, session);
        assert_eq!(loaded.windows.unwrap().len(), 2);
        assert_eq!(loaded.tab_groups[0].window_id.as_deref(), Some("win-1"));
    }

    #[test]
    fn legacy_session_without_window_dimension_deserializes() {
        // A pre-multi-window last session: no windows set, no windowId.
        let json =
            r#"{"version":"1","tabGroups":[{"name":"Main","layout":{"type":"leaf","tabs":[]}}]}"#;
        let session: LastSession = serde_json::from_str(json).unwrap();
        assert!(session.windows.is_none());
        assert!(session.tab_groups[0].window_id.is_none());
    }

    #[test]
    fn windows_omitted_when_none_in_json() {
        let json = serde_json::to_string(&sample_session()).unwrap();
        assert!(!json.contains("\"windows\""));
    }

    #[test]
    fn manager_save_empty_session_clears_file() {
        let dir = TempDir::new().unwrap();
        let storage = LastSessionStorage {
            file_path: dir.path().join(FILE_NAME),
        };
        storage.save(&sample_session()).unwrap();
        assert!(storage.file_path.exists());

        // Saving an empty session through the manager should clear the file
        // rather than persist an empty session.
        let manager = LastSessionManager { storage };
        manager
            .save(LastSession {
                version: "1".to_string(),
                tab_groups: vec![],
                active_group_index: 0,
                windows: None,
                extra: Default::default(),
            })
            .unwrap();

        assert!(manager.load().unwrap().is_none());
    }
}

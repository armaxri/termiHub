//! Agent state persistence for session recovery after restart.
//!
//! Tracks running sessions with their daemon socket paths so the agent
//! can reconnect to surviving daemon processes on startup.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::{debug, error, warn};

/// Current schema version stamped into every freshly written `state.json`.
///
/// A file written before this field existed deserializes with `version == 0`
/// (`#[serde(default)]` → `u32::default()`), which lets a future migration hook
/// tell a pre-versioning file apart from a current one. The full migration
/// framework is tracked in #2744; today the read is deliberately tolerant (any
/// version loads) and [`AgentState::save_to`] always re-stamps this value.
pub const CURRENT_STATE_VERSION: u32 = 1;

/// Persisted agent state written to `state.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentState {
    /// Schema version of the on-disk file (see [`CURRENT_STATE_VERSION`]).
    ///
    /// `#[serde(default)]` so a pre-versioning `state.json` still loads (it reads
    /// back as `0`); [`AgentState::save_to`] always writes the current version.
    #[serde(default)]
    pub version: u32,
    pub sessions: HashMap<String, PersistedSession>,
    /// Self-update bookkeeping (last GitHub poll time, staged pending update).
    ///
    /// `#[serde(default)]` so a `state.json` written by an agent that predates
    /// the self-update feature still loads (the field defaults to empty).
    #[serde(default)]
    pub update: UpdateState,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            version: CURRENT_STATE_VERSION,
            sessions: HashMap::new(),
            update: UpdateState::default(),
        }
    }
}

/// Self-update state persisted across agent restarts (#1355).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct UpdateState {
    /// RFC 3339 timestamp of the last GitHub `releases/latest` poll, or `None`
    /// if the agent has never polled.
    #[serde(default)]
    pub last_check_time: Option<String>,
    /// A downloaded-and-verified binary awaiting application, or `None`.
    #[serde(default)]
    pub pending_update: Option<PendingUpdate>,
}

/// An agent binary that has been staged (downloaded + SHA-256-verified, or
/// pushed via `agent.request_deferred_update`) but not yet applied.
///
/// The deferred apply (SI-6, #1352) is wired: the agent applies this when its
/// last session disconnects, or immediately via `agent.request_deferred_update`
/// when it is idle — see [`crate::session::manager::SessionManager`] and the
/// `crate::update::apply` module. A *self-update* staged by the background timer
/// now flows through the same path and auto-applies on idle (#1401), gated on
/// the connection's update strategy; a failed apply keeps this record for retry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingUpdate {
    /// Target version (release tag semver, e.g. `"0.3.0"`).
    pub version: String,
    /// Absolute path to the staged, verified binary.
    pub binary_path: String,
    /// RFC 3339 timestamp when the binary was staged.
    pub staged_at: String,
}

/// Minimal session info stored for recovery.
///
/// Stores the connection type ID and settings JSON so the session can
/// be reconnected by spawning a new daemon or recreating the connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSession {
    /// Connection type identifier (e.g., `"local"`, `"ssh"`, `"docker"`).
    pub type_id: String,
    pub title: String,
    pub created_at: String,
    /// Path to the daemon Unix socket.
    pub daemon_socket: Option<String>,
    /// Full connection settings for reconnection.
    pub settings: serde_json::Value,
    /// ID of the saved connection definition this session was created from.
    /// Survives agent restart so clients can re-link a recovered session
    /// to its source definition.
    #[serde(default)]
    pub definition_id: Option<String>,
}

impl AgentState {
    /// Load state from a specific path.
    ///
    /// A **missing** file is normal → returns empty state quietly. A file that
    /// is **present but unparseable** is never silently discarded: its bytes are
    /// quarantined to a `state.json.corrupt-<n>` sibling (preserving every
    /// recoverable session for a human/tool to salvage) and a loud `error!` names
    /// the backup path, before continuing with empty state. This upholds the
    /// "persistent sessions survive an agent restart" guarantee — a single bad
    /// byte must not vaporize the whole recovery map (AGT-017, PER-006).
    pub fn load_from(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(contents) => match serde_json::from_str::<AgentState>(&contents) {
                Ok(state) => {
                    debug!(
                        "Loaded agent state (version {}) with {} sessions from {}",
                        state.version,
                        state.sessions.len(),
                        path.display()
                    );
                    state
                }
                Err(e) => {
                    // Present-but-corrupt: quarantine the bytes rather than drop
                    // every recoverable session on the floor.
                    match backup_corrupt_state(path) {
                        Some(backup) => error!(
                            "Agent state at {} is corrupt ({}); backed up to {} and started with \
                             empty state — recoverable sessions are preserved in the backup",
                            path.display(),
                            e,
                            backup.display()
                        ),
                        None => error!(
                            "Agent state at {} is corrupt ({}) and could NOT be backed up; \
                             starting with empty state",
                            path.display(),
                            e
                        ),
                    }
                    Self::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                debug!("No agent state file at {}", path.display());
                Self::default()
            }
            Err(e) => {
                // The file exists but could not be read (e.g. permissions). Do
                // not silently pretend there were no sessions — surface it.
                warn!(
                    "Failed to read agent state from {}: {}; starting with empty state",
                    path.display(),
                    e
                );
                Self::default()
            }
        }
    }

    /// Save state to a specific path.
    pub fn save_to(&self, path: &Path) {
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                warn!(
                    "Failed to create state directory {}: {}",
                    parent.display(),
                    e
                );
                return;
            }
        }
        // Always re-stamp the current schema version on write: the in-memory
        // state is by definition the current shape, so a re-saved legacy file
        // (which loaded as version 0) is transparently upgraded to the current
        // version. Full migration handling is tracked in #2744.
        let mut to_write = self.clone();
        to_write.version = CURRENT_STATE_VERSION;
        match serde_json::to_string_pretty(&to_write) {
            Ok(json) => {
                // Atomic write (temp + rename) so a crash mid-write can never
                // truncate state.json and lose the persisted session state (#2366).
                if let Err(e) = crate::fs::write_atomic(path, &json) {
                    warn!("Failed to write agent state to {}: {:#}", path.display(), e);
                }
            }
            Err(e) => {
                warn!("Failed to serialize agent state: {}", e);
            }
        }
    }

    /// Cross-process-safe read-modify-write of the shared on-disk state.
    ///
    /// Acquires an exclusive advisory lock on `path`'s sidecar lock-file, then
    /// **re-reads the current on-disk state**, applies `delta`, and writes the
    /// result atomically before releasing the lock. Re-reading under the lock is
    /// what closes the multi-worker lost-update window (AGT-016): a peer worker's
    /// concurrent insert/remove is merged in rather than clobbered by a stale
    /// whole-struct save. Callers should pass a *delta* (insert one session,
    /// remove one session, set one update field) rather than a whole snapshot.
    ///
    /// Returns the merged state so the caller can refresh its in-memory copy to
    /// match the on-disk truth. If the lock cannot be acquired (e.g. the lock
    /// file is unwritable) it degrades to an unlocked read-modify-write and logs
    /// a warning — the same behaviour as before this guard existed, never a lost
    /// save.
    pub fn mutate_locked(path: &Path, delta: impl FnOnce(&mut AgentState)) -> AgentState {
        let _lock = match crate::fs::FileLock::acquire(path) {
            Ok(lock) => Some(lock),
            Err(e) => {
                warn!(
                    "Could not acquire cross-process lock for {}: {:#}; \
                     proceeding without it (a concurrent worker could lose an update)",
                    path.display(),
                    e
                );
                None
            }
        };
        let mut state = AgentState::load_from(path);
        delta(&mut state);
        state.save_to(path);
        state
    }

    /// The default `state.json` path under the platform config dir.
    ///
    /// Resolves to `$XDG_CONFIG_HOME/termihub-agent/state.json` on Linux,
    /// `~/Library/Application Support/termihub-agent/state.json` on macOS,
    /// and `%APPDATA%\termihub-agent\state.json` on Windows.
    pub fn default_path() -> PathBuf {
        Self::config_dir().join("state.json")
    }

    /// The platform config directory the agent stores its state under.
    pub fn config_dir() -> PathBuf {
        config_dir()
    }
}

/// Quarantine a corrupt `state.json` by renaming it aside, preserving its bytes.
///
/// Picks the lowest free `state.json.corrupt-<n>` sibling (starting at 1) so
/// repeated corruptions never clobber an earlier backup, and uses a plain
/// rename — no timestamp — so the operation is deterministic and needs no clock.
/// The rename also clears the live path, letting the next [`AgentState::save_to`]
/// write a fresh file. Returns the backup path on success, or `None` if no free
/// slot was found or the rename failed (the caller then logs and proceeds with
/// empty state).
fn backup_corrupt_state(path: &Path) -> Option<PathBuf> {
    let file_name = path.file_name()?.to_string_lossy().into_owned();
    // Cap the search so a directory already littered with backups cannot loop
    // unboundedly; 1000 quarantined copies is far past any realistic case.
    for n in 1..=1000u32 {
        let candidate = path.with_file_name(format!("{file_name}.corrupt-{n}"));
        if candidate.exists() {
            continue;
        }
        match std::fs::rename(path, &candidate) {
            Ok(()) => return Some(candidate),
            Err(e) => {
                warn!(
                    "Failed to quarantine corrupt agent state {} to {}: {}",
                    path.display(),
                    candidate.display(),
                    e
                );
                return None;
            }
        }
    }
    None
}

/// Platform config directory for the agent.
///
/// Honors `XDG_CONFIG_HOME` first on every platform (used by integration
/// tests and portable setups to redirect the agent's state to a sandbox).
/// Otherwise delegates to the `dirs` crate, which resolves `$HOME/.config`
/// on Linux, `~/Library/Application Support` on macOS, and `%APPDATA%`
/// (Roaming) on Windows. Falls back to a relative `.config/termihub-agent`
/// only as a last resort if `dirs` cannot resolve a user config directory.
fn config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("termihub-agent");
        }
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from(".config"))
        .join("termihub-agent")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn make_session(type_id: &str, socket: Option<&str>) -> PersistedSession {
        PersistedSession {
            type_id: type_id.to_string(),
            title: "Test".to_string(),
            created_at: "2026-02-20T10:00:00Z".to_string(),
            daemon_socket: socket.map(|s| s.to_string()),
            settings: json!({}),
            definition_id: None,
        }
    }

    #[test]
    fn save_and_load_round_trip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.sessions.insert(
            "sess-1".to_string(),
            make_session("local", Some("/tmp/test.sock")),
        );
        state
            .sessions
            .insert("sess-2".to_string(), make_session("serial", None));
        state.save_to(&path);

        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.sessions.len(), 2);
        assert!(loaded.sessions.contains_key("sess-1"));
        assert!(loaded.sessions.contains_key("sess-2"));

        let s1 = &loaded.sessions["sess-1"];
        assert_eq!(s1.type_id, "local");
        assert_eq!(s1.daemon_socket.as_deref(), Some("/tmp/test.sock"));
    }

    #[test]
    fn missing_file_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nonexistent.json");
        let state = AgentState::load_from(&path);
        assert!(state.sessions.is_empty());
    }

    #[test]
    fn corrupt_file_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        std::fs::write(&path, "not valid json!!!").unwrap();

        let state = AgentState::load_from(&path);
        assert!(state.sessions.is_empty());
    }

    #[test]
    fn corrupt_file_is_backed_up_not_discarded() {
        // A corrupt state.json must never be silently dropped: its bytes are
        // quarantined to a `.corrupt-<n>` sibling so recoverable sessions can be
        // salvaged (AGT-017, PER-006). Regression test — without the backup this
        // fails (no sibling file, original gone).
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        let bad = r#"{ "sessions": { truncated..."#;
        std::fs::write(&path, bad).unwrap();

        let state = AgentState::load_from(&path);
        assert!(state.sessions.is_empty(), "corrupt load must be empty");

        // The bytes were preserved verbatim in the backup, not lost.
        let backup = tmp.path().join("state.json.corrupt-1");
        assert!(
            backup.exists(),
            "corrupt file must be backed up, not discarded"
        );
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), bad);
    }

    #[test]
    fn repeated_corruption_keeps_earlier_backups() {
        // A second corruption must not clobber the first quarantined copy — the
        // counter advances so both sets of bytes survive.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        std::fs::write(&path, "first-corrupt").unwrap();
        AgentState::load_from(&path);
        std::fs::write(&path, "second-corrupt").unwrap();
        AgentState::load_from(&path);

        let b1 = tmp.path().join("state.json.corrupt-1");
        let b2 = tmp.path().join("state.json.corrupt-2");
        assert_eq!(std::fs::read_to_string(&b1).unwrap(), "first-corrupt");
        assert_eq!(std::fs::read_to_string(&b2).unwrap(), "second-corrupt");
    }

    #[test]
    fn save_writes_version_and_leaves_no_temp_file() {
        // A save round-trips, stamps the current schema version into the file,
        // and leaves no partial/temp artifact behind (atomic write, #2366).
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state
            .sessions
            .insert("s".to_string(), make_session("local", Some("/tmp/s.sock")));
        state.save_to(&path);

        let raw = std::fs::read_to_string(&path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(json["version"], CURRENT_STATE_VERSION);

        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.version, CURRENT_STATE_VERSION);
        assert_eq!(loaded.sessions.len(), 1);

        // No leftover temp/partial files — only state.json remains.
        let names: Vec<String> = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["state.json".to_string()], "got {names:?}");
    }

    #[test]
    fn legacy_versionless_state_loads_as_version_zero_and_upgrades_on_save() {
        // A pre-versioning state.json (no `version` key) still loads: it reads
        // back as version 0 so a future migration hook (#2744) can spot it, and a
        // re-save transparently upgrades it to the current version.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        std::fs::write(
            &path,
            r#"{
              "sessions": {
                "sess-1": {
                  "type_id": "shell",
                  "title": "Legacy",
                  "created_at": "2026-02-20T10:00:00Z",
                  "daemon_socket": "/tmp/legacy.sock",
                  "settings": {}
                }
              }
            }"#,
        )
        .unwrap();

        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.version, 0, "versionless file must read back as 0");
        assert_eq!(loaded.sessions.len(), 1);

        // Re-saving stamps the current version without losing sessions.
        loaded.save_to(&path);
        let reloaded = AgentState::load_from(&path);
        assert_eq!(reloaded.version, CURRENT_STATE_VERSION);
        assert_eq!(reloaded.sessions.len(), 1);
    }

    #[test]
    fn docker_session_round_trip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.sessions.insert(
            "docker-1".to_string(),
            PersistedSession {
                type_id: "docker".to_string(),
                title: "Docker test".to_string(),
                created_at: "2026-02-20T10:00:00Z".to_string(),
                daemon_socket: Some("/tmp/docker.sock".to_string()),
                settings: json!({"image": "ubuntu:22.04", "shell": "/bin/bash"}),
                definition_id: None,
            },
        );
        state.save_to(&path);

        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.sessions.len(), 1);

        let s = &loaded.sessions["docker-1"];
        assert_eq!(s.type_id, "docker");
        assert_eq!(s.daemon_socket.as_deref(), Some("/tmp/docker.sock"));
        assert_eq!(s.settings["image"], "ubuntu:22.04");
    }

    #[test]
    fn definition_id_round_trips() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.sessions.insert(
            "sess-1".to_string(),
            PersistedSession {
                type_id: "shell".to_string(),
                title: "Build".to_string(),
                created_at: "2026-02-20T10:00:00Z".to_string(),
                daemon_socket: Some("/tmp/s.sock".to_string()),
                settings: json!({}),
                definition_id: Some("def-42".to_string()),
            },
        );
        state.save_to(&path);

        let loaded = AgentState::load_from(&path);
        assert_eq!(
            loaded.sessions["sess-1"].definition_id.as_deref(),
            Some("def-42")
        );
    }

    #[test]
    fn legacy_state_without_definition_id_loads() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        // Pre-existing state.json from an earlier agent version that did not
        // know about definition_id — must still load (default to None).
        std::fs::write(
            &path,
            r#"{
              "sessions": {
                "sess-1": {
                  "type_id": "shell",
                  "title": "Legacy",
                  "created_at": "2026-02-20T10:00:00Z",
                  "daemon_socket": "/tmp/legacy.sock",
                  "settings": {}
                }
              }
            }"#,
        )
        .unwrap();

        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.sessions.len(), 1);
        assert!(loaded.sessions["sess-1"].definition_id.is_none());
    }

    #[test]
    fn config_dir_returns_absolute_path_under_termihub_agent() {
        // Regression test for #764: on every supported platform (including
        // Windows) the agent's config directory must be an absolute path
        // rooted under the OS's user config location, not a relative
        // working-directory path.
        let dir = config_dir();
        assert!(
            dir.is_absolute(),
            "config_dir must be absolute, got {}",
            dir.display()
        );
        assert!(
            dir.ends_with("termihub-agent"),
            "config_dir must end with 'termihub-agent', got {}",
            dir.display()
        );
    }

    #[test]
    fn state_path_lives_inside_config_dir() {
        let path = AgentState::default_path();
        assert_eq!(
            path.file_name().and_then(|s| s.to_str()),
            Some("state.json")
        );
        assert!(
            path.is_absolute(),
            "state_path must be absolute, got {}",
            path.display()
        );
    }

    #[test]
    fn update_state_round_trips() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.update.last_check_time = Some("2026-07-10T12:00:00Z".to_string());
        state.update.pending_update = Some(PendingUpdate {
            version: "0.3.0".to_string(),
            binary_path: "/tmp/updates/termihub-agent-linux-x64".to_string(),
            staged_at: "2026-07-10T12:00:01Z".to_string(),
        });
        state.save_to(&path);

        let loaded = AgentState::load_from(&path);
        assert_eq!(
            loaded.update.last_check_time.as_deref(),
            Some("2026-07-10T12:00:00Z")
        );
        let pending = loaded
            .update
            .pending_update
            .expect("pending update present");
        assert_eq!(pending.version, "0.3.0");
        assert_eq!(pending.binary_path, "/tmp/updates/termihub-agent-linux-x64");
    }

    #[test]
    fn deferred_update_request_round_trips_and_consumes() {
        // A deferred update requested via `agent.request_deferred_update` records
        // a PendingUpdate (version may be empty when only a path is supplied). It
        // must survive a restart and clear cleanly once consumed on apply.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.update.pending_update = Some(PendingUpdate {
            version: String::new(),
            binary_path: "/opt/updates/termihub-agent".to_string(),
            staged_at: "2026-07-14T09:00:00Z".to_string(),
        });
        state.save_to(&path);

        // Survives a restart.
        let mut reloaded = AgentState::load_from(&path);
        let pending = reloaded
            .update
            .pending_update
            .clone()
            .expect("pending update present after reload");
        assert_eq!(pending.binary_path, "/opt/updates/termihub-agent");
        assert!(pending.version.is_empty());

        // Consuming it (apply) clears it and persists the cleared state.
        let taken = reloaded.update.pending_update.take();
        assert!(taken.is_some());
        reloaded.save_to(&path);
        let after = AgentState::load_from(&path);
        assert!(after.update.pending_update.is_none());
    }

    #[test]
    fn legacy_state_without_update_field_loads() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");
        // Pre-existing state.json from an agent version that predates #1355 —
        // must still load, defaulting `update` to an empty UpdateState.
        std::fs::write(
            &path,
            r#"{
              "sessions": {}
            }"#,
        )
        .unwrap();

        let loaded = AgentState::load_from(&path);
        assert!(loaded.sessions.is_empty());
        assert_eq!(loaded.update, UpdateState::default());
        assert!(loaded.update.last_check_time.is_none());
        assert!(loaded.update.pending_update.is_none());
    }

    /// A save that fails part-way (here: the parent directory is read-only, so a
    /// new temp file cannot be created) must leave the **previous** good
    /// `state.json` untouched — never a truncated or empty file. This is the
    /// whole point of an atomic write: a torn write must never lose the persisted
    /// session-recovery state. Regression test for #2366.
    #[cfg(unix)]
    #[test]
    fn failed_save_preserves_previous_state() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("cfg");
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("state.json");

        // Persist a good state first.
        let mut original = AgentState::default();
        original.sessions.insert(
            "keep".to_string(),
            make_session("local", Some("/tmp/keep.sock")),
        );
        original.save_to(&path);
        assert_eq!(AgentState::load_from(&path).sessions.len(), 1);

        // Make the parent directory read-only so the save cannot complete.
        let mut ro = std::fs::metadata(&dir).unwrap().permissions();
        ro.set_mode(0o500);
        std::fs::set_permissions(&dir, ro).unwrap();

        // Attempt to save a DIFFERENT state; the write must fail internally
        // without panicking and without clobbering the file on disk.
        let mut changed = AgentState::default();
        changed
            .sessions
            .insert("gone".to_string(), make_session("serial", None));
        changed.save_to(&path);

        // Restore write permission so we can read the file and so temp-dir
        // cleanup succeeds.
        let mut rw = std::fs::metadata(&dir).unwrap().permissions();
        rw.set_mode(0o700);
        std::fs::set_permissions(&dir, rw).unwrap();

        // The on-disk file must still hold the ORIGINAL state, intact.
        let recovered = AgentState::load_from(&path);
        assert_eq!(
            recovered.sessions.len(),
            1,
            "a failed save clobbered state.json — torn write lost data"
        );
        assert!(recovered.sessions.contains_key("keep"));
        assert!(!recovered.sessions.contains_key("gone"));
    }

    /// Two simulated workers concurrently inserting *different* sessions into
    /// the same shared `state.json` must both survive — the classic lost-update
    /// that `mutate_locked`'s locked read-modify-write exists to prevent
    /// (AGT-016). Without the lock + re-read, one worker's blind whole-struct
    /// save would clobber the other's session.
    #[test]
    fn concurrent_mutate_locked_never_loses_an_insert() {
        use std::sync::Arc;

        let tmp = TempDir::new().unwrap();
        let path = Arc::new(tmp.path().join("state.json"));
        AgentState::default().save_to(path.as_path());

        let iters = 40;
        let workers = 3;
        let handles: Vec<_> = (0..workers)
            .map(|w| {
                let path = Arc::clone(&path);
                std::thread::spawn(move || {
                    for i in 0..iters {
                        let key = format!("w{w}-{i}");
                        AgentState::mutate_locked(&path, |s| {
                            s.sessions
                                .insert(key.clone(), make_session("local", Some("/tmp/s.sock")));
                        });
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let loaded = AgentState::load_from(path.as_path());
        assert_eq!(
            loaded.sessions.len(),
            workers * iters,
            "every worker's inserts must survive — a shortfall means a lost update"
        );
        for w in 0..workers {
            for i in 0..iters {
                assert!(
                    loaded.sessions.contains_key(&format!("w{w}-{i}")),
                    "missing session w{w}-{i} — lost update"
                );
            }
        }
    }

    /// A `mutate_locked` remove must delete only the targeted session and
    /// preserve the rest of the on-disk map (a peer worker's sessions), because
    /// it re-reads the current file rather than overwriting with a stale
    /// snapshot.
    #[test]
    fn mutate_locked_remove_preserves_other_sessions() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut seeded = AgentState::default();
        seeded.sessions.insert(
            "keep".to_string(),
            make_session("local", Some("/tmp/k.sock")),
        );
        seeded
            .sessions
            .insert("drop".to_string(), make_session("serial", None));
        seeded.save_to(&path);

        let merged = AgentState::mutate_locked(&path, |s| {
            s.sessions.remove("drop");
        });

        assert!(merged.sessions.contains_key("keep"));
        assert!(!merged.sessions.contains_key("drop"));
        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.sessions.len(), 1);
        assert!(loaded.sessions.contains_key("keep"));
    }

    #[test]
    fn add_and_remove_session() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.sessions.insert(
            "sess-1".to_string(),
            make_session("local", Some("/tmp/s1.sock")),
        );
        state.save_to(&path);

        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.sessions.len(), 1);

        let mut state = loaded;
        state.sessions.remove("sess-1");
        state.save_to(&path);

        let loaded = AgentState::load_from(&path);
        assert!(loaded.sessions.is_empty());
    }
}

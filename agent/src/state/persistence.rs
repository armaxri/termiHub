//! Agent state persistence for session recovery after restart.
//!
//! Tracks running sessions with their daemon socket paths so the agent
//! can reconnect to surviving daemon processes on startup.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

/// Persisted agent state written to `state.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentState {
    pub sessions: HashMap<String, PersistedSession>,
    /// Self-update bookkeeping (last GitHub poll time, staged pending update).
    ///
    /// `#[serde(default)]` so a `state.json` written by an agent that predates
    /// the self-update feature still loads (the field defaults to empty).
    #[serde(default)]
    pub update: UpdateState,
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
    /// Returns an empty state if the file is missing or corrupt.
    pub fn load_from(path: &PathBuf) -> Self {
        match std::fs::read_to_string(path) {
            Ok(contents) => match serde_json::from_str::<AgentState>(&contents) {
                Ok(state) => {
                    debug!(
                        "Loaded agent state with {} sessions from {}",
                        state.sessions.len(),
                        path.display()
                    );
                    state
                }
                Err(e) => {
                    warn!("Failed to parse agent state from {}: {}", path.display(), e);
                    Self::default()
                }
            },
            Err(_) => {
                debug!("No agent state file at {}", path.display());
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
        match serde_json::to_string_pretty(self) {
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

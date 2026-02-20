//! Agent state persistence for session recovery after restart.
//!
//! Tracks running sessions with their daemon socket paths so the agent
//! can reconnect to surviving daemon processes on startup.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

/// Persisted agent state written to `state.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentState {
    pub sessions: HashMap<String, PersistedSession>,
}

/// Minimal session info stored for recovery.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSession {
    pub session_type: String,
    pub title: String,
    pub created_at: String,
    /// Path to the daemon Unix socket (shell and Docker sessions).
    pub daemon_socket: Option<String>,
    /// Original session config (for display/metadata).
    pub config: serde_json::Value,
    /// Docker container name (Docker sessions only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_name: Option<String>,
    /// Whether to remove the Docker container on exit (Docker sessions only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remove_on_exit: Option<bool>,
}

impl AgentState {
    /// Load state from the default state file.
    ///
    /// Returns an empty state if the file is missing or corrupt.
    pub fn load() -> Self {
        let path = Self::state_path();
        Self::load_from(&path)
    }

    /// Load state from a specific path (for testing).
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

    /// Save state to the default state file.
    pub fn save(&self) {
        let path = Self::state_path();
        self.save_to(&path);
    }

    /// Save state to a specific path (for testing).
    pub fn save_to(&self, path: &PathBuf) {
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
                if let Err(e) = std::fs::write(path, json) {
                    warn!("Failed to write agent state to {}: {}", path.display(), e);
                }
            }
            Err(e) => {
                warn!("Failed to serialize agent state: {}", e);
            }
        }
    }

    /// Add a session and persist.
    pub fn add_session(&mut self, id: String, session: PersistedSession) {
        self.sessions.insert(id, session);
        self.save();
    }

    /// Remove a session and persist.
    pub fn remove_session(&mut self, id: &str) {
        self.sessions.remove(id);
        self.save();
    }

    /// Get the default state file path: `~/.config/termihub-agent/state.json`.
    fn state_path() -> PathBuf {
        config_dir().join("state.json")
    }
}

/// Get the platform config directory for the agent.
fn config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(xdg).join("termihub-agent");
    }
    if let Ok(home) = std::env::var("HOME") {
        #[cfg(target_os = "macos")]
        return PathBuf::from(&home)
            .join("Library")
            .join("Application Support")
            .join("termihub-agent");
        #[cfg(not(target_os = "macos"))]
        return PathBuf::from(&home).join(".config").join("termihub-agent");
    }
    PathBuf::from(".config").join("termihub-agent")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn make_session(session_type: &str, socket: Option<&str>) -> PersistedSession {
        PersistedSession {
            session_type: session_type.to_string(),
            title: "Test".to_string(),
            created_at: "2026-02-20T10:00:00Z".to_string(),
            daemon_socket: socket.map(|s| s.to_string()),
            config: json!({}),
            container_name: None,
            remove_on_exit: None,
        }
    }

    #[test]
    fn save_and_load_round_trip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.sessions.insert(
            "sess-1".to_string(),
            make_session("shell", Some("/tmp/test.sock")),
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
        assert_eq!(s1.session_type, "shell");
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
                session_type: "docker".to_string(),
                title: "Docker test".to_string(),
                created_at: "2026-02-20T10:00:00Z".to_string(),
                daemon_socket: Some("/tmp/docker.sock".to_string()),
                config: json!({"image": "ubuntu:22.04", "shell": "/bin/bash"}),
                container_name: Some("termihub-docker-1".to_string()),
                remove_on_exit: Some(true),
            },
        );
        state.save_to(&path);

        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.sessions.len(), 1);

        let s = &loaded.sessions["docker-1"];
        assert_eq!(s.session_type, "docker");
        assert_eq!(s.container_name.as_deref(), Some("termihub-docker-1"));
        assert_eq!(s.remove_on_exit, Some(true));
        assert_eq!(s.daemon_socket.as_deref(), Some("/tmp/docker.sock"));
    }

    #[test]
    fn backward_compatible_load_without_docker_fields() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        // Write JSON without container_name or remove_on_exit fields
        // (simulating state saved before Docker support was added)
        let json = r#"{
            "sessions": {
                "old-shell": {
                    "session_type": "shell",
                    "title": "Old shell",
                    "created_at": "2026-02-20T10:00:00Z",
                    "daemon_socket": "/tmp/old.sock",
                    "config": {}
                }
            }
        }"#;
        std::fs::write(&path, json).unwrap();

        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.sessions.len(), 1);

        let s = &loaded.sessions["old-shell"];
        assert_eq!(s.session_type, "shell");
        assert!(s.container_name.is_none());
        assert!(s.remove_on_exit.is_none());
    }

    #[test]
    fn docker_fields_skipped_when_none() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        let mut state = AgentState::default();
        state.sessions.insert(
            "shell-1".to_string(),
            make_session("shell", Some("/tmp/test.sock")),
        );
        state.save_to(&path);

        // Read the raw JSON and verify Docker fields are absent
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("container_name"),
            "container_name should be skipped when None"
        );
        assert!(
            !raw.contains("remove_on_exit"),
            "remove_on_exit should be skipped when None"
        );
    }

    #[test]
    fn add_and_remove_session() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("state.json");

        // Override save to use our test path
        let mut state = AgentState::default();
        state.sessions.insert(
            "sess-1".to_string(),
            make_session("shell", Some("/tmp/s1.sock")),
        );
        state.save_to(&path);

        // Verify it persisted
        let loaded = AgentState::load_from(&path);
        assert_eq!(loaded.sessions.len(), 1);

        // Remove and verify
        let mut state = loaded;
        state.sessions.remove("sess-1");
        state.save_to(&path);

        let loaded = AgentState::load_from(&path);
        assert!(loaded.sessions.is_empty());
    }
}

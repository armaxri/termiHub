use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::{debug, warn};

/// A saved session definition that survives agent restarts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionDefinition {
    pub id: String,
    pub name: String,
    /// "shell" or "serial".
    pub session_type: String,
    /// Session-specific configuration (shell path, serial params, etc.).
    #[serde(default)]
    pub config: serde_json::Value,
    /// Whether this session is persistent (re-attachable after reconnect).
    #[serde(default)]
    pub persistent: bool,
}

/// Read-only snapshot returned by list operations.
#[derive(Debug, Clone, Serialize)]
pub struct DefinitionSnapshot {
    pub id: String,
    pub name: String,
    pub session_type: String,
    pub config: serde_json::Value,
    pub persistent: bool,
}

impl SessionDefinition {
    fn snapshot(&self) -> DefinitionSnapshot {
        DefinitionSnapshot {
            id: self.id.clone(),
            name: self.name.clone(),
            session_type: self.session_type.clone(),
            config: self.config.clone(),
            persistent: self.persistent,
        }
    }
}

/// Manages session definitions with disk persistence.
pub struct DefinitionStore {
    definitions: Mutex<HashMap<String, SessionDefinition>>,
    file_path: PathBuf,
}

impl DefinitionStore {
    /// Create a new store, loading any existing definitions from disk.
    pub fn new(file_path: PathBuf) -> Self {
        let definitions = Self::load_from_disk(&file_path);
        Self {
            definitions: Mutex::new(definitions),
            file_path,
        }
    }

    /// Create a store with a custom path (useful for testing).
    #[cfg(test)]
    pub fn new_temp(file_path: PathBuf) -> Self {
        Self {
            definitions: Mutex::new(HashMap::new()),
            file_path,
        }
    }

    /// Save or update a session definition.
    pub async fn define(&self, def: SessionDefinition) -> DefinitionSnapshot {
        let snapshot = def.snapshot();
        let mut defs = self.definitions.lock().await;
        defs.insert(def.id.clone(), def);
        self.save_to_disk(&defs);
        snapshot
    }

    /// List all definitions.
    pub async fn list(&self) -> Vec<DefinitionSnapshot> {
        let defs = self.definitions.lock().await;
        defs.values().map(|d| d.snapshot()).collect()
    }

    /// Delete a definition by ID. Returns `true` if found and deleted.
    pub async fn delete(&self, id: &str) -> bool {
        let mut defs = self.definitions.lock().await;
        let removed = defs.remove(id).is_some();
        if removed {
            self.save_to_disk(&defs);
        }
        removed
    }

    /// Get the default storage path: `~/.config/termihub-agent/sessions.json`.
    pub fn default_path() -> PathBuf {
        let config_dir = dirs_config_dir().join("termihub-agent");
        config_dir.join("sessions.json")
    }

    fn load_from_disk(path: &PathBuf) -> HashMap<String, SessionDefinition> {
        match std::fs::read_to_string(path) {
            Ok(contents) => match serde_json::from_str::<Vec<SessionDefinition>>(&contents) {
                Ok(defs) => {
                    debug!(
                        "Loaded {} session definitions from {}",
                        defs.len(),
                        path.display()
                    );
                    defs.into_iter().map(|d| (d.id.clone(), d)).collect()
                }
                Err(e) => {
                    warn!(
                        "Failed to parse session definitions from {}: {}",
                        path.display(),
                        e
                    );
                    HashMap::new()
                }
            },
            Err(_) => {
                debug!("No session definitions file at {}", path.display());
                HashMap::new()
            }
        }
    }

    fn save_to_disk(&self, defs: &HashMap<String, SessionDefinition>) {
        let list: Vec<&SessionDefinition> = defs.values().collect();
        if let Some(parent) = self.file_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                warn!(
                    "Failed to create config directory {}: {}",
                    parent.display(),
                    e
                );
                return;
            }
        }
        match serde_json::to_string_pretty(&list) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&self.file_path, json) {
                    warn!(
                        "Failed to write session definitions to {}: {}",
                        self.file_path.display(),
                        e
                    );
                }
            }
            Err(e) => {
                warn!("Failed to serialize session definitions: {}", e);
            }
        }
    }
}

/// Get the platform config directory (~/.config on Linux, ~/Library/Application Support on macOS).
fn dirs_config_dir() -> PathBuf {
    // Use $XDG_CONFIG_HOME if set, otherwise default to ~/.config
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(xdg);
    }
    if let Ok(home) = std::env::var("HOME") {
        #[cfg(target_os = "macos")]
        return PathBuf::from(&home)
            .join("Library")
            .join("Application Support");
        #[cfg(not(target_os = "macos"))]
        return PathBuf::from(&home).join(".config");
    }
    PathBuf::from(".config")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir;

    fn make_definition(id: &str, name: &str, persistent: bool) -> SessionDefinition {
        SessionDefinition {
            id: id.to_string(),
            name: name.to_string(),
            session_type: "shell".to_string(),
            config: json!({"shell": "/bin/bash"}),
            persistent,
        }
    }

    #[tokio::test]
    async fn define_and_list() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("sessions.json");
        let store = DefinitionStore::new_temp(path);

        let def = make_definition("def-1", "Build Shell", true);
        let snapshot = store.define(def).await;
        assert_eq!(snapshot.id, "def-1");
        assert_eq!(snapshot.name, "Build Shell");
        assert!(snapshot.persistent);

        let list = store.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "def-1");
    }

    #[tokio::test]
    async fn define_updates_existing() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("sessions.json");
        let store = DefinitionStore::new_temp(path);

        store
            .define(make_definition("def-1", "Old Name", false))
            .await;
        store
            .define(make_definition("def-1", "New Name", true))
            .await;

        let list = store.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "New Name");
        assert!(list[0].persistent);
    }

    #[tokio::test]
    async fn delete_existing() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("sessions.json");
        let store = DefinitionStore::new_temp(path);

        store.define(make_definition("def-1", "Shell", false)).await;
        assert!(store.delete("def-1").await);
        assert!(store.list().await.is_empty());
    }

    #[tokio::test]
    async fn delete_nonexistent() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("sessions.json");
        let store = DefinitionStore::new_temp(path);

        assert!(!store.delete("nonexistent").await);
    }

    #[tokio::test]
    async fn persistence_round_trip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("sessions.json");

        // Write definitions
        {
            let store = DefinitionStore::new_temp(path.clone());
            store
                .define(make_definition("def-1", "Shell 1", true))
                .await;
            store
                .define(make_definition("def-2", "Shell 2", false))
                .await;
        }

        // Read back from disk
        let store2 = DefinitionStore::new(path);
        let list = store2.list().await;
        assert_eq!(list.len(), 2);

        let ids: Vec<&str> = list.iter().map(|d| d.id.as_str()).collect();
        assert!(ids.contains(&"def-1"));
        assert!(ids.contains(&"def-2"));
    }

    #[tokio::test]
    async fn handles_corrupt_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("sessions.json");
        fs::write(&path, "not valid json!!!").unwrap();

        let store = DefinitionStore::new(path);
        let list = store.list().await;
        assert!(list.is_empty());
    }

    #[tokio::test]
    async fn handles_missing_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nonexistent.json");

        let store = DefinitionStore::new(path);
        let list = store.list().await;
        assert!(list.is_empty());
    }

    #[test]
    fn session_definition_serde_round_trip() {
        let def = SessionDefinition {
            id: "def-1".to_string(),
            name: "Test".to_string(),
            session_type: "serial".to_string(),
            config: json!({"port": "/dev/ttyUSB0", "baud_rate": 115200}),
            persistent: true,
        };
        let json = serde_json::to_string(&def).unwrap();
        let parsed: SessionDefinition = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "def-1");
        assert_eq!(parsed.session_type, "serial");
        assert!(parsed.persistent);
    }

    #[test]
    fn session_definition_persistent_defaults_to_false() {
        let json = r#"{"id":"def-1","name":"Test","session_type":"shell","config":{}}"#;
        let def: SessionDefinition = serde_json::from_str(json).unwrap();
        assert!(!def.persistent);
    }
}

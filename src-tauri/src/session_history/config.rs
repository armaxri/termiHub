use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Default `use_count` for a freshly recorded entry (a legacy entry with no
/// count on disk is treated as having been used once).
fn default_use_count() -> u32 {
    1
}

/// A single recorded session in the browsable history.
///
/// Passwords and key contents are **never** stored here — only connection
/// metadata (host, port, user, auth method, …) carried in `config`, which
/// mirrors the frontend `ConnectionConfig` shape `{ type, config: { … } }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryEntry {
    /// Deduplication key (e.g. `ssh:admin@prod-db:22`).
    pub dedup_key: String,
    /// Human-readable display title (e.g. `admin@prod-db`).
    pub title: String,
    /// Connection type identifier (`ssh`, `serial`, `docker`, …).
    pub connection_type: String,
    /// Connection configuration, same shape as the frontend `ConnectionConfig`.
    pub config: Value,
    /// When this session was first recorded (Unix timestamp, milliseconds).
    pub first_used: u64,
    /// When this session was last used (Unix timestamp, milliseconds).
    pub last_used: u64,
    /// Total number of times connected.
    #[serde(default = "default_use_count")]
    pub use_count: u32,
    /// Whether the entry is pinned (exempt from automatic eviction).
    #[serde(default)]
    pub pinned: bool,
    /// Whether the entry has been promoted to a saved connection.
    #[serde(default)]
    pub promoted: bool,
}

/// Top-level schema for the `session-history.json` file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionHistoryStore {
    /// Schema version, for forward-compatible migrations.
    pub version: String,
    /// All recorded history entries (unordered on disk; sorted for display).
    pub entries: Vec<SessionHistoryEntry>,
}

impl Default for SessionHistoryStore {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            entries: Vec::new(),
        }
    }
}

/// Read a config field as a display string, accepting either a JSON string or a
/// JSON number (ports/baud rates are sometimes serialized as numbers).
fn field(config: &Value, key: &str) -> Option<String> {
    let inner = config.get("config")?;
    match inner.get(key)? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Deterministically derive a deduplication key from a connection config.
///
/// Two sessions that share a key collapse into a single history entry (whose
/// timestamp and use-count are updated) rather than creating a duplicate. The
/// `config` value mirrors the frontend `ConnectionConfig` (`{ type, config }`),
/// so per-type fields are read from the nested `config` object.
pub fn compute_dedup_key(connection_type: &str, config: &Value) -> String {
    let f = |key: &str| field(config, key);
    match connection_type {
        "ssh" => format!(
            "ssh:{}@{}:{}",
            f("username").unwrap_or_default(),
            f("host").unwrap_or_default(),
            f("port").unwrap_or_else(|| "22".to_string())
        ),
        "telnet" => format!(
            "telnet:{}:{}",
            f("host").unwrap_or_default(),
            f("port").unwrap_or_else(|| "23".to_string())
        ),
        "serial" => format!(
            "serial:{}:{}",
            f("device").or_else(|| f("port")).unwrap_or_default(),
            f("baudRate").unwrap_or_default()
        ),
        "docker" => format!(
            "docker:{}:{}",
            f("container").unwrap_or_default(),
            f("agentId").unwrap_or_else(|| "local".to_string())
        ),
        "local" => format!(
            "local:{}:{}",
            f("shell")
                .or_else(|| f("shellType"))
                .unwrap_or_else(|| "default".to_string()),
            f("shellPath").unwrap_or_default()
        ),
        "wsl" => format!(
            "wsl:{}",
            f("distribution").unwrap_or_else(|| "default".to_string())
        ),
        other => {
            // Stable fallback: type + compact JSON of the config payload.
            let payload = config
                .get("config")
                .map(|c| c.to_string())
                .unwrap_or_default();
            format!("{other}:{payload}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cfg(ty: &str, inner: Value) -> Value {
        json!({ "type": ty, "config": inner })
    }

    #[test]
    fn store_default_is_empty() {
        let store = SessionHistoryStore::default();
        assert_eq!(store.version, "1");
        assert!(store.entries.is_empty());
    }

    #[test]
    fn entry_serializes_with_camel_case_keys() {
        let entry = SessionHistoryEntry {
            dedup_key: "ssh:admin@host:22".to_string(),
            title: "admin@host".to_string(),
            connection_type: "ssh".to_string(),
            config: cfg("ssh", json!({ "host": "host", "username": "admin" })),
            first_used: 1,
            last_used: 2,
            use_count: 3,
            pinned: true,
            promoted: false,
        };
        let text = serde_json::to_string(&entry).unwrap();
        assert!(text.contains("\"dedupKey\""));
        assert!(text.contains("\"connectionType\""));
        assert!(text.contains("\"firstUsed\""));
        assert!(text.contains("\"lastUsed\""));
        assert!(text.contains("\"useCount\":3"));
        let parsed: SessionHistoryEntry = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed, entry);
    }

    #[test]
    fn use_count_defaults_to_one() {
        let entry: SessionHistoryEntry = serde_json::from_str(
            r#"{"dedupKey":"k","title":"t","connectionType":"ssh","config":{},"firstUsed":1,"lastUsed":1}"#,
        )
        .unwrap();
        assert_eq!(entry.use_count, 1);
        assert!(!entry.pinned);
        assert!(!entry.promoted);
    }

    #[test]
    fn ssh_dedup_key_uses_user_host_port() {
        let key = compute_dedup_key(
            "ssh",
            &cfg(
                "ssh",
                json!({ "host": "prod-db", "username": "admin", "port": 22 }),
            ),
        );
        assert_eq!(key, "ssh:admin@prod-db:22");
    }

    #[test]
    fn ssh_dedup_key_defaults_port_when_missing() {
        let key = compute_dedup_key(
            "ssh",
            &cfg("ssh", json!({ "host": "prod-db", "username": "admin" })),
        );
        assert_eq!(key, "ssh:admin@prod-db:22");
    }

    #[test]
    fn ssh_dedup_key_accepts_string_port() {
        let key = compute_dedup_key(
            "ssh",
            &cfg(
                "ssh",
                json!({ "host": "h", "username": "u", "port": "2222" }),
            ),
        );
        assert_eq!(key, "ssh:u@h:2222");
    }

    #[test]
    fn telnet_serial_docker_wsl_keys() {
        assert_eq!(
            compute_dedup_key(
                "telnet",
                &cfg("telnet", json!({ "host": "sw", "port": 23 }))
            ),
            "telnet:sw:23"
        );
        assert_eq!(
            compute_dedup_key(
                "serial",
                &cfg(
                    "serial",
                    json!({ "device": "/dev/ttyUSB0", "baudRate": 115200 })
                )
            ),
            "serial:/dev/ttyUSB0:115200"
        );
        assert_eq!(
            compute_dedup_key("docker", &cfg("docker", json!({ "container": "nginx" }))),
            "docker:nginx:local"
        );
        assert_eq!(
            compute_dedup_key("wsl", &cfg("wsl", json!({ "distribution": "Ubuntu" }))),
            "wsl:Ubuntu"
        );
    }

    #[test]
    fn local_key_reads_shell() {
        assert_eq!(
            compute_dedup_key("local", &cfg("local", json!({ "shell": "zsh" }))),
            "local:zsh:"
        );
    }

    #[test]
    fn unknown_type_falls_back_to_compact_json() {
        let key = compute_dedup_key("mystery", &cfg("mystery", json!({ "a": 1 })));
        assert_eq!(key, "mystery:{\"a\":1}");
    }
}

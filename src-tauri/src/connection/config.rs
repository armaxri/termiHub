use serde::{Deserialize, Serialize};

use crate::credential::crypto::EncryptedEnvelope;
use crate::terminal::backend::{ConnectionConfig, RemoteAgentConfig};

fn default_true() -> bool {
    true
}

fn default_log_level() -> String {
    "info".to_string()
}

fn default_starting_directory() -> String {
    "~".to_string()
}

fn default_persistent_buffer_mb() -> u32 {
    1
}

/// Runtime behaviour preferences for a connected remote agent.
///
/// Stored locally with the connection profile; sent to the agent on startup
/// and on live updates via the `agent.settingsUpdate` JSON-RPC method.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    /// Start the system monitoring subsystem on agent startup.
    #[serde(default = "default_true")]
    pub enable_monitoring: bool,
    /// Start the SFTP file-browser subsystem on agent startup.
    #[serde(default = "default_true")]
    pub enable_file_browser: bool,
    /// Enable Docker/Podman session support on agent startup.
    #[serde(default = "default_true")]
    pub enable_docker: bool,
    /// Preferred shell for new sessions. `None` means auto-detect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_shell: Option<String>,
    /// Default working directory for new sessions.
    #[serde(default = "default_starting_directory")]
    pub starting_directory: String,
    /// Agent log level: "error", "warn", "info", "debug", "trace".
    #[serde(default = "default_log_level")]
    pub log_level: String,
    /// Enable verbose JSON-RPC protocol tracing in agent logs.
    #[serde(default)]
    pub verbose_tracing: bool,
    /// Ring-buffer size for persistent sessions in MiB (1–64).
    #[serde(default = "default_persistent_buffer_mb")]
    pub persistent_scrollback_buffer_size_mb: u32,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            enable_monitoring: true,
            enable_file_browser: true,
            enable_docker: true,
            default_shell: None,
            starting_directory: "~".to_string(),
            log_level: "info".to_string(),
            verbose_tracing: false,
            persistent_scrollback_buffer_size_mb: 1,
        }
    }
}

/// Per-connection terminal display options.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub horizontal_scrolling: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scrollback_buffer: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_blink: Option<bool>,
    /// Per-connection line-ending override ("cr", "lf", or "crlf").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_ending: Option<String>,
    /// Per-connection terminal line-height multiplier (may be fractional).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    /// When `true`, this connection's session output is logged to a file on
    /// connect (#1960).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_to_file: Option<bool>,
    /// When logging to a file, prefix each line with a timestamp (#1960).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_timestamps: Option<bool>,
    /// Per-connection syntax-highlighting override (epic #1696).
    ///
    /// Stored opaquely as JSON — the backend never introspects it, so it
    /// follows the [`crate::terminal::backend::ConnectionConfig::settings`]
    /// precedent rather than duplicating the frontend's nested schema in Rust.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub syntax_highlighting: Option<serde_json::Value>,
    /// Forward-compatibility catch-all (#2311).
    ///
    /// Preserves any field the frontend `TerminalOptions` interface
    /// (`src/types/terminal.ts`) carries that this struct does not model
    /// explicitly. Without it, an unmodelled key is silently dropped on the
    /// save/load round-trip and the user loses that per-connection option on the
    /// next restart — the exact defect class behind #2261, #2309 and this
    /// hardening. Unknown keys round-trip verbatim instead. Empty by default, so
    /// a flattened empty map contributes nothing to the serialized output.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

// ---------------------------------------------------------------------------
// On-disk types (v2 nested tree format)
// ---------------------------------------------------------------------------

/// A node in the connection tree stored on disk.
///
/// Folders contain children; connections are leaf nodes.
/// Neither has an `id` — identity is determined by name within the parent.
// Both variants are intentionally value-carrying persistence nodes: a
// `Connection` inlines its `ConnectionConfig` and `TerminalOptions` (the latter
// grew with the #2311 flatten catch-all). Boxing a field to shrink the enum
// would add heap indirection to every tree node — an unhelpful trade for a
// short-lived (de)serialization type — so the size skew is accepted.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConnectionTreeNode {
    /// A folder containing child nodes.
    #[serde(rename_all = "camelCase")]
    Folder {
        name: String,
        #[serde(default)]
        is_expanded: bool,
        #[serde(default)]
        children: Vec<ConnectionTreeNode>,
    },
    /// A saved connection.
    #[serde(rename_all = "camelCase")]
    Connection {
        name: String,
        config: ConnectionConfig,
        #[serde(skip_serializing_if = "Option::is_none")]
        terminal_options: Option<TerminalOptions>,
        /// Optional per-connection icon identifier chosen in the UI.
        ///
        /// Mirrors the frontend `SavedConnection.icon`
        /// (`src/types/connection.ts`). Persisted on disk so the user's icon
        /// choice survives a save/load round-trip (#2316).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        icon: Option<String>,
    },
}

/// A saved remote agent definition (SSH transport config only, no ephemeral state).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRemoteAgent {
    pub id: String,
    pub name: String,
    pub config: RemoteAgentConfig,
    /// Runtime preferences sent to the agent on startup and on live updates.
    #[serde(default)]
    pub agent_settings: AgentSettings,
}

/// Top-level schema for the connections JSON file (v2 nested format).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStore {
    pub version: String,
    pub children: Vec<ConnectionTreeNode>,
    #[serde(default)]
    pub agents: Vec<SavedRemoteAgent>,
}

impl Default for ConnectionStore {
    fn default() -> Self {
        Self {
            version: "2".to_string(),
            children: Vec::new(),
            agents: Vec::new(),
        }
    }
}

/// Schema for external connection files. Same nested format with an optional `name`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalConnectionStore {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub version: String,
    pub children: Vec<ConnectionTreeNode>,
}

/// Export format that optionally includes an encrypted credentials section.
///
/// When the user exports "with credentials", the `$encrypted` field
/// contains an [`EncryptedEnvelope`] holding a JSON map of
/// `"connection_path_id:credential_type" -> "value"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedConnectionExport {
    pub version: String,
    pub children: Vec<ConnectionTreeNode>,
    #[serde(default)]
    pub agents: Vec<SavedRemoteAgent>,
    #[serde(rename = "$encrypted", skip_serializing_if = "Option::is_none")]
    pub encrypted: Option<EncryptedEnvelope>,
}

/// Summary of an import file before the user confirms the import.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub connection_count: usize,
    pub folder_count: usize,
    pub agent_count: usize,
    pub has_encrypted_credentials: bool,
}

/// Result of a completed import operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub connections_imported: usize,
    pub credentials_imported: usize,
}

// ---------------------------------------------------------------------------
// In-memory types (flat, with generated path-based IDs)
// ---------------------------------------------------------------------------

/// In-memory representation of a saved connection (with generated path-based ID).
///
/// The `id` is not stored on disk — it is derived from the connection's
/// position in the tree (e.g., `"Work/Dev/My SSH"`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub config: ConnectionConfig,
    pub folder_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_options: Option<TerminalOptions>,
    /// Optional per-connection icon identifier chosen in the UI.
    ///
    /// Mirrors the frontend `SavedConnection.icon` (`src/types/connection.ts`).
    /// Without this field the user's icon choice was silently dropped on
    /// `save_connection` and lost on the next restart (#2316).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Runtime-only: which external file this connection was loaded from.
    /// `None` = main connections.json, `Some(path)` = external file.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_file: Option<String>,
}

/// In-memory representation of a folder (with generated path-based ID).
///
/// The `id` is not stored on disk — it is derived from the folder's
/// position in the tree (e.g., `"Work/Dev"`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub is_expanded: bool,
}

/// Flattened in-memory store used by the manager and IPC layer.
///
/// This is NOT serialized to disk — the on-disk format is [`ConnectionStore`]
/// (nested tree). Conversion happens in `tree.rs`.
pub struct FlatConnectionStore {
    pub connections: Vec<SavedConnection>,
    pub folders: Vec<ConnectionFolder>,
    pub agents: Vec<SavedRemoteAgent>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::backend::RemoteAgentConfig;

    fn make_local_config() -> ConnectionConfig {
        ConnectionConfig {
            type_id: "local".to_string(),
            settings: serde_json::json!({"shell": "bash"}),
        }
    }

    fn make_ssh_config() -> ConnectionConfig {
        ConnectionConfig {
            type_id: "ssh".to_string(),
            settings: serde_json::json!({
                "host": "example.com",
                "port": 22,
                "username": "admin",
                "authMethod": "password",
                "enableX11Forwarding": false
            }),
        }
    }

    #[test]
    fn connection_tree_node_folder_serde_round_trip() {
        let node = ConnectionTreeNode::Folder {
            name: "Work".to_string(),
            is_expanded: true,
            children: vec![ConnectionTreeNode::Connection {
                icon: None,
                name: "My SSH".to_string(),
                config: make_ssh_config(),
                terminal_options: None,
            }],
        };
        let json = serde_json::to_string(&node).unwrap();
        let deserialized: ConnectionTreeNode = serde_json::from_str(&json).unwrap();
        match deserialized {
            ConnectionTreeNode::Folder {
                name,
                is_expanded,
                children,
            } => {
                assert_eq!(name, "Work");
                assert!(is_expanded);
                assert_eq!(children.len(), 1);
            }
            _ => panic!("Expected Folder"),
        }
    }

    #[test]
    fn connection_tree_node_connection_serde_round_trip() {
        let node = ConnectionTreeNode::Connection {
            icon: None,
            name: "Local Shell".to_string(),
            config: make_local_config(),
            terminal_options: Some(TerminalOptions {
                horizontal_scrolling: Some(true),
                ..Default::default()
            }),
        };
        let json = serde_json::to_string(&node).unwrap();
        let deserialized: ConnectionTreeNode = serde_json::from_str(&json).unwrap();
        match deserialized {
            ConnectionTreeNode::Connection {
                name,
                config,
                terminal_options,
                icon,
            } => {
                assert_eq!(name, "Local Shell");
                assert_eq!(config.type_id, "local");
                assert!(terminal_options.is_some());
                assert!(icon.is_none());
            }
            _ => panic!("Expected Connection"),
        }
    }

    #[test]
    fn connection_store_v2_serde_round_trip() {
        let store = ConnectionStore {
            version: "2".to_string(),
            children: vec![
                ConnectionTreeNode::Folder {
                    name: "Work".to_string(),
                    is_expanded: true,
                    children: vec![ConnectionTreeNode::Connection {
                        icon: None,
                        name: "Prod SSH".to_string(),
                        config: make_ssh_config(),
                        terminal_options: None,
                    }],
                },
                ConnectionTreeNode::Connection {
                    icon: None,
                    name: "Local".to_string(),
                    config: make_local_config(),
                    terminal_options: None,
                },
            ],
            agents: vec![],
        };
        let json = serde_json::to_string_pretty(&store).unwrap();
        let deserialized: ConnectionStore = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.version, "2");
        assert_eq!(deserialized.children.len(), 2);
        assert!(deserialized.agents.is_empty());
    }

    #[test]
    fn connection_store_default_is_v2() {
        let store = ConnectionStore::default();
        assert_eq!(store.version, "2");
        assert!(store.children.is_empty());
        assert!(store.agents.is_empty());
    }

    #[test]
    fn connection_store_with_agents_backward_compat() {
        // agents field missing from JSON should default to empty
        let json = r#"{"version":"2","children":[]}"#;
        let store: ConnectionStore = serde_json::from_str(json).unwrap();
        assert!(store.agents.is_empty());
    }

    #[test]
    fn saved_remote_agent_serde_round_trip() {
        let agent = SavedRemoteAgent {
            id: "agent-1".to_string(),
            name: "Pi Agent".to_string(),
            config: RemoteAgentConfig {
                host: "pi.local".to_string(),
                port: 22,
                username: "pi".to_string(),
                auth_method: "key".to_string(),
                password: None,
                key_path: Some("~/.ssh/id_ed25519".to_string()),
                save_password: None,
                agent_path: None,
                external_connection_files: vec![],
                ..Default::default()
            },
            agent_settings: AgentSettings::default(),
        };
        let json = serde_json::to_string(&agent).unwrap();
        let deserialized: SavedRemoteAgent = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "agent-1");
        assert_eq!(deserialized.name, "Pi Agent");
        assert_eq!(deserialized.config.host, "pi.local");
        assert_eq!(deserialized.config.auth_method, "key");
        assert!(deserialized.agent_settings.enable_monitoring);
        assert!(deserialized.agent_settings.enable_file_browser);
        assert_eq!(deserialized.agent_settings.log_level, "info");
    }

    #[test]
    fn saved_remote_agent_backward_compat_missing_agent_settings() {
        // Existing JSON without agentSettings should deserialize with defaults
        let json = r#"{
            "id": "agent-1",
            "name": "Pi Agent",
            "config": {
                "host": "pi.local",
                "port": 22,
                "username": "pi",
                "authMethod": "key"
            }
        }"#;
        let agent: SavedRemoteAgent = serde_json::from_str(json).unwrap();
        assert!(agent.agent_settings.enable_monitoring);
        assert!(agent.agent_settings.enable_file_browser);
        assert!(agent.agent_settings.enable_docker);
        assert!(agent.agent_settings.default_shell.is_none());
        assert_eq!(agent.agent_settings.starting_directory, "~");
        assert_eq!(agent.agent_settings.log_level, "info");
        assert!(!agent.agent_settings.verbose_tracing);
    }

    #[test]
    fn agent_settings_default_values() {
        let settings = AgentSettings::default();
        assert!(settings.enable_monitoring);
        assert!(settings.enable_file_browser);
        assert!(settings.enable_docker);
        assert!(settings.default_shell.is_none());
        assert_eq!(settings.starting_directory, "~");
        assert_eq!(settings.log_level, "info");
        assert!(!settings.verbose_tracing);
    }

    #[test]
    fn serde_produces_correct_json_shape() {
        let node = ConnectionTreeNode::Connection {
            icon: None,
            name: "Test".to_string(),
            config: make_local_config(),
            terminal_options: Some(TerminalOptions {
                horizontal_scrolling: Some(true),
                color: None,
                ..Default::default()
            }),
        };
        let json: serde_json::Value = serde_json::to_value(&node).unwrap();
        assert_eq!(json.get("type").unwrap(), "connection");
        assert_eq!(json.get("name").unwrap(), "Test");
        assert!(json.get("config").is_some());
        assert!(json.get("terminalOptions").is_some());
    }

    #[test]
    fn terminal_options_round_trip_preserves_all_frontend_fields() {
        // Regression for #2309: the frontend `TerminalOptions` (src/types/terminal.ts)
        // carries fields the Rust struct must not drop on the save/load round-trip —
        // otherwise a user's per-connection log-to-file (#1960), line-height and
        // syntax-highlighting (#1696) overrides silently vanish on the next restart.
        let json = serde_json::json!({
            "horizontalScrolling": true,
            "color": "#123456",
            "fontFamily": "Fira Code",
            "fontSize": 14,
            "lineHeight": 1.25,
            "scrollbackBuffer": 5000,
            "cursorStyle": "bar",
            "cursorBlink": true,
            "lineEnding": "crlf",
            "logToFile": true,
            "logTimestamps": true,
            "syntaxHighlighting": {
                "override": "custom",
                "additionalRules": [{ "name": "TODO", "enabled": true }]
            }
        });

        // Deserialize into the Rust struct, then serialize back — this mirrors what
        // happens when the connection is persisted and reloaded.
        let opts: TerminalOptions = serde_json::from_value(json.clone()).unwrap();
        let round_tripped = serde_json::to_value(&opts).unwrap();

        for key in [
            "lineHeight",
            "logToFile",
            "logTimestamps",
            "syntaxHighlighting",
        ] {
            assert_eq!(
                round_tripped.get(key),
                json.get(key),
                "field {key} was dropped or altered during the round-trip",
            );
        }
        // The already-modelled fields must survive too.
        assert_eq!(round_tripped.get("cursorStyle"), json.get("cursorStyle"));
        assert_eq!(round_tripped.get("lineEnding"), json.get("lineEnding"));
    }

    #[test]
    fn folder_json_shape_has_type_tag() {
        let node = ConnectionTreeNode::Folder {
            name: "Work".to_string(),
            is_expanded: false,
            children: vec![],
        };
        let json: serde_json::Value = serde_json::to_value(&node).unwrap();
        assert_eq!(json.get("type").unwrap(), "folder");
        assert_eq!(json.get("name").unwrap(), "Work");
        assert_eq!(json.get("isExpanded").unwrap(), false);
    }

    // -----------------------------------------------------------------------
    // #2311 — serde field-drop guard
    // -----------------------------------------------------------------------

    #[test]
    fn terminal_options_flatten_preserves_unknown_frontend_field() {
        // A field the backend does not model must round-trip through the
        // `#[serde(flatten)] extra` catch-all instead of vanishing on save.
        // Without the catch-all this assertion fails — that is the guard.
        let json = serde_json::json!({
            "cursorStyle": "bar",
            "someFutureOption": { "nested": [1, 2, 3] },
            "anotherNewFlag": true,
        });

        let opts: TerminalOptions = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(
            opts.extra.get("someFutureOption"),
            json.get("someFutureOption"),
            "unknown key was not captured by the flatten catch-all",
        );

        let round_tripped = serde_json::to_value(&opts).unwrap();
        assert_eq!(
            round_tripped.get("someFutureOption"),
            json.get("someFutureOption")
        );
        assert_eq!(
            round_tripped.get("anotherNewFlag"),
            json.get("anotherNewFlag")
        );
        // Modelled fields still work alongside the catch-all.
        assert_eq!(round_tripped.get("cursorStyle").unwrap(), "bar");
    }

    #[test]
    fn terminal_options_empty_extra_keeps_serialized_output_clean() {
        // An empty catch-all must contribute nothing to the JSON — no stray
        // "extra" key, no empty object.
        let opts = TerminalOptions {
            cursor_style: Some("block".to_string()),
            ..Default::default()
        };
        let json = serde_json::to_value(&opts).unwrap();
        assert!(json.get("extra").is_none(), "flatten leaked an `extra` key");
        let obj = json.as_object().unwrap();
        assert_eq!(obj.len(), 1, "unexpected keys: {obj:?}");
        assert_eq!(obj.get("cursorStyle").unwrap(), "block");
    }

    // ---- Frontend/backend drift guard (approach (b), for the non-flatten
    // ---- container structs `SavedConnection` and `ConnectionConfig`) --------

    /// Extract the top-level field names of a TypeScript `export interface`.
    ///
    /// Only depth-1 members are returned; JSDoc/`//` comments, blank lines and
    /// nested object types are skipped. Trailing `?` (optional) is stripped.
    fn extract_ts_interface_fields(
        src: &str,
        interface: &str,
    ) -> std::collections::BTreeSet<String> {
        let header = format!("export interface {interface} {{");
        let mut lines = src.lines();
        let mut found = false;
        for line in lines.by_ref() {
            if line.contains(&header) {
                found = true;
                break;
            }
        }
        assert!(found, "interface `{interface}` not found in source");

        let mut fields = std::collections::BTreeSet::new();
        let mut depth = 1i32; // the opening brace was on the header line
        for line in lines {
            let trimmed = line.trim();
            let is_comment = trimmed.is_empty()
                || trimmed.starts_with("//")
                || trimmed.starts_with("/*")
                || trimmed.starts_with('*');
            if depth == 1 && !is_comment {
                if let Some(name) = parse_ts_field_name(trimmed) {
                    fields.insert(name);
                }
            }
            depth += line.matches('{').count() as i32;
            depth -= line.matches('}').count() as i32;
            if depth <= 0 {
                break;
            }
        }
        fields
    }

    /// Parse a leading `name:` / `name?:` identifier from a TS member line.
    fn parse_ts_field_name(line: &str) -> Option<String> {
        let end = line
            .char_indices()
            .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '_' || *c == '$'))
            .map(|(i, _)| i)
            .unwrap_or(line.len());
        if end == 0 {
            return None;
        }
        let rest = line[end..].trim_start();
        if rest.starts_with('?') || rest.starts_with(':') {
            Some(line[..end].to_string())
        } else {
            None
        }
    }

    /// Fail when the frontend interface carries a field the backend neither
    /// models nor knowingly excludes — the silent-drop defect (#2311).
    fn assert_no_silent_drop(ts_src: &str, interface: &str, modelled: &[&str], known_gap: &[&str]) {
        let ts = extract_ts_interface_fields(ts_src, interface);
        assert!(!ts.is_empty(), "no fields parsed for `{interface}`");
        let modelled: std::collections::BTreeSet<String> =
            modelled.iter().map(|s| s.to_string()).collect();
        let known_gap: std::collections::BTreeSet<String> =
            known_gap.iter().map(|s| s.to_string()).collect();
        let dropped: Vec<&String> = ts
            .iter()
            .filter(|f| !modelled.contains(*f) && !known_gap.contains(*f))
            .collect();
        assert!(
            dropped.is_empty(),
            "frontend `{interface}` has field(s) the backend silently drops: {dropped:?}. \
             Add a matching backend field (or `#[serde(flatten)] extra` catch-all), or record \
             it in the known-gap list with a tracking issue.",
        );
    }

    // These const lists mirror the serialized (camelCase) keys of the Rust
    // structs. Update them when a field is added/removed so the drift test
    // stays a faithful mirror.
    const CONNECTION_CONFIG_BACKEND_FIELDS: &[&str] = &["type", "config"];
    const SAVED_CONNECTION_BACKEND_FIELDS: &[&str] = &[
        "id",
        "name",
        "config",
        "folderId",
        "terminalOptions",
        "icon",
        "sourceFile",
    ];

    #[test]
    fn connection_config_no_silent_frontend_field_drop() {
        // `ConnectionConfig.settings` is opaque JSON (`serde_json::Value`) that
        // already preserves everything under `config`; only the two top-level
        // keys need to stay in parity with the frontend.
        let ts = include_str!("../../../src/types/terminal.ts");
        assert_no_silent_drop(
            ts,
            "ConnectionConfig",
            CONNECTION_CONFIG_BACKEND_FIELDS,
            &[],
        );
    }

    #[test]
    fn saved_connection_no_silent_frontend_field_drop() {
        let ts = include_str!("../../../src/types/connection.ts");
        // No known gaps: every frontend `SavedConnection` field is now modelled
        // by the backend (the `icon` gap tracked by #2311 was closed in #2316).
        assert_no_silent_drop(ts, "SavedConnection", SAVED_CONNECTION_BACKEND_FIELDS, &[]);
    }

    #[test]
    fn saved_connection_icon_round_trips_through_serde() {
        // Regression for #2316: the frontend `SavedConnection.icon`
        // (src/types/connection.ts) must survive the save/load round-trip
        // instead of being silently dropped and lost on the next restart.
        let json = serde_json::json!({
            "id": "Work/My SSH",
            "name": "My SSH",
            "config": { "type": "ssh", "config": { "host": "example.com" } },
            "folderId": "Work",
            "icon": "server"
        });
        let conn: SavedConnection = serde_json::from_value(json).unwrap();
        assert_eq!(conn.icon.as_deref(), Some("server"));

        let round_tripped = serde_json::to_value(&conn).unwrap();
        assert_eq!(round_tripped.get("icon").unwrap(), "server");
    }

    #[test]
    fn saved_connection_without_icon_stays_clean() {
        // A connection with no icon must not emit a stray `icon` key.
        let conn = SavedConnection {
            id: "Local".to_string(),
            name: "Local".to_string(),
            config: make_local_config(),
            folder_id: None,
            terminal_options: None,
            icon: None,
            source_file: None,
        };
        let json = serde_json::to_value(&conn).unwrap();
        assert!(
            json.get("icon").is_none(),
            "icon: None leaked an `icon` key into the serialized output",
        );
    }

    #[test]
    fn connection_tree_node_connection_icon_round_trips() {
        // The on-disk `ConnectionTreeNode::Connection` variant must carry `icon`
        // so it persists to disk, not just in memory (#2316).
        let node = ConnectionTreeNode::Connection {
            name: "My SSH".to_string(),
            config: make_ssh_config(),
            terminal_options: None,
            icon: Some("server".to_string()),
        };
        let json = serde_json::to_value(&node).unwrap();
        assert_eq!(json.get("icon").unwrap(), "server");

        let deserialized: ConnectionTreeNode = serde_json::from_value(json).unwrap();
        match deserialized {
            ConnectionTreeNode::Connection { icon, .. } => {
                assert_eq!(icon.as_deref(), Some("server"));
            }
            _ => panic!("Expected Connection"),
        }
    }

    #[test]
    fn drift_guard_flags_an_unmodelled_field() {
        // Proves the guard's red path: a synthetic interface with a field the
        // backend does not model is reported.
        let ts = "export interface Sample {\n  known: string;\n  brandNew?: number;\n}\n";
        // The catch-all is expected to panic; silence its backtrace so the test
        // log stays clean, then restore the previous hook.
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let result = std::panic::catch_unwind(|| {
            assert_no_silent_drop(ts, "Sample", &["known"], &[]);
        });
        std::panic::set_hook(prev);
        assert!(
            result.is_err(),
            "drift guard failed to flag the unmodelled `brandNew` field",
        );
    }

    #[test]
    fn ts_field_extractor_ignores_comments_and_nested_blocks() {
        let ts = "export interface Sample {\n  /** doc */\n  a: string;\n  // note\n  b?: { x: number };\n  c: string;\n}\n";
        let fields = extract_ts_interface_fields(ts, "Sample");
        let got: Vec<&str> = fields.iter().map(String::as_str).collect();
        assert_eq!(got, vec!["a", "b", "c"]);
    }
}

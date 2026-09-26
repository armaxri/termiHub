//! Per-workspace settings overrides (PROD-052).
//!
//! A workspace may override a curated subset of the global `AppSettings`
//! (theme, terminal font family/size) and carry session defaults for **new**
//! local shells (a default working directory and extra environment variables).
//!
//! # Precedence
//!
//! `global < workspace < connection`: a workspace value replaces the global
//! setting while that workspace is active, and a value set on the connection
//! itself (its own `startingDirectory`, an `envVars` entry with the same name, a
//! per-connection terminal font) always wins over the workspace.
//!
//! The overrides are stored inside the workspace record in `workspaces.json`
//! (schema v2), so anything that captures that store — including the unified
//! backup — carries them automatically.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Smallest accepted terminal font size override (mirrors the Settings UI).
pub const MIN_FONT_SIZE: u32 = 8;
/// Largest accepted terminal font size override (mirrors the Settings UI).
pub const MAX_FONT_SIZE: u32 = 32;
/// Upper bound on an environment variable name's length.
const MAX_ENV_NAME_LEN: usize = 256;

/// One extra environment variable for new local sessions of a workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEnvVar {
    /// Variable name (`[A-Za-z_][A-Za-z0-9_]*`).
    pub key: String,
    /// Variable value. Never meant for secrets — the editor warns on secret-looking names.
    pub value: String,
}

/// The settings a workspace overrides. Every field is optional; an absent field
/// inherits the global setting.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSettings {
    /// Theme override (same value space as `AppSettings.theme`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    /// Terminal font family override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    /// Terminal font size override in pixels ([`MIN_FONT_SIZE`]..=[`MAX_FONT_SIZE`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u32>,
    /// Default working directory for new local shells that do not set their own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_working_directory: Option<String>,
    /// Extra environment variables for new local shells (connection entries win).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env_vars: Vec<WorkspaceEnvVar>,
    /// Unknown keys written by a newer build, preserved verbatim on save (PER-010).
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, Value>,
}

/// The active workspace as broadcast to every window (`active-workspace-changed`)
/// and returned by `get_active_workspace`, so each window applies the same
/// overrides live.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWorkspaceInfo {
    /// Workspace id.
    pub id: String,
    /// Workspace display name (for the "Overridden in workspace X" indicator).
    pub name: String,
    /// The workspace's overrides (`None` → it inherits every global setting).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<WorkspaceSettings>,
}

/// Tauri event emitted whenever the active workspace or its overrides change.
pub const ACTIVE_WORKSPACE_CHANGED_EVENT: &str = "active-workspace-changed";

/// Whether `name` is a valid environment variable name.
pub fn is_valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    name.len() <= MAX_ENV_NAME_LEN
        && (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

impl WorkspaceSettings {
    /// Whether no override is set at all (an empty record need not be stored).
    pub fn is_empty(&self) -> bool {
        self.theme.is_none()
            && self.font_family.is_none()
            && self.font_size.is_none()
            && self.default_working_directory.is_none()
            && self.env_vars.is_empty()
            && self.extra.is_empty()
    }

    /// Validate the overrides, returning a user-facing message on the first problem.
    pub fn validate(&self) -> Result<(), String> {
        if let Some(size) = self.font_size {
            if !(MIN_FONT_SIZE..=MAX_FONT_SIZE).contains(&size) {
                return Err(format!(
                    "Font size must be between {MIN_FONT_SIZE} and {MAX_FONT_SIZE} (got {size})"
                ));
            }
        }
        if matches!(self.theme.as_deref(), Some(t) if t.trim().is_empty()) {
            return Err("Theme override must not be empty".to_string());
        }
        let mut seen = HashSet::new();
        for var in &self.env_vars {
            if !is_valid_env_name(&var.key) {
                return Err(format!(
                    "Invalid environment variable name \"{}\": use letters, digits and \
                     underscores, not starting with a digit",
                    var.key
                ));
            }
            if var.value.contains('\0') {
                return Err(format!(
                    "Environment variable \"{}\" contains a NUL character",
                    var.key
                ));
            }
            if !seen.insert(var.key.as_str()) {
                return Err(format!("Duplicate environment variable \"{}\"", var.key));
            }
        }
        Ok(())
    }

    /// Apply the workspace's session defaults to the settings of a **new local
    /// shell** connection, in place.
    ///
    /// Connection-level values win: `startingDirectory` is only filled when the
    /// connection leaves it empty, and a workspace `envVars` entry is dropped
    /// when the connection already sets a variable of the same name. Workspace
    /// entries are placed first so the core parser's "last entry wins" rule
    /// would still favour the connection even without that filtering.
    pub fn apply_to_local_shell_settings(&self, settings: &mut Value) {
        let Some(obj) = settings.as_object_mut() else {
            return;
        };

        if let Some(dir) = self
            .default_working_directory
            .as_deref()
            .filter(|d| !d.trim().is_empty())
        {
            let has_own = obj
                .get("startingDirectory")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty());
            if !has_own {
                obj.insert("startingDirectory".to_string(), Value::String(dir.into()));
            }
        }

        if self.env_vars.is_empty() {
            return;
        }
        let existing: Vec<Value> = obj
            .get("envVars")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let own_keys: HashSet<String> = existing
            .iter()
            .filter_map(|e| e.get("key").and_then(Value::as_str).map(String::from))
            .collect();
        let mut merged: Vec<Value> = self
            .env_vars
            .iter()
            .filter(|v| !own_keys.contains(&v.key))
            .map(|v| serde_json::json!({ "key": v.key, "value": v.value }))
            .collect();
        merged.extend(existing);
        obj.insert("envVars".to_string(), Value::Array(merged));
    }
}

/// Apply the active workspace's session defaults to a **new** connection's
/// settings, when it is a direct (non-agent) local shell.
///
/// Only `local` sessions are affected: the workspace's directory and
/// environment describe the local machine, so they are never pushed to a
/// remote agent or another connection type. With no active overrides this is a
/// no-op.
pub fn apply_session_defaults(
    type_id: &str,
    agent_id: Option<&str>,
    workspace: Option<&WorkspaceSettings>,
    settings: &mut Value,
) {
    if type_id != "local" || agent_id.is_some() {
        return;
    }
    if let Some(ws) = workspace {
        ws.apply_to_local_shell_settings(settings);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn env(key: &str, value: &str) -> WorkspaceEnvVar {
        WorkspaceEnvVar {
            key: key.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn env_name_validation() {
        assert!(is_valid_env_name("PATH"));
        assert!(is_valid_env_name("_my_var2"));
        assert!(!is_valid_env_name(""));
        assert!(!is_valid_env_name("2FAST"));
        assert!(!is_valid_env_name("MY-VAR"));
        assert!(!is_valid_env_name("A B"));
        assert!(!is_valid_env_name("A=B"));
        assert!(!is_valid_env_name(&"A".repeat(300)));
    }

    #[test]
    fn validate_rejects_bad_values() {
        let ok = WorkspaceSettings {
            font_size: Some(14),
            env_vars: vec![env("STAGE", "dev")],
            ..Default::default()
        };
        assert!(ok.validate().is_ok());

        let big = WorkspaceSettings {
            font_size: Some(99),
            ..Default::default()
        };
        assert!(big.validate().unwrap_err().contains("Font size"));

        let bad_name = WorkspaceSettings {
            env_vars: vec![env("BAD-NAME", "x")],
            ..Default::default()
        };
        assert!(bad_name.validate().unwrap_err().contains("BAD-NAME"));

        let dup = WorkspaceSettings {
            env_vars: vec![env("A", "1"), env("A", "2")],
            ..Default::default()
        };
        assert!(dup.validate().unwrap_err().contains("Duplicate"));

        let nul = WorkspaceSettings {
            env_vars: vec![env("A", "x\0y")],
            ..Default::default()
        };
        assert!(nul.validate().is_err());

        let blank_theme = WorkspaceSettings {
            theme: Some("  ".into()),
            ..Default::default()
        };
        assert!(blank_theme.validate().is_err());
    }

    #[test]
    fn apply_fills_directory_and_env_when_connection_sets_none() {
        let ws = WorkspaceSettings {
            default_working_directory: Some("/work/project".into()),
            env_vars: vec![env("STAGE", "dev")],
            ..Default::default()
        };
        let mut settings = json!({ "shell": "zsh" });
        ws.apply_to_local_shell_settings(&mut settings);
        assert_eq!(settings["startingDirectory"], "/work/project");
        assert_eq!(settings["envVars"], json!([{ "key": "STAGE", "value": "dev" }]));
    }

    #[test]
    fn apply_connection_values_win() {
        let ws = WorkspaceSettings {
            default_working_directory: Some("/work/project".into()),
            env_vars: vec![env("STAGE", "dev"), env("REGION", "eu")],
            ..Default::default()
        };
        let mut settings = json!({
            "startingDirectory": "/own",
            "envVars": [{ "key": "STAGE", "value": "prod" }]
        });
        ws.apply_to_local_shell_settings(&mut settings);
        assert_eq!(settings["startingDirectory"], "/own");
        assert_eq!(
            settings["envVars"],
            json!([
                { "key": "REGION", "value": "eu" },
                { "key": "STAGE", "value": "prod" }
            ])
        );
    }

    #[test]
    fn apply_treats_empty_starting_directory_as_unset() {
        let ws = WorkspaceSettings {
            default_working_directory: Some("/work".into()),
            ..Default::default()
        };
        let mut settings = json!({ "startingDirectory": "" });
        ws.apply_to_local_shell_settings(&mut settings);
        assert_eq!(settings["startingDirectory"], "/work");
    }

    #[test]
    fn apply_without_overrides_is_identity() {
        let ws = WorkspaceSettings::default();
        let mut settings = json!({ "shell": "bash", "envVars": [] });
        let before = settings.clone();
        ws.apply_to_local_shell_settings(&mut settings);
        assert_eq!(settings, before);
    }

    #[test]
    fn session_defaults_only_touch_direct_local_shells() {
        let ws = WorkspaceSettings {
            default_working_directory: Some("/w".into()),
            env_vars: vec![env("A", "1")],
            ..Default::default()
        };
        let mut local = json!({});
        apply_session_defaults("local", None, Some(&ws), &mut local);
        assert_eq!(local["startingDirectory"], "/w");

        let mut ssh = json!({ "host": "h" });
        apply_session_defaults("ssh", None, Some(&ws), &mut ssh);
        assert_eq!(ssh, json!({ "host": "h" }));

        let mut agent_local = json!({});
        apply_session_defaults("local", Some("agent-1"), Some(&ws), &mut agent_local);
        assert_eq!(agent_local, json!({}));

        let mut none = json!({});
        apply_session_defaults("local", None, None, &mut none);
        assert_eq!(none, json!({}));
    }

    #[test]
    fn serde_round_trip_preserves_unknown_keys() {
        let raw = json!({
            "theme": "light",
            "fontSize": 16,
            "envVars": [{ "key": "A", "value": "1" }],
            "futureKey": { "nested": true }
        });
        let parsed: WorkspaceSettings = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(parsed.theme.as_deref(), Some("light"));
        assert_eq!(parsed.font_size, Some(16));
        assert_eq!(serde_json::to_value(&parsed).unwrap(), raw);
    }

    #[test]
    fn is_empty_detects_no_overrides() {
        assert!(WorkspaceSettings::default().is_empty());
        let s = WorkspaceSettings {
            font_family: Some("Fira Code".into()),
            ..Default::default()
        };
        assert!(!s.is_empty());
    }
}

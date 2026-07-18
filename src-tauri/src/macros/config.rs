use serde::{Deserialize, Serialize};

/// A single recorded step of a macro.
///
/// A step is one chunk of terminal input plus the delay that precedes it during
/// playback. `data` holds the raw input as either UTF-8 text or a base64-encoded
/// byte string — recording (#1674) and playback (#1675) decide the encoding; the
/// storage layer treats it as an opaque string.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MacroStep {
    /// The recorded input for this step (UTF-8 text or base64-encoded bytes).
    pub data: String,
    /// Delay in milliseconds to wait before this step is played back.
    #[serde(default)]
    pub delay_ms: u64,
}

/// A named, stored sequence of recorded terminal input.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Macro {
    /// Unique macro identifier.
    pub id: String,
    /// User-friendly name for this macro.
    pub name: String,
    /// Optional free-text description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Optional tags for grouping/filtering in the manager UI.
    #[serde(default)]
    pub tags: Vec<String>,
    /// The ordered steps that make up this macro.
    #[serde(default)]
    pub steps: Vec<MacroStep>,
    /// RFC 3339 timestamp of when the macro was first created.
    #[serde(default)]
    pub created_at: String,
    /// RFC 3339 timestamp of the macro's last update.
    #[serde(default)]
    pub updated_at: String,
}

/// Top-level schema for the macros JSON file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacroStore {
    /// Schema version, for forward-compatible migrations.
    pub version: String,
    /// All stored macros.
    pub macros: Vec<Macro>,
}

impl Default for MacroStore {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            macros: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macro_store_default_is_empty() {
        let store = MacroStore::default();
        assert_eq!(store.version, "1");
        assert!(store.macros.is_empty());
    }

    #[test]
    fn macro_serializes_with_camel_case_keys() {
        let m = Macro {
            id: "macro-1".to_string(),
            name: "Deploy".to_string(),
            description: Some("Deploy sequence".to_string()),
            tags: vec!["ops".to_string()],
            steps: vec![MacroStep {
                data: "ls\r".to_string(),
                delay_ms: 250,
            }],
            created_at: "2026-07-19T00:00:00Z".to_string(),
            updated_at: "2026-07-19T00:00:00Z".to_string(),
        };

        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"delayMs\":250"));
        assert!(json.contains("\"createdAt\""));
        assert!(json.contains("\"updatedAt\""));
        // Round-trips back to an equal value.
        let parsed: Macro = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, m);
    }

    #[test]
    fn macro_step_delay_defaults_to_zero() {
        let step: MacroStep = serde_json::from_str(r#"{ "data": "x" }"#).unwrap();
        assert_eq!(step.delay_ms, 0);
    }
}

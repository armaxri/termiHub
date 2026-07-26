//! The `manifest.json` data model and its validation.
//!
//! Every `.termihub-plugin` package carries a `manifest.json` at its root. This
//! module defines the strongly-typed [`PluginManifest`] that mirrors that file
//! (see the plugin-system concept, impl §2 and §6), together with strict
//! (de)serialization and semantic validation.
//!
//! Two layers of checking apply:
//!
//! * **Deserialization** — [`parse_manifest`] rejects unknown top-level fields,
//!   missing required fields, and unknown `platforms` / `permissions` values
//!   (they are modelled as closed enums), producing an actionable serde error.
//! * **Semantic validation** — [`PluginManifest::validate`] enforces rules that
//!   the type system cannot express: a filesystem-safe plugin `id`, non-empty
//!   identity fields, a parseable `apiVersion`, and at least one declared
//!   extension point.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// The plugin API version this build of termiHub implements.
///
/// A plugin's declared `apiVersion` is checked against this constant; see
/// [`PluginManifest::api_compatibility`] and [`check_api_compatibility`].
pub const CURRENT_PLUGIN_API_VERSION: &str = "1.0";

/// Maximum length of a plugin `id`. Ids become on-disk directory names
/// (`<app-data>/plugins/<id>/`), so they are kept short and slug-like.
const MAX_PLUGIN_ID_LEN: usize = 64;

/// A coarse-grained capability a plugin requests in its manifest.
///
/// The set is intentionally closed: an unknown permission string fails
/// deserialization rather than being silently ignored, which is what lets the
/// install-time permission prompt be exhaustive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginPermission {
    /// Creating and managing terminal sessions.
    Terminal,
    /// Making outbound network connections.
    Network,
    /// Reading and writing files (scoped to declared paths).
    Filesystem,
    /// Rendering UI components in designated slots.
    Ui,
    /// Storing and reading plugin-specific configuration.
    Settings,
}

/// A desktop platform a plugin declares support for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    /// Microsoft Windows.
    Windows,
    /// Linux.
    Linux,
    /// Apple macOS.
    Macos,
}

/// The `extensions` object: which extension points a plugin provides.
///
/// A plugin declares one or more of these. The individual extension bodies are
/// modelled here for a faithful round-trip, but this crate only validates their
/// presence — wiring them into the terminal manager, theme engine, etc. is the
/// job of later plugin-system issues.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginExtensions {
    /// A new connection type with full terminal I/O (Rust dynamic library).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_backend: Option<TerminalBackendExtension>,
    /// An output filter that transforms or annotates terminal output (JS).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_parser: Option<ProtocolParserExtension>,
    /// One or more custom color themes (JSON data).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<ThemeExtension>,
    /// A widget rendered into the status bar (JS).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_bar_widget: Option<StatusBarWidgetExtension>,
}

impl PluginExtensions {
    /// Whether the plugin declares no extension points at all.
    pub fn is_empty(&self) -> bool {
        self.terminal_backend.is_none()
            && self.protocol_parser.is_none()
            && self.theme.is_none()
            && self.status_bar_widget.is_none()
    }
}

/// A terminal-backend extension point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalBackendExtension {
    /// The connection type this backend registers.
    pub connection_type: String,
    /// Human-readable name shown in the connection-type selector.
    pub display_name: String,
    /// JSON Schema describing the backend's connection config. Opaque to this
    /// crate — later issues drive the schema-based config form.
    pub config_schema: serde_json::Value,
}

/// A protocol-parser extension point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolParserExtension {
    /// Parser identifier.
    pub name: String,
    /// Human-readable description.
    pub description: String,
    /// Path to the JS entry point within the package.
    pub entry_point: String,
}

/// A theme extension point: one or more theme definitions bundled in the package.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeExtension {
    /// The themes provided by this plugin.
    pub themes: Vec<ThemeEntry>,
}

/// A single theme provided by a [`ThemeExtension`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeEntry {
    /// Theme identifier (unique within the plugin).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Path to the theme JSON file within the package's `themes/` directory.
    pub file: String,
}

/// Which side of the status bar a widget renders on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WidgetPosition {
    /// Left-hand side of the status bar.
    Left,
    /// Right-hand side of the status bar.
    Right,
}

/// A status-bar-widget extension point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusBarWidgetExtension {
    /// Path to the JS entry point within the package.
    pub entry_point: String,
    /// Where the widget is placed.
    pub position: WidgetPosition,
}

/// The primitive type of a plugin setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingType {
    /// A text value.
    String,
    /// A numeric value.
    Number,
    /// A boolean value.
    Boolean,
}

/// The schema for a single plugin setting (`settings.<key>`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSettingSchema {
    /// The setting's primitive type.
    #[serde(rename = "type")]
    pub setting_type: SettingType,
    /// Default value applied when the user has not set one.
    pub default: serde_json::Value,
    /// Human-readable description shown in the settings UI.
    pub description: String,
    /// Optional closed set of allowed string values.
    #[serde(rename = "enum", default, skip_serializing_if = "Option::is_none")]
    pub allowed_values: Option<Vec<String>>,
}

/// The parsed and (once [`validate`](PluginManifest::validate)d) trusted
/// contents of a plugin's `manifest.json`.
///
/// Field names mirror the concept's manifest (impl §2/§6); JSON keys are
/// `camelCase`. Unknown keys are rejected.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifest {
    /// Stable, filesystem-safe identifier (used as the install directory name).
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Plugin version string (informational; the host does not interpret it).
    pub version: String,
    /// Plugin author.
    pub author: String,
    /// Short description.
    pub description: String,
    /// SPDX-style license identifier.
    pub license: String,
    /// Declared plugin-API version, as `"major.minor"`.
    pub api_version: String,
    /// Desktop platforms the plugin supports.
    pub platforms: Vec<Platform>,
    /// Coarse-grained permissions the plugin requests.
    pub permissions: Vec<PluginPermission>,
    /// Filesystem paths the plugin is scoped to. Only meaningful together with
    /// the [`Filesystem`](PluginPermission::Filesystem) permission: the host
    /// confines the plugin's filesystem access to these roots (concept §13, "must
    /// declare which paths they need"). Absent/empty for plugins that request no
    /// filesystem access.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filesystem_paths: Vec<String>,
    /// The extension points the plugin provides.
    pub extensions: PluginExtensions,
    /// Optional user-configurable settings, keyed by setting name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<BTreeMap<String, PluginSettingSchema>>,
}

impl PluginManifest {
    /// Run semantic validation over an already-deserialized manifest.
    ///
    /// Deserialization has already guaranteed the shape (known fields, known
    /// enum values); this layer enforces the invariants the type system cannot:
    /// a filesystem-safe `id`, non-empty identity fields, a parseable
    /// `apiVersion`, and at least one declared extension point.
    pub fn validate(&self) -> Result<(), ManifestValidationError> {
        validate_plugin_id(&self.id)?;
        require_non_empty("name", &self.name)?;
        require_non_empty("version", &self.version)?;
        require_non_empty("author", &self.author)?;
        if parse_api_version(&self.api_version).is_none() {
            return Err(ManifestValidationError::InvalidApiVersion(
                self.api_version.clone(),
            ));
        }
        if self.extensions.is_empty() {
            return Err(ManifestValidationError::NoExtensions);
        }
        Ok(())
    }

    /// Compatibility of this manifest's `apiVersion` with the host
    /// ([`CURRENT_PLUGIN_API_VERSION`]).
    pub fn api_compatibility(&self) -> ApiCompatibility {
        check_api_compatibility(&self.api_version)
    }
}

/// The outcome of an API-version compatibility check — a distinct result from
/// the other, structural validation failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiCompatibility {
    /// The plugin targets an API version this host can load.
    Compatible,
    /// The plugin targets an incompatible API version and must not be loaded.
    Incompatible,
}

/// Whether a declared `apiVersion` string is compatible with the host.
///
/// Compatibility rule: the **major** versions must match and the plugin's
/// **minor** must not exceed the host's. An unparseable version is treated as
/// incompatible. (Callers that want an actionable "malformed version" error
/// should run [`PluginManifest::validate`] first, which reports it distinctly.)
pub fn check_api_compatibility(declared: &str) -> ApiCompatibility {
    match (
        parse_api_version(declared),
        parse_api_version(CURRENT_PLUGIN_API_VERSION),
    ) {
        (Some((dmaj, dmin)), Some((hmaj, hmin))) if dmaj == hmaj && dmin <= hmin => {
            ApiCompatibility::Compatible
        }
        _ => ApiCompatibility::Incompatible,
    }
}

/// Deserialize and strictly validate a `manifest.json` string.
///
/// Rejects unknown/missing fields and unknown enum values with an actionable
/// serde error. Note this performs *deserialization* only; call
/// [`PluginManifest::validate`] for the semantic checks.
pub fn parse_manifest(json: &str) -> Result<PluginManifest, ManifestParseError> {
    serde_json::from_str(json).map_err(|e| ManifestParseError(e.to_string()))
}

/// A failure to deserialize `manifest.json` (malformed JSON, unknown or missing
/// field, unknown permission/platform, …). Wraps the underlying serde message.
#[derive(Debug, Error)]
#[error("invalid plugin manifest: {0}")]
pub struct ManifestParseError(pub String);

/// A semantic validation failure over an already-parsed manifest.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ManifestValidationError {
    /// A required identity field was present but empty.
    #[error("plugin manifest field `{0}` must not be empty")]
    EmptyField(&'static str),
    /// The `id` is empty, too long, or contains characters that are not
    /// lowercase alphanumerics or single interior hyphens.
    #[error(
        "plugin manifest `id` must be a non-empty slug of lowercase letters, \
         digits and hyphens (got `{0}`)"
    )]
    InvalidId(String),
    /// The `apiVersion` string is not of the form `major` or `major.minor`.
    #[error("plugin manifest `apiVersion` is not a valid `major.minor` version (got `{0}`)")]
    InvalidApiVersion(String),
    /// The manifest declares no extension points.
    #[error("plugin manifest declares no extensions; at least one is required")]
    NoExtensions,
}

/// Parse a `"major"` or `"major.minor"` version into its numeric components.
/// Returns `None` for anything else (extra components, empty, non-numeric).
fn parse_api_version(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.split('.');
    let major = parts.next()?;
    if major.is_empty() {
        return None;
    }
    let major: u32 = major.parse().ok()?;
    let minor = match parts.next() {
        Some(m) => m.parse().ok()?,
        None => 0,
    };
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor))
}

fn require_non_empty(field: &'static str, value: &str) -> Result<(), ManifestValidationError> {
    if value.trim().is_empty() {
        Err(ManifestValidationError::EmptyField(field))
    } else {
        Ok(())
    }
}

/// A plugin id must be a filesystem-safe slug: 1..=64 chars of `[a-z0-9-]`, not
/// starting or ending with a hyphen and with no consecutive hyphens. This keeps
/// the install directory (`plugins/<id>/`) safe from traversal and collisions.
fn validate_plugin_id(id: &str) -> Result<(), ManifestValidationError> {
    if id.is_empty() || id.len() > MAX_PLUGIN_ID_LEN {
        return Err(ManifestValidationError::InvalidId(id.to_string()));
    }
    let bytes = id.as_bytes();
    if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
        return Err(ManifestValidationError::InvalidId(id.to_string()));
    }
    let mut prev_hyphen = false;
    for &b in bytes {
        let ok = b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-';
        if !ok {
            return Err(ManifestValidationError::InvalidId(id.to_string()));
        }
        if b == b'-' && prev_hyphen {
            return Err(ManifestValidationError::InvalidId(id.to_string()));
        }
        prev_hyphen = b == b'-';
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal manifest that passes both deserialization and validation.
    fn valid_manifest_json() -> &'static str {
        r#"{
            "id": "k8s-exec",
            "name": "Kubernetes Exec",
            "version": "1.2.0",
            "author": "k8s-contrib",
            "description": "Terminal backend for Kubernetes pod exec sessions",
            "license": "MIT",
            "apiVersion": "1.0",
            "platforms": ["windows", "linux", "macos"],
            "permissions": ["terminal", "network", "filesystem"],
            "extensions": {
                "terminalBackend": {
                    "connectionType": "k8s-exec",
                    "displayName": "Kubernetes Exec",
                    "configSchema": {
                        "type": "object",
                        "properties": { "pod": { "type": "string" } },
                        "required": ["pod"]
                    }
                }
            },
            "settings": {
                "defaultNamespace": {
                    "type": "string",
                    "default": "default",
                    "description": "Default Kubernetes namespace"
                }
            }
        }"#
    }

    #[test]
    fn parses_and_validates_a_good_manifest() {
        let manifest = parse_manifest(valid_manifest_json()).expect("should parse");
        assert_eq!(manifest.id, "k8s-exec");
        assert_eq!(manifest.platforms.len(), 3);
        assert_eq!(
            manifest.permissions,
            vec![
                PluginPermission::Terminal,
                PluginPermission::Network,
                PluginPermission::Filesystem
            ]
        );
        assert!(manifest.extensions.terminal_backend.is_some());
        assert!(manifest.settings.is_some());
        manifest.validate().expect("should validate");
        assert_eq!(manifest.api_compatibility(), ApiCompatibility::Compatible);
    }

    #[test]
    fn round_trips_through_serde() {
        let manifest = parse_manifest(valid_manifest_json()).unwrap();
        let json = serde_json::to_string(&manifest).unwrap();
        let reparsed = parse_manifest(&json).unwrap();
        assert_eq!(manifest, reparsed);
    }

    #[test]
    fn rejects_malformed_json() {
        let err = parse_manifest("{ this is not json ").unwrap_err();
        // Actionable message from serde.
        assert!(!err.to_string().is_empty());
    }

    #[test]
    fn rejects_unknown_top_level_field() {
        let json = valid_manifest_json().replace(
            "\"license\": \"MIT\",",
            "\"license\": \"MIT\", \"surprise\": 1,",
        );
        let err = parse_manifest(&json).unwrap_err();
        assert!(err.to_string().contains("surprise"), "got: {err}");
    }

    #[test]
    fn rejects_missing_required_field() {
        // Drop the required `author` field.
        let json = valid_manifest_json().replace("\"author\": \"k8s-contrib\",", "");
        let err = parse_manifest(&json).unwrap_err();
        assert!(err.to_string().contains("author"), "got: {err}");
    }

    #[test]
    fn rejects_unknown_permission() {
        let json = valid_manifest_json().replace(
            "[\"terminal\", \"network\", \"filesystem\"]",
            "[\"terminal\", \"root\"]",
        );
        let err = parse_manifest(&json).unwrap_err();
        assert!(err.to_string().contains("root"), "got: {err}");
    }

    #[test]
    fn rejects_unknown_platform() {
        let json = valid_manifest_json().replace(
            "[\"windows\", \"linux\", \"macos\"]",
            "[\"windows\", \"solaris\"]",
        );
        let err = parse_manifest(&json).unwrap_err();
        assert!(err.to_string().contains("solaris"), "got: {err}");
    }

    #[test]
    fn validate_rejects_bad_plugin_id() {
        for bad in [
            "",
            "-lead",
            "trail-",
            "double--hyphen",
            "Upper",
            "has space",
            "sla/sh",
            "../escape",
        ] {
            let json = valid_manifest_json()
                .replace("\"id\": \"k8s-exec\"", &format!("\"id\": \"{bad}\""));
            let manifest = parse_manifest(&json).expect("shape is fine");
            assert!(
                matches!(
                    manifest.validate(),
                    Err(ManifestValidationError::InvalidId(_))
                ),
                "id {bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn validate_accepts_good_plugin_ids() {
        for good in ["k8s-exec", "a", "plugin1", "my-cool-plugin", "0abc"] {
            let json = valid_manifest_json()
                .replace("\"id\": \"k8s-exec\"", &format!("\"id\": \"{good}\""));
            let manifest = parse_manifest(&json).expect("shape is fine");
            manifest
                .validate()
                .unwrap_or_else(|e| panic!("id {good:?} should validate: {e}"));
        }
    }

    #[test]
    fn validate_rejects_no_extensions() {
        let json = valid_manifest_json().replace(
            "\"extensions\": {\n                \"terminalBackend\": {\n                    \"connectionType\": \"k8s-exec\",\n                    \"displayName\": \"Kubernetes Exec\",\n                    \"configSchema\": {\n                        \"type\": \"object\",\n                        \"properties\": { \"pod\": { \"type\": \"string\" } },\n                        \"required\": [\"pod\"]\n                    }\n                }\n            }",
            "\"extensions\": {}",
        );
        let manifest = parse_manifest(&json).expect("empty extensions is a valid shape");
        assert_eq!(
            manifest.validate(),
            Err(ManifestValidationError::NoExtensions)
        );
    }

    #[test]
    fn validate_rejects_bad_api_version() {
        for bad in ["", "x", "1.y", "1.2.3", "1."] {
            let json = valid_manifest_json().replace(
                "\"apiVersion\": \"1.0\"",
                &format!("\"apiVersion\": \"{bad}\""),
            );
            let manifest = parse_manifest(&json).expect("shape is fine");
            assert!(
                matches!(
                    manifest.validate(),
                    Err(ManifestValidationError::InvalidApiVersion(_))
                ),
                "apiVersion {bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn api_compatibility_rules() {
        // Same version is compatible.
        assert_eq!(check_api_compatibility("1.0"), ApiCompatibility::Compatible);
        // Bare major matches minor 0.
        assert_eq!(check_api_compatibility("1"), ApiCompatibility::Compatible);
        // Lower minor within the same major is compatible.
        // (host is 1.0, so only minor 0 qualifies here.)
        // Higher minor is not.
        assert_eq!(
            check_api_compatibility("1.1"),
            ApiCompatibility::Incompatible
        );
        // Different major is incompatible in both directions.
        assert_eq!(
            check_api_compatibility("2.0"),
            ApiCompatibility::Incompatible
        );
        assert_eq!(
            check_api_compatibility("0.9"),
            ApiCompatibility::Incompatible
        );
        // Garbage is incompatible.
        assert_eq!(
            check_api_compatibility("nope"),
            ApiCompatibility::Incompatible
        );
    }
}

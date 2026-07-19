//! VNC connection settings: the deserialized config plus the schema the shared
//! connection editor renders.
//!
//! The schema is the **shared field base** (#1680) plus VNC-specific groups,
//! layered through the existing schema system — the user sees the same editor as
//! every other graphical type, only the protocol-specific rows differ. This is
//! the additive seam: the VNC backend never edits a hand-written editor switch.

use serde::Deserialize;

use crate::connection::schema::{Condition, FieldType, SelectOption, SettingsField, SettingsGroup};
use crate::connection::{shared_field_base, SettingsSchema};

/// Default RFB display 0 → port 5900.
pub const VNC_BASE_PORT: u16 = 5900;

/// Deserialized VNC connection settings.
///
/// A superset of the shared field base plus the VNC-specific rows. Unknown keys
/// (e.g. frontend-only `scaleMode`, `autoReconnect`) are ignored.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VncConfig {
    /// Target host.
    pub host: String,
    /// Explicit TCP port. Overridden by [`display`](Self::display) when that is set.
    pub port: u16,
    /// Optional VNC display number; when set, the port is `5900 + display`.
    pub display: Option<u16>,
    /// VNC password (classic RFB auth). Empty means "no auth" is attempted.
    pub password: String,
    /// Suppress all keyboard/mouse input when `true`.
    pub view_only: bool,
    /// Render server-pushed cursor shapes when `true`.
    pub show_remote_cursor: bool,
    /// Preferred framebuffer encoding: `"zrle"` (compressed) or `"raw"`.
    pub preferred_encoding: String,
    /// Connect through an SSH tunnel when `true` (reuses the SSH backend).
    pub use_ssh_tunnel: bool,
    /// SSH gateway host for the tunnel.
    pub ssh_host: String,
    /// SSH gateway port.
    pub ssh_port: u16,
    /// SSH gateway username.
    pub ssh_username: String,
    /// SSH gateway password.
    pub ssh_password: String,
}

impl Default for VncConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: VNC_BASE_PORT,
            display: None,
            password: String::new(),
            view_only: false,
            show_remote_cursor: true,
            preferred_encoding: "zrle".to_string(),
            use_ssh_tunnel: false,
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_username: String::new(),
            ssh_password: String::new(),
        }
    }
}

impl VncConfig {
    /// The effective TCP port to reach the VNC server on.
    ///
    /// The display number wins when present (`5900 + display`), realizing the
    /// concept's display↔port interplay on the connect side; otherwise the
    /// explicit port is used.
    pub fn effective_port(&self) -> u16 {
        match self.display {
            Some(d) => VNC_BASE_PORT.saturating_add(d),
            None => self.port,
        }
    }

    /// Whether the raw (uncompressed) encoding was requested in preference to ZRLE.
    pub fn prefers_raw(&self) -> bool {
        self.preferred_encoding.eq_ignore_ascii_case("raw")
    }
}

fn field(key: &str, label: &str, field_type: FieldType) -> SettingsField {
    SettingsField {
        key: key.to_string(),
        label: label.to_string(),
        description: None,
        help_text: None,
        field_type,
        required: false,
        default: None,
        placeholder: None,
        supports_env_expansion: false,
        supports_tilde_expansion: false,
        visible_when: None,
    }
}

/// Only shown when `useSshTunnel` is enabled.
fn when_tunnel_enabled() -> Option<Condition> {
    Some(Condition {
        field: "useSshTunnel".to_string(),
        equals: serde_json::json!(true),
    })
}

/// The VNC connection editor schema: the shared field base plus the VNC-specific
/// **VNC Options** and **SSH Tunnel** groups.
pub fn vnc_settings_schema() -> SettingsSchema {
    let mut groups = shared_field_base(VNC_BASE_PORT);

    groups.push(SettingsGroup {
        key: "vnc".to_string(),
        label: "VNC Options".to_string(),
        fields: vec![
            SettingsField {
                description: Some(
                    "VNC display number. When set, the port becomes 5900 + display.".to_string(),
                ),
                field_type: FieldType::Number {
                    min: Some(0.0),
                    max: Some(255.0),
                },
                placeholder: Some("0".to_string()),
                ..field("display", "Display Number", FieldType::Text)
            },
            SettingsField {
                default: Some(serde_json::json!("zrle")),
                description: Some(
                    "Framebuffer encoding preference. ZRLE is compressed; Raw is uncompressed."
                        .to_string(),
                ),
                ..field(
                    "preferredEncoding",
                    "Encoding",
                    FieldType::Select {
                        options: vec![
                            SelectOption {
                                value: "zrle".to_string(),
                                label: "ZRLE (compressed)".to_string(),
                            },
                            SelectOption {
                                value: "raw".to_string(),
                                label: "Raw (uncompressed)".to_string(),
                            },
                        ],
                    },
                )
            },
            SettingsField {
                default: Some(serde_json::json!(true)),
                description: Some(
                    "Render the remote cursor shape pushed by the server.".to_string(),
                ),
                ..field("showRemoteCursor", "Show Remote Cursor", FieldType::Boolean)
            },
        ],
    });

    groups.push(SettingsGroup {
        key: "sshTunnel".to_string(),
        label: "SSH Tunnel".to_string(),
        fields: vec![
            SettingsField {
                default: Some(serde_json::json!(false)),
                description: Some(
                    "Reach the VNC server through an SSH tunnel (SSH local forward).".to_string(),
                ),
                ..field("useSshTunnel", "Use SSH Tunnel", FieldType::Boolean)
            },
            SettingsField {
                required: true,
                supports_env_expansion: true,
                placeholder: Some("bastion.example.com".to_string()),
                visible_when: when_tunnel_enabled(),
                ..field("sshHost", "SSH Host", FieldType::Text)
            },
            SettingsField {
                default: Some(serde_json::json!(22)),
                visible_when: when_tunnel_enabled(),
                ..field("sshPort", "SSH Port", FieldType::Port)
            },
            SettingsField {
                supports_env_expansion: true,
                visible_when: when_tunnel_enabled(),
                ..field("sshUsername", "SSH Username", FieldType::Text)
            },
            SettingsField {
                visible_when: when_tunnel_enabled(),
                ..field("sshPassword", "SSH Password", FieldType::Password)
            },
        ],
    });

    SettingsSchema { groups }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_target_display_zero() {
        let cfg = VncConfig::default();
        assert_eq!(cfg.port, 5900);
        assert_eq!(cfg.effective_port(), 5900);
        assert!(cfg.show_remote_cursor);
        assert!(!cfg.prefers_raw());
    }

    #[test]
    fn display_overrides_port() {
        let cfg: VncConfig = serde_json::from_value(serde_json::json!({
            "host": "h", "port": 5999, "display": 3
        }))
        .unwrap();
        assert_eq!(cfg.effective_port(), 5903);
    }

    #[test]
    fn explicit_port_used_without_display() {
        let cfg: VncConfig = serde_json::from_value(serde_json::json!({
            "host": "h", "port": 5905
        }))
        .unwrap();
        assert_eq!(cfg.effective_port(), 5905);
    }

    #[test]
    fn effective_port_saturates() {
        let cfg = VncConfig {
            display: Some(u16::MAX),
            ..Default::default()
        };
        assert_eq!(cfg.effective_port(), u16::MAX);
    }

    #[test]
    fn unknown_frontend_only_keys_are_ignored() {
        let cfg: VncConfig = serde_json::from_value(serde_json::json!({
            "host": "h", "scaleMode": "fit", "autoReconnect": true, "colorDepth": "16"
        }))
        .unwrap();
        assert_eq!(cfg.host, "h");
    }

    #[test]
    fn raw_encoding_preference_detected() {
        let cfg: VncConfig = serde_json::from_value(serde_json::json!({
            "host": "h", "preferredEncoding": "raw"
        }))
        .unwrap();
        assert!(cfg.prefers_raw());
    }

    #[test]
    fn schema_extends_shared_base_with_vnc_groups() {
        let schema = vnc_settings_schema();
        let keys: Vec<&str> = schema.groups.iter().map(|g| g.key.as_str()).collect();
        // Shared base first, then the protocol-specific groups appended.
        assert_eq!(
            keys,
            vec!["connection", "display", "features", "vnc", "sshTunnel"]
        );
    }

    #[test]
    fn schema_has_no_domain_field() {
        let schema = vnc_settings_schema();
        let has_domain = schema
            .groups
            .iter()
            .flat_map(|g| &g.fields)
            .any(|f| f.key == "domain");
        assert!(!has_domain, "VNC must not expose a domain field");
    }

    #[test]
    fn schema_port_defaults_to_5900() {
        let schema = vnc_settings_schema();
        let port = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "port")
            .unwrap();
        assert_eq!(port.default, Some(serde_json::json!(5900)));
    }

    #[test]
    fn ssh_tunnel_fields_are_conditionally_visible() {
        let schema = vnc_settings_schema();
        let group = schema.groups.iter().find(|g| g.key == "sshTunnel").unwrap();
        let host = group.fields.iter().find(|f| f.key == "sshHost").unwrap();
        let cond = host.visible_when.as_ref().unwrap();
        assert_eq!(cond.field, "useSshTunnel");
        assert_eq!(cond.equals, serde_json::json!(true));
        // The toggle itself is always visible.
        let toggle = group
            .fields
            .iter()
            .find(|f| f.key == "useSshTunnel")
            .unwrap();
        assert!(toggle.visible_when.is_none());
    }

    #[test]
    fn schema_serializes() {
        // The whole schema must round-trip through serde for the IPC boundary.
        let schema = vnc_settings_schema();
        let json = serde_json::to_string(&schema).unwrap();
        let back: SettingsSchema = serde_json::from_str(&json).unwrap();
        assert_eq!(back.groups.len(), 5);
    }
}

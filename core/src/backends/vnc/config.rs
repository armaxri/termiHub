//! VNC connection settings: the deserialized config plus the schema the shared
//! connection editor renders.
//!
//! The schema is the **shared field base** (#1680) plus VNC-specific groups,
//! layered through the existing schema system — the user sees the same editor as
//! every other graphical type, only the protocol-specific rows differ. This is
//! the additive seam: the VNC backend never edits a hand-written editor switch.

use serde::Deserialize;

use crate::config::SshConfig;
use crate::connection::schema::{
    Condition, FieldType, FilePathKind, SelectOption, SettingsField, SettingsGroup,
};
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
    /// SSH gateway authentication method: `"password"`, `"key"`, or `"agent"`.
    /// Empty is treated as `"password"` for backward compatibility with
    /// connections saved before key/agent auth existed.
    pub ssh_auth_method: String,
    /// Path to the private key file when [`ssh_auth_method`](Self::ssh_auth_method)
    /// is `"key"`.
    pub ssh_key_path: Option<String>,
    /// SSH gateway password. Doubles as the private-key passphrase when the auth
    /// method is `"key"`; ignored for `"agent"`.
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
            ssh_auth_method: "password".to_string(),
            ssh_key_path: None,
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

    /// The effective SSH-tunnel auth method, defaulting to `"password"` when unset
    /// so connections saved before key/agent auth existed still authenticate.
    pub fn ssh_auth_method(&self) -> &str {
        if self.ssh_auth_method.trim().is_empty() {
            "password"
        } else {
            self.ssh_auth_method.as_str()
        }
    }

    /// Build the [`SshConfig`] for the SSH-tunnel gateway from the VNC settings.
    ///
    /// Reuses the SSH backend's own auth machinery: `"password"`, `"key"` (with
    /// [`ssh_key_path`](Self::ssh_key_path) and an optional passphrase carried in
    /// [`ssh_password`](Self::ssh_password)), or `"agent"` (ssh-agent). Empty
    /// password / key-path values map to `None` so an unencrypted key isn't
    /// mistaken for a passphrase-protected one, and an empty method falls back to
    /// `"password"`.
    pub fn tunnel_ssh_config(&self) -> SshConfig {
        let password = if self.ssh_password.is_empty() {
            None
        } else {
            Some(self.ssh_password.clone())
        };
        let key_path = self.ssh_key_path.clone().filter(|p| !p.trim().is_empty());
        SshConfig {
            host: self.ssh_host.clone(),
            port: self.ssh_port,
            username: self.ssh_username.clone(),
            auth_method: self.ssh_auth_method().to_string(),
            password,
            key_path,
            ..SshConfig::default()
        }
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

/// Only shown when the SSH-tunnel auth method equals `method`. The auth-method
/// select is itself gated on the tunnel being enabled, so these fields stay
/// hidden until the user opts into a tunnel and picks the matching method.
fn when_ssh_auth_is(method: &str) -> Option<Condition> {
    Some(Condition {
        field: "sshAuthMethod".to_string(),
        equals: serde_json::json!(method),
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
                default: Some(serde_json::json!("password")),
                description: Some(
                    "How to authenticate to the SSH gateway: a password, a private \
                     key file, or the local ssh-agent."
                        .to_string(),
                ),
                visible_when: when_tunnel_enabled(),
                ..field(
                    "sshAuthMethod",
                    "SSH Auth Method",
                    FieldType::Select {
                        options: vec![
                            SelectOption {
                                value: "password".to_string(),
                                label: "Password".to_string(),
                            },
                            SelectOption {
                                value: "key".to_string(),
                                label: "Key File".to_string(),
                            },
                            SelectOption {
                                value: "agent".to_string(),
                                label: "SSH Agent".to_string(),
                            },
                        ],
                    },
                )
            },
            SettingsField {
                supports_tilde_expansion: true,
                supports_env_expansion: true,
                placeholder: Some("~/.ssh/id_ed25519".to_string()),
                description: Some("Private key used to authenticate the SSH tunnel.".to_string()),
                visible_when: when_ssh_auth_is("key"),
                ..field(
                    "sshKeyPath",
                    "SSH Key Path",
                    FieldType::FilePath {
                        kind: FilePathKind::File,
                    },
                )
            },
            SettingsField {
                description: Some(
                    "SSH gateway password, or the passphrase for the selected key file."
                        .to_string(),
                ),
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

    // --- SSH-tunnel key/agent auth (#1714) ---

    #[test]
    fn tunnel_defaults_to_password_auth() {
        let cfg = VncConfig::default();
        assert_eq!(cfg.ssh_auth_method(), "password");
        let ssh = cfg.tunnel_ssh_config();
        assert_eq!(ssh.auth_method, "password");
        assert!(ssh.key_path.is_none());
    }

    #[test]
    fn empty_auth_method_falls_back_to_password() {
        // Connections saved before key/agent auth existed carry no method.
        let cfg: VncConfig = serde_json::from_value(serde_json::json!({
            "host": "h", "useSshTunnel": true, "sshAuthMethod": ""
        }))
        .unwrap();
        assert_eq!(cfg.ssh_auth_method(), "password");
        assert_eq!(cfg.tunnel_ssh_config().auth_method, "password");
    }

    #[test]
    fn tunnel_key_auth_maps_key_path_and_passphrase() {
        let cfg: VncConfig = serde_json::from_value(serde_json::json!({
            "host": "h",
            "useSshTunnel": true,
            "sshHost": "bastion",
            "sshUsername": "admin",
            "sshAuthMethod": "key",
            "sshKeyPath": "~/.ssh/id_ed25519",
            "sshPassword": "secret-passphrase"
        }))
        .unwrap();
        let ssh = cfg.tunnel_ssh_config();
        assert_eq!(ssh.auth_method, "key");
        assert_eq!(ssh.host, "bastion");
        assert_eq!(ssh.username, "admin");
        assert_eq!(ssh.key_path.as_deref(), Some("~/.ssh/id_ed25519"));
        // The password field carries the key passphrase for "key" auth.
        assert_eq!(ssh.password.as_deref(), Some("secret-passphrase"));
    }

    #[test]
    fn tunnel_agent_auth_needs_no_key_or_password() {
        let cfg: VncConfig = serde_json::from_value(serde_json::json!({
            "host": "h",
            "useSshTunnel": true,
            "sshAuthMethod": "agent"
        }))
        .unwrap();
        let ssh = cfg.tunnel_ssh_config();
        assert_eq!(ssh.auth_method, "agent");
        assert!(ssh.key_path.is_none());
        assert!(ssh.password.is_none());
    }

    #[test]
    fn tunnel_empty_password_and_key_path_map_to_none() {
        // Empty strings must become None so an unencrypted key isn't treated as
        // passphrase-protected and an empty password isn't sent.
        let cfg = VncConfig {
            use_ssh_tunnel: true,
            ssh_auth_method: "key".to_string(),
            ssh_key_path: Some("  ".to_string()),
            ssh_password: String::new(),
            ..VncConfig::default()
        };
        let ssh = cfg.tunnel_ssh_config();
        assert!(ssh.password.is_none());
        assert!(ssh.key_path.is_none());
    }

    #[test]
    fn schema_exposes_ssh_auth_method_and_key_path() {
        let schema = vnc_settings_schema();
        let group = schema.groups.iter().find(|g| g.key == "sshTunnel").unwrap();
        let keys: Vec<&str> = group.fields.iter().map(|f| f.key.as_str()).collect();
        assert!(keys.contains(&"sshAuthMethod"));
        assert!(keys.contains(&"sshKeyPath"));

        // Auth method is a select over password/key/agent, defaulting to password.
        let method = group
            .fields
            .iter()
            .find(|f| f.key == "sshAuthMethod")
            .unwrap();
        assert_eq!(method.default, Some(serde_json::json!("password")));
        if let FieldType::Select { options } = &method.field_type {
            let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
            assert_eq!(values, vec!["password", "key", "agent"]);
        } else {
            panic!("sshAuthMethod must be a select");
        }
        // The method select only appears once a tunnel is enabled.
        let cond = method.visible_when.as_ref().unwrap();
        assert_eq!(cond.field, "useSshTunnel");
        assert_eq!(cond.equals, serde_json::json!(true));
    }

    #[test]
    fn schema_key_path_is_file_picker_gated_on_key_auth() {
        let schema = vnc_settings_schema();
        let group = schema.groups.iter().find(|g| g.key == "sshTunnel").unwrap();
        let key_path = group.fields.iter().find(|f| f.key == "sshKeyPath").unwrap();
        assert!(matches!(
            key_path.field_type,
            FieldType::FilePath {
                kind: FilePathKind::File
            }
        ));
        assert!(key_path.supports_tilde_expansion);
        let cond = key_path.visible_when.as_ref().unwrap();
        assert_eq!(cond.field, "sshAuthMethod");
        assert_eq!(cond.equals, serde_json::json!("key"));
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

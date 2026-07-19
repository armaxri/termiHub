//! RDP connection settings: the deserialized config plus the schema the shared
//! connection editor renders.
//!
//! The schema is the **shared field base** (#1680) plus RDP-specific rows —
//! layered through the existing schema system, so the user sees the same editor
//! as every other graphical type, only the protocol-specific rows differ. This
//! is the additive seam: the RDP backend never edits a hand-written editor
//! switch. Unlike VNC, RDP carries a **domain** field, a **security-mode**
//! select (Auto / NLA / TLS / legacy RDP), and **certificate-error** handling.
//!
//! Ported from the parked #1682 branch. Unchanged except that [`RdpConfig`] now
//! also derives [`Serialize`]: it crosses the sidecar IPC boundary
//! (`HostMessage::Connect`) as the connect payload, so it must round-trip.

use serde::{Deserialize, Serialize};

use crate::connection::schema::{Condition, FieldType, SelectOption, SettingsField, SettingsGroup};
use crate::connection::{shared_field_base, SettingsSchema};

/// Standard RDP TCP port.
pub const RDP_DEFAULT_PORT: u16 = 3389;

/// Default initial desktop width requested from the server, in pixels.
pub const DEFAULT_WIDTH: u16 = 1280;
/// Default initial desktop height requested from the server, in pixels.
pub const DEFAULT_HEIGHT: u16 = 800;

/// The security mode the client negotiates with the RDP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecurityMode {
    /// Let the server pick the strongest mutually-supported protocol.
    Auto,
    /// Network Level Authentication (CredSSP) — the secure default for modern hosts.
    Nla,
    /// TLS (standard RDP security over TLS) without CredSSP pre-authentication.
    Tls,
    /// Legacy "Standard RDP Security" (RC4). Insecure; shown behind a warning.
    Rdp,
}

impl SecurityMode {
    /// Parse the schema select value (`"auto" | "nla" | "tls" | "rdp"`),
    /// defaulting to [`SecurityMode::Auto`] for unknown/empty input.
    pub fn from_value(value: &str) -> Self {
        match value.to_ascii_lowercase().as_str() {
            "nla" => SecurityMode::Nla,
            "tls" => SecurityMode::Tls,
            "rdp" => SecurityMode::Rdp,
            _ => SecurityMode::Auto,
        }
    }

    /// Whether this mode is the insecure legacy RC4 path (the frontend shows a
    /// security warning for it).
    pub fn is_legacy(self) -> bool {
        matches!(self, SecurityMode::Rdp)
    }
}

/// Deserialized RDP connection settings.
///
/// A superset of the shared field base plus the RDP-specific rows. Unknown keys
/// (e.g. frontend-only `scaleMode`, `autoReconnect`) are ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RdpConfig {
    /// Target host.
    pub host: String,
    /// TCP port (defaults to 3389).
    pub port: u16,
    /// Username for authentication.
    pub username: String,
    /// Password for authentication.
    pub password: String,
    /// Windows domain (RDP-specific; VNC has none). Empty means no domain.
    pub domain: String,
    /// Security mode select value: `"auto" | "nla" | "tls" | "rdp"`.
    pub security_mode: String,
    /// Accept a mismatched / untrusted server certificate instead of failing.
    pub ignore_cert_errors: bool,
    /// Suppress all keyboard/mouse input when `true`.
    pub view_only: bool,
    /// Initial requested desktop width in pixels.
    pub width: Option<u16>,
    /// Initial requested desktop height in pixels.
    pub height: Option<u16>,
    /// Shared field-base color depth select (`"32" | "24" | "16" | "8"`).
    pub color_depth: String,
}

impl Default for RdpConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: RDP_DEFAULT_PORT,
            username: String::new(),
            password: String::new(),
            domain: String::new(),
            security_mode: "auto".to_string(),
            ignore_cert_errors: false,
            view_only: false,
            width: None,
            height: None,
            color_depth: "32".to_string(),
        }
    }
}

impl RdpConfig {
    /// The effective TCP port to reach the RDP server on.
    pub fn effective_port(&self) -> u16 {
        if self.port == 0 {
            RDP_DEFAULT_PORT
        } else {
            self.port
        }
    }

    /// The negotiated [`SecurityMode`].
    pub fn security(&self) -> SecurityMode {
        SecurityMode::from_value(&self.security_mode)
    }

    /// The initial desktop width to request (clamped to a sane minimum).
    pub fn desktop_width(&self) -> u16 {
        self.width.filter(|w| *w > 0).unwrap_or(DEFAULT_WIDTH)
    }

    /// The initial desktop height to request (clamped to a sane minimum).
    pub fn desktop_height(&self) -> u16 {
        self.height.filter(|h| *h > 0).unwrap_or(DEFAULT_HEIGHT)
    }

    /// Parse the shared-base color-depth select into bits-per-pixel, defaulting
    /// to 32 for unknown/empty input.
    pub fn color_depth_bpp(&self) -> u32 {
        match self.color_depth.as_str() {
            "8" => 8,
            "16" => 16,
            "24" => 24,
            _ => 32,
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

/// Only shown when the legacy `rdp` security mode is selected — the certificate
/// toggle is meaningful for the TLS-bearing modes; it is always visible so the
/// user can pre-toggle it, but the warning wording lives in the frontend.
fn when_security_is(mode: &str) -> Option<Condition> {
    Some(Condition {
        field: "securityMode".to_string(),
        equals: serde_json::json!(mode),
    })
}

/// The RDP connection editor schema: the shared field base plus the RDP-specific
/// **RDP Options** group (domain, security mode, certificate handling).
pub fn rdp_settings_schema() -> SettingsSchema {
    let mut groups = shared_field_base(RDP_DEFAULT_PORT);

    groups.push(SettingsGroup {
        key: "rdp".to_string(),
        label: "RDP Options".to_string(),
        fields: vec![
            SettingsField {
                supports_env_expansion: true,
                description: Some(
                    "Windows domain for authentication. Leave empty for a local account or a \
                     user@domain UPN."
                        .to_string(),
                ),
                placeholder: Some("WORKGROUP".to_string()),
                ..field("domain", "Domain", FieldType::Text)
            },
            SettingsField {
                default: Some(serde_json::json!("auto")),
                description: Some(
                    "How the session is secured. NLA (CredSSP) is recommended; legacy RDP \
                     security is insecure and offered only for old servers."
                        .to_string(),
                ),
                ..field(
                    "securityMode",
                    "Security",
                    FieldType::Select {
                        options: vec![
                            SelectOption {
                                value: "auto".to_string(),
                                label: "Auto (negotiate)".to_string(),
                            },
                            SelectOption {
                                value: "nla".to_string(),
                                label: "NLA (CredSSP)".to_string(),
                            },
                            SelectOption {
                                value: "tls".to_string(),
                                label: "TLS".to_string(),
                            },
                            SelectOption {
                                value: "rdp".to_string(),
                                label: "Legacy RDP (insecure)".to_string(),
                            },
                        ],
                    },
                )
            },
            SettingsField {
                default: Some(serde_json::json!(false)),
                description: Some(
                    "Connect even when the server certificate is untrusted or its name does not \
                     match. Reduces security — use only for hosts you trust."
                        .to_string(),
                ),
                ..field(
                    "ignoreCertErrors",
                    "Ignore Certificate Errors",
                    FieldType::Boolean,
                )
            },
        ],
    });

    // Silence the unused helper if no field currently uses a condition; keeping
    // it available documents the conditional-visibility seam for future rows.
    let _ = when_security_is;

    SettingsSchema { groups }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_target_port_3389() {
        let cfg = RdpConfig::default();
        assert_eq!(cfg.port, 3389);
        assert_eq!(cfg.effective_port(), 3389);
        assert_eq!(cfg.security(), SecurityMode::Auto);
        assert!(!cfg.ignore_cert_errors);
    }

    #[test]
    fn zero_port_falls_back_to_default() {
        let cfg = RdpConfig {
            port: 0,
            ..Default::default()
        };
        assert_eq!(cfg.effective_port(), 3389);
    }

    #[test]
    fn security_mode_parses_all_values() {
        assert_eq!(SecurityMode::from_value("auto"), SecurityMode::Auto);
        assert_eq!(SecurityMode::from_value("NLA"), SecurityMode::Nla);
        assert_eq!(SecurityMode::from_value("tls"), SecurityMode::Tls);
        assert_eq!(SecurityMode::from_value("rdp"), SecurityMode::Rdp);
        // Unknown → Auto.
        assert_eq!(SecurityMode::from_value("bogus"), SecurityMode::Auto);
        assert!(SecurityMode::Rdp.is_legacy());
        assert!(!SecurityMode::Nla.is_legacy());
    }

    #[test]
    fn desktop_size_defaults_and_overrides() {
        let cfg = RdpConfig::default();
        assert_eq!(cfg.desktop_width(), DEFAULT_WIDTH);
        assert_eq!(cfg.desktop_height(), DEFAULT_HEIGHT);
        let sized = RdpConfig {
            width: Some(1920),
            height: Some(1080),
            ..Default::default()
        };
        assert_eq!(sized.desktop_width(), 1920);
        assert_eq!(sized.desktop_height(), 1080);
        // Zero is treated as "unset".
        let zeroed = RdpConfig {
            width: Some(0),
            ..Default::default()
        };
        assert_eq!(zeroed.desktop_width(), DEFAULT_WIDTH);
    }

    #[test]
    fn color_depth_parses() {
        for (val, bpp) in [("8", 8), ("16", 16), ("24", 24), ("32", 32), ("x", 32)] {
            let cfg = RdpConfig {
                color_depth: val.to_string(),
                ..Default::default()
            };
            assert_eq!(cfg.color_depth_bpp(), bpp);
        }
    }

    #[test]
    fn unknown_frontend_only_keys_are_ignored() {
        let cfg: RdpConfig = serde_json::from_value(serde_json::json!({
            "host": "h", "scaleMode": "fit", "autoReconnect": true
        }))
        .unwrap();
        assert_eq!(cfg.host, "h");
    }

    #[test]
    fn domain_deserializes() {
        let cfg: RdpConfig = serde_json::from_value(serde_json::json!({
            "host": "h", "domain": "CORP", "securityMode": "nla"
        }))
        .unwrap();
        assert_eq!(cfg.domain, "CORP");
        assert_eq!(cfg.security(), SecurityMode::Nla);
    }

    #[test]
    fn config_round_trips_through_serde() {
        // RdpConfig crosses the IPC boundary, so Serialize→Deserialize must be
        // lossless for every field the sidecar relies on.
        let cfg = RdpConfig {
            host: "host".to_string(),
            port: 3390,
            username: "user".to_string(),
            password: "secret".to_string(),
            domain: "CORP".to_string(),
            security_mode: "nla".to_string(),
            ignore_cert_errors: true,
            view_only: true,
            width: Some(1600),
            height: Some(900),
            color_depth: "16".to_string(),
        };
        let json = serde_json::to_value(&cfg).unwrap();
        let back: RdpConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back.host, "host");
        assert_eq!(back.port, 3390);
        assert_eq!(back.password, "secret");
        assert_eq!(back.domain, "CORP");
        assert_eq!(back.security(), SecurityMode::Nla);
        assert!(back.ignore_cert_errors);
        assert!(back.view_only);
        assert_eq!(back.desktop_width(), 1600);
        assert_eq!(back.color_depth_bpp(), 16);
    }

    #[test]
    fn schema_extends_shared_base_with_rdp_group() {
        let schema = rdp_settings_schema();
        let keys: Vec<&str> = schema.groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(keys, vec!["connection", "display", "features", "rdp"]);
    }

    #[test]
    fn schema_has_domain_field() {
        let schema = rdp_settings_schema();
        let has_domain = schema
            .groups
            .iter()
            .flat_map(|g| &g.fields)
            .any(|f| f.key == "domain");
        assert!(has_domain, "RDP must expose a domain field");
    }

    #[test]
    fn schema_has_security_mode_and_cert_toggle() {
        let schema = rdp_settings_schema();
        let group = schema.groups.iter().find(|g| g.key == "rdp").unwrap();
        assert!(group.fields.iter().any(|f| f.key == "securityMode"));
        assert!(group.fields.iter().any(|f| f.key == "ignoreCertErrors"));
    }

    #[test]
    fn schema_port_defaults_to_3389() {
        let schema = rdp_settings_schema();
        let port = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "port")
            .unwrap();
        assert_eq!(port.default, Some(serde_json::json!(3389)));
    }

    #[test]
    fn schema_serializes() {
        let schema = rdp_settings_schema();
        let json = serde_json::to_string(&schema).unwrap();
        let back: SettingsSchema = serde_json::from_str(&json).unwrap();
        assert_eq!(back.groups.len(), 4);
    }
}

//! VNC connection settings: the deserialized config plus the schema the shared
//! connection editor renders.
//!
//! The schema is the **shared field base** (#1680) plus VNC-specific groups,
//! layered through the existing schema system — the user sees the same editor as
//! every other graphical type, only the protocol-specific rows differ. This is
//! the additive seam: the VNC backend never edits a hand-written editor switch.

use serde::Deserialize;

use crate::config::SshConfig;
use crate::connection::graphical_resolution::{
    normalize_fixed_size, server_resolution_fields, DEFAULT_FIXED_HEIGHT, DEFAULT_FIXED_WIDTH,
    RESOLUTION_MODE_DYNAMIC, RESOLUTION_MODE_SERVER,
};
use crate::connection::schema::{
    Condition, FieldType, FilePathKind, SelectOption, SettingsField, SettingsGroup,
};
use crate::connection::{is_fixed_mode, shared_field_base, SettingsSchema};

use super::desktop_size::ResolutionMode;

/// Default RFB display 0 → port 5900.
pub const VNC_BASE_PORT: u16 = 5900;

/// The default [`VncConfig::quality`]: lossless Tight, no JPEG.
pub const QUALITY_LOSSLESS: &str = "lossless";

/// Tight quality presets: `(value, label, jpeg_quality_level, compress_level)`.
/// Levels are the RFB pseudo-encoding levels `0..=9` (#3464).
const QUALITY_PRESETS: [(&str, &str, u8, u8); 3] = [
    ("high", "High (JPEG, light compression)", 8, 1),
    ("medium", "Medium (JPEG, balanced)", 5, 5),
    ("low", "Low (JPEG, maximum compression)", 2, 9),
];

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
    /// Also the password for the VeNCrypt `VncAuth`/`Plain` second stages.
    pub password: String,
    /// VNC username (the shared "Username" field). Used only for the VeNCrypt
    /// `Plain` sub-authentication; classic VNC-password auth ignores it.
    pub username: String,
    /// TLS certificate verification for VeNCrypt X509 sub-types: `"system"`
    /// (webpki roots — the default, rejects self-signed), `"insecure"` (accept
    /// any certificate, for self-signed servers), or `"ca"` (verify against
    /// [`tls_ca_path`](Self::tls_ca_path)).
    pub tls_verify: String,
    /// PEM CA bundle path used when [`tls_verify`](Self::tls_verify) is `"ca"`.
    pub tls_ca_path: Option<String>,
    /// Suppress all keyboard/mouse input when `true`.
    pub view_only: bool,
    /// Render server-pushed cursor shapes when `true`.
    pub show_remote_cursor: bool,
    /// Preferred framebuffer encoding: `"zrle"` (compressed) or `"raw"`.
    pub preferred_encoding: String,
    /// Pixel format requested from the server: `"32"` (true color, the default)
    /// or `"16"` (RGB565 high color, half the bandwidth). Anything else —
    /// including a stale `"24"` / `"8"` from the former shared select (#3460) —
    /// means 32-bit (#3464).
    pub color_depth: String,
    /// Tight image quality: `"lossless"` (the default — no JPEG, the behavior
    /// before #3464), or `"high"` / `"medium"` / `"low"`, which allow lossy JPEG
    /// sub-rects at a decreasing quality and increasing zlib compression.
    /// Unknown values mean lossless.
    pub quality: String,
    /// Remote resolution (#3463): `"server"` (the default — keep the size the
    /// server chose, the only behavior before #3463), `"dynamic"` (follow the
    /// tab via RFB `SetDesktopSize`) or `"fixed"` (request
    /// [`width`](Self::width) x [`height`](Self::height) once connected).
    /// Unknown values mean `"server"`.
    pub resolution_mode: String,
    /// Fixed desktop width in pixels (fixed resolution mode only).
    pub width: Option<u16>,
    /// Fixed desktop height in pixels (fixed resolution mode only).
    pub height: Option<u16>,
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
            username: String::new(),
            tls_verify: "system".to_string(),
            tls_ca_path: None,
            view_only: false,
            show_remote_cursor: true,
            preferred_encoding: "zrle".to_string(),
            color_depth: "32".to_string(),
            quality: QUALITY_LOSSLESS.to_string(),
            resolution_mode: RESOLUTION_MODE_SERVER.to_string(),
            width: None,
            height: None,
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

    /// The remote-resolution mode (#3463). A fixed size is normalized into the
    /// shared 200..=8192 range; anything other than `"dynamic"` / `"fixed"`
    /// keeps the server's size.
    pub fn resolution_mode(&self) -> ResolutionMode {
        let mode = self.resolution_mode.trim();
        if is_fixed_mode(mode) {
            let (width, height) = normalize_fixed_size(
                self.width.unwrap_or(DEFAULT_FIXED_WIDTH),
                self.height.unwrap_or(DEFAULT_FIXED_HEIGHT),
            );
            ResolutionMode::Fixed { width, height }
        } else if mode.eq_ignore_ascii_case(RESOLUTION_MODE_DYNAMIC) {
            ResolutionMode::Dynamic
        } else {
            ResolutionMode::Server
        }
    }

    /// Whether the raw (uncompressed) encoding was requested in preference to ZRLE.
    pub fn prefers_raw(&self) -> bool {
        self.preferred_encoding.eq_ignore_ascii_case("raw")
    }

    /// The bits per pixel to negotiate: 16 when the user picked 16-bit high
    /// color, otherwise 32 (the default for every other or missing value).
    pub fn color_depth_bpp(&self) -> u8 {
        if self.color_depth.trim() == "16" {
            16
        } else {
            32
        }
    }

    /// The RFB pixel format to request with `SetPixelFormat`.
    pub fn pixel_format(&self) -> vnc::PixelFormat {
        match self.color_depth_bpp() {
            16 => vnc::PixelFormat::rgb565(),
            _ => vnc::PixelFormat::rgba(),
        }
    }

    /// The Tight `(jpeg_quality_level, compress_level)` pseudo-encoding levels
    /// for the chosen quality, or `None` for lossless (no quality hints sent,
    /// so the server never switches to JPEG).
    pub fn tight_levels(&self) -> Option<(u8, u8)> {
        let quality = self.quality.trim();
        QUALITY_PRESETS
            .iter()
            .find(|(value, ..)| value.eq_ignore_ascii_case(quality))
            .map(|&(_, _, jpeg, compress)| (jpeg, compress))
    }

    /// The effective VeNCrypt TLS verification mode, normalized and defaulted to
    /// `"system"` for empty/unknown values.
    pub fn tls_verify_mode(&self) -> &str {
        match self.tls_verify.trim() {
            "insecure" => "insecure",
            "ca" => "ca",
            _ => "system",
        }
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

/// Only shown when TLS verification is set to a custom CA bundle.
fn when_tls_ca() -> Option<Condition> {
    Some(Condition {
        field: "tlsVerify".to_string(),
        equals: serde_json::json!("ca"),
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

fn opt(value: &str, label: &str) -> SelectOption {
    SelectOption {
        value: value.to_string(),
        label: label.to_string(),
    }
}

/// The VNC color-depth select: exactly the pixel formats the client negotiates
/// and renders (see [`VncConfig::pixel_format`]).
fn color_depth_field() -> SettingsField {
    SettingsField {
        default: Some(serde_json::json!("32")),
        description: Some(
            "Pixel format requested from the server. 16-bit halves the bandwidth \
             at the cost of color banding."
                .to_string(),
        ),
        ..field(
            "colorDepth",
            "Color Depth",
            FieldType::Select {
                options: vec![
                    opt("32", "32-bit (true color)"),
                    opt("16", "16-bit (high color)"),
                ],
            },
        )
    }
}

/// The Tight image-quality select (see [`VncConfig::tight_levels`]).
fn quality_field() -> SettingsField {
    let mut options = vec![opt(QUALITY_LOSSLESS, "Lossless (no JPEG)")];
    options.extend(
        QUALITY_PRESETS
            .iter()
            .map(|(value, label, ..)| opt(value, label)),
    );
    SettingsField {
        default: Some(serde_json::json!(QUALITY_LOSSLESS)),
        description: Some(
            "Image quality for Tight-capable servers. The JPEG levels trade image \
             quality for bandwidth on photo-like content. Has no effect with the \
             Raw encoding."
                .to_string(),
        ),
        ..field("quality", "Quality", FieldType::Select { options })
    }
}

/// The VNC connection editor schema: the shared field base (with a VNC color
/// depth in its Display group) plus the VNC-specific **VNC Options** and
/// **SSH Tunnel** groups.
pub fn vnc_settings_schema() -> SettingsSchema {
    let mut groups = shared_field_base(VNC_BASE_PORT);
    if let Some(display) = groups.iter_mut().find(|g| g.key == "display") {
        display.fields.push(color_depth_field());
        display.fields.extend(server_resolution_fields());
    }

    groups.push(SettingsGroup {
        collapsed: false,
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
            quality_field(),
            SettingsField {
                default: Some(serde_json::json!(true)),
                description: Some(
                    "Render the remote cursor shape pushed by the server.".to_string(),
                ),
                ..field("showRemoteCursor", "Show Remote Cursor", FieldType::Boolean)
            },
            SettingsField {
                default: Some(serde_json::json!("system")),
                description: Some(
                    "How to verify the server's TLS certificate when the server \
                     negotiates VeNCrypt (X509). \"System\" trusts public CAs; \
                     \"Accept self-signed\" skips verification (insecure); \"Custom \
                     CA\" verifies against a PEM bundle."
                        .to_string(),
                ),
                ..field(
                    "tlsVerify",
                    "TLS Certificate Verification",
                    FieldType::Select {
                        options: vec![
                            SelectOption {
                                value: "system".to_string(),
                                label: "System trust store".to_string(),
                            },
                            SelectOption {
                                value: "insecure".to_string(),
                                label: "Accept self-signed (insecure)".to_string(),
                            },
                            SelectOption {
                                value: "ca".to_string(),
                                label: "Custom CA bundle".to_string(),
                            },
                        ],
                    },
                )
            },
            SettingsField {
                supports_tilde_expansion: true,
                supports_env_expansion: true,
                placeholder: Some("~/.vnc/ca.pem".to_string()),
                description: Some(
                    "PEM CA bundle used to verify the VeNCrypt TLS certificate.".to_string(),
                ),
                visible_when: when_tls_ca(),
                ..field(
                    "tlsCaPath",
                    "TLS CA Bundle",
                    FieldType::FilePath {
                        kind: FilePathKind::File,
                    },
                )
            },
        ],
    });

    groups.push(SettingsGroup {
        collapsed: false,
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

    // A secret containing `$`, `${VAR}`, and a leading `~` — all valid password
    // characters. If any field were run through shell/env/tilde expansion the
    // `${VAR}` would resolve to the process-environment value (a secret-leak
    // channel) and the leading `~` would become a home path (corruption), so a
    // verbatim round-trip is the guarantee this locks (TBE-013 / SEC-001).
    const SECRET_WITH_METACHARS: &str = "~p@$$${TERMIHUB_TEST_SECRET_LEAK}w0rd";

    #[test]
    fn vnc_secret_fields_are_never_shell_expanded() {
        // VncConfig has no `expand()`: neither the RFB `password` nor the SSH
        // tunnel `ssh_password` may ever be env/tilde-expanded. Set the leak var
        // so any accidental `${VAR}` expansion would be caught red-handed.
        temp_env::with_var(
            "TERMIHUB_TEST_SECRET_LEAK",
            Some("leaked-env-value"),
            || {
                let cfg: VncConfig = serde_json::from_value(serde_json::json!({
                    "host": "h",
                    "password": SECRET_WITH_METACHARS,
                    "useSshTunnel": true,
                    "sshHost": "gateway",
                    "sshUsername": "admin",
                    "sshAuthMethod": "password",
                    "sshPassword": SECRET_WITH_METACHARS,
                }))
                .unwrap();
                assert_eq!(
                    cfg.password, SECRET_WITH_METACHARS,
                    "VNC RFB password must be preserved verbatim (no expansion, no env leak)"
                );
                assert_eq!(
                    cfg.ssh_password, SECRET_WITH_METACHARS,
                    "VNC SSH-tunnel password must be preserved verbatim (no expansion, no env leak)"
                );
                // The gateway secret reaches SSH auth via `tunnel_ssh_config()`;
                // that builder must carry it through untouched too.
                assert_eq!(
                    cfg.tunnel_ssh_config().password.as_deref(),
                    Some(SECRET_WITH_METACHARS),
                    "tunnel SSH config must carry the gateway password verbatim"
                );
            },
        );
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
            "host": "h", "scaleMode": "fit", "autoReconnect": true
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

    // --- VeNCrypt TLS auth (#1714) ---

    #[test]
    fn tls_verify_defaults_to_system() {
        let cfg = VncConfig::default();
        assert_eq!(cfg.tls_verify_mode(), "system");
        assert!(cfg.tls_ca_path.is_none());
        assert_eq!(cfg.username, "");
    }

    #[test]
    fn tls_verify_mode_normalizes_values() {
        let mk = |v: &str| VncConfig {
            tls_verify: v.to_string(),
            ..VncConfig::default()
        };
        assert_eq!(mk("insecure").tls_verify_mode(), "insecure");
        assert_eq!(mk("ca").tls_verify_mode(), "ca");
        assert_eq!(mk("system").tls_verify_mode(), "system");
        // Empty/unknown fall back to the secure default.
        assert_eq!(mk("").tls_verify_mode(), "system");
        assert_eq!(mk("bogus").tls_verify_mode(), "system");
    }

    #[test]
    fn username_deserializes_from_shared_field() {
        // The shared "connection" group already exposes a username field; VeNCrypt
        // Plain reuses it.
        let cfg: VncConfig = serde_json::from_value(serde_json::json!({
            "host": "h", "username": "alice", "tlsVerify": "insecure"
        }))
        .unwrap();
        assert_eq!(cfg.username, "alice");
        assert_eq!(cfg.tls_verify_mode(), "insecure");
    }

    #[test]
    fn schema_exposes_tls_verify_and_ca_path() {
        let schema = vnc_settings_schema();
        let group = schema.groups.iter().find(|g| g.key == "vnc").unwrap();
        let verify = group.fields.iter().find(|f| f.key == "tlsVerify").unwrap();
        assert_eq!(verify.default, Some(serde_json::json!("system")));
        if let FieldType::Select { options } = &verify.field_type {
            let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
            assert_eq!(values, vec!["system", "insecure", "ca"]);
        } else {
            panic!("tlsVerify must be a select");
        }
        // The CA path picker only appears for the custom-CA mode.
        let ca = group.fields.iter().find(|f| f.key == "tlsCaPath").unwrap();
        assert!(matches!(
            ca.field_type,
            FieldType::FilePath {
                kind: FilePathKind::File
            }
        ));
        let cond = ca.visible_when.as_ref().unwrap();
        assert_eq!(cond.field, "tlsVerify");
        assert_eq!(cond.equals, serde_json::json!("ca"));
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
    fn schema_exposes_server_dynamic_and_fixed_resolution() {
        let schema = vnc_settings_schema();
        let display = schema
            .groups
            .iter()
            .find(|g| g.key == "display")
            .expect("display group");
        let mode = display
            .fields
            .iter()
            .find(|f| f.key == "resolutionMode")
            .expect("VNC exposes a resolution mode (#3463)");
        assert_eq!(mode.default, Some(serde_json::json!("server")));
        let FieldType::Select { options } = &mode.field_type else {
            panic!("resolutionMode must be a select");
        };
        let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
        assert_eq!(values, vec!["server", "dynamic", "fixed"]);
        for key in ["width", "height"] {
            let f = display.fields.iter().find(|f| f.key == key).unwrap();
            let cond = f.visible_when.as_ref().expect("gated on fixed");
            assert_eq!(cond.equals, serde_json::json!("fixed"));
        }
    }

    #[test]
    fn resolution_mode_defaults_to_server_for_old_configs() {
        // A config saved before #3463 carries no resolution keys at all.
        let cfg: VncConfig = serde_json::from_value(serde_json::json!({ "host": "h" })).unwrap();
        assert_eq!(cfg.resolution_mode(), ResolutionMode::Server);
        assert_eq!(
            VncConfig::default().resolution_mode(),
            ResolutionMode::Server
        );
        for stale in ["", "bogus", "auto"] {
            let cfg = VncConfig {
                resolution_mode: stale.to_string(),
                ..Default::default()
            };
            assert_eq!(cfg.resolution_mode(), ResolutionMode::Server, "{stale:?}");
        }
    }

    #[test]
    fn resolution_mode_parses_dynamic_and_normalized_fixed() {
        let parse = |v: serde_json::Value| {
            serde_json::from_value::<VncConfig>(v)
                .unwrap()
                .resolution_mode()
        };
        assert_eq!(
            parse(serde_json::json!({ "resolutionMode": "Dynamic", "width": 800 })),
            ResolutionMode::Dynamic
        );
        assert_eq!(
            parse(serde_json::json!({ "resolutionMode": "fixed", "width": 1280, "height": 720 })),
            ResolutionMode::Fixed {
                width: 1280,
                height: 720
            }
        );
        // Missing size → the editor's defaults; out-of-range → clamped.
        assert_eq!(
            parse(serde_json::json!({ "resolutionMode": "fixed" })),
            ResolutionMode::Fixed {
                width: 1920,
                height: 1080
            }
        );
        assert_eq!(
            parse(serde_json::json!({ "resolutionMode": "fixed", "width": 10, "height": 9000 })),
            ResolutionMode::Fixed {
                width: 200,
                height: 8192
            }
        );
    }

    #[test]
    fn schema_display_group_offers_only_negotiable_color_depths() {
        let schema = vnc_settings_schema();
        let display = schema
            .groups
            .iter()
            .find(|g| g.key == "display")
            .expect("display group");
        let keys: Vec<&str> = display.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(
            keys,
            vec![
                "scaleMode",
                "colorDepth",
                "resolutionMode",
                "width",
                "height"
            ]
        );
        let depth = &display.fields[1];
        assert_eq!(depth.default, Some(serde_json::json!("32")));
        let FieldType::Select { options } = &depth.field_type else {
            panic!("colorDepth must be a select");
        };
        let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
        assert_eq!(values, vec!["32", "16"]);
        // Every offered value negotiates exactly that depth.
        for opt in options {
            let cfg = VncConfig {
                color_depth: opt.value.clone(),
                ..Default::default()
            };
            assert_eq!(cfg.color_depth_bpp().to_string(), opt.value);
            assert_eq!(cfg.pixel_format().bits_per_pixel.to_string(), opt.value);
        }
    }

    #[test]
    fn color_depth_defaults_to_32_bit_and_tolerates_legacy_values() {
        assert_eq!(VncConfig::default().color_depth_bpp(), 32);
        // A config saved before #3464 has no colorDepth at all.
        let legacy: VncConfig = serde_json::from_value(serde_json::json!({"host": "h"})).unwrap();
        assert_eq!(legacy.color_depth_bpp(), 32);
        let pf = legacy.pixel_format();
        assert_eq!(pf.bits_per_pixel, 32);
        assert_eq!((pf.red_shift, pf.green_shift, pf.blue_shift), (0, 8, 16));
        // Values from the former shared select (#3460) fall back to 32-bit.
        for stale in ["24", "8", "", "bogus"] {
            let cfg: VncConfig =
                serde_json::from_value(serde_json::json!({"host": "h", "colorDepth": stale}))
                    .unwrap();
            assert_eq!(cfg.color_depth_bpp(), 32, "{stale:?}");
        }
        let high: VncConfig =
            serde_json::from_value(serde_json::json!({"host": "h", "colorDepth": "16"})).unwrap();
        let pf = high.pixel_format();
        assert_eq!(pf.bits_per_pixel, 16);
        assert_eq!((pf.red_max, pf.green_max, pf.blue_max), (31, 63, 31));
    }

    #[test]
    fn quality_defaults_to_lossless_and_maps_presets_to_tight_levels() {
        assert_eq!(VncConfig::default().tight_levels(), None);
        let legacy: VncConfig = serde_json::from_value(serde_json::json!({"host": "h"})).unwrap();
        assert_eq!(legacy.quality, QUALITY_LOSSLESS);
        assert_eq!(legacy.tight_levels(), None);
        let mk = |q: &str| VncConfig {
            quality: q.to_string(),
            ..Default::default()
        };
        assert_eq!(mk("high").tight_levels(), Some((8, 1)));
        assert_eq!(mk("medium").tight_levels(), Some((5, 5)));
        assert_eq!(mk("low").tight_levels(), Some((2, 9)));
        assert_eq!(mk("bogus").tight_levels(), None);
        assert_eq!(mk("").tight_levels(), None);
    }

    #[test]
    fn schema_exposes_quality_select_in_vnc_options() {
        let schema = vnc_settings_schema();
        let group = schema.groups.iter().find(|g| g.key == "vnc").unwrap();
        let keys: Vec<&str> = group.fields.iter().map(|f| f.key.as_str()).collect();
        let enc = keys.iter().position(|k| *k == "preferredEncoding").unwrap();
        assert_eq!(keys.get(enc + 1), Some(&"quality"));
        let quality = group.fields.iter().find(|f| f.key == "quality").unwrap();
        assert_eq!(quality.default, Some(serde_json::json!("lossless")));
        let FieldType::Select { options } = &quality.field_type else {
            panic!("quality must be a select");
        };
        let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
        assert_eq!(values, vec!["lossless", "high", "medium", "low"]);
        for opt in options {
            let cfg = VncConfig {
                quality: opt.value.clone(),
                ..Default::default()
            };
            assert_eq!(cfg.tight_levels().is_none(), opt.value == "lossless");
        }
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

//! The shared **SSH Tunnel** settings group of the graphical connection types
//! (VNC #1681, RDP #4865).
//!
//! A graphical connection can reach its server through an SSH local forward —
//! what `ssh -L` does — instead of a direct TCP connect. Both VNC and RDP offer
//! the same group with the same keys, so the editor rows, the parsed settings
//! and the [`SshConfig`] they produce live here once. The tunnel itself (the
//! authenticated SSH session plus the loopback forwarder) is
//! `backends::ssh_tunnel`, compiled only with the `ssh` feature; this module
//! carries no SSH dependency, so the RDP sidecar's slim core build can still
//! render the schema.
//!
//! The SSH hop itself can go through an outbound SOCKS or HTTP proxy (#4887):
//! the group's proxy rows use [`SSH_TUNNEL_PROXY_KEYS`] (`sshProxyType`, …)
//! and become [`SshConfig::proxy`], which the SSH dial honours.
//!
//! Secrets: [`SshTunnelSettings::ssh_password`] and the proxy password
//! (`sshProxyPassword`) are `Password` fields, so the editor keeps them in the
//! credential store (schema field secrets, #4289) and fills them in only at
//! connect time. `Debug` redacts both.

use serde::{Deserialize, Deserializer};

use crate::config::{SshConfig, SshProxyConfig};
use crate::connection::proxy_settings::{
    parse_proxy_with_keys, proxy_fields, SSH_TUNNEL_PROXY_KEYS,
};
use crate::connection::schema::{
    Condition, FieldType, FilePathKind, SelectOption, SettingsField, SettingsGroup,
};

/// The settings group key of the SSH Tunnel group.
pub const SSH_TUNNEL_GROUP_KEY: &str = "sshTunnel";

/// The boolean settings key that turns the tunnel on.
pub const USE_SSH_TUNNEL_KEY: &str = "useSshTunnel";

/// Default SSH gateway port.
pub const DEFAULT_SSH_TUNNEL_PORT: u16 = 22;

/// The outbound proxy of an SSH tunnel's SSH hop (#4887), parsed from the
/// group's [`SSH_TUNNEL_PROXY_KEYS`] rows; `None` for a direct connection.
///
/// Its `Deserialize` reads the whole settings object, so a config struct
/// takes it with `#[serde(flatten)]` next to its other fields. `Debug` redacts
/// the password (see [`SshProxyConfig`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SshTunnelProxy(pub Option<SshProxyConfig>);

impl<'de> Deserialize<'de> for SshTunnelProxy {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let settings = serde_json::Value::deserialize(deserializer)?;
        Ok(Self(parse_proxy_with_keys(
            &settings,
            &SSH_TUNNEL_PROXY_KEYS,
        )))
    }
}

/// The SSH Tunnel settings of a graphical connection.
///
/// Parsed from the same settings object as the protocol config; unknown keys
/// are ignored, so it reads only its own rows.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SshTunnelSettings {
    /// Connect through an SSH tunnel when `true`.
    pub use_ssh_tunnel: bool,
    /// SSH gateway host.
    pub ssh_host: String,
    /// SSH gateway port.
    pub ssh_port: u16,
    /// SSH gateway username.
    pub ssh_username: String,
    /// SSH gateway authentication method: `"password"`, `"key"`, or `"agent"`.
    /// Empty is treated as `"password"` (connections saved before key/agent
    /// auth existed).
    pub ssh_auth_method: String,
    /// Private key file when the auth method is `"key"`.
    pub ssh_key_path: Option<String>,
    /// SSH gateway password; doubles as the key passphrase for `"key"`, ignored
    /// for `"agent"`.
    pub ssh_password: String,
    /// Outbound proxy for the SSH hop (#4887).
    #[serde(flatten)]
    pub ssh_proxy: SshTunnelProxy,
}

impl Default for SshTunnelSettings {
    fn default() -> Self {
        Self {
            use_ssh_tunnel: false,
            ssh_host: String::new(),
            ssh_port: DEFAULT_SSH_TUNNEL_PORT,
            ssh_username: String::new(),
            ssh_auth_method: "password".to_string(),
            ssh_key_path: None,
            ssh_password: String::new(),
            ssh_proxy: SshTunnelProxy::default(),
        }
    }
}

impl std::fmt::Debug for SshTunnelSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshTunnelSettings")
            .field("use_ssh_tunnel", &self.use_ssh_tunnel)
            .field("ssh_host", &self.ssh_host)
            .field("ssh_port", &self.ssh_port)
            .field("ssh_username", &self.ssh_username)
            .field("ssh_auth_method", &self.ssh_auth_method)
            .field("ssh_key_path", &self.ssh_key_path)
            .field(
                "ssh_password",
                &if self.ssh_password.is_empty() {
                    ""
                } else {
                    "<redacted>"
                },
            )
            .field("ssh_proxy", &self.ssh_proxy)
            .finish()
    }
}

impl SshTunnelSettings {
    /// Parse the tunnel rows from a connection's settings, treating an explicit
    /// `null` member like a missing one (#4017).
    pub fn from_settings(settings: &serde_json::Value) -> Result<Self, serde_json::Error> {
        serde_json::from_value(crate::backends::without_null_fields(settings.clone()))
    }

    /// The effective auth method, defaulting to `"password"` when unset.
    pub fn auth_method(&self) -> &str {
        if self.ssh_auth_method.trim().is_empty() {
            "password"
        } else {
            self.ssh_auth_method.as_str()
        }
    }

    /// Build the [`SshConfig`] for the gateway, reusing the SSH backend's own
    /// auth machinery: `"password"`, `"key"` (key path plus an optional
    /// passphrase in the password), or `"agent"`. Empty password / key-path
    /// values map to `None` so an unencrypted key is not mistaken for a
    /// passphrase-protected one. The proxy rows become [`SshConfig::proxy`].
    pub fn ssh_config(&self) -> SshConfig {
        let password = (!self.ssh_password.is_empty()).then(|| self.ssh_password.clone());
        let key_path = self.ssh_key_path.clone().filter(|p| !p.trim().is_empty());
        SshConfig {
            host: self.ssh_host.clone(),
            port: self.ssh_port,
            username: self.ssh_username.clone(),
            auth_method: self.auth_method().to_string(),
            password,
            key_path,
            proxy: self.ssh_proxy.0.clone(),
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

fn when_equals(key: &str, value: serde_json::Value) -> Option<Condition> {
    Some(Condition {
        field: key.to_string(),
        equals: value,
        ..Default::default()
    })
}

fn opt(value: &str, label: &str) -> SelectOption {
    SelectOption {
        value: value.to_string(),
        label: label.to_string(),
    }
}

/// The **SSH Tunnel** settings group. `server_kind` names the server in the
/// toggle's description ("VNC", "RDP").
///
/// The rows after the toggle show only with the tunnel on; the key path only
/// with key auth (the auth-method select is itself tunnel-gated). The proxy
/// rows (#4887) follow the password: the type select with the tunnel on, the
/// rest only with a proxy chosen as well.
pub fn ssh_tunnel_group(server_kind: &str) -> SettingsGroup {
    let tunnel_on = || when_equals(USE_SSH_TUNNEL_KEY, serde_json::json!(true));
    let mut fields = vec![
        SettingsField {
            default: Some(serde_json::json!(false)),
            description: Some(format!(
                "Reach the {server_kind} server through an SSH tunnel (SSH local forward)."
            )),
            ..field(USE_SSH_TUNNEL_KEY, "Use SSH Tunnel", FieldType::Boolean)
        },
        SettingsField {
            required: true,
            supports_env_expansion: true,
            placeholder: Some("bastion.example.com".to_string()),
            visible_when: tunnel_on(),
            ..field("sshHost", "SSH Host", FieldType::Text)
        },
        SettingsField {
            default: Some(serde_json::json!(DEFAULT_SSH_TUNNEL_PORT)),
            visible_when: tunnel_on(),
            ..field("sshPort", "SSH Port", FieldType::Port)
        },
        SettingsField {
            supports_env_expansion: true,
            visible_when: tunnel_on(),
            ..field("sshUsername", "SSH Username", FieldType::Text)
        },
        SettingsField {
            default: Some(serde_json::json!("password")),
            description: Some(
                "How to authenticate to the SSH gateway: a password, a private \
                     key file, or the local ssh-agent."
                    .to_string(),
            ),
            visible_when: tunnel_on(),
            ..field(
                "sshAuthMethod",
                "SSH Auth Method",
                FieldType::Select {
                    options: vec![
                        opt("password", "Password"),
                        opt("key", "Key File"),
                        opt("agent", "SSH Agent"),
                    ],
                },
            )
        },
        SettingsField {
            supports_tilde_expansion: true,
            supports_env_expansion: true,
            placeholder: Some("~/.ssh/id_ed25519".to_string()),
            description: Some("Private key used to authenticate the SSH tunnel.".to_string()),
            visible_when: when_equals("sshAuthMethod", serde_json::json!("key")),
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
                "SSH gateway password, or the passphrase for the selected key file.".to_string(),
            ),
            visible_when: tunnel_on(),
            ..field("sshPassword", "SSH Password", FieldType::Password)
        },
    ];
    fields.extend(proxy_fields(
        &SSH_TUNNEL_PROXY_KEYS,
        tunnel_on(),
        concat!(
            "Reach the SSH host through a SOCKS or HTTP proxy, like OpenSSH's ",
            "`ProxyCommand nc -X`. Only the SSH connection goes through the proxy; ",
            "the SSH host's key is still checked against the SSH host. HTTP ",
            "proxies must allow `CONNECT` to the SSH port. SOCKS4 has no password ",
            "support.",
        ),
    ));
    SettingsGroup {
        collapsed: false,
        key: SSH_TUNNEL_GROUP_KEY.to_string(),
        label: "SSH Tunnel".to_string(),
        fields,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_off_port_22_password_auth() {
        let s = SshTunnelSettings::default();
        assert!(!s.use_ssh_tunnel);
        assert_eq!(s.ssh_port, 22);
        assert_eq!(s.auth_method(), "password");
    }

    #[test]
    fn from_settings_reads_only_the_tunnel_rows_and_tolerates_nulls() {
        let s = SshTunnelSettings::from_settings(&serde_json::json!({
            "host": "desk", "port": 3389, "domain": "CORP",
            "useSshTunnel": true, "sshHost": "bastion", "sshPort": 2222,
            "sshUsername": "arne", "sshAuthMethod": null, "sshKeyPath": null,
            "sshPassword": null,
        }))
        .unwrap();
        assert!(s.use_ssh_tunnel);
        assert_eq!(s.ssh_host, "bastion");
        assert_eq!(s.ssh_port, 2222);
        assert_eq!(s.ssh_username, "arne");
        assert_eq!(s.auth_method(), "password");
        assert_eq!(s.ssh_key_path, None);
        assert_eq!(s.ssh_password, "");
    }

    #[test]
    fn ssh_config_maps_empty_secrets_to_none_and_blank_method_to_password() {
        let s = SshTunnelSettings {
            use_ssh_tunnel: true,
            ssh_host: "gw".to_string(),
            ssh_username: "u".to_string(),
            ssh_auth_method: "  ".to_string(),
            ssh_key_path: Some("  ".to_string()),
            ..SshTunnelSettings::default()
        };
        let c = s.ssh_config();
        assert_eq!(c.host, "gw");
        assert_eq!(c.port, 22);
        assert_eq!(c.auth_method, "password");
        assert_eq!(c.password, None);
        assert_eq!(c.key_path, None);
    }

    #[test]
    fn ssh_config_carries_key_and_passphrase() {
        let s = SshTunnelSettings {
            ssh_auth_method: "key".to_string(),
            ssh_key_path: Some("~/.ssh/id".to_string()),
            ssh_password: "pp".to_string(),
            ..SshTunnelSettings::default()
        };
        let c = s.ssh_config();
        assert_eq!(c.auth_method, "key");
        assert_eq!(c.key_path.as_deref(), Some("~/.ssh/id"));
        assert_eq!(c.password.as_deref(), Some("pp"));
    }

    #[test]
    fn debug_redacts_the_password() {
        let s = SshTunnelSettings {
            ssh_password: "hunter2".to_string(),
            ..SshTunnelSettings::default()
        };
        let printed = format!("{s:?}");
        assert!(!printed.contains("hunter2"), "{printed}");
        assert!(printed.contains("<redacted>"));
    }

    #[test]
    fn group_has_the_tunnel_and_proxy_rows_gated_on_the_toggle() {
        let g = ssh_tunnel_group("RDP");
        assert_eq!(g.key, SSH_TUNNEL_GROUP_KEY);
        let keys: Vec<&str> = g.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(
            keys,
            [
                "useSshTunnel",
                "sshHost",
                "sshPort",
                "sshUsername",
                "sshAuthMethod",
                "sshKeyPath",
                "sshPassword",
                "sshProxyType",
                "sshProxyHost",
                "sshProxyPort",
                "sshProxyUsername",
                "sshProxyPassword",
            ]
        );
        assert!(g.fields[0]
            .description
            .as_deref()
            .unwrap()
            .contains("RDP server"));
        assert!(g.fields[0].visible_when.is_none());
        for f in &g.fields[1..7] {
            let cond = f.visible_when.as_ref().expect("gated");
            assert!(
                cond.field == "useSshTunnel" || cond.field == "sshAuthMethod",
                "{}",
                f.key
            );
        }
        assert!(matches!(g.fields[6].field_type, FieldType::Password));
        assert!(matches!(g.fields[11].field_type, FieldType::Password));
        // Both secrets are schema secrets (credential store, #4289).
        let secrets: Vec<&str> = g
            .fields
            .iter()
            .filter(|f| crate::connection::secrets::is_secret_field(f))
            .map(|f| f.key.as_str())
            .collect();
        assert_eq!(secrets, ["sshPassword", "sshProxyPassword"]);
    }

    /// The visible rows of the group for `settings`.
    fn visible(settings: serde_json::Value) -> Vec<String> {
        use crate::connection::schema_defaults::is_field_visible;
        let settings = settings.as_object().expect("object").clone();
        ssh_tunnel_group("VNC")
            .fields
            .iter()
            .filter(|f| is_field_visible(f, &settings))
            .map(|f| f.key.clone())
            .collect()
    }

    #[test]
    fn proxy_rows_need_the_tunnel_on_and_a_proxy_chosen() {
        // Tunnel off: a chosen proxy shows nothing but the toggle.
        assert_eq!(
            visible(serde_json::json!({ "useSshTunnel": false, "sshProxyType": "socks5" })),
            ["useSshTunnel"]
        );
        let tunnel = [
            "useSshTunnel",
            "sshHost",
            "sshPort",
            "sshUsername",
            "sshAuthMethod",
            "sshPassword",
        ];
        let on = |proxy: &str| {
            visible(serde_json::json!({
                "useSshTunnel": true, "sshAuthMethod": "password", "sshProxyType": proxy,
            }))
        };
        let with = |extra: &[&str]| {
            tunnel
                .iter()
                .chain(extra)
                .map(|k| k.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(on("none"), with(&["sshProxyType"]));
        let all = [
            "sshProxyType",
            "sshProxyHost",
            "sshProxyPort",
            "sshProxyUsername",
            "sshProxyPassword",
        ];
        assert_eq!(on("socks5"), with(&all));
        assert_eq!(on("http"), with(&all));
        // SOCKS4 has no password support.
        assert_eq!(on("socks4"), with(&all[..4]));
    }

    #[test]
    fn from_settings_reads_the_proxy_rows() {
        let s = SshTunnelSettings::from_settings(&serde_json::json!({
            "useSshTunnel": true, "sshHost": "bastion",
            "sshProxyType": "socks5", "sshProxyHost": " proxy.corp ",
            "sshProxyPort": "1081", "sshProxyUsername": "alice",
            "sshProxyPassword": " pw ",
            // The SSH type's own proxy keys are not the tunnel's.
            "proxyType": "http", "proxyHost": "other",
        }))
        .unwrap();
        let proxy = s.ssh_proxy.0.clone().expect("proxy");
        assert_eq!(proxy.proxy_type, crate::config::SshProxyType::Socks5);
        assert_eq!(proxy.host, "proxy.corp");
        assert_eq!(proxy.port, 1081);
        assert_eq!(proxy.username.as_deref(), Some("alice"));
        assert_eq!(proxy.password.as_deref(), Some(" pw "));
        assert_eq!(s.ssh_config().proxy, Some(proxy));
    }

    #[test]
    fn no_proxy_without_a_type_or_host() {
        for settings in [
            serde_json::json!({ "useSshTunnel": true }),
            serde_json::json!({ "sshProxyType": "none", "sshProxyHost": "p" }),
            serde_json::json!({ "sshProxyType": "http", "sshProxyHost": null }),
            serde_json::json!({ "proxyType": "socks5", "proxyHost": "p" }),
        ] {
            let s = SshTunnelSettings::from_settings(&settings).unwrap();
            assert_eq!(s.ssh_proxy, SshTunnelProxy(None), "{settings}");
            assert_eq!(s.ssh_config().proxy, None);
        }
    }

    #[test]
    fn debug_redacts_the_proxy_password() {
        let s = SshTunnelSettings::from_settings(&serde_json::json!({
            "sshProxyType": "http", "sshProxyHost": "p", "sshProxyPassword": "hunter2",
        }))
        .unwrap();
        let printed = format!("{s:?}");
        assert!(!printed.contains("hunter2"), "{printed}");
        assert!(printed.contains("<redacted>"), "{printed}");
    }
}

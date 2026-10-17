//! Settings schema and parsing for an outbound connection proxy (#4867).
//!
//! The form stores the proxy as flat settings keys — a type select
//! (`none` / `socks4` / `socks5` / `http`), a host, a port, a user and a secret
//! password, which as a [`FieldType::Password`] field is routed to the
//! credential store like every other schema secret (#4289).
//!
//! Two key sets use these rows:
//!
//! - [`SSH_PROXY_KEYS`] — the SSH connection type's own collapsed **Proxy**
//!   group (`proxyType`, `proxyHost`, …). The serialized
//!   [`SshConfig`](crate::config::SshConfig) shape (a nested `proxy` object) is
//!   accepted there too.
//! - [`SSH_TUNNEL_PROXY_KEYS`] — the proxy rows of the graphical types' shared
//!   **SSH Tunnel** group (`sshProxyType`, `sshProxyHost`, …, #4887), so a VNC
//!   or RDP connection's SSH hop can go through a proxy too.
//! - [`DIRECT_PROXY_KEYS`] — a direct (untunnelled) VNC connection's own
//!   collapsed **Proxy** group (#4897). The same keys as the SSH type's, shown
//!   only with the SSH tunnel off ([`direct_proxy_group`]).
//!
//! This module carries no SSH dependency (it lives outside the `ssh` feature),
//! so the RDP sidecar's slim core build can still render the tunnel group.

use crate::config::{SshProxyConfig, SshProxyType};
use crate::connection::{Condition, FieldType, SelectOption, SettingsField, SettingsGroup};

/// The settings keys of one set of proxy rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProxyKeys {
    /// The proxy type select (`none` / `socks4` / `socks5` / `http`).
    pub proxy_type: &'static str,
    /// The proxy host.
    pub host: &'static str,
    /// The proxy port.
    pub port: &'static str,
    /// The proxy user.
    pub username: &'static str,
    /// The proxy password (a secret).
    pub password: &'static str,
}

/// The SSH connection type's proxy keys (#4867).
pub const SSH_PROXY_KEYS: ProxyKeys = ProxyKeys {
    proxy_type: "proxyType",
    host: "proxyHost",
    port: "proxyPort",
    username: "proxyUsername",
    password: "proxyPassword",
};

/// The proxy keys of the graphical types' SSH Tunnel group (#4887). Distinct
/// from [`SSH_PROXY_KEYS`] so they never clash with a protocol's own settings.
pub const SSH_TUNNEL_PROXY_KEYS: ProxyKeys = ProxyKeys {
    proxy_type: "sshProxyType",
    host: "sshProxyHost",
    port: "sshProxyPort",
    username: "sshProxyUsername",
    password: "sshProxyPassword",
};

/// The proxy keys of a graphical connection's own **Proxy** group, used when
/// it dials its server directly (no SSH tunnel, #4897). The same keys as the
/// SSH type's [`SSH_PROXY_KEYS`] for consistency; a graphical type has no SSH
/// proxy rows of its own, so they never clash.
pub const DIRECT_PROXY_KEYS: ProxyKeys = SSH_PROXY_KEYS;

/// Settings key of the SSH proxy type select.
pub const PROXY_TYPE_KEY: &str = SSH_PROXY_KEYS.proxy_type;
/// Settings key of the SSH proxy host.
pub const PROXY_HOST_KEY: &str = SSH_PROXY_KEYS.host;
/// Settings key of the SSH proxy port.
pub const PROXY_PORT_KEY: &str = SSH_PROXY_KEYS.port;
/// Settings key of the SSH proxy user.
pub const PROXY_USERNAME_KEY: &str = SSH_PROXY_KEYS.username;
/// Settings key of the SSH proxy password (a secret).
pub const PROXY_PASSWORD_KEY: &str = SSH_PROXY_KEYS.password;

fn text(settings: &serde_json::Value, key: &str) -> Option<String> {
    settings
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Parse the SSH connection's proxy from its settings ([`SSH_PROXY_KEYS`]);
/// `None` for no proxy (type unset, `none` or unknown) or a proxy without a
/// host. Without a flat proxy type, the serialized nested `proxy` object is
/// read instead.
pub fn parse_proxy_settings(settings: &serde_json::Value) -> Option<SshProxyConfig> {
    if text(settings, SSH_PROXY_KEYS.proxy_type)
        .as_deref()
        .and_then(SshProxyType::from_setting)
        .is_some()
    {
        return parse_proxy_with_keys(settings, &SSH_PROXY_KEYS);
    }
    // The serialized `SshConfig` shape nests the proxy as an object.
    settings
        .get("proxy")
        .filter(|v| v.is_object())
        .and_then(|v| serde_json::from_value::<SshProxyConfig>(v.clone()).ok())
        .filter(|p| !p.host.trim().is_empty())
}

/// Parse a proxy from the flat rows named by `keys`; `None` for no proxy (type
/// unset, `none` or unknown) or a proxy without a host. A missing, empty or
/// zero port falls back to the type's usual port.
pub fn parse_proxy_with_keys(
    settings: &serde_json::Value,
    keys: &ProxyKeys,
) -> Option<SshProxyConfig> {
    let proxy_type = text(settings, keys.proxy_type)
        .as_deref()
        .and_then(SshProxyType::from_setting)?;
    let host = text(settings, keys.host)?;
    let port = settings
        .get(keys.port)
        .and_then(|v| {
            v.as_u64()
                .and_then(|n| u16::try_from(n).ok())
                .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u16>().ok()))
        })
        .filter(|p| *p != 0)
        .unwrap_or_else(|| proxy_type.default_port());
    // The password is a secret: taken verbatim (no trimming), never logged.
    let password = settings
        .get(keys.password)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Some(SshProxyConfig {
        proxy_type,
        host,
        port,
        username: text(settings, keys.username),
        password,
    })
}

/// A direct graphical connection's outbound proxy (#4897), parsed from the
/// [`DIRECT_PROXY_KEYS`] rows; `None` for a direct connection. Only the flat
/// rows are read, never the SSH type's nested serialized `proxy` object.
///
/// Its `Deserialize` reads the whole settings object, so a config struct takes
/// it with `#[serde(flatten)]` next to its other fields. `Debug` redacts the
/// password (see [`SshProxyConfig`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DirectProxy(pub Option<SshProxyConfig>);

impl<'de> serde::Deserialize<'de> for DirectProxy {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let settings = serde_json::Value::deserialize(deserializer)?;
        Ok(Self(parse_proxy_with_keys(&settings, &DIRECT_PROXY_KEYS)))
    }
}

fn field(key: &str, label: &str, description: &str, field_type: FieldType) -> SettingsField {
    SettingsField {
        key: key.to_string(),
        label: label.to_string(),
        description: Some(description.to_string()),
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

/// `field` does not equal `value` (a negated test, #4888).
fn not_equal(field: &str, value: &str) -> Condition {
    Condition {
        field: field.to_string(),
        equals: serde_json::json!(value),
        negate: true,
        ..Default::default()
    }
}

/// Visible when the proxy type is set to a proxy, i.e. not `none` (#4888),
/// and `gate` holds.
fn when_proxy_chosen(keys: &ProxyKeys, gate: Option<&Condition>) -> Condition {
    Condition {
        all_of: gate.into_iter().cloned().collect(),
        ..not_equal(keys.proxy_type, "none")
    }
}

/// Visible when the proxy type is a proxy that takes a password: not `none`
/// and not SOCKS4, which has no password support (#4888), and `gate` holds.
fn when_proxy_takes_password(keys: &ProxyKeys, gate: Option<&Condition>) -> Condition {
    let mut cond = when_proxy_chosen(keys, gate);
    cond.all_of.push(not_equal(keys.proxy_type, "socks4"));
    cond
}

/// The five proxy rows for `keys`: type, host, port, user and password.
///
/// `gate` is an extra condition every row needs (the SSH Tunnel toggle for the
/// tunnel rows); the type select shows whenever it holds, the rest only with a
/// proxy chosen, and the password not for SOCKS4. `type_help` is the type
/// select's help text.
pub fn proxy_fields(
    keys: &ProxyKeys,
    gate: Option<Condition>,
    type_help: &str,
) -> Vec<SettingsField> {
    let option = |value: &str, label: &str| SelectOption {
        value: value.to_string(),
        label: label.to_string(),
    };
    let chosen = || Some(when_proxy_chosen(keys, gate.as_ref()));
    vec![
        SettingsField {
            help_text: Some(type_help.to_string()),
            default: Some(serde_json::json!("none")),
            visible_when: gate.clone(),
            ..field(
                keys.proxy_type,
                "Proxy Type",
                "Proxy the SSH connection is made through",
                FieldType::Select {
                    options: vec![
                        option("none", "None (direct)"),
                        option("socks5", "SOCKS5"),
                        option("socks4", "SOCKS4 / SOCKS4a"),
                        option("http", "HTTP (CONNECT)"),
                    ],
                },
            )
        },
        SettingsField {
            placeholder: Some("proxy.example.com".to_string()),
            supports_env_expansion: true,
            visible_when: chosen(),
            ..field(
                keys.host,
                "Proxy Host",
                "Hostname or IP address of the proxy",
                FieldType::Text,
            )
        },
        SettingsField {
            placeholder: Some("1080".to_string()),
            visible_when: chosen(),
            help_text: Some(
                "Leave empty for the usual port: 1080 for SOCKS, 8080 for HTTP.".to_string(),
            ),
            ..field(
                keys.port,
                "Proxy Port",
                "Port of the proxy",
                FieldType::Port,
            )
        },
        SettingsField {
            supports_env_expansion: true,
            visible_when: chosen(),
            ..field(
                keys.username,
                "Proxy User",
                "User name for the proxy, if it requires one",
                FieldType::Text,
            )
        },
        SettingsField {
            help_text: Some(
                concat!(
                    "Stored in termiHub's credential store, never in the ",
                    "connection file. Used for SOCKS5 and HTTP proxies.",
                )
                .to_string(),
            ),
            visible_when: Some(when_proxy_takes_password(keys, gate.as_ref())),
            ..field(
                keys.password,
                "Proxy Password",
                "Password for the proxy user",
                FieldType::Password,
            )
        },
    ]
}

/// The collapsed **Proxy** settings group of the SSH schema.
pub fn proxy_settings_group() -> SettingsGroup {
    SettingsGroup {
        // Rarely needed (corporate networks), so collapsed like Advanced.
        collapsed: true,
        key: "proxy".to_string(),
        label: "Proxy".to_string(),
        fields: proxy_fields(
            &SSH_PROXY_KEYS,
            None,
            concat!(
                "Connect through a SOCKS or HTTP proxy, like OpenSSH's ",
                "`ProxyCommand nc -X`. The proxy only forwards the connection: ",
                "the server's host key is still checked against the SSH host, ",
                "not the proxy.\n\n",
                "With jump hosts set, only the connection to the first jump ",
                "host goes through the proxy. HTTP proxies must allow ",
                "`CONNECT` to the SSH port. SOCKS4 has no password support.",
            ),
        ),
    }
}

/// The collapsed **Proxy** group of a graphical connection that dials its
/// server directly (VNC, #4897). `server_kind` names the server ("VNC").
///
/// Every row needs the SSH tunnel off (`useSshTunnel` not `true`): with the
/// tunnel on, the server is reached through the tunnel and only the SSH Tunnel
/// group's own proxy rows (`sshProxy*`) apply, to the SSH hop.
pub fn direct_proxy_group(server_kind: &str) -> SettingsGroup {
    let tunnel_off = Condition {
        field: crate::connection::graphical_ssh_tunnel::USE_SSH_TUNNEL_KEY.to_string(),
        equals: serde_json::json!(true),
        negate: true,
        ..Default::default()
    };
    let help = format!(
        "Connect to the {server_kind} server through a SOCKS or HTTP proxy, like \
         OpenSSH's `ProxyCommand nc -X`. Used only without an SSH tunnel; with the \
         tunnel on, set the SSH Tunnel's own proxy instead. HTTP proxies must allow \
         `CONNECT` to the {server_kind} port. SOCKS4 has no password support."
    );
    let mut fields = proxy_fields(&DIRECT_PROXY_KEYS, Some(tunnel_off), &help);
    if let Some(type_field) = fields.first_mut() {
        type_field.description = Some(format!(
            "Proxy the connection to the {server_kind} server is made through"
        ));
    }
    SettingsGroup {
        collapsed: true,
        key: "proxy".to_string(),
        label: "Proxy".to_string(),
        fields,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn no_proxy_by_default_and_for_none() {
        assert!(parse_proxy_settings(&json!({})).is_none());
        assert!(parse_proxy_settings(&json!({"proxyType": "none", "proxyHost": "p"})).is_none());
        assert!(parse_proxy_settings(&json!({"proxyType": "bogus", "proxyHost": "p"})).is_none());
        // A proxy type without a host is no proxy.
        assert!(parse_proxy_settings(&json!({"proxyType": "socks5"})).is_none());
    }

    #[test]
    fn parses_flat_keys() {
        let p = parse_proxy_settings(&json!({
            "proxyType": "http",
            "proxyHost": " proxy.example.com ",
            "proxyPort": "3128",
            "proxyUsername": "alice",
            "proxyPassword": " spaced pw ",
        }))
        .expect("proxy");
        assert_eq!(p.proxy_type, SshProxyType::Http);
        assert_eq!(p.host, "proxy.example.com");
        assert_eq!(p.port, 3128);
        assert_eq!(p.username.as_deref(), Some("alice"));
        // The secret is kept verbatim.
        assert_eq!(p.password.as_deref(), Some(" spaced pw "));
    }

    #[test]
    fn missing_port_falls_back_to_the_type_default() {
        let socks = parse_proxy_settings(&json!({"proxyType": "socks4", "proxyHost": "p"}));
        assert_eq!(socks.map(|p| p.port), Some(1080));
        let http = parse_proxy_settings(&json!({
            "proxyType": "http", "proxyHost": "p", "proxyPort": ""
        }));
        assert_eq!(http.map(|p| p.port), Some(8080));
    }

    #[test]
    fn accepts_the_serialized_nested_shape() {
        let p = parse_proxy_settings(&json!({
            "proxy": {"type": "socks5", "host": "p", "port": 9050}
        }))
        .expect("proxy");
        assert_eq!(p.proxy_type, SshProxyType::Socks5);
        assert_eq!(p.port, 9050);
    }

    #[test]
    fn schema_group_declares_the_password_as_a_secret() {
        let group = proxy_settings_group();
        assert!(group.collapsed);
        let keys: Vec<&str> = group.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(
            keys,
            [
                PROXY_TYPE_KEY,
                PROXY_HOST_KEY,
                PROXY_PORT_KEY,
                PROXY_USERNAME_KEY,
                PROXY_PASSWORD_KEY
            ]
        );
        let password = group.fields.last().expect("password field");
        assert!(crate::connection::secrets::is_secret_field(password));
        assert!(!password.required);
    }

    #[test]
    fn proxy_rows_show_only_for_a_chosen_proxy() {
        use crate::connection::schema_defaults::is_field_visible;
        let group = proxy_settings_group();
        let visible = |proxy_type: &str| -> Vec<&str> {
            let settings = json!({ "proxyType": proxy_type });
            let settings = settings.as_object().expect("object");
            group
                .fields
                .iter()
                .filter(|f| is_field_visible(f, settings))
                .map(|f| f.key.as_str())
                .collect()
        };
        assert_eq!(visible("none"), [PROXY_TYPE_KEY]);
        let all = [
            PROXY_TYPE_KEY,
            PROXY_HOST_KEY,
            PROXY_PORT_KEY,
            PROXY_USERNAME_KEY,
            PROXY_PASSWORD_KEY,
        ];
        assert_eq!(visible("socks5"), all);
        assert_eq!(visible("http"), all);
        // SOCKS4 has no password support.
        assert_eq!(visible("socks4"), &all[..4]);
    }

    #[test]
    fn tunnel_keys_parse_only_their_own_rows() {
        let settings = json!({
            "proxyType": "http", "proxyHost": "ssh-proxy",
            "proxy": {"type": "socks5", "host": "nested", "port": 9050},
            "sshProxyType": "socks4", "sshProxyHost": "tunnel-proxy",
            "sshProxyUsername": "bob",
        });
        let p = parse_proxy_with_keys(&settings, &SSH_TUNNEL_PROXY_KEYS).expect("proxy");
        assert_eq!(p.proxy_type, SshProxyType::Socks4);
        assert_eq!(p.host, "tunnel-proxy");
        assert_eq!(p.port, 1080);
        assert_eq!(p.username.as_deref(), Some("bob"));
        assert_eq!(p.password, None);
        // The tunnel keys never read the nested serialized shape.
        let nested_only = json!({"proxy": {"type": "socks5", "host": "n", "port": 1}});
        assert!(parse_proxy_with_keys(&nested_only, &SSH_TUNNEL_PROXY_KEYS).is_none());
        // And the SSH parser ignores the tunnel rows.
        assert_eq!(
            parse_proxy_settings(&settings).map(|p| p.host),
            Some("ssh-proxy".to_string())
        );
    }

    #[test]
    fn gated_rows_need_the_gate() {
        use crate::connection::schema_defaults::is_field_visible;
        let gate = Condition {
            field: "on".to_string(),
            equals: json!(true),
            ..Default::default()
        };
        let fields = proxy_fields(&SSH_TUNNEL_PROXY_KEYS, Some(gate), "help");
        let visible = |settings: serde_json::Value| -> usize {
            let settings = settings.as_object().expect("object").clone();
            fields
                .iter()
                .filter(|f| is_field_visible(f, &settings))
                .count()
        };
        assert_eq!(visible(json!({"on": false, "sshProxyType": "http"})), 0);
        assert_eq!(visible(json!({"on": true, "sshProxyType": "none"})), 1);
        assert_eq!(visible(json!({"on": true, "sshProxyType": "http"})), 5);
        assert_eq!(visible(json!({"on": true, "sshProxyType": "socks4"})), 4);
        assert!(crate::connection::secrets::is_secret_field(&fields[4]));
        assert_eq!(fields[4].key, "sshProxyPassword");
    }
}

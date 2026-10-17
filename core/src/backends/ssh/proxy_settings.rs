//! Settings schema and parsing for an SSH connection's outbound proxy (#4867).
//!
//! The form stores the proxy as flat settings keys — `proxyType`
//! (`none` / `socks4` / `socks5` / `http`), `proxyHost`, `proxyPort`,
//! `proxyUsername` and the secret `proxyPassword`, which as a
//! [`FieldType::Password`] field is routed to the credential store like every
//! other schema secret (#4289). The serialized [`SshConfig`](crate::config::SshConfig)
//! shape (a nested `proxy` object) is accepted too.

use crate::config::{SshProxyConfig, SshProxyType};
use crate::connection::{FieldType, SelectOption, SettingsField, SettingsGroup};

/// Settings key of the proxy type select.
pub const PROXY_TYPE_KEY: &str = "proxyType";
/// Settings key of the proxy host.
pub const PROXY_HOST_KEY: &str = "proxyHost";
/// Settings key of the proxy port.
pub const PROXY_PORT_KEY: &str = "proxyPort";
/// Settings key of the proxy user.
pub const PROXY_USERNAME_KEY: &str = "proxyUsername";
/// Settings key of the proxy password (a secret).
pub const PROXY_PASSWORD_KEY: &str = "proxyPassword";

/// Parse the proxy from connection settings; `None` for no proxy (type unset,
/// `none` or unknown) or a proxy without a host.
pub fn parse_proxy_settings(settings: &serde_json::Value) -> Option<SshProxyConfig> {
    let text = |key: &str| -> Option<String> {
        settings
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let Some(proxy_type) = text(PROXY_TYPE_KEY)
        .as_deref()
        .and_then(SshProxyType::from_setting)
    else {
        // The serialized `SshConfig` shape nests the proxy as an object.
        return settings
            .get("proxy")
            .filter(|v| v.is_object())
            .and_then(|v| serde_json::from_value::<SshProxyConfig>(v.clone()).ok())
            .filter(|p| !p.host.trim().is_empty());
    };
    let host = text(PROXY_HOST_KEY)?;
    let port = settings
        .get(PROXY_PORT_KEY)
        .and_then(|v| {
            v.as_u64()
                .and_then(|n| u16::try_from(n).ok())
                .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u16>().ok()))
        })
        .filter(|p| *p != 0)
        .unwrap_or_else(|| proxy_type.default_port());
    // The password is a secret: taken verbatim (no trimming), never logged.
    let password = settings
        .get(PROXY_PASSWORD_KEY)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Some(SshProxyConfig {
        proxy_type,
        host,
        port,
        username: text(PROXY_USERNAME_KEY),
        password,
    })
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

/// The collapsed **Proxy** settings group of the SSH schema.
pub fn proxy_settings_group() -> SettingsGroup {
    let option = |value: &str, label: &str| SelectOption {
        value: value.to_string(),
        label: label.to_string(),
    };
    SettingsGroup {
        // Rarely needed (corporate networks), so collapsed like Advanced.
        collapsed: true,
        key: "proxy".to_string(),
        label: "Proxy".to_string(),
        fields: vec![
            SettingsField {
                help_text: Some(
                    concat!(
                        "Connect through a SOCKS or HTTP proxy, like OpenSSH's ",
                        "`ProxyCommand nc -X`. The proxy only forwards the connection: ",
                        "the server's host key is still checked against the SSH host, ",
                        "not the proxy.\n\n",
                        "With jump hosts set, only the connection to the first jump ",
                        "host goes through the proxy. HTTP proxies must allow ",
                        "`CONNECT` to the SSH port. SOCKS4 has no password support.",
                    )
                    .to_string(),
                ),
                default: Some(serde_json::json!("none")),
                ..field(
                    PROXY_TYPE_KEY,
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
                ..field(
                    PROXY_HOST_KEY,
                    "Proxy Host",
                    "Hostname or IP address of the proxy",
                    FieldType::Text,
                )
            },
            SettingsField {
                placeholder: Some("1080".to_string()),
                help_text: Some(
                    "Leave empty for the usual port: 1080 for SOCKS, 8080 for HTTP.".to_string(),
                ),
                ..field(
                    PROXY_PORT_KEY,
                    "Proxy Port",
                    "Port of the proxy",
                    FieldType::Port,
                )
            },
            SettingsField {
                supports_env_expansion: true,
                ..field(
                    PROXY_USERNAME_KEY,
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
                ..field(
                    PROXY_PASSWORD_KEY,
                    "Proxy Password",
                    "Password for the proxy user",
                    FieldType::Password,
                )
            },
        ],
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
}

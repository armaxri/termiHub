//! Settings schema for the telnet connection type (rendered by `DynamicForm`).

use crate::connection::{
    Condition, FieldType, SelectOption, SettingsField, SettingsGroup, SettingsSchema,
};

use super::auto_login::{
    DEFAULT_AUTO_LOGIN_TIMEOUT_SECS, DEFAULT_LOGIN_PROMPT, DEFAULT_PASSWORD_PROMPT,
};
use super::negotiation::{InputMode, DEFAULT_TERMINAL_TYPE};
use super::AUTH_METHOD_AUTO_LOGIN;

/// Help text shown on the auto-login fields: telnet is unencrypted.
const CLEARTEXT_WARNING: &str = "Warning: telnet is unencrypted. The username and password are \
     sent in cleartext and can be read by anyone on the network path. Only use auto-login on \
     trusted networks, and prefer SSH where the device supports it.";

/// A field with every optional property unset.
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

/// Visible only when auto-login is selected.
fn when_auto_login() -> Option<Condition> {
    Some(Condition {
        field: "authMethod".to_string(),
        equals: serde_json::json!(AUTH_METHOD_AUTO_LOGIN),
    })
}

/// The telnet settings schema: connection, terminal type, and optional
/// auto-login.
pub(super) fn settings_schema() -> SettingsSchema {
    SettingsSchema {
        groups: vec![connection_group(), login_group()],
    }
}

fn connection_group() -> SettingsGroup {
    SettingsGroup {
        collapsed: false,
        key: "telnet".to_string(),
        label: "Telnet".to_string(),
        fields: vec![
            SettingsField {
                description: Some("Hostname or IP address of the telnet server".to_string()),
                required: true,
                placeholder: Some("192.168.1.1".to_string()),
                supports_env_expansion: true,
                ..field("host", "Host", FieldType::Text)
            },
            SettingsField {
                description: Some("TCP port number".to_string()),
                required: true,
                default: Some(serde_json::json!(23)),
                ..field("port", "Port", FieldType::Port)
            },
            SettingsField {
                description: Some(
                    "Seconds to wait for the TCP connection before giving up".to_string(),
                ),
                help_text: Some(
                    "Bounds how long a connection to an unreachable host blocks before \
                     failing. Leave empty to use the default (10 s)."
                        .to_string(),
                ),
                placeholder: Some("10".to_string()),
                ..field(
                    "connectTimeoutSecs",
                    "Connect Timeout (s)",
                    FieldType::Number {
                        min: Some(1.0),
                        max: Some(300.0),
                    },
                )
            },
            SettingsField {
                description: Some("Terminal type reported to the server".to_string()),
                help_text: Some(format!(
                    "Sent when the server asks for the terminal type (TERMINAL-TYPE, \
                     RFC 1091); it usually becomes TERM on the remote side. Use \"vt100\" \
                     for older devices that do not know \"{DEFAULT_TERMINAL_TYPE}\"."
                )),
                default: Some(serde_json::json!(DEFAULT_TERMINAL_TYPE)),
                placeholder: Some(DEFAULT_TERMINAL_TYPE.to_string()),
                ..field("terminalType", "Terminal Type", FieldType::Text)
            },
            input_mode_field(),
        ],
    }
}

fn input_mode_field() -> SettingsField {
    SettingsField {
        description: Some("How typed input is echoed and sent".to_string()),
        help_text: Some(
            "Character: every keystroke is sent immediately and the server echoes it \
             (accepts the server's ECHO and SUPPRESS-GO-AHEAD options). Right for \
             almost every server and network device.\n\nLine: termiHub echoes and \
             edits the line locally (Backspace, Ctrl+U) and sends it on Enter. Use \
             this for line-oriented devices that never echo. While the server echoes \
             (for example at a password prompt) keystrokes are passed straight \
             through."
                .to_string(),
        ),
        default: Some(serde_json::json!(InputMode::CHARACTER)),
        ..field(
            "inputMode",
            "Input Mode",
            FieldType::Select {
                options: vec![
                    SelectOption {
                        value: InputMode::CHARACTER.to_string(),
                        label: "Character (server echo)".to_string(),
                    },
                    SelectOption {
                        value: InputMode::LINE.to_string(),
                        label: "Line (local echo & editing)".to_string(),
                    },
                ],
            },
        )
    }
}

fn login_group() -> SettingsGroup {
    SettingsGroup {
        collapsed: false,
        key: "login".to_string(),
        label: "Login".to_string(),
        fields: vec![
            SettingsField {
                description: Some("How to log in after connecting".to_string()),
                help_text: Some(format!(
                    "Manual: type your credentials in the terminal.\n\nAuto-login: termiHub \
                     types the username and password for you when the login and password \
                     prompts appear. If a prompt does not appear in time, auto-login stops \
                     and the session stays interactive.\n\n{CLEARTEXT_WARNING}"
                )),
                default: Some(serde_json::json!("none")),
                ..field(
                    "authMethod",
                    "Login",
                    FieldType::Select {
                        options: vec![
                            SelectOption {
                                value: "none".to_string(),
                                label: "Manual".to_string(),
                            },
                            SelectOption {
                                value: AUTH_METHOD_AUTO_LOGIN.to_string(),
                                label: "Auto-login (username & password)".to_string(),
                            },
                        ],
                    },
                )
            },
            SettingsField {
                description: Some("Sent at the login prompt".to_string()),
                help_text: Some(format!(
                    "Leave empty for devices that only ask for a password.\n\n\
                     {CLEARTEXT_WARNING}"
                )),
                supports_env_expansion: true,
                visible_when: when_auto_login(),
                ..field("username", "Username", FieldType::Text)
            },
            SettingsField {
                description: Some("Sent at the password prompt".to_string()),
                help_text: Some(format!(
                    "Stored in the credential store when \"Save password\" is on, never in \
                     the connection file. Leave empty to be asked when connecting.\n\n\
                     {CLEARTEXT_WARNING}"
                )),
                visible_when: when_auto_login(),
                ..field("password", "Password", FieldType::Password)
            },
            SettingsField {
                description: Some("Store the password in the credential store".to_string()),
                help_text: Some(
                    "When enabled, termiHub keeps the password in its credential store \
                     (keychain or master-password vault) so you are not asked on every \
                     connection. The password is never written to the connection file."
                        .to_string(),
                ),
                default: Some(serde_json::json!(false)),
                visible_when: when_auto_login(),
                ..field("savePassword", "Save password", FieldType::Boolean)
            },
            SettingsField {
                description: Some("Text that ends the login prompt".to_string()),
                help_text: Some(
                    "Case-insensitive; separate alternatives with |. Matched against the end \
                     of the server output."
                        .to_string(),
                ),
                default: Some(serde_json::json!(DEFAULT_LOGIN_PROMPT)),
                placeholder: Some(DEFAULT_LOGIN_PROMPT.to_string()),
                visible_when: when_auto_login(),
                ..field("loginPrompt", "Login Prompt", FieldType::Text)
            },
            SettingsField {
                description: Some("Text that ends the password prompt".to_string()),
                help_text: Some(
                    "Case-insensitive; separate alternatives with |. Matched against the end \
                     of the server output."
                        .to_string(),
                ),
                default: Some(serde_json::json!(DEFAULT_PASSWORD_PROMPT)),
                placeholder: Some(DEFAULT_PASSWORD_PROMPT.to_string()),
                visible_when: when_auto_login(),
                ..field("passwordPrompt", "Password Prompt", FieldType::Text)
            },
            SettingsField {
                description: Some("Seconds to wait for each prompt".to_string()),
                help_text: Some(format!(
                    "If the expected prompt does not appear within this time, auto-login \
                     stops and the session stays interactive. Leave empty to use the \
                     default ({DEFAULT_AUTO_LOGIN_TIMEOUT_SECS} s)."
                )),
                placeholder: Some(DEFAULT_AUTO_LOGIN_TIMEOUT_SECS.to_string()),
                visible_when: when_auto_login(),
                ..field(
                    "autoLoginTimeoutSecs",
                    "Prompt Timeout (s)",
                    FieldType::Number {
                        min: Some(1.0),
                        max: Some(300.0),
                    },
                )
            },
        ],
    }
}

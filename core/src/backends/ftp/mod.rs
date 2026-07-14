//! FTP / FTPS backend implementing [`ConnectionType`](crate::connection::ConnectionType).
//!
//! Wraps the [`suppaftp`](https://crates.io/crates/suppaftp) async client
//! (rustls TLS via `futures-rustls`, aligning with termiHub's rustls stack).
//! This is the connect-only skeleton: it establishes the control connection,
//! negotiates TLS (explicit / implicit), authenticates (user/pass or
//! anonymous), selects the data-channel mode and transfer type, and changes to
//! the initial directory. File listing and transfers are layered on later
//! (see the FTP client concept); `write`/`resize` are no-ops because FTP has no
//! terminal channel.

mod file_browser;
mod listing_parser;
mod transfer;

pub use transfer::{
    probe_remote_size, run_attempt, AttemptOutcome, FtpDirection, StopReason, FTP_CHUNK_SIZE,
};

use std::sync::Arc;

use file_browser::FtpFileBrowser;

use futures_rustls::rustls::crypto::aws_lc_rs;
use futures_rustls::rustls::{ClientConfig, RootCertStore};
use futures_rustls::TlsConnector;
use suppaftp::types::{FileType, FormatControl};
use suppaftp::{AsyncRustlsConnector, AsyncRustlsFtpStream, FtpError, Mode};
use tracing::{debug, info};

use crate::config::{FtpConfig, FtpDataMode, FtpTlsMode, FtpTransferType};
use crate::connection::{
    Capabilities, Condition, ConnectionType, FieldType, NoticeSeverity, OutputReceiver,
    SelectOption, SettingsField, SettingsGroup, SettingsSchema,
};
use crate::errors::SessionError;
use crate::files::FileBrowser;
use crate::monitoring::MonitoringProvider;

/// Password sent for anonymous logins (a conventional email-style placeholder).
const ANONYMOUS_PASSWORD: &str = "anonymous@termihub";

/// FTP / FTPS backend, implementing [`ConnectionType`].
///
/// # Lifecycle
///
/// 1. Create with [`Ftp::new()`] (disconnected state).
/// 2. Call [`connect()`](ConnectionType::connect) with settings JSON.
/// 3. Call [`disconnect()`](ConnectionType::disconnect) to send `QUIT` and
///    close the control connection.
pub struct Ftp {
    /// Active control connection; `None` when disconnected.
    client: Option<AsyncRustlsFtpStream>,
    /// File browser bound to this connection; created on connect. It runs its
    /// own control connection (opened lazily) so it can offer the `&self`-based
    /// [`FileBrowser`] API independently of this session's mutable stream.
    browser: Option<FtpFileBrowser>,
}

impl Ftp {
    /// Create a new disconnected `Ftp` instance.
    pub fn new() -> Self {
        Self {
            client: None,
            browser: None,
        }
    }
}

impl Default for Ftp {
    fn default() -> Self {
        Self::new()
    }
}

/// Map a [`suppaftp`] protocol error to a [`SessionError`].
fn map_ftp_err(err: FtpError) -> SessionError {
    SessionError::SpawnFailed(format!("FTP error: {err}"))
}

/// Build a rustls-based TLS connector trusting the Mozilla root CA bundle.
///
/// An explicit crypto provider is passed to avoid an ambiguous-default panic
/// when both `ring` and `aws-lc-rs` are present in the dependency graph.
fn build_tls_connector() -> Result<AsyncRustlsConnector, SessionError> {
    let mut root_store = RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    let provider = Arc::new(aws_lc_rs::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| SessionError::SpawnFailed(format!("FTPS TLS config error: {e}")))?
        .with_root_certificates(root_store)
        .with_no_client_auth();

    Ok(AsyncRustlsConnector::from(TlsConnector::from(Arc::new(
        config,
    ))))
}

/// Establish the control connection: TCP → optional TLS → auth → mode →
/// transfer type → initial `CWD`.
async fn establish(config: &FtpConfig) -> Result<AsyncRustlsFtpStream, SessionError> {
    let addr = format!("{}:{}", config.host, config.port);

    // TCP connect + optional TLS negotiation.
    let mut stream = match config.tls_mode {
        FtpTlsMode::Implicit => {
            let connector = build_tls_connector()?;
            AsyncRustlsFtpStream::connect_secure_implicit(&addr, connector, &config.host)
                .await
                .map_err(map_ftp_err)?
        }
        FtpTlsMode::Explicit => {
            let connector = build_tls_connector()?;
            let plain = AsyncRustlsFtpStream::connect(&addr)
                .await
                .map_err(map_ftp_err)?;
            plain
                .into_secure(connector, &config.host)
                .await
                .map_err(map_ftp_err)?
        }
        FtpTlsMode::None => AsyncRustlsFtpStream::connect(&addr)
            .await
            .map_err(map_ftp_err)?,
    };

    // Data-channel mode (passive/active).
    stream.set_mode(match config.mode {
        FtpDataMode::Passive => Mode::Passive,
        FtpDataMode::Active => Mode::Active,
    });

    // Authenticate.
    if config.anonymous {
        stream
            .login("anonymous", ANONYMOUS_PASSWORD)
            .await
            .map_err(map_ftp_err)?;
    } else {
        let password = config.password.clone().unwrap_or_default();
        stream
            .login(config.username.as_str(), password.as_str())
            .await
            .map_err(map_ftp_err)?;
    }

    // Transfer representation type.
    let file_type = match config.transfer_type {
        FtpTransferType::Binary => FileType::Binary,
        FtpTransferType::Ascii => FileType::Ascii(FormatControl::Default),
    };
    stream.transfer_type(file_type).await.map_err(map_ftp_err)?;

    // Change to the initial directory, if configured.
    if let Some(dir) = &config.initial_directory {
        if !dir.is_empty() {
            stream.cwd(dir).await.map_err(map_ftp_err)?;
        }
    }

    Ok(stream)
}

/// Base [`SettingsField`] with all optional metadata cleared; callers override
/// the fields they care about via struct-update syntax.
fn base_field(key: &str, label: &str, field_type: FieldType) -> SettingsField {
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

/// Convenience constructor for a [`SelectOption`].
fn opt(value: &str, label: &str) -> SelectOption {
    SelectOption {
        value: value.to_string(),
        label: label.to_string(),
    }
}

/// Server group: host + control port.
fn server_group() -> SettingsGroup {
    SettingsGroup {
        key: "server".to_string(),
        label: "Server".to_string(),
        fields: vec![
            SettingsField {
                required: true,
                placeholder: Some("ftp.example.com".to_string()),
                supports_env_expansion: true,
                description: Some("Hostname or IP address of the FTP server".to_string()),
                ..base_field("host", "Host", FieldType::Text)
            },
            SettingsField {
                required: true,
                default: Some(serde_json::json!(21)),
                description: Some("Control-channel port (990 for implicit FTPS)".to_string()),
                ..base_field("port", "Port", FieldType::Port)
            },
        ],
    }
}

/// Security group: TLS mode + an insecure-FTP warning shown only for plain FTP.
fn security_group() -> SettingsGroup {
    SettingsGroup {
        key: "security".to_string(),
        label: "Security".to_string(),
        fields: vec![
            SettingsField {
                required: true,
                default: Some(serde_json::json!("none")),
                description: Some(
                    "Plain FTP sends credentials in cleartext — prefer FTPS when available"
                        .to_string(),
                ),
                ..base_field(
                    "tlsMode",
                    "TLS Mode",
                    FieldType::Select {
                        options: vec![
                            opt("none", "None (plain FTP)"),
                            opt("explicit", "Explicit (STARTTLS)"),
                            opt("implicit", "Implicit"),
                        ],
                    },
                )
            },
            // Display-only callout: only visible while TLS Mode is "none".
            SettingsField {
                description: Some(
                    "Plain FTP transmits credentials and data in cleartext. \
                     Use FTPS if the server supports it."
                        .to_string(),
                ),
                visible_when: Some(Condition {
                    field: "tlsMode".to_string(),
                    equals: serde_json::json!("none"),
                }),
                ..base_field(
                    "tlsWarning",
                    "",
                    FieldType::Notice {
                        severity: NoticeSeverity::Warning,
                    },
                )
            },
        ],
    }
}

/// Authentication group: anonymous toggle + conditional username/password.
fn authentication_group() -> SettingsGroup {
    let not_anonymous = Condition {
        field: "anonymous".to_string(),
        equals: serde_json::json!(false),
    };
    SettingsGroup {
        key: "authentication".to_string(),
        label: "Authentication".to_string(),
        fields: vec![
            SettingsField {
                default: Some(serde_json::json!(false)),
                description: Some("Log in as the anonymous user".to_string()),
                ..base_field("anonymous", "Use anonymous login", FieldType::Boolean)
            },
            SettingsField {
                supports_env_expansion: true,
                visible_when: Some(not_anonymous.clone()),
                ..base_field("username", "Username", FieldType::Text)
            },
            SettingsField {
                supports_env_expansion: true,
                visible_when: Some(not_anonymous),
                ..base_field("password", "Password", FieldType::Password)
            },
        ],
    }
}

/// Transfer group: data mode, transfer type, initial directory, timeout.
fn transfer_group() -> SettingsGroup {
    SettingsGroup {
        key: "transfer".to_string(),
        label: "Transfer".to_string(),
        fields: vec![
            SettingsField {
                default: Some(serde_json::json!("passive")),
                ..base_field(
                    "mode",
                    "Mode",
                    FieldType::Select {
                        options: vec![opt("passive", "Passive"), opt("active", "Active")],
                    },
                )
            },
            SettingsField {
                default: Some(serde_json::json!("binary")),
                ..base_field(
                    "transferType",
                    "Transfer",
                    FieldType::Select {
                        options: vec![opt("binary", "Binary"), opt("ascii", "ASCII")],
                    },
                )
            },
            SettingsField {
                supports_env_expansion: true,
                placeholder: Some("/pub".to_string()),
                ..base_field("initialDirectory", "Initial Dir", FieldType::Text)
            },
            SettingsField {
                default: Some(serde_json::json!(30)),
                ..base_field(
                    "timeoutSecs",
                    "Timeout (s)",
                    FieldType::Number {
                        min: Some(1.0),
                        max: None,
                    },
                )
            },
        ],
    }
}

#[async_trait::async_trait]
impl ConnectionType for Ftp {
    fn type_id(&self) -> &str {
        "ftp"
    }

    fn display_name(&self) -> &str {
        "FTP"
    }

    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema {
            groups: vec![
                server_group(),
                security_group(),
                authentication_group(),
                transfer_group(),
            ],
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: false,
            file_browser: true,
            resize: false,
            persistent: false,
        }
    }

    async fn connect(&mut self, settings: serde_json::Value) -> Result<(), SessionError> {
        if self.client.is_some() {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        }

        let config: FtpConfig = serde_json::from_value(settings)
            .map_err(|e| SessionError::InvalidConfig(format!("Invalid FTP settings: {e}")))?;
        let config = config.expand();

        if config.host.is_empty() {
            return Err(SessionError::InvalidConfig(
                "Host must not be empty".to_string(),
            ));
        }
        if !config.anonymous && config.username.is_empty() {
            return Err(SessionError::InvalidConfig(
                "Username must not be empty for non-anonymous login".to_string(),
            ));
        }

        info!(
            host = %config.host,
            port = config.port,
            tls = ?config.tls_mode,
            "Connecting FTP session"
        );

        let stream = tokio::time::timeout(config.timeout(), establish(&config))
            .await
            .map_err(|_| {
                SessionError::SpawnFailed(format!(
                    "FTP connect timed out after {}s",
                    config.timeout_secs
                ))
            })??;

        self.client = Some(stream);
        self.browser = Some(FtpFileBrowser::new(config));
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        // Drop the browser (closing its own control connection, if opened).
        self.browser = None;
        if let Some(mut client) = self.client.take() {
            if let Err(e) = client.quit().await {
                debug!("FTP QUIT failed during disconnect: {e}");
            }
            debug!("FTP session disconnected");
        }
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.client.is_some()
    }

    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        // FTP has no terminal input channel; keystrokes are meaningless here.
        Ok(())
    }

    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        // FTP has no terminal to resize.
        Ok(())
    }

    fn subscribe_output(&self) -> OutputReceiver {
        // No terminal output stream — hand back an immediately-closed receiver.
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }

    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        self.browser.as_ref().map(|b| b as &dyn FileBrowser)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::validate_settings;

    #[test]
    fn type_id() {
        assert_eq!(Ftp::new().type_id(), "ftp");
    }

    #[test]
    fn display_name() {
        assert_eq!(Ftp::new().display_name(), "FTP");
    }

    #[test]
    fn capabilities() {
        let caps = Ftp::new().capabilities();
        assert!(caps.file_browser);
        assert!(!caps.monitoring);
        assert!(!caps.resize);
        assert!(!caps.persistent);
    }

    #[test]
    fn not_connected_initially() {
        assert!(!Ftp::new().is_connected());
    }

    #[test]
    fn default_creates_disconnected() {
        assert!(!Ftp::default().is_connected());
    }

    #[test]
    fn schema_has_four_groups() {
        let schema = Ftp::new().settings_schema();
        let keys: Vec<&str> = schema.groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(
            keys,
            vec!["server", "security", "authentication", "transfer"]
        );
        let labels: Vec<&str> = schema.groups.iter().map(|g| g.label.as_str()).collect();
        assert_eq!(
            labels,
            vec!["Server", "Security", "Authentication", "Transfer"]
        );
    }

    /// Look up a field by key across all groups.
    fn find_field<'a>(schema: &'a SettingsSchema, key: &str) -> &'a SettingsField {
        schema
            .groups
            .iter()
            .flat_map(|g| g.fields.iter())
            .find(|f| f.key == key)
            .unwrap_or_else(|| panic!("field {key} not found"))
    }

    #[test]
    fn schema_port_defaults_to_21() {
        let schema = Ftp::new().settings_schema();
        let port = find_field(&schema, "port");
        assert!(matches!(port.field_type, FieldType::Port));
        assert_eq!(port.default, Some(serde_json::json!(21)));
    }

    #[test]
    fn schema_tls_mode_default_and_options() {
        let schema = Ftp::new().settings_schema();
        let tls = find_field(&schema, "tlsMode");
        assert_eq!(tls.default, Some(serde_json::json!("none")));
        match &tls.field_type {
            FieldType::Select { options } => {
                let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
                assert_eq!(values, vec!["none", "explicit", "implicit"]);
            }
            other => panic!("tlsMode should be a select, got {other:?}"),
        }
    }

    #[test]
    fn schema_has_tls_warning_notice_only_for_plain_ftp() {
        // The inline insecure-FTP warning is a display-only notice field that is
        // conditionally visible only while TLS Mode is "none". Assert against the
        // serialized schema so the test does not depend on the internal enum.
        let schema = Ftp::new().settings_schema();
        let field = find_field(&schema, "tlsWarning");
        assert!(
            matches!(field.field_type, FieldType::Notice { .. }),
            "tlsWarning should be a notice field"
        );
        let cond = field
            .visible_when
            .as_ref()
            .expect("tlsWarning should be conditionally visible");
        assert_eq!(cond.field, "tlsMode");
        assert_eq!(cond.equals, serde_json::json!("none"));
        // The warning message is carried in the field description.
        assert!(field
            .description
            .as_ref()
            .is_some_and(|d| d.to_lowercase().contains("cleartext")));
    }

    #[test]
    fn config_defaults_suppress_security_warning_to_false() {
        // Round-trips through JSON without referencing the field name directly,
        // so this test stays valid even as the struct evolves.
        let json = serde_json::to_value(FtpConfig::default()).unwrap();
        assert_eq!(json["suppressSecurityWarning"], serde_json::json!(false));
    }

    #[test]
    fn config_deserializes_suppress_security_warning() {
        let cfg: FtpConfig = serde_json::from_value(serde_json::json!({
            "host": "ftp.example.com",
            "suppressSecurityWarning": true,
        }))
        .unwrap();
        assert!(cfg.suppress_security_warning);
    }

    #[test]
    fn schema_username_password_hidden_when_anonymous() {
        let schema = Ftp::new().settings_schema();
        for key in ["username", "password"] {
            let field = find_field(&schema, key);
            let cond = field
                .visible_when
                .as_ref()
                .unwrap_or_else(|| panic!("{key} should be conditionally visible"));
            assert_eq!(cond.field, "anonymous");
            assert_eq!(cond.equals, serde_json::json!(false));
        }
    }

    #[test]
    fn schema_serializes_with_all_groups_and_conditions() {
        let schema = Ftp::new().settings_schema();
        let json = serde_json::to_value(&schema).unwrap();
        let groups = json["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 4);
        // Round-trips cleanly.
        let back: SettingsSchema = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(back.groups.len(), 4);
        // The conditional visibility survives serialization as `visibleWhen`.
        let serialized = serde_json::to_string(&schema).unwrap();
        assert!(serialized.contains("visibleWhen"));
        assert!(serialized.contains("\"anonymous\""));
    }

    #[test]
    fn schema_validates_required_host() {
        let schema = Ftp::new().settings_schema();
        let errors = validate_settings(&schema, &serde_json::json!({ "port": 21 }));
        assert!(errors.iter().any(|e| e.field == "host"));
    }

    #[tokio::test]
    async fn connect_empty_host_fails() {
        let mut ftp = Ftp::new();
        let result = ftp
            .connect(serde_json::json!({ "host": "", "username": "u" }))
            .await;
        assert!(matches!(result, Err(SessionError::InvalidConfig(_))));
    }

    #[tokio::test]
    async fn connect_missing_username_when_not_anonymous_fails() {
        let mut ftp = Ftp::new();
        let result = ftp
            .connect(serde_json::json!({ "host": "ftp.example.com", "anonymous": false }))
            .await;
        assert!(matches!(result, Err(SessionError::InvalidConfig(_))));
    }

    #[tokio::test]
    async fn disconnect_when_not_connected_is_noop() {
        let mut ftp = Ftp::new();
        ftp.disconnect().await.expect("disconnect should not fail");
    }

    #[test]
    fn write_and_resize_are_noops() {
        let ftp = Ftp::new();
        assert!(ftp.write(b"ignored").is_ok());
        assert!(ftp.resize(80, 24).is_ok());
    }

    #[test]
    fn file_browser_none_until_connected_then_some() {
        let mut ftp = Ftp::new();
        // No browser before connecting.
        assert!(ftp.file_browser().is_none());
        // Once a browser is bound (as `connect` does), it is exposed.
        ftp.browser = Some(FtpFileBrowser::new(FtpConfig::default()));
        assert!(ftp.file_browser().is_some());
    }
}

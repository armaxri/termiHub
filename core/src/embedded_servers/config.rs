use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::activity::ServerActivity;
use crate::service::ServiceStatus;

/// Protocol type for an embedded server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ServerType {
    Http,
    Ftp,
    Tftp,
}

/// Authentication configuration for FTP servers.
///
/// The `password` is only carried in memory and over IPC / the agent RPC: the
/// desktop keeps it in the credential store and never writes it to
/// `embedded_servers.json` (#3514). It is `#[serde(default)]` so a persisted
/// config — which omits it — still parses. `Debug` redacts it.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FtpAuth {
    Anonymous,
    Credentials {
        username: String,
        #[serde(default)]
        password: String,
    },
}

impl std::fmt::Debug for FtpAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FtpAuth::Anonymous => f.write_str("Anonymous"),
            FtpAuth::Credentials { username, password } => f
                .debug_struct("Credentials")
                .field("username", username)
                .field("password", &redacted(password))
                .finish(),
        }
    }
}

/// Placeholder printed instead of a secret by the redacting `Debug` impls.
fn redacted(secret: &str) -> &'static str {
    if secret.is_empty() {
        "<empty>"
    } else {
        "<redacted>"
    }
}

/// Optional HTTP Basic authentication credentials for an embedded HTTP server
/// (PROD-0035).
///
/// When present on an HTTP server's [`EmbeddedServerConfig`], the server
/// challenges every request with `401 Unauthorized` +
/// `WWW-Authenticate: Basic` until a matching `Authorization: Basic` header is
/// supplied. Absent (`http_auth: None`) the server serves unauthenticated,
/// exactly as before this field existed.
///
/// Like [`FtpAuth`], the `password` lives in the desktop's credential store and
/// is never persisted to `embedded_servers.json` (#3514); `Debug` redacts it.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HttpBasicAuth {
    pub username: String,
    #[serde(default)]
    pub password: String,
}

impl std::fmt::Debug for HttpBasicAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpBasicAuth")
            .field("username", &self.username)
            .field("password", &redacted(&self.password))
            .finish()
    }
}

/// Configuration for a single embedded server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedServerConfig {
    /// Unique server identifier.
    pub id: String,
    /// User-friendly name.
    pub name: String,
    /// Protocol type.
    pub server_type: ServerType,
    /// Root directory to serve files from.
    pub root_directory: String,
    /// Bind address (e.g. "127.0.0.1" or "0.0.0.0").
    pub bind_host: String,
    /// Port to listen on.
    pub port: u16,
    /// Start automatically when termiHub launches.
    #[serde(default)]
    pub auto_start: bool,
    /// Disable file uploads/writes.
    #[serde(default)]
    pub read_only: bool,
    /// Show directory listing (HTTP only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory_listing: Option<bool>,
    /// Authentication for FTP servers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ftp_auth: Option<FtpAuth>,
    /// Optional HTTP Basic authentication (HTTP only, PROD-0035).
    ///
    /// `None` (the default, and the shape of every config written before this
    /// field existed) serves the directory unauthenticated exactly as before;
    /// `Some(_)` protects it behind a Basic-auth challenge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_auth: Option<HttpBasicAuth>,
    /// Maximum size, in bytes, of a single file transfer.
    ///
    /// Currently enforced by the TFTP server (which is unauthenticated by
    /// design) to bound the memory/disk an anonymous client can consume in one
    /// transfer (CORE-021). `None` falls back to the server's built-in default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_transfer_bytes: Option<u64>,
}

/// Current status of an embedded server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ServerStatus {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

impl ServerStatus {
    /// Project a generic [`ServiceStatus`] lifecycle onto the embedded-server
    /// `(ServerStatus, error)` representation.
    ///
    /// The embedded servers live behind the core [`Service`] trait, whose
    /// lifecycle is [`ServiceStatus`], but the desktop→frontend projection (and
    /// the persisted [`ServerState`]) speak [`ServerStatus`] plus a separate
    /// `error` string. The two enums therefore model one lifecycle in two shapes
    /// and must keep their distinct serialized forms (agent RPC's adjacently
    /// tagged `{ "state": … }` vs the frontend's plain string). This is the
    /// single source of truth for the variant relationship between them, so it is
    /// no longer hand-maintained at each transition site (DUP-022):
    ///
    /// | [`ServiceStatus`]        | [`ServerStatus`] | `error`         |
    /// | ------------------------ | ---------------- | --------------- |
    /// | `Stopped`                | `Stopped`        | `None`          |
    /// | `Starting`               | `Starting`       | `None`          |
    /// | `Running`                | `Running`        | `None`          |
    /// | `Stopping`               | `Stopping`       | `None`          |
    /// | `Failed(reason)`         | `Error`          | `Some(reason)`  |
    ///
    /// [`Service`]: crate::service::Service
    /// [`ServerState`]: crate::embedded_servers::config::ServerState
    pub fn from_service_status(status: &ServiceStatus) -> (ServerStatus, Option<String>) {
        match status {
            ServiceStatus::Stopped => (ServerStatus::Stopped, None),
            ServiceStatus::Starting => (ServerStatus::Starting, None),
            ServiceStatus::Running => (ServerStatus::Running, None),
            ServiceStatus::Stopping => (ServerStatus::Stopping, None),
            ServiceStatus::Failed(reason) => (ServerStatus::Error, Some(reason.clone())),
        }
    }
}

/// Live traffic statistics for an active server.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerStats {
    pub active_connections: u64,
    pub total_connections: u64,
    pub bytes_sent: u64,
    pub bytes_received: u64,
}

/// Combined runtime state for a server (returned to the frontend).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerState {
    pub server_id: String,
    pub status: ServerStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub stats: ServerStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

/// `embedded_servers.json` schema version whose files may still carry
/// plaintext FTP / HTTP Basic passwords (before #3514).
pub const STORE_VERSION_LEGACY_PLAINTEXT: &str = "1";

/// Current `embedded_servers.json` schema version: passwords are kept in the
/// credential store and never written to the file (#3514).
pub const STORE_VERSION: &str = "2";

/// Top-level schema for the embedded_servers.json file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddedServerStore {
    pub version: String,
    pub servers: Vec<EmbeddedServerConfig>,
}

impl Default for EmbeddedServerStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION.to_string(),
            servers: Vec::new(),
        }
    }
}

/// Atomic counters shared between a running server and its manager entry.
#[derive(Debug)]
pub struct AtomicServerStats {
    pub active_connections: AtomicU64,
    pub total_connections: AtomicU64,
    pub bytes_sent: AtomicU64,
    pub bytes_received: AtomicU64,
    /// Per-request access log + detailed stats (PROD-034, PROD-036). Owned by
    /// the service across restarts; the counters above are per run.
    pub activity: Arc<ServerActivity>,
}

impl AtomicServerStats {
    /// Create a new zeroed stats instance (with a fresh activity log) wrapped
    /// in an Arc.
    pub fn new() -> Arc<Self> {
        Self::with_activity(ServerActivity::new())
    }

    /// Create zeroed per-run counters that record into an existing, longer-lived
    /// `activity` log (so the access log survives a stop/start).
    pub fn with_activity(activity: Arc<ServerActivity>) -> Arc<Self> {
        Arc::new(Self {
            active_connections: AtomicU64::new(0),
            total_connections: AtomicU64::new(0),
            bytes_sent: AtomicU64::new(0),
            bytes_received: AtomicU64::new(0),
            activity,
        })
    }

    /// Read the current values into a serialisable snapshot.
    pub fn snapshot(&self) -> ServerStats {
        ServerStats {
            active_connections: self.active_connections.load(Ordering::Relaxed),
            total_connections: self.total_connections.load(Ordering::Relaxed),
            bytes_sent: self.bytes_sent.load(Ordering::Relaxed),
            bytes_received: self.bytes_received.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_server_config_serde_round_trip() {
        let config = EmbeddedServerConfig {
            id: "srv-1".to_string(),
            name: "Test HTTP".to_string(),
            server_type: ServerType::Http,
            root_directory: "/tmp".to_string(),
            bind_host: "127.0.0.1".to_string(),
            port: 8080,
            auto_start: false,
            read_only: true,
            directory_listing: Some(true),
            ftp_auth: None,
            http_auth: None,
            max_transfer_bytes: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        let de: EmbeddedServerConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(de.id, "srv-1");
        assert_eq!(de.server_type, ServerType::Http);
        assert!(de.read_only);
        assert_eq!(de.directory_listing, Some(true));
        assert!(de.ftp_auth.is_none());
    }

    #[test]
    fn ftp_auth_anonymous_serde() {
        let auth = FtpAuth::Anonymous;
        let json = serde_json::to_string(&auth).unwrap();
        let de: FtpAuth = serde_json::from_str(&json).unwrap();
        assert_eq!(de, FtpAuth::Anonymous);
    }

    #[test]
    fn ftp_auth_credentials_serde() {
        let auth = FtpAuth::Credentials {
            username: "admin".to_string(),
            password: "secret".to_string(),
        };
        let json = serde_json::to_string(&auth).unwrap();
        let de: FtpAuth = serde_json::from_str(&json).unwrap();
        assert_eq!(de, auth);
    }

    #[test]
    fn server_store_default_is_empty() {
        let store = EmbeddedServerStore::default();
        assert_eq!(store.version, STORE_VERSION);
        assert!(store.servers.is_empty());
    }

    /// A persisted (#3514) config omits the password; it must still parse, with
    /// an empty password the desktop fills from the credential store.
    #[test]
    fn auth_without_password_field_parses_as_empty() {
        let ftp: FtpAuth =
            serde_json::from_str(r#"{"type":"credentials","username":"admin"}"#).unwrap();
        assert_eq!(
            ftp,
            FtpAuth::Credentials {
                username: "admin".to_string(),
                password: String::new(),
            }
        );
        let http: HttpBasicAuth = serde_json::from_str(r#"{"username":"u"}"#).unwrap();
        assert_eq!(http.password, "");
    }

    /// `Debug` must never print a password (it reaches tracing via `?config`).
    #[test]
    fn debug_redacts_passwords() {
        let ftp = FtpAuth::Credentials {
            username: "admin".to_string(),
            password: "hunter2".to_string(),
        };
        let http = HttpBasicAuth {
            username: "u".to_string(),
            password: "s3cret".to_string(),
        };
        let out = format!("{ftp:?} {http:?}");
        assert!(!out.contains("hunter2") && !out.contains("s3cret"), "{out}");
        assert!(out.contains("admin") && out.contains("<redacted>"), "{out}");
    }

    #[test]
    fn server_status_wire_form_is_plain_camel_case_strings() {
        // The frontend/persisted projection is a plain string, distinct from the
        // agent-RPC ServiceStatus adjacently-tagged object. Lock every variant.
        for (status, wire) in [
            (ServerStatus::Stopped, "\"stopped\""),
            (ServerStatus::Starting, "\"starting\""),
            (ServerStatus::Running, "\"running\""),
            (ServerStatus::Stopping, "\"stopping\""),
            (ServerStatus::Error, "\"error\""),
        ] {
            assert_eq!(serde_json::to_string(&status).unwrap(), wire);
            let back: ServerStatus = serde_json::from_str(wire).unwrap();
            assert_eq!(back, status);
        }
    }

    #[test]
    fn from_service_status_covers_every_variant() {
        assert_eq!(
            ServerStatus::from_service_status(&ServiceStatus::Stopped),
            (ServerStatus::Stopped, None)
        );
        assert_eq!(
            ServerStatus::from_service_status(&ServiceStatus::Starting),
            (ServerStatus::Starting, None)
        );
        assert_eq!(
            ServerStatus::from_service_status(&ServiceStatus::Running),
            (ServerStatus::Running, None)
        );
        assert_eq!(
            ServerStatus::from_service_status(&ServiceStatus::Stopping),
            (ServerStatus::Stopping, None)
        );
        assert_eq!(
            ServerStatus::from_service_status(&ServiceStatus::Failed("boom".to_string())),
            (ServerStatus::Error, Some("boom".to_string()))
        );
    }

    #[test]
    fn atomic_stats_snapshot() {
        let stats = AtomicServerStats::new();
        stats.total_connections.fetch_add(5, Ordering::Relaxed);
        stats.bytes_sent.fetch_add(1024, Ordering::Relaxed);
        let snap = stats.snapshot();
        assert_eq!(snap.total_connections, 5);
        assert_eq!(snap.bytes_sent, 1024);
    }
}

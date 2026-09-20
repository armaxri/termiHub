use termihub_core::errors::SessionError;
use thiserror::Error;

/// Locale-independent machine codes attached to serialized IPC error strings as
/// a `[thub-code:<code>] ` marker (see [`with_code`]), so the frontend
/// classifies connection/agent errors **structurally by code** rather than by
/// matching English message text — which is one localization or rewording away
/// from silently misclassifying (I18N-002 / ERR-003).
///
/// This is the single Rust-side source of truth for the slugs. The frontend no
/// longer hand-mirrors them: `classifyAgentError.ts` keys off the ts-rs-generated
/// [`IpcErrorCode`] union (and `AUTH_FAILED_CODE` in
/// `src/utils/backendErrorCode.ts` is typed against it), so a slug rename is a
/// frontend compile error rather than silent drift.
pub mod codes {
    /// SSH/agent authentication was genuinely rejected (wrong password /
    /// passphrase or a refused key).
    ///
    /// Unlike the other slugs, auth's marker is emitted through the thiserror
    /// `#[error("[thub-code:auth_failed] {0}")]` attribute on
    /// [`super::TerminalError::AuthFailed`] (a proc-macro attribute cannot
    /// reference a `const`). It is consumed by [`super::IpcErrorCode::from_slug`]
    /// when mapping a marker slug back to its code, and is verified to match the
    /// hard-coded attribute by the `auth_failed_code_matches_the_hardcoded_attribute`
    /// test.
    pub const AUTH_FAILED: &str = "auth_failed";
    /// The host could not be reached (TCP/DNS/transport failure).
    pub const UNREACHABLE: &str = "unreachable";
    /// SSH connected, but the `termihub-agent` binary could not be started on
    /// the remote host (missing/not-installed agent).
    pub const AGENT_MISSING: &str = "agent_missing";
    /// The remote agent binary is protocol-incompatible with this desktop.
    pub const AGENT_OUTDATED: &str = "agent_outdated";
    /// The agent is already connected.
    pub const ALREADY_CONNECTED: &str = "already_connected";
}

/// Prefix `message` with the locale-independent `[thub-code:<code>] ` marker so
/// the serialized error carries a machine-stable signal the frontend can parse.
///
/// Mirrors the wire format baked into [`TerminalError::AuthFailed`]'s
/// `#[error("[thub-code:auth_failed] {0}")]` attribute. The frontend strips the
/// marker before display, so it never leaks into user-visible text.
pub fn with_code(code: &str, message: impl std::fmt::Display) -> String {
    format!("[thub-code:{code}] {message}")
}

/// The literal that opens a `[thub-code:<slug>] ` machine marker in a message.
const MARKER_OPEN: &str = "[thub-code:";

/// Extract the machine-code slug from the first `[thub-code:<slug>]` marker in
/// `s`, if present. Used to route the constructor-tagged connect/agent codes
/// (which ride inside the message) to their [`IpcErrorCode`].
fn marker_slug(s: &str) -> Option<&str> {
    let start = s.find(MARKER_OPEN)?;
    let rest = &s[start + MARKER_OPEN.len()..];
    let end = rest.find(']')?;
    Some(&rest[..end])
}

/// Remove the first `[thub-code:<slug>]` marker (and one following whitespace)
/// from `s` and trim, mirroring the frontend `parseBackendError` marker removal
/// so the human message in the IPC envelope is what the frontend renders today.
fn strip_marker(s: &str) -> String {
    let Some(start) = s.find(MARKER_OPEN) else {
        return s.to_string();
    };
    let Some(close_rel) = s[start..].find(']') else {
        return s.to_string();
    };
    let mut end = start + close_rel + 1;
    if let Some(c) = s[end..].chars().next() {
        if c.is_whitespace() {
            end += c.len_utf8();
        }
    }
    format!("{}{}", &s[..start], &s[end..]).trim().to_string()
}

/// The stable, locale-independent machine code carried on the structured IPC
/// error envelope (`{ code, message, details }`) that [`TerminalError`]
/// serializes to (ARCH-006 / TAURI-008 / ERR-008).
///
/// Supersets the five pre-existing `[thub-code:*]` marker slugs (`auth_failed`,
/// `unreachable`, `agent_missing`, `agent_outdated`, `already_connected` — see
/// [`codes`]) with one slug per [`TerminalError`] variant category, so every one
/// of the ~144 `TerminalError`-returning commands now delivers a
/// machine-classifiable code rather than an opaque string. Exported to the
/// frontend as `src/types/generated/IpcErrorCode.ts`; the frontend classifier
/// (`classifyAgentError.ts` / `backendErrorCode.ts`) keys off these slugs, which
/// keeps the two type-checked against drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "snake_case")]
pub enum IpcErrorCode {
    // The five pre-existing marker slugs (their category is tagged inside the
    // message via [`with_code`] / the `AuthFailed` `#[error(...)]` attribute).
    AuthFailed,
    Unreachable,
    AgentMissing,
    AgentOutdated,
    AlreadyConnected,
    // One slug per remaining `TerminalError` variant category.
    SessionNotFound,
    SpawnFailed,
    WriteFailed,
    ResizeFailed,
    ConnectionFailed,
    SshError,
    SftpError,
    EditorError,
    RemoteError,
    Cancelled,
    SftpSessionNotFound,
    TunnelError,
    WorkspaceError,
    MacroError,
    SessionHistoryError,
    WorkflowError,
    NetworkError,
    NotFound,
    InternalError,
    EmbeddedServerError,
    Io,
}

impl IpcErrorCode {
    /// Map a `[thub-code:<slug>]` marker slug (the pre-existing wire codes) to its
    /// enum value, if it names one of the recognized marker categories.
    fn from_slug(slug: &str) -> Option<Self> {
        match slug {
            codes::AUTH_FAILED => Some(Self::AuthFailed),
            codes::UNREACHABLE => Some(Self::Unreachable),
            codes::AGENT_MISSING => Some(Self::AgentMissing),
            codes::AGENT_OUTDATED => Some(Self::AgentOutdated),
            codes::ALREADY_CONNECTED => Some(Self::AlreadyConnected),
            _ => None,
        }
    }
}

/// Errors that can occur in terminal operations.
#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Failed to spawn terminal: {0}")]
    SpawnFailed(String),

    /// Authentication was genuinely rejected (wrong password/passphrase or a
    /// refused key). Its `Display` (and therefore the serialized IPC string)
    /// carries the stable, locale-independent marker `[thub-code:auth_failed] `
    /// so the frontend can detect it structurally; the `{0}` payload remains the
    /// human message for display once the marker is stripped. The `auth_failed`
    /// code is mirrored on the frontend as `AUTH_FAILED_CODE` in
    /// `src/utils/backendErrorCode.ts` (I18N-001 / ERR-003).
    #[error("[thub-code:auth_failed] {0}")]
    AuthFailed(String),

    #[error("Failed to write to terminal: {0}")]
    WriteFailed(String),

    #[error("Failed to resize terminal: {0}")]
    ResizeFailed(String),

    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("SSH error: {0}")]
    SshError(String),

    #[error("SFTP error: {0}")]
    SftpError(String),

    #[error("Editor error: {0}")]
    EditorError(String),

    #[error("Remote agent error: {0}")]
    RemoteError(String),

    #[error("Operation cancelled")]
    Cancelled,

    #[error("SFTP session not found: {0}")]
    SftpSessionNotFound(String),

    #[error("Tunnel error: {0}")]
    TunnelError(String),

    #[error("Workspace error: {0}")]
    WorkspaceError(String),

    #[error("Macro error: {0}")]
    MacroError(String),

    #[error("Session history error: {0}")]
    SessionHistoryError(String),

    #[error("Workflow error: {0}")]
    WorkflowError(String),

    #[error("Network error: {0}")]
    NetworkError(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Internal error: {0}")]
    InternalError(String),

    #[error("Embedded server error: {0}")]
    EmbeddedServerError(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

impl TerminalError {
    /// A host-unreachable connection failure carrying the locale-independent
    /// [`codes::UNREACHABLE`] marker, so the frontend classifies it structurally
    /// rather than by matching the "Connection failed" text (I18N-002 / ERR-003).
    pub fn unreachable(message: impl std::fmt::Display) -> Self {
        TerminalError::ConnectionFailed(with_code(codes::UNREACHABLE, message))
    }

    /// A remote error meaning the `termihub-agent` binary could not be started
    /// on the host, carrying the [`codes::AGENT_MISSING`] marker.
    pub fn agent_missing(message: impl std::fmt::Display) -> Self {
        TerminalError::RemoteError(with_code(codes::AGENT_MISSING, message))
    }

    /// A remote error meaning the agent is protocol-incompatible with this
    /// desktop, carrying the [`codes::AGENT_OUTDATED`] marker.
    pub fn agent_outdated(message: impl std::fmt::Display) -> Self {
        TerminalError::RemoteError(with_code(codes::AGENT_OUTDATED, message))
    }

    /// A remote error meaning the agent is already connected, carrying the
    /// [`codes::ALREADY_CONNECTED`] marker.
    pub fn already_connected(message: impl std::fmt::Display) -> Self {
        TerminalError::RemoteError(with_code(codes::ALREADY_CONNECTED, message))
    }

    /// The stable, locale-independent machine [`IpcErrorCode`] for this error —
    /// the `code` field of the serialized IPC envelope. The connect/agent
    /// categories tagged inside the message marker (the pre-existing wire codes)
    /// are routed through [`marker_slug`]; every other variant maps directly to
    /// its category.
    pub fn code(&self) -> IpcErrorCode {
        use IpcErrorCode as C;
        match self {
            TerminalError::SessionNotFound(_) => C::SessionNotFound,
            TerminalError::SpawnFailed(_) => C::SpawnFailed,
            TerminalError::AuthFailed(_) => C::AuthFailed,
            TerminalError::WriteFailed(_) => C::WriteFailed,
            TerminalError::ResizeFailed(_) => C::ResizeFailed,
            TerminalError::ConnectionFailed(msg) => marker_slug(msg)
                .and_then(C::from_slug)
                .unwrap_or(C::ConnectionFailed),
            TerminalError::SshError(_) => C::SshError,
            TerminalError::SftpError(_) => C::SftpError,
            TerminalError::EditorError(_) => C::EditorError,
            TerminalError::RemoteError(msg) => marker_slug(msg)
                .and_then(C::from_slug)
                .unwrap_or(C::RemoteError),
            TerminalError::Cancelled => C::Cancelled,
            TerminalError::SftpSessionNotFound(_) => C::SftpSessionNotFound,
            TerminalError::TunnelError(_) => C::TunnelError,
            TerminalError::WorkspaceError(_) => C::WorkspaceError,
            TerminalError::MacroError(_) => C::MacroError,
            TerminalError::SessionHistoryError(_) => C::SessionHistoryError,
            TerminalError::WorkflowError(_) => C::WorkflowError,
            TerminalError::NetworkError(_) => C::NetworkError,
            TerminalError::NotFound(_) => C::NotFound,
            TerminalError::InternalError(_) => C::InternalError,
            TerminalError::EmbeddedServerError(_) => C::EmbeddedServerError,
            TerminalError::Io(_) => C::Io,
        }
    }

    /// The human-readable message for the IPC envelope: today's `Display` text
    /// with any `[thub-code:*]` marker removed, so frontend paths reading
    /// `.message` are byte-for-byte unaffected while the machine signal moves to
    /// the `code` field.
    fn display_message(&self) -> String {
        strip_marker(&self.to_string())
    }

    /// Map a core [`SessionError`] to a [`TerminalError`] for a **direct
    /// terminal connect**, preserving the typed [`SessionError::AuthFailed`] as
    /// [`TerminalError::AuthFailed`] and [`SessionError::ConnectionFailed`] as a
    /// coded [`TerminalError::unreachable`] so the machine-stable signals survive
    /// to the IPC boundary. Every other variant keeps its previous stringified
    /// `SpawnFailed` representation, so non-auth error text is unchanged.
    pub fn from_session_spawn(err: SessionError) -> Self {
        match err {
            SessionError::AuthFailed => TerminalError::AuthFailed(err_display(&err)),
            SessionError::ConnectionFailed(msg) => TerminalError::unreachable(msg),
            other => TerminalError::SpawnFailed(other.to_string()),
        }
    }

    /// Like [`from_session_spawn`](Self::from_session_spawn) but for the SSH/agent
    /// connect helper, whose non-auth fallback is `SshError` (preserving the
    /// existing `"SSH error: …"` prefix for every non-auth failure).
    pub fn from_session_ssh(err: SessionError) -> Self {
        match err {
            SessionError::AuthFailed => TerminalError::AuthFailed(err_display(&err)),
            SessionError::ConnectionFailed(msg) => TerminalError::unreachable(msg),
            other => TerminalError::SshError(other.to_string()),
        }
    }
}

/// The human-readable message for a core error, kept for the auth-failure arm
/// so the `{0}` payload of [`TerminalError::AuthFailed`] stays a real message.
fn err_display(err: &SessionError) -> String {
    err.to_string()
}

/// Preserve the exact embedded-server message text when the relocated core
/// service (#2192) surfaces an error to the desktop, so the frontend sees the
/// same string as before the relocation.
impl From<termihub_core::embedded_servers::service::EmbeddedServerError> for TerminalError {
    fn from(err: termihub_core::embedded_servers::service::EmbeddedServerError) -> Self {
        TerminalError::EmbeddedServerError(err.0)
    }
}

impl serde::Serialize for TerminalError {
    /// Serialize as the structured IPC error envelope `{ code, message, details }`
    /// (ARCH-006 / TAURI-008 / ERR-008), superseding the legacy flat string.
    ///
    /// - `code` is the stable, locale-independent machine slug ([`IpcErrorCode`]).
    /// - `message` is today's human `Display` text with any `[thub-code:*]` marker
    ///   stripped, so frontend paths reading `.message` are unaffected.
    /// - `details` is reserved for future structured payloads (currently `null`).
    ///
    /// The frontend `parseBackendError` shim reads both this object shape and the
    /// legacy string during the migration.
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut envelope = serializer.serialize_struct("TerminalError", 3)?;
        envelope.serialize_field("code", &self.code())?;
        envelope.serialize_field("message", &self.display_message())?;
        envelope.serialize_field("details", &Option::<()>::None)?;
        envelope.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Locale-independent code carried on an auth-failure IPC error. Must match
    /// the frontend `AUTH_FAILED_CODE` in `src/utils/backendErrorCode.ts`.
    const AUTH_FAILED_CODE: &str = "auth_failed";
    /// Wire prefix emitted before an auth-failure message. Must match the
    /// `#[error(...)]` attribute on [`TerminalError::AuthFailed`] and the
    /// frontend parser's regex.
    const AUTH_FAILED_MARKER: &str = "[thub-code:auth_failed] ";

    /// SFTP file-operation failures must surface with an `SFTP error:` prefix,
    /// not the misleading `SSH error:` prefix (issue #2094).
    #[test]
    fn sftp_error_renders_with_sftp_prefix() {
        let err = TerminalError::SftpError("readdir failed: no such file".to_string());
        let rendered = err.to_string();
        assert_eq!(rendered, "SFTP error: readdir failed: no such file");
        assert!(
            !rendered.starts_with("SSH error:"),
            "SFTP operation errors must not be labeled as SSH errors, got {rendered:?}"
        );
    }

    /// The distinct `SshError` variant keeps its own prefix for genuine
    /// SSH-session/transport failures.
    #[test]
    fn ssh_error_renders_with_ssh_prefix() {
        let err = TerminalError::SshError("exec channel failed".to_string());
        assert_eq!(err.to_string(), "SSH error: exec channel failed");
    }

    /// A genuine auth rejection maps to the typed `AuthFailed` variant on both
    /// connect chokepoints, and the serialized IPC string carries the stable,
    /// locale-independent `auth_failed` code so the frontend never has to parse
    /// the human message text (I18N-001).
    #[test]
    fn auth_failure_maps_to_typed_variant_and_carries_the_code() {
        for terminal_err in [
            TerminalError::from_session_spawn(SessionError::AuthFailed),
            TerminalError::from_session_ssh(SessionError::AuthFailed),
        ] {
            assert!(matches!(terminal_err, TerminalError::AuthFailed(_)));

            // Display == serialized IPC string (serialize is serialize_str of Display).
            let rendered = terminal_err.to_string();
            assert!(
                rendered.starts_with(AUTH_FAILED_MARKER),
                "auth-failure IPC string must carry the machine code marker, got {rendered:?}"
            );
            assert!(rendered.contains(AUTH_FAILED_CODE));
            // The human message survives after the marker for display.
            assert_eq!(
                rendered,
                format!("{AUTH_FAILED_MARKER}Authentication failed")
            );

            let json = serde_json::to_string(&terminal_err).expect("serialize");
            assert!(
                json.contains(AUTH_FAILED_CODE),
                "serialized error must carry the code, got {json}"
            );
        }
    }

    /// A transport/protocol failure that merely occurred during the auth
    /// exchange is NOT an auth rejection: it must stay non-`AuthFailed` and must
    /// NOT carry the code, so the destructive credential discard never fires for
    /// it (the inverse mis-fire I18N-001 warns about).
    #[test]
    fn non_auth_session_error_does_not_carry_the_code() {
        let spawn = TerminalError::from_session_spawn(SessionError::SpawnFailed(
            "Password auth failed: connection reset".to_string(),
        ));
        assert!(matches!(spawn, TerminalError::SpawnFailed(_)));
        assert!(!spawn.to_string().contains(AUTH_FAILED_CODE));

        let ssh = TerminalError::from_session_ssh(SessionError::SpawnFailed(
            "Connection failed: timed out".to_string(),
        ));
        assert!(matches!(ssh, TerminalError::SshError(_)));
        assert!(!ssh.to_string().contains(AUTH_FAILED_CODE));
    }

    /// Guards the `#[error(...)]` attribute against drifting away from the
    /// `AUTH_FAILED_MARKER` constant the frontend parser is written against.
    #[test]
    fn auth_failed_display_carries_the_marker() {
        let rendered = TerminalError::AuthFailed("x".to_string()).to_string();
        assert_eq!(rendered, format!("{AUTH_FAILED_MARKER}x"));
    }

    /// `with_code` emits the exact `[thub-code:<code>] <message>` wire format the
    /// frontend `parseBackendError` regex is written against.
    #[test]
    fn with_code_emits_the_wire_marker_format() {
        assert_eq!(
            with_code("unreachable", "boom"),
            "[thub-code:unreachable] boom"
        );
    }

    /// The `codes::AUTH_FAILED` slug must match the marker baked into the
    /// `TerminalError::AuthFailed` `#[error(...)]` attribute — the single Rust
    /// source of truth stays consistent with the hand-written attribute.
    #[test]
    fn auth_failed_code_matches_the_hardcoded_attribute() {
        assert_eq!(codes::AUTH_FAILED, AUTH_FAILED_CODE);
        assert_eq!(
            TerminalError::AuthFailed("x".to_string()).to_string(),
            format!("{}x", with_code(codes::AUTH_FAILED, ""))
        );
    }

    /// Every coded connection/agent-error constructor tags its serialized string
    /// with the matching locale-independent `[thub-code:<code>]` marker, so the
    /// frontend classifies the category structurally regardless of the message
    /// language (I18N-002 / ERR-003).
    #[test]
    fn coded_constructors_carry_their_markers() {
        let cases = [
            (
                TerminalError::unreachable("Connection refused"),
                codes::UNREACHABLE,
                "Connection refused",
            ),
            (
                TerminalError::agent_missing("Exec failed: no such file"),
                codes::AGENT_MISSING,
                "Exec failed: no such file",
            ),
            (
                TerminalError::agent_outdated("Initialize rejected: bad version"),
                codes::AGENT_OUTDATED,
                "Initialize rejected: bad version",
            ),
            (
                TerminalError::already_connected("Agent a1 is already connected"),
                codes::ALREADY_CONNECTED,
                "Agent a1 is already connected",
            ),
        ];
        for (err, code, human) in cases {
            let rendered = err.to_string();
            assert!(
                rendered.contains(&format!("[thub-code:{code}]")),
                "error must carry the {code} marker, got {rendered:?}"
            );
            // The human message survives alongside the marker for the fallback
            // substring path and for display once the marker is stripped.
            assert!(
                rendered.contains(human),
                "error must retain the human message, got {rendered:?}"
            );
            // The serialized envelope now carries the category in its `code`
            // field, and the machine marker is stripped from the human `message`.
            let json = serde_json::to_string(&err).expect("serialize");
            assert!(
                json.contains(&format!("\"code\":\"{code}\"")),
                "envelope must carry the {code} code, got {json}"
            );
            assert!(
                !json.contains("[thub-code:"),
                "the machine marker must be stripped from the serialized message, got {json}"
            );
        }
    }

    /// The structured IPC envelope carries the stable machine `code` slug and a
    /// marker-stripped human `message` for representative `TerminalError`
    /// variants (ARCH-006 / TAURI-008 / ERR-008), and reserves a null `details`.
    #[test]
    fn serializes_structured_envelope_with_code_and_stripped_message() {
        let cases = [
            (
                TerminalError::SessionNotFound("s1".to_string()),
                "session_not_found",
                "Session not found: s1",
            ),
            (
                TerminalError::SpawnFailed("boom".to_string()),
                "spawn_failed",
                "Failed to spawn terminal: boom",
            ),
            (
                TerminalError::AuthFailed("Authentication failed".to_string()),
                "auth_failed",
                "Authentication failed",
            ),
            (
                TerminalError::unreachable("Connection refused"),
                "unreachable",
                "Connection failed: Connection refused",
            ),
            (
                TerminalError::agent_missing("Exec failed"),
                "agent_missing",
                "Remote agent error: Exec failed",
            ),
            (
                TerminalError::NotFound("x".to_string()),
                "not_found",
                "Not found: x",
            ),
            (
                TerminalError::InternalError("oops".to_string()),
                "internal_error",
                "Internal error: oops",
            ),
        ];
        for (err, code, message) in cases {
            let value: serde_json::Value =
                serde_json::from_str(&serde_json::to_string(&err).expect("serialize"))
                    .expect("valid JSON object");
            assert_eq!(value["code"], code, "wrong code for {err:?}: {value}");
            assert_eq!(
                value["message"], message,
                "wrong message for {err:?}: {value}"
            );
            assert!(
                value["details"].is_null(),
                "details must be null, got {value}"
            );
            assert!(
                !value["message"]
                    .as_str()
                    .expect("message is a string")
                    .contains("[thub-code:"),
                "message must not contain the machine marker, got {value}"
            );
        }
    }

    /// `TerminalError::code()` routes the constructor-tagged agent markers to
    /// their [`IpcErrorCode`] and falls back to the generic category when a
    /// message carries no marker.
    #[test]
    fn code_routes_marker_variants_and_falls_back() {
        assert_eq!(
            TerminalError::agent_outdated("v").code(),
            IpcErrorCode::AgentOutdated
        );
        assert_eq!(
            TerminalError::already_connected("a").code(),
            IpcErrorCode::AlreadyConnected
        );
        // A plain (uncoded) RemoteError/ConnectionFailed falls back to its
        // generic category rather than mis-reading a marker.
        assert_eq!(
            TerminalError::RemoteError("plain".to_string()).code(),
            IpcErrorCode::RemoteError
        );
        assert_eq!(
            TerminalError::ConnectionFailed("plain".to_string()).code(),
            IpcErrorCode::ConnectionFailed
        );
    }

    /// A core `ConnectionFailed` maps to a coded `unreachable` on both connect
    /// chokepoints, and the rendered string still contains the "Connection
    /// failed" text the frontend substring fallback matches.
    #[test]
    fn connection_failed_maps_to_coded_unreachable() {
        for terminal_err in [
            TerminalError::from_session_spawn(SessionError::ConnectionFailed("timed out".into())),
            TerminalError::from_session_ssh(SessionError::ConnectionFailed("timed out".into())),
        ] {
            let rendered = terminal_err.to_string();
            assert!(
                rendered.contains(&format!("[thub-code:{}]", codes::UNREACHABLE)),
                "unreachable IPC string must carry the marker, got {rendered:?}"
            );
            assert!(
                rendered.contains("Connection failed"),
                "the substring fallback text must be preserved, got {rendered:?}"
            );
        }
    }
}

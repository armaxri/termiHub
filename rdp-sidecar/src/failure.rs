//! Typed classification of a fatal session failure: a rejected credential vs
//! any other connect failure (#3390).
//!
//! The RDP negotiation (TCP → TLS → CredSSP/NLA → capability exchange) runs in
//! this sidecar **after** the desktop's `connect()` has already returned, so the
//! desktop cannot see *why* the session ended — only that its frame stream
//! closed. This module inspects IronRDP's **typed** errors (never the English
//! message text) and reports a [`SidecarFailureKind`] over the IPC
//! ([`SidecarMessage::Failure`](termihub_core::backends::rdp_sidecar::protocol::SidecarMessage::Failure)),
//! so the desktop can rest in "Authentication failed" instead of burning its
//! auto-reconnect attempts on credentials that can never work.
//!
//! What counts as an authentication failure:
//!
//! - **CredSSP / NLA** — [`ConnectorErrorKind::AccessDenied`] (early user
//!   authorization result) and [`ConnectorErrorKind::Credssp`] carrying either an
//!   NTSTATUS logon code from the server's `TSRequest.errorCode`
//!   ([`AUTH_NSTATUS`], e.g. `STATUS_LOGON_FAILURE`) or a credential-level SSPI
//!   error kind ([`is_auth_sspi_kind`]). Any other CredSSP error (a transport
//!   hiccup during the exchange, a protocol error) is **not** an auth failure.
//! - **Server logon / access errors** — a Set Error Info PDU (`ERRINFO_*`) whose
//!   code is a credential/privilege rejection ([`AUTH_ERROR_INFO`]), whether it
//!   arrives during connection finalization or after the session went active.
//!
//! Everything else is [`SidecarFailureKind::Connect`].

use std::fmt;

use ironrdp::connector::sspi;
use ironrdp::connector::{ConnectorError, ConnectorErrorKind};
use ironrdp::pdu::rdp::server_error_info::ProtocolIndependentCode;
use ironrdp::session::GracefulDisconnectReason;
use termihub_core::backends::rdp_sidecar::protocol::SidecarFailureKind;
use termihub_core::connection::GraphicalState;

/// NTSTATUS codes a CredSSP server returns in `TSRequest.errorCode` when it
/// rejects the supplied credentials or the account behind them.
pub const AUTH_NSTATUS: &[sspi::credssp::NStatusCode] = &[
    sspi::credssp::NStatusCode::LOGON_FAILURE,
    sspi::credssp::NStatusCode::WRONG_PASSWORD,
    sspi::credssp::NStatusCode::NO_SUCH_USER,
    sspi::credssp::NStatusCode::INVALID_ACCOUNT_NAME,
    sspi::credssp::NStatusCode::ACCOUNT_RESTRICTION,
    sspi::credssp::NStatusCode::INVALID_LOGON_HOURS,
    sspi::credssp::NStatusCode::INVALID_WORKSTATION,
    sspi::credssp::NStatusCode::PASSWORD_EXPIRED,
    sspi::credssp::NStatusCode::PASSWORD_MUST_CHANGE,
    sspi::credssp::NStatusCode::ACCOUNT_DISABLED,
    sspi::credssp::NStatusCode::ACCOUNT_LOCKED_OUT,
    sspi::credssp::NStatusCode::LOGON_NOT_GRANTED,
    sspi::credssp::NStatusCode::LOGON_TYPE_NOT_GRANTED,
    sspi::credssp::NStatusCode::SMARTCARD_LOGON_REQUIRED,
    // STATUS_ACCOUNT_EXPIRED has no named constant in sspi.
    sspi::credssp::NStatusCode(0xc000_0193),
];

/// `ERRINFO_*` codes (MS-RDPBCGR 2.2.5.1.1) that mean the server refused the
/// user's credentials or access rights — retrying the same logon cannot help.
pub const AUTH_ERROR_INFO: &[ProtocolIndependentCode] = &[
    ProtocolIndependentCode::ServerInsufficientPrivileges,
    ProtocolIndependentCode::ServerFreshCredentialsRequired,
];

/// The server rejected the logon after the session had been established — a
/// credential / privilege `ERRINFO` graceful disconnect. Carried as the source
/// of the sidecar's fatal error so [`classify`] recognises it by type.
#[derive(Debug)]
pub struct ServerLogonRejected(pub String);

impl fmt::Display for ServerLogonRejected {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "the server rejected the logon: {}", self.0)
    }
}

impl std::error::Error for ServerLogonRejected {}

/// Classify a fatal sidecar error (the whole `anyhow` chain) as auth vs connect.
pub fn classify(error: &anyhow::Error) -> SidecarFailureKind {
    let auth = error.chain().any(|cause| {
        cause.is::<ServerLogonRejected>()
            || cause
                .downcast_ref::<ConnectorError>()
                .is_some_and(|e| is_auth_connector_error(e.kind()))
            || cause
                .downcast_ref::<sspi::Error>()
                .is_some_and(is_auth_sspi_error)
    });
    if auth {
        SidecarFailureKind::Auth
    } else {
        SidecarFailureKind::Connect
    }
}

/// The lifecycle state the sidecar reports alongside a failure of `kind`.
pub fn failure_state(kind: SidecarFailureKind) -> GraphicalState {
    match kind {
        SidecarFailureKind::Auth => GraphicalState::AuthFailed,
        SidecarFailureKind::Connect => GraphicalState::ConnectFailed,
    }
}

/// Whether an IronRDP connector error is a credential rejection.
pub fn is_auth_connector_error(kind: &ConnectorErrorKind) -> bool {
    match kind {
        ConnectorErrorKind::AccessDenied => true,
        ConnectorErrorKind::Credssp(e) => is_auth_sspi_error(e),
        // Connection finalization turns a non-zero Set Error Info PDU into a
        // `Reason` carrying ironrdp's own description of the code.
        ConnectorErrorKind::Reason(reason) => is_auth_error_info_description(reason),
        _ => false,
    }
}

/// Whether a CredSSP/SSPI error is a credential rejection: the server's NTSTATUS
/// logon code, or an SSPI error kind that is about the credentials themselves.
pub fn is_auth_sspi_error(error: &sspi::Error) -> bool {
    error
        .nstatus
        .is_some_and(|status| AUTH_NSTATUS.contains(&status))
        || is_auth_sspi_kind(error.error_type)
}

/// SSPI error kinds that describe the credentials (not the transport).
pub fn is_auth_sspi_kind(kind: sspi::ErrorKind) -> bool {
    matches!(
        kind,
        sspi::ErrorKind::LogonDenied
            | sspi::ErrorKind::UnknownCredentials
            | sspi::ErrorKind::NoCredentials
            | sspi::ErrorKind::IncompleteCredentials
    )
}

/// Whether a server graceful-disconnect reason is a credential / privilege
/// rejection (`ERRINFO_SERVER_INSUFFICIENT_PRIVILEGES`, …).
pub fn is_auth_disconnect(reason: &GracefulDisconnectReason) -> bool {
    match reason {
        GracefulDisconnectReason::Other(description) => is_auth_error_info_description(description),
        GracefulDisconnectReason::UserInitiated | GracefulDisconnectReason::ServerInitiated => {
            false
        }
    }
}

/// IronRDP renders a Set Error Info code only as text (its description, inside
/// the connector `Reason` or the disconnect reason), so match against
/// **ironrdp's own** descriptions of the auth codes rather than free-form text.
fn is_auth_error_info_description(text: &str) -> bool {
    AUTH_ERROR_INFO
        .iter()
        .any(|code| text.contains(code.description()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Context;

    fn credssp(error: sspi::Error) -> ConnectorError {
        ConnectorError::new("CredSSP", ConnectorErrorKind::Credssp(error))
    }

    /// A wrong password under NLA: the server answers the TSRequest with
    /// `STATUS_LOGON_FAILURE`, which sspi surfaces as `InvalidToken` + nstatus.
    fn server_logon_failure(status: sspi::credssp::NStatusCode) -> sspi::Error {
        sspi::Error::new_with_nstatus(
            sspi::ErrorKind::InvalidToken,
            "CredSSP server returned an error status",
            status,
        )
    }

    fn classify_connector(error: ConnectorError) -> SidecarFailureKind {
        classify(&anyhow::Error::new(error).context("RDP CredSSP / capability exchange failed"))
    }

    #[test]
    fn credssp_logon_nstatus_codes_are_auth() {
        for status in AUTH_NSTATUS {
            assert_eq!(
                classify_connector(credssp(server_logon_failure(*status))),
                SidecarFailureKind::Auth,
                "{status:?}"
            );
        }
    }

    #[test]
    fn credssp_access_denied_early_user_auth_is_auth() {
        let err = ConnectorError::new("CredSSP", ConnectorErrorKind::AccessDenied);
        assert_eq!(classify_connector(err), SidecarFailureKind::Auth);
    }

    #[test]
    fn credential_level_sspi_kinds_are_auth() {
        for kind in [
            sspi::ErrorKind::LogonDenied,
            sspi::ErrorKind::UnknownCredentials,
            sspi::ErrorKind::NoCredentials,
            sspi::ErrorKind::IncompleteCredentials,
        ] {
            let err = credssp(sspi::Error::new(kind, "credentials"));
            assert_eq!(
                classify_connector(err),
                SidecarFailureKind::Auth,
                "{kind:?}"
            );
        }
    }

    /// A CredSSP error that is not about the credentials — a transport or
    /// protocol problem during the exchange, or a non-logon NTSTATUS — must stay
    /// retryable.
    #[test]
    fn non_credential_credssp_errors_are_connect() {
        let transport = credssp(sspi::Error::new(
            sspi::ErrorKind::InternalError,
            "connection reset",
        ));
        assert_eq!(classify_connector(transport), SidecarFailureKind::Connect);
        let invalid_token = credssp(sspi::Error::new(
            sspi::ErrorKind::InvalidToken,
            "malformed token",
        ));
        assert_eq!(
            classify_connector(invalid_token),
            SidecarFailureKind::Connect
        );
        let timeout = credssp(server_logon_failure(sspi::credssp::NStatusCode::IO_TIMEOUT));
        assert_eq!(classify_connector(timeout), SidecarFailureKind::Connect);
    }

    #[test]
    fn auth_error_info_during_finalization_is_auth() {
        for code in AUTH_ERROR_INFO {
            let reason = format!(
                "server returned error info: [Protocol independent error] {}",
                code.description()
            );
            let err = ConnectorError::new("ServerSetErrorInfo", ConnectorErrorKind::Reason(reason));
            assert_eq!(
                classify_connector(err),
                SidecarFailureKind::Auth,
                "{code:?}"
            );
        }
    }

    #[test]
    fn other_connector_errors_are_connect() {
        let denied = ConnectorError::new(
            "ServerSetErrorInfo",
            ConnectorErrorKind::Reason(format!(
                "server returned error info: {}",
                ProtocolIndependentCode::ServerDeniedConnection.description()
            )),
        );
        assert_eq!(classify_connector(denied), SidecarFailureKind::Connect);
        let general = ConnectorError::new("X.224", ConnectorErrorKind::General);
        assert_eq!(classify_connector(general), SidecarFailureKind::Connect);
    }

    /// Plain transport / TLS / size failures — no typed IronRDP error at all —
    /// are connect failures. The old text heuristic matched on "credssp" and
    /// would have called this auth.
    #[test]
    fn untyped_errors_are_connect_even_when_the_text_mentions_credssp() {
        let io = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "refused");
        let err = anyhow::Error::new(io).context("RDP TCP connect to host:3389 failed");
        assert_eq!(classify(&err), SidecarFailureKind::Connect);
        let err = anyhow::anyhow!("RDP CredSSP / capability exchange failed: logon");
        assert_eq!(classify(&err), SidecarFailureKind::Connect);
    }

    #[test]
    fn server_logon_rejected_is_auth_through_context() {
        let err = anyhow::Error::new(ServerLogonRejected("privileges".into()));
        assert_eq!(classify(&err), SidecarFailureKind::Auth);
        let wrapped: anyhow::Result<()> = Err(err);
        let wrapped = wrapped.context("session ended").unwrap_err();
        assert_eq!(classify(&wrapped), SidecarFailureKind::Auth);
    }

    #[test]
    fn auth_errinfo_disconnect_is_auth_and_others_are_not() {
        for code in AUTH_ERROR_INFO {
            let reason = GracefulDisconnectReason::Other(format!(
                "[Protocol independent error] {}",
                code.description()
            ));
            assert!(is_auth_disconnect(&reason), "{code:?}");
        }
        let logoff = GracefulDisconnectReason::Other(format!(
            "[Protocol independent error] {}",
            ProtocolIndependentCode::LogoffByUser.description()
        ));
        assert!(!is_auth_disconnect(&logoff));
        assert!(!is_auth_disconnect(
            &GracefulDisconnectReason::ServerInitiated
        ));
        assert!(!is_auth_disconnect(
            &GracefulDisconnectReason::UserInitiated
        ));
    }

    #[test]
    fn failure_state_mirrors_the_kind() {
        assert_eq!(
            failure_state(SidecarFailureKind::Auth),
            GraphicalState::AuthFailed
        );
        assert_eq!(
            failure_state(SidecarFailureKind::Connect),
            GraphicalState::ConnectFailed
        );
    }
}

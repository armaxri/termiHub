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
//!   error kind ([`is_auth_sspi_kind`]). The logon codes are also recognised in
//!   their facility-Win32 form ([`AUTH_WIN32`], `NTSTATUS_FROM_WIN32`), which
//!   FreeRDP-based servers produce.
//! - **A CredSSP error answering the NTLM AUTHENTICATE message** (#3612) — the
//!   message carrying the password proof. FreeRDP-based servers (FreeRDP shadow,
//!   gnome-remote-desktop) put `NTSTATUS_FROM_WIN32(GetLastError())` in
//!   `errorCode`, and that last error is unrelated to the logon (the fixture sends
//!   `0xC00700EA`, i.e. `ERROR_MORE_DATA`), so the code alone cannot say "wrong
//!   password" — the phase does ([`is_auth_credssp_rejection`], driven by
//!   [`crate::nla`], surfaced as [`CredsspRejected`]). Known transient server
//!   conditions ([`TRANSIENT_NSTATUS`], e.g. no logon server reachable) stay
//!   retryable even then.
//!
//! Any other CredSSP error (a transport hiccup during the exchange, a protocol
//! error, a server error answering the NEGOTIATE message) is **not** an auth
//! failure.
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

/// `NTSTATUS_FROM_WIN32(code)`: a Win32 error wrapped as an error-severity
/// NTSTATUS in `FACILITY_NTWIN32` (7) — `0xC007xxxx`.
pub const fn ntstatus_from_win32(code: u32) -> sspi::credssp::NStatusCode {
    sspi::credssp::NStatusCode(0xc007_0000 | (code & 0xffff))
}

/// The Win32 error behind a facility-Win32 NTSTATUS (`0xC007xxxx`), if it is one.
pub const fn win32_from_ntstatus(status: sspi::credssp::NStatusCode) -> Option<u32> {
    if status.0 & 0xffff_0000 == 0xc007_0000 {
        Some(status.0 & 0xffff)
    } else {
        None
    }
}

/// Win32 logon errors — the Win32 twins of [`AUTH_NSTATUS`] — that a server may
/// return wrapped by `NTSTATUS_FROM_WIN32` (FreeRDP's NLA server does, #3612).
pub const AUTH_WIN32: &[u32] = &[
    1315, // ERROR_INVALID_ACCOUNT_NAME
    1317, // ERROR_NO_SUCH_USER
    1323, // ERROR_WRONG_PASSWORD
    1326, // ERROR_LOGON_FAILURE
    1327, // ERROR_ACCOUNT_RESTRICTION
    1328, // ERROR_INVALID_LOGON_HOURS
    1329, // ERROR_INVALID_WORKSTATION
    1330, // ERROR_PASSWORD_EXPIRED
    1331, // ERROR_ACCOUNT_DISABLED
    1380, // ERROR_LOGON_NOT_GRANTED
    1385, // ERROR_LOGON_TYPE_NOT_GRANTED
    1793, // ERROR_ACCOUNT_EXPIRED
    1907, // ERROR_PASSWORD_MUST_CHANGE
    1909, // ERROR_ACCOUNT_LOCKED_OUT
];

/// Server-side conditions that can fail a CredSSP logon without saying anything
/// about the credentials — retrying later can succeed, so they are never
/// reported as auth, even in reply to the AUTHENTICATE message.
pub const TRANSIENT_NSTATUS: &[sspi::credssp::NStatusCode] = &[
    sspi::credssp::NStatusCode::NO_LOGON_SERVERS,
    sspi::credssp::NStatusCode::IO_TIMEOUT,
    sspi::credssp::NStatusCode::TRANSACTION_TIMED_OUT,
    // STATUS_INSUFFICIENT_RESOURCES, STATUS_NETLOGON_NOT_STARTED.
    sspi::credssp::NStatusCode(0xc000_009a),
    sspi::credssp::NStatusCode(0xc000_0192),
    // The same conditions as facility-Win32 codes: ERROR_NOT_ENOUGH_MEMORY,
    // ERROR_OUTOFMEMORY, ERROR_NO_LOGON_SERVERS, ERROR_TIMEOUT.
    ntstatus_from_win32(8),
    ntstatus_from_win32(14),
    ntstatus_from_win32(1311),
    ntstatus_from_win32(1460),
];

/// Whether a server-returned NTSTATUS names a logon rejection, in either its
/// native ([`AUTH_NSTATUS`]) or facility-Win32 ([`AUTH_WIN32`]) form.
pub fn is_auth_nstatus(status: sspi::credssp::NStatusCode) -> bool {
    AUTH_NSTATUS.contains(&status)
        || win32_from_ntstatus(status).is_some_and(|code| AUTH_WIN32.contains(&code))
}

/// Which client message a server's CredSSP `TSRequest` answers (NTLM, #3612).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredsspPhase {
    /// Reply #1: answers NEGOTIATE (a CHALLENGE, or an error before any
    /// credential was presented).
    Negotiate,
    /// Reply #2 onwards: answers AUTHENTICATE, the message with the password
    /// proof (the server's public-key echo, or its rejection).
    Authenticate,
}

impl CredsspPhase {
    /// The phase of the server TSRequest being processed, given how many server
    /// replies have been received so far (including it).
    pub fn from_server_replies(server_replies: usize) -> Self {
        if server_replies >= 2 {
            Self::Authenticate
        } else {
            Self::Negotiate
        }
    }
}

/// Whether a CredSSP error is the server rejecting the credentials, given the
/// phase the server's reply answers. Only server-returned errors (`TSRequest.
/// errorCode`, carried as the error's NTSTATUS) qualify: a logon code in any
/// phase, and — because FreeRDP-based servers send an unrelated stale error
/// there — any non-transient code in reply to AUTHENTICATE.
pub fn is_auth_credssp_rejection(error: &sspi::Error, phase: CredsspPhase) -> bool {
    let Some(status) = error.nstatus else {
        return false;
    };
    if is_auth_nstatus(status) {
        return true;
    }
    phase == CredsspPhase::Authenticate && !TRANSIENT_NSTATUS.contains(&status)
}

/// The CredSSP server rejected the NTLM AUTHENTICATE message (#3612). Carried as
/// the sidecar's fatal error so [`classify`] recognises it by type; the source is
/// IronRDP's original CredSSP error.
#[derive(Debug)]
pub struct CredsspRejected {
    /// The server's `TSRequest.errorCode`.
    pub status: sspi::credssp::NStatusCode,
    /// IronRDP's CredSSP connector error it arrived as.
    pub source: ConnectorError,
}

impl fmt::Display for CredsspRejected {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the server rejected the NLA credentials (CredSSP error status {:#010x})",
            self.status.0
        )
    }
}

impl std::error::Error for CredsspRejected {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

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
            || cause.is::<CredsspRejected>()
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
    error.nstatus.is_some_and(is_auth_nstatus) || is_auth_sspi_kind(error.error_type)
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

    /// The code the FreeRDP shadow server (and gnome-remote-desktop) sends for a
    /// wrong password: `NTSTATUS_FROM_WIN32(ERROR_MORE_DATA)` (#3612).
    const FREERDP_WRONG_PASSWORD: sspi::credssp::NStatusCode =
        sspi::credssp::NStatusCode(0xc007_00ea);

    #[test]
    fn freerdp_wrong_password_code_is_a_wrapped_win32_error_more_data() {
        assert_eq!(ntstatus_from_win32(234), FREERDP_WRONG_PASSWORD);
        assert_eq!(win32_from_ntstatus(FREERDP_WRONG_PASSWORD), Some(234));
        assert_eq!(
            win32_from_ntstatus(sspi::credssp::NStatusCode::LOGON_FAILURE),
            None
        );
        // Not a logon code on its own: without the phase it stays retryable.
        assert!(!is_auth_nstatus(FREERDP_WRONG_PASSWORD));
        assert_eq!(
            classify_connector(credssp(server_logon_failure(FREERDP_WRONG_PASSWORD))),
            SidecarFailureKind::Connect
        );
    }

    #[test]
    fn server_error_answering_authenticate_is_auth() {
        let err = server_logon_failure(FREERDP_WRONG_PASSWORD);
        assert!(is_auth_credssp_rejection(&err, CredsspPhase::Authenticate));
        assert!(!is_auth_credssp_rejection(&err, CredsspPhase::Negotiate));
    }

    #[test]
    fn logon_codes_are_auth_in_either_phase() {
        let win32_logon_failure = ntstatus_from_win32(1326);
        for status in [
            sspi::credssp::NStatusCode::LOGON_FAILURE,
            win32_logon_failure,
        ] {
            let err = server_logon_failure(status);
            assert!(
                is_auth_credssp_rejection(&err, CredsspPhase::Negotiate),
                "{status:?}"
            );
            assert!(
                is_auth_credssp_rejection(&err, CredsspPhase::Authenticate),
                "{status:?}"
            );
        }
    }

    #[test]
    fn wrapped_win32_logon_codes_are_auth_without_the_phase() {
        for code in AUTH_WIN32 {
            assert_eq!(
                classify_connector(credssp(server_logon_failure(ntstatus_from_win32(*code)))),
                SidecarFailureKind::Auth,
                "win32 {code}"
            );
        }
    }

    #[test]
    fn transient_server_errors_answering_authenticate_stay_connect() {
        for status in TRANSIENT_NSTATUS {
            let err = server_logon_failure(*status);
            assert!(
                !is_auth_credssp_rejection(&err, CredsspPhase::Authenticate),
                "{status:?}"
            );
        }
    }

    /// Only a server-returned `errorCode` (an NTSTATUS on the error) counts —
    /// a client-side CredSSP failure in the AUTHENTICATE phase does not.
    #[test]
    fn client_side_credssp_errors_are_never_a_server_rejection() {
        let err = sspi::Error::new(sspi::ErrorKind::MessageAltered, "public key mismatch");
        assert!(!is_auth_credssp_rejection(&err, CredsspPhase::Authenticate));
    }

    #[test]
    fn phase_follows_the_server_reply_count() {
        assert_eq!(
            CredsspPhase::from_server_replies(0),
            CredsspPhase::Negotiate
        );
        assert_eq!(
            CredsspPhase::from_server_replies(1),
            CredsspPhase::Negotiate
        );
        assert_eq!(
            CredsspPhase::from_server_replies(2),
            CredsspPhase::Authenticate
        );
        assert_eq!(
            CredsspPhase::from_server_replies(3),
            CredsspPhase::Authenticate
        );
    }

    #[test]
    fn credssp_rejected_is_auth_through_context_and_keeps_the_cause() {
        let err = anyhow::Error::new(CredsspRejected {
            status: FREERDP_WRONG_PASSWORD,
            source: credssp(server_logon_failure(FREERDP_WRONG_PASSWORD)),
        })
        .context("RDP CredSSP / capability exchange failed");
        assert_eq!(classify(&err), SidecarFailureKind::Auth);
        let text = format!("{err:#}");
        assert!(text.contains("0xc00700ea"), "{text}");
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

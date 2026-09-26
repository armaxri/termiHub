//! Standard and application JSON-RPC 2.0 error codes.

/// Invalid JSON was received by the server.
pub const PARSE_ERROR: i64 = -32700;

/// The JSON sent is not a valid Request object.
pub const INVALID_REQUEST: i64 = -32600;

/// The method does not exist / is not available.
pub const METHOD_NOT_FOUND: i64 = -32601;

/// Invalid method parameter(s).
pub const INVALID_PARAMS: i64 = -32602;

/// Internal JSON-RPC error.
pub const INTERNAL_ERROR: i64 = -32603;

// Application error codes (termiHub-specific).

/// No session with the given ID.
pub const SESSION_NOT_FOUND: i64 = -32001;

/// Protocol version mismatch.
pub const VERSION_NOT_SUPPORTED: i64 = -32002;

/// Could not create the session.
pub const SESSION_CREATION_FAILED: i64 = -32003;

/// Agent has reached `max_sessions`.
pub const SESSION_LIMIT_REACHED: i64 = -32004;

/// Invalid config values.
pub const INVALID_CONFIGURATION: i64 = -32005;

/// Session exists but has exited.
pub const SESSION_NOT_RUNNING: i64 = -32006;

/// The agent has not been initialized yet (must call `initialize` first).
pub const NOT_INITIALIZED: i64 = -32007;

/// No connection with the given ID.
pub const CONNECTION_NOT_FOUND: i64 = -32008;

/// No folder with the given ID.
pub const FOLDER_NOT_FOUND: i64 = -32009;

/// The file or directory was not found.
pub const FILE_NOT_FOUND: i64 = -32010;

/// Permission denied for the requested file operation.
pub const PERMISSION_DENIED: i64 = -32011;

/// A file operation failed (I/O error, docker exec failure, etc.).
pub const FILE_OPERATION_FAILED: i64 = -32012;

/// File browsing is not supported for this connection type (e.g., serial).
pub const FILE_BROWSING_NOT_SUPPORTED: i64 = -32013;

/// A monitoring operation failed (collection error, SSH failure, etc.).
pub const MONITORING_ERROR: i64 = -32014;

/// An error occurred during agent shutdown.
pub const SHUTDOWN_ERROR: i64 = -32015;

/// A deferred agent update failed to apply (binary swap / re-exec error).
pub const DEFERRED_UPDATE_FAILED: i64 = -32016;

/// An agent-hosted SSH tunnel failed to start (SSH connect or bind error).
pub const TUNNEL_START_FAILED: i64 = -32017;

/// An agent-hosted embedded server (HTTP/FTP/TFTP) failed to start (bad config,
/// port bind failure, or an unknown service type).
pub const SERVICE_START_FAILED: i64 = -32018;

/// A process operation (list / kill) failed (exec error, non-zero kill, etc.)
/// (PROD-0028).
pub const PROCESS_OPERATION_FAILED: i64 = -32019;

/// Process listing / termination is not supported for this connection type
/// (e.g., serial, telnet) (PROD-0028).
pub const PROCESS_NOT_SUPPORTED: i64 = -32020;

/// An agent update was refused because its Ed25519 signature is missing,
/// malformed, or does not verify against the agent's compiled-in release key
/// (or the agent was built with the placeholder key) (AGT-005, #3213).
pub const UPDATE_SIGNATURE_REJECTED: i64 = -32021;

/// A streaming `tool.start` was refused: unknown tool, a duplicate or invalid
/// run id, or the agent's concurrent-run limit is reached (#3353).
pub const TOOL_RUN_REJECTED: i64 = -32022;

/// A plain (non-takeover) `connection.attach` was refused because another
/// desktop currently holds the session (SM-003 single-attach, #3395/#3404). The
/// holder is left undisturbed; only an explicit takeover (`takeover: true`) may
/// evict it. The desktop folds the refused tab to `Evicted` (with Reclaim)
/// instead of treating this as a failure or retrying.
pub const SESSION_HELD_BY_OTHER: i64 = -32023;

/// The user cancelled an SSH keyboard-interactive (OTP / 2FA) prompt the agent
/// relayed while authenticating (#3375). The desktop treats it as a quiet
/// cancel, exactly like a cancelled prompt on a direct SSH connection.
pub const AUTH_CANCELLED: i64 = -32024;

/// An agent-authenticated SSH connection's **second factor** (a user-typed
/// one-time code entered after an earlier factor was accepted) was rejected
/// (#3375, #3376). The saved password was not what failed, so the desktop must
/// keep it.
pub const SECOND_FACTOR_FAILED: i64 = -32025;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_are_negative() {
        let codes = [
            PARSE_ERROR,
            INVALID_REQUEST,
            METHOD_NOT_FOUND,
            INVALID_PARAMS,
            INTERNAL_ERROR,
            SESSION_NOT_FOUND,
            VERSION_NOT_SUPPORTED,
            SESSION_CREATION_FAILED,
            SESSION_LIMIT_REACHED,
            INVALID_CONFIGURATION,
            SESSION_NOT_RUNNING,
            NOT_INITIALIZED,
            CONNECTION_NOT_FOUND,
            FOLDER_NOT_FOUND,
            FILE_NOT_FOUND,
            PERMISSION_DENIED,
            FILE_OPERATION_FAILED,
            FILE_BROWSING_NOT_SUPPORTED,
            MONITORING_ERROR,
            SHUTDOWN_ERROR,
            DEFERRED_UPDATE_FAILED,
            TUNNEL_START_FAILED,
            SERVICE_START_FAILED,
            PROCESS_OPERATION_FAILED,
            PROCESS_NOT_SUPPORTED,
            UPDATE_SIGNATURE_REJECTED,
            TOOL_RUN_REJECTED,
            SESSION_HELD_BY_OTHER,
            AUTH_CANCELLED,
            SECOND_FACTOR_FAILED,
        ];
        for code in codes {
            assert!(code < 0, "Error code {code} should be negative");
        }
    }

    #[test]
    fn standard_codes_in_json_rpc_range() {
        // Standard JSON-RPC codes are in -32768..-32000
        let standard = [
            PARSE_ERROR,
            INVALID_REQUEST,
            METHOD_NOT_FOUND,
            INVALID_PARAMS,
            INTERNAL_ERROR,
        ];
        for code in standard {
            assert!(
                (-32768..=-32000).contains(&code),
                "Standard code {code} should be in -32768..-32000"
            );
        }
    }

    #[test]
    fn application_codes_in_expected_range() {
        let app_codes = [
            SESSION_NOT_FOUND,
            VERSION_NOT_SUPPORTED,
            SESSION_CREATION_FAILED,
            SESSION_LIMIT_REACHED,
            INVALID_CONFIGURATION,
            SESSION_NOT_RUNNING,
            NOT_INITIALIZED,
            CONNECTION_NOT_FOUND,
            FOLDER_NOT_FOUND,
            FILE_NOT_FOUND,
            PERMISSION_DENIED,
            FILE_OPERATION_FAILED,
            FILE_BROWSING_NOT_SUPPORTED,
            MONITORING_ERROR,
            SHUTDOWN_ERROR,
            DEFERRED_UPDATE_FAILED,
            PROCESS_OPERATION_FAILED,
            PROCESS_NOT_SUPPORTED,
            UPDATE_SIGNATURE_REJECTED,
            TOOL_RUN_REJECTED,
            SESSION_HELD_BY_OTHER,
            AUTH_CANCELLED,
            SECOND_FACTOR_FAILED,
        ];
        for code in app_codes {
            assert!(
                (-32099..=-32000).contains(&code),
                "Application code {code} should be in -32099..-32000"
            );
        }
    }
}

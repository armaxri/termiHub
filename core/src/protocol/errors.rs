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
        ];
        for code in app_codes {
            assert!(
                (-32099..=-32000).contains(&code),
                "Application code {code} should be in -32099..-32000"
            );
        }
    }
}

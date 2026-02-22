//! Standard and application JSON-RPC 2.0 error codes.

pub use termihub_core::protocol::errors::*;

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

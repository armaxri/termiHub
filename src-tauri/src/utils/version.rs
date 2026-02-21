//! Semantic version parsing and compatibility checking for agent deployment.
//!
//! Version matching rules (from Phase 7 spec):
//! - Same major version required
//! - Agent minor version >= desktop expected minor
//! - Patch version is ignored

/// Parse a semver version string into (major, minor, patch).
///
/// Returns `None` if the string does not contain exactly three
/// dot-separated unsigned integers.
pub fn parse_semver(version: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ))
}

/// Result of comparing an agent version against the expected version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionStatus {
    /// Versions are compatible — agent can serve this desktop.
    Compatible,
    /// Agent minor version is too old (needs update).
    AgentTooOld { agent: String, expected: String },
    /// Major version mismatch (incompatible).
    MajorMismatch { agent: String, expected: String },
    /// Version string could not be parsed.
    InvalidVersion(String),
}

/// Check if the agent version is compatible with the expected version.
///
/// Rules:
/// - Same major version required
/// - Agent minor version >= expected minor
/// - Patch is ignored
pub fn check_version(agent_version: &str, expected_version: &str) -> VersionStatus {
    let agent = match parse_semver(agent_version) {
        Some(v) => v,
        None => return VersionStatus::InvalidVersion(agent_version.to_string()),
    };
    let expected = match parse_semver(expected_version) {
        Some(v) => v,
        None => return VersionStatus::InvalidVersion(expected_version.to_string()),
    };

    if agent.0 != expected.0 {
        return VersionStatus::MajorMismatch {
            agent: agent_version.to_string(),
            expected: expected_version.to_string(),
        };
    }

    if agent.1 < expected.1 {
        return VersionStatus::AgentTooOld {
            agent: agent_version.to_string(),
            expected: expected_version.to_string(),
        };
    }

    VersionStatus::Compatible
}

/// Convenience check that returns `true` if versions are compatible.
pub fn is_version_compatible(agent_version: &str, expected_version: &str) -> bool {
    check_version(agent_version, expected_version) == VersionStatus::Compatible
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_semver ──────────────────────────────────────────────────

    #[test]
    fn parse_semver_valid() {
        assert_eq!(parse_semver("0.1.0"), Some((0, 1, 0)));
        assert_eq!(parse_semver("1.0.0"), Some((1, 0, 0)));
        assert_eq!(parse_semver("2.15.3"), Some((2, 15, 3)));
        assert_eq!(parse_semver("0.0.0"), Some((0, 0, 0)));
    }

    #[test]
    fn parse_semver_invalid() {
        assert_eq!(parse_semver("invalid"), None);
        assert_eq!(parse_semver("1.0"), None);
        assert_eq!(parse_semver("1.0.0.0"), None);
        assert_eq!(parse_semver(""), None);
        assert_eq!(parse_semver("1.0.beta"), None);
        assert_eq!(parse_semver("v1.0.0"), None);
        assert_eq!(parse_semver("-1.0.0"), None);
    }

    // ── check_version ────────────────────────────────────────────────

    #[test]
    fn check_version_compatible_exact() {
        assert_eq!(check_version("0.1.0", "0.1.0"), VersionStatus::Compatible);
    }

    #[test]
    fn check_version_compatible_agent_newer_minor() {
        assert_eq!(check_version("0.2.0", "0.1.0"), VersionStatus::Compatible);
        assert_eq!(check_version("0.5.0", "0.1.0"), VersionStatus::Compatible);
    }

    #[test]
    fn check_version_compatible_agent_newer_patch() {
        assert_eq!(check_version("0.1.5", "0.1.0"), VersionStatus::Compatible);
    }

    #[test]
    fn check_version_agent_too_old() {
        assert_eq!(
            check_version("0.1.0", "0.2.0"),
            VersionStatus::AgentTooOld {
                agent: "0.1.0".to_string(),
                expected: "0.2.0".to_string(),
            }
        );
    }

    #[test]
    fn check_version_major_mismatch() {
        assert_eq!(
            check_version("1.0.0", "0.1.0"),
            VersionStatus::MajorMismatch {
                agent: "1.0.0".to_string(),
                expected: "0.1.0".to_string(),
            }
        );
        assert_eq!(
            check_version("0.1.0", "1.0.0"),
            VersionStatus::MajorMismatch {
                agent: "0.1.0".to_string(),
                expected: "1.0.0".to_string(),
            }
        );
    }

    #[test]
    fn check_version_invalid_agent() {
        assert_eq!(
            check_version("invalid", "0.1.0"),
            VersionStatus::InvalidVersion("invalid".to_string())
        );
    }

    #[test]
    fn check_version_invalid_expected() {
        assert_eq!(
            check_version("0.1.0", "bad"),
            VersionStatus::InvalidVersion("bad".to_string())
        );
    }

    // ── is_version_compatible ────────────────────────────────────────

    #[test]
    fn is_compatible_true() {
        assert!(is_version_compatible("0.1.0", "0.1.0"));
        assert!(is_version_compatible("0.2.0", "0.1.0"));
        assert!(is_version_compatible("0.1.5", "0.1.0"));
    }

    #[test]
    fn is_compatible_false() {
        assert!(!is_version_compatible("0.1.0", "0.2.0"));
        assert!(!is_version_compatible("1.0.0", "0.1.0"));
        assert!(!is_version_compatible("invalid", "0.1.0"));
    }
}

//! The single semantic-version parser and agent-compatibility rule
//! (DUP2-010, #4363).
//!
//! The desktop, the agent and the protocol layer each used to parse versions
//! their own way; the desktop's split-on-`.` parser rejected every pre-release
//! agent (`0.2.0-beta.1` has four dot-separated parts), so a `vX.Y.Z-beta.N`
//! release agent read as incompatible. Everything now parses through the
//! maintained [`semver`] crate here.
//!
//! Parsing accepts a single leading `v`/`V` (GitHub release tags such as
//! `v0.3.0`) and ignores surrounding whitespace. Pre-release and build-metadata
//! suffixes are accepted.

use std::fmt;

pub use semver::Version;

/// A version string that is not valid semantic versioning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionParseError {
    input: String,
    reason: String,
}

impl VersionParseError {
    /// The rejected input, as given.
    #[must_use]
    pub fn input(&self) -> &str {
        &self.input
    }
}

impl fmt::Display for VersionParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "invalid semantic version: {:?}: {}",
            self.input, self.reason
        )
    }
}

impl std::error::Error for VersionParseError {}

/// Parse a version or release tag into a [`Version`].
///
/// A single leading `v`/`V` is stripped and surrounding whitespace ignored;
/// pre-release (`-beta.1`) and build-metadata (`+abc`) suffixes are accepted.
pub fn parse_version(raw: &str) -> Result<Version, VersionParseError> {
    let trimmed = raw.trim();
    let stripped = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    Version::parse(stripped).map_err(|e| VersionParseError {
        input: raw.to_string(),
        reason: e.to_string(),
    })
}

/// Whether `candidate` is strictly newer than `current` by semver ordering
/// (so `0.3.0-rc.1` is older than `0.3.0`). Parse errors on either side are
/// surfaced so the caller can log and skip.
pub fn is_newer(candidate: &str, current: &str) -> Result<bool, VersionParseError> {
    Ok(parse_version(candidate)? > parse_version(current)?)
}

/// The agent-compatibility rule: an agent can serve a desktop expecting
/// `expected` when both share the MAJOR version and the agent's MINOR is at
/// least the expected one. PATCH, pre-release and build metadata are ignored,
/// so a `0.2.0-beta.1` agent serves a desktop expecting `0.2.0`.
#[must_use]
pub fn is_compatible(agent: &Version, expected: &Version) -> bool {
    agent.major == expected.major && agent.minor >= expected.minor
}

/// Result of comparing an agent version against the version the desktop
/// expects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionStatus {
    /// Versions are compatible — the agent can serve this desktop.
    Compatible,
    /// The agent's MINOR version is too old (needs an update).
    AgentTooOld { agent: String, expected: String },
    /// MAJOR version mismatch (incompatible).
    MajorMismatch { agent: String, expected: String },
    /// The version string could not be parsed.
    InvalidVersion(String),
}

/// Classify `agent_version` against `expected_version` by [`is_compatible`]'s
/// rule.
#[must_use]
pub fn check_agent_version(agent_version: &str, expected_version: &str) -> VersionStatus {
    let agent = match parse_version(agent_version) {
        Ok(v) => v,
        Err(_) => return VersionStatus::InvalidVersion(agent_version.to_string()),
    };
    let expected = match parse_version(expected_version) {
        Ok(v) => v,
        Err(_) => return VersionStatus::InvalidVersion(expected_version.to_string()),
    };
    if is_compatible(&agent, &expected) {
        VersionStatus::Compatible
    } else if agent.major != expected.major {
        VersionStatus::MajorMismatch {
            agent: agent_version.to_string(),
            expected: expected_version.to_string(),
        }
    } else {
        VersionStatus::AgentTooOld {
            agent: agent_version.to_string(),
            expected: expected_version.to_string(),
        }
    }
}

/// `true` when [`check_agent_version`] reports [`VersionStatus::Compatible`].
#[must_use]
pub fn is_agent_compatible(agent_version: &str, expected_version: &str) -> bool {
    check_agent_version(agent_version, expected_version) == VersionStatus::Compatible
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_version ─────────────────────────────────────────────────

    #[test]
    fn parse_plain_and_v_prefixed() {
        assert_eq!(parse_version("0.1.0").unwrap(), Version::new(0, 1, 0));
        assert_eq!(parse_version("v0.3.0").unwrap(), Version::new(0, 3, 0));
        assert_eq!(parse_version("V1.2.3").unwrap(), Version::new(1, 2, 3));
        assert_eq!(parse_version("  v2.0.1\n").unwrap(), Version::new(2, 0, 1));
    }

    #[test]
    fn parse_accepts_pre_release_and_build_metadata() {
        let v = parse_version("0.2.0-beta.1").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (0, 2, 0));
        assert_eq!(v.pre.as_str(), "beta.1");
        let v = parse_version("v1.0.0+build.7").unwrap();
        assert_eq!(v.build.as_str(), "build.7");
    }

    #[test]
    fn parse_rejects_garbage() {
        for bad in [
            "", "v", "invalid", "1.0", "1.0.0.0", "1.0.beta", "-1.0.0", "vv1.0.0",
        ] {
            let err = parse_version(bad).unwrap_err();
            assert_eq!(err.input(), bad);
            assert!(err.to_string().contains("invalid semantic version"));
        }
    }

    // ── is_newer ──────────────────────────────────────────────────────

    #[test]
    fn is_newer_orders_by_semver() {
        assert!(is_newer("v0.3.1", "v0.3.0").unwrap());
        assert!(is_newer("v0.4.0", "v0.3.9").unwrap());
        assert!(is_newer("v1.0.0", "0.99.99").unwrap());
        assert!(!is_newer("v0.3.0", "v0.3.0").unwrap());
        assert!(!is_newer("0.2.0", "v0.3.0").unwrap());
        // A pre-release precedes its release.
        assert!(is_newer("v0.3.0", "v0.3.0-rc.1").unwrap());
        assert!(!is_newer("v0.3.0-rc.1", "v0.3.0").unwrap());
        assert!(is_newer("garbage", "v0.3.0").is_err());
    }

    // ── check_agent_version ───────────────────────────────────────────

    #[test]
    fn compatible_same_or_newer_minor_any_patch() {
        assert_eq!(
            check_agent_version("0.1.0", "0.1.0"),
            VersionStatus::Compatible
        );
        assert_eq!(
            check_agent_version("0.2.0", "0.1.0"),
            VersionStatus::Compatible
        );
        assert_eq!(
            check_agent_version("0.1.5", "0.1.0"),
            VersionStatus::Compatible
        );
        assert_eq!(
            check_agent_version("0.1.0", "0.1.9"),
            VersionStatus::Compatible
        );
    }

    /// Regression (DUP2-010): a pre-release agent was `InvalidVersion`.
    #[test]
    fn pre_release_agent_is_compatible() {
        assert_eq!(
            check_agent_version("0.2.0-beta.1", "0.2.0"),
            VersionStatus::Compatible
        );
        assert_eq!(
            check_agent_version("0.2.0-beta.1", "0.2.0-beta.1"),
            VersionStatus::Compatible
        );
        assert!(is_agent_compatible("0.3.0-rc.2+abc", "0.2.0"));
        assert!(is_agent_compatible("v0.2.0-beta.1", "0.2.0"));
        assert_eq!(
            check_agent_version("0.1.0-beta.1", "0.2.0"),
            VersionStatus::AgentTooOld {
                agent: "0.1.0-beta.1".to_string(),
                expected: "0.2.0".to_string(),
            }
        );
    }

    #[test]
    fn agent_too_old() {
        assert_eq!(
            check_agent_version("0.1.0", "0.2.0"),
            VersionStatus::AgentTooOld {
                agent: "0.1.0".to_string(),
                expected: "0.2.0".to_string(),
            }
        );
    }

    #[test]
    fn major_mismatch_either_direction() {
        assert_eq!(
            check_agent_version("1.0.0", "0.1.0"),
            VersionStatus::MajorMismatch {
                agent: "1.0.0".to_string(),
                expected: "0.1.0".to_string(),
            }
        );
        assert_eq!(
            check_agent_version("0.1.0", "1.0.0"),
            VersionStatus::MajorMismatch {
                agent: "0.1.0".to_string(),
                expected: "1.0.0".to_string(),
            }
        );
    }

    #[test]
    fn invalid_agent_or_expected() {
        assert_eq!(
            check_agent_version("invalid", "0.1.0"),
            VersionStatus::InvalidVersion("invalid".to_string())
        );
        assert_eq!(
            check_agent_version("0.1.0", "bad"),
            VersionStatus::InvalidVersion("bad".to_string())
        );
        assert!(!is_agent_compatible("invalid", "0.1.0"));
    }
}

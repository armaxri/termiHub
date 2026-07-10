//! Semantic-version parsing and comparison for the agent self-update check.
//!
//! GitHub release tags follow the `v{semver}` convention (e.g. `v0.3.0`); the
//! agent's own version comes from `env!("CARGO_PKG_VERSION")`. This module
//! normalizes both through the maintained [`semver`] crate rather than
//! hand-rolling version parsing.

use anyhow::{Context, Result};
use semver::Version;

/// Parse a release tag or version string into a [`Version`].
///
/// A single leading `v`/`V` (as used by GitHub tags like `v0.3.0`) is stripped
/// before parsing. Surrounding whitespace is ignored.
pub fn parse_version(tag: &str) -> Result<Version> {
    let trimmed = tag.trim();
    let stripped = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    Version::parse(stripped).with_context(|| format!("invalid semantic version: {tag:?}"))
}

/// Return `true` when `candidate` is strictly newer than `current`.
///
/// Both inputs are parsed via [`parse_version`]; a parse failure on either side
/// yields `Ok(false)` semantics only through the caller — this function returns
/// the raw comparison and surfaces parse errors so the caller can log and skip.
pub fn is_newer(candidate: &str, current: &str) -> Result<bool> {
    let candidate = parse_version(candidate)?;
    let current = parse_version(current)?;
    Ok(candidate > current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_strips_v_prefix() {
        assert_eq!(parse_version("v0.3.0").unwrap(), Version::new(0, 3, 0));
        assert_eq!(parse_version("V1.2.3").unwrap(), Version::new(1, 2, 3));
        assert_eq!(parse_version("0.1.0").unwrap(), Version::new(0, 1, 0));
    }

    #[test]
    fn parse_version_trims_whitespace() {
        assert_eq!(parse_version("  v2.0.1\n").unwrap(), Version::new(2, 0, 1));
    }

    #[test]
    fn parse_version_rejects_garbage() {
        assert!(parse_version("not-a-version").is_err());
        assert!(parse_version("").is_err());
        assert!(parse_version("v").is_err());
    }

    #[test]
    fn is_newer_true_for_higher_patch_minor_major() {
        assert!(is_newer("v0.3.1", "v0.3.0").unwrap());
        assert!(is_newer("v0.4.0", "v0.3.9").unwrap());
        assert!(is_newer("v1.0.0", "v0.99.99").unwrap());
    }

    #[test]
    fn is_newer_false_for_equal_or_older() {
        assert!(!is_newer("v0.3.0", "v0.3.0").unwrap());
        assert!(!is_newer("v0.2.9", "v0.3.0").unwrap());
        assert!(!is_newer("v0.3.0", "v1.0.0").unwrap());
    }

    #[test]
    fn is_newer_handles_mixed_prefixes() {
        // Tag has the `v`, current (CARGO_PKG_VERSION) does not.
        assert!(is_newer("v0.3.0", "0.2.0").unwrap());
        assert!(!is_newer("0.2.0", "v0.3.0").unwrap());
    }

    #[test]
    fn is_newer_prerelease_is_older_than_release() {
        // Standard semver: 0.3.0-rc.1 < 0.3.0.
        assert!(is_newer("v0.3.0", "v0.3.0-rc.1").unwrap());
        assert!(!is_newer("v0.3.0-rc.1", "v0.3.0").unwrap());
    }

    #[test]
    fn is_newer_surfaces_parse_errors() {
        assert!(is_newer("garbage", "v0.3.0").is_err());
    }
}

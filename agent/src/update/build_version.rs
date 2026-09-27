//! Authentic build version of an agent binary and the update downgrade policy
//! (SEC-006, #3213).
//!
//! # Why the version is read from the binary
//!
//! The `version` an update RPC carries is a caller-supplied label — trusting it
//! for a downgrade decision would let any caller dress an old binary up as a new
//! one. The Ed25519 signature (AGT-005) covers only the binary's SHA-256, not a
//! version string. So the policy reads the version **out of the binary itself**:
//! every agent build embeds one [`MARKER_PREFIX`]`<version>\0` record (see
//! [`BUILD_VERSION_MARKER`]). Once the signature has proven the bytes are a
//! genuine termiHub build, the version embedded in them is authentic too.
//!
//! # The policy
//!
//! Given the running agent's version `current`, the staged binary's embedded
//! version `candidate`, and an optional desktop-supplied `pinned` version:
//!
//! - a `pinned` version that is set must equal `candidate` — a pin names an
//!   exact binary;
//! - `candidate >= current` (an upgrade, or a same-version reinstall) is allowed;
//! - `candidate < current` (a downgrade) is allowed **only** when it is pinned.
//!
//! The RPC layer additionally requires that a pin equals the requesting
//! desktop's own `client_version` (a *matched* downgrade: the desktop may put
//! back the agent that matches itself, nothing else) — see
//! [`check_pin_matches_desktop`].
//!
//! A binary whose version cannot be determined (no marker, or an ambiguous one)
//! is refused in a release build. A debug build (`cargo test`, the `dev.sh`
//! dev loop) tolerates an *unknown* version with a loud warning — mirroring the
//! unsigned-update allowance in [`super::signature`] — but still refuses a
//! known, unpinned downgrade.

use std::io::Read;
use std::path::Path;

use semver::Version;
use tracing::warn;

use super::version::parse_version;

/// Prefix of the embedded build-version record. The version and a terminating
/// NUL follow it. The leading NUL keeps the record from matching in the middle
/// of an unrelated string.
pub const MARKER_PREFIX: &[u8] = b"\0TERMIHUB-AGENT-BUILD-VERSION=";

/// The build-version record embedded in every agent binary.
///
/// Referenced at runtime by [`own_version`] (through `black_box`, so the
/// optimizer can neither drop it nor shrink it to just the version substring),
/// which guarantees the full record survives linking into the shipped binary.
pub static BUILD_VERSION_MARKER: &str = concat!(
    "\0TERMIHUB-AGENT-BUILD-VERSION=",
    env!("CARGO_PKG_VERSION"),
    "\0"
);

/// Longest version string accepted after the prefix. Real versions are far
/// shorter; the cap bounds the scan and rejects garbage.
const MAX_VERSION_LEN: usize = 64;

/// Read-chunk size of the binary scan.
const SCAN_CHUNK: usize = 64 * 1024;

/// This agent's own version, read from its embedded build-version record.
pub fn own_version() -> &'static str {
    let marker: &'static str = std::hint::black_box(BUILD_VERSION_MARKER);
    marker
        .trim_start_matches('\0')
        .trim_start_matches("TERMIHUB-AGENT-BUILD-VERSION=")
        .trim_end_matches('\0')
}

/// Why an update was refused by the downgrade policy. Every variant is a
/// **fail-closed** refusal, surfaced to the desktop as
/// `UPDATE_DOWNGRADE_REFUSED`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VersionPolicyError {
    /// The binary's embedded build version could not be determined.
    #[error("cannot determine the version of the agent update binary: {0} (fail closed)")]
    UnknownVersion(String),
    /// The binary is older than the running agent and no matched pin allows it.
    #[error(
        "refusing to downgrade the agent from {current} to {candidate}: a downgrade is only \
         accepted when the desktop pins it to its own version"
    )]
    Downgrade { current: String, candidate: String },
    /// A pin was given but the binary is a different version.
    #[error("the agent update binary is version {candidate}, not the pinned version {pinned}")]
    PinnedVersionMismatch { pinned: String, candidate: String },
    /// A pin was given that is not the requesting desktop's own version.
    #[error(
        "the pinned version {pinned} does not match the requesting desktop's version {desktop} \
         — only a matched downgrade is accepted"
    )]
    PinNotDesktopVersion { pinned: String, desktop: String },
    /// A pin (or the running version) is not a valid semantic version.
    #[error("invalid version: {0}")]
    InvalidVersion(String),
}

/// The downgrade policy for this build (see the module docs).
#[derive(Debug, Clone)]
pub struct VersionPolicy {
    current: String,
    allow_unknown: bool,
}

impl VersionPolicy {
    /// The policy compiled into this build: the running version, with the
    /// unknown-version allowance on **only** when `debug_assertions` is on.
    pub fn for_build() -> Self {
        Self {
            current: own_version().to_string(),
            allow_unknown: cfg!(debug_assertions),
        }
    }

    /// A strict policy (release-build rule) for an agent running `current`.
    /// Used by tests to exercise the production behaviour from a debug build.
    #[cfg(test)]
    pub fn strict(current: &str) -> Self {
        Self {
            current: current.to_string(),
            allow_unknown: false,
        }
    }

    /// Check the binary at `path` against the policy, reading its embedded
    /// build version.
    pub fn check_binary(
        &self,
        path: &Path,
        pinned: Option<&str>,
    ) -> Result<(), VersionPolicyError> {
        match read_binary_version(path) {
            Ok(candidate) => self.check(&candidate, pinned),
            Err(e) if self.allow_unknown => {
                warn!(
                    "!!! DEBUG BUILD: applying an agent update whose version is unknown ({e}) — \
                     the downgrade check is skipped only because this agent was built with \
                     debug_assertions. A release build refuses this update (SEC-006). !!!"
                );
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    /// Check an already-known `candidate` version against the policy.
    pub fn check(
        &self,
        candidate: &Version,
        pinned: Option<&str>,
    ) -> Result<(), VersionPolicyError> {
        let current = parse_version(&self.current)
            .map_err(|e| VersionPolicyError::InvalidVersion(format!("{e:#}")))?;
        if let Some(pinned) = pinned {
            let pinned_version = parse_version(pinned)
                .map_err(|e| VersionPolicyError::InvalidVersion(format!("{e:#}")))?;
            if &pinned_version != candidate {
                return Err(VersionPolicyError::PinnedVersionMismatch {
                    pinned: pinned_version.to_string(),
                    candidate: candidate.to_string(),
                });
            }
            // A pin that names the binary exactly authorises it, downgrade or not
            // (the RPC layer has already bound the pin to the desktop version).
            return Ok(());
        }
        if candidate < &current {
            return Err(VersionPolicyError::Downgrade {
                current: current.to_string(),
                candidate: candidate.to_string(),
            });
        }
        Ok(())
    }
}

/// Require a desktop-supplied `pinned` version to equal the requesting
/// desktop's own `desktop_version` (its `initialize` `client_version`). This is
/// what makes a pinned downgrade a *matched* one.
pub fn check_pin_matches_desktop(
    pinned: &str,
    desktop_version: Option<&str>,
) -> Result<(), VersionPolicyError> {
    let pinned_version =
        parse_version(pinned).map_err(|e| VersionPolicyError::InvalidVersion(format!("{e:#}")))?;
    let desktop = desktop_version.unwrap_or("unknown");
    match parse_version(desktop) {
        Ok(desktop_version) if desktop_version == pinned_version => Ok(()),
        _ => Err(VersionPolicyError::PinNotDesktopVersion {
            pinned: pinned_version.to_string(),
            desktop: desktop.to_string(),
        }),
    }
}

/// Read the embedded build version of the agent binary at `path`.
///
/// Scans the file for [`MARKER_PREFIX`] records and parses the version after
/// each. Exactly one distinct valid version must be found; none, or more than
/// one distinct version, is an [`VersionPolicyError::UnknownVersion`].
pub fn read_binary_version(path: &Path) -> Result<Version, VersionPolicyError> {
    let file = std::fs::File::open(path).map_err(|e| {
        VersionPolicyError::UnknownVersion(format!("cannot open {}: {e}", path.display()))
    })?;
    let versions = scan_versions(file).map_err(|e| {
        VersionPolicyError::UnknownVersion(format!("cannot read {}: {e}", path.display()))
    })?;
    let mut distinct: Vec<Version> = Vec::new();
    for v in versions {
        if !distinct.contains(&v) {
            distinct.push(v);
        }
    }
    match distinct.len() {
        1 => Ok(distinct.remove(0)),
        0 => Err(VersionPolicyError::UnknownVersion(format!(
            "{} carries no embedded build-version record",
            path.display()
        ))),
        n => Err(VersionPolicyError::UnknownVersion(format!(
            "{} carries {n} conflicting build-version records",
            path.display()
        ))),
    }
}

/// Stream `reader` and return every valid version that follows a
/// [`MARKER_PREFIX`]. Chunks overlap by the longest possible record so a record
/// straddling a chunk boundary is still found.
fn scan_versions<R: Read>(mut reader: R) -> std::io::Result<Vec<Version>> {
    let keep = MARKER_PREFIX.len() + MAX_VERSION_LEN + 1;
    let mut found = Vec::new();
    let mut buf: Vec<u8> = Vec::with_capacity(SCAN_CHUNK + keep);
    let mut chunk = vec![0u8; SCAN_CHUNK];
    loop {
        let n = reader.read(&mut chunk)?;
        let eof = n == 0;
        buf.extend_from_slice(&chunk[..n]);

        // Records that start early enough to be complete in `buf` are parsed
        // now; at EOF every remaining position is final.
        let limit = if eof {
            buf.len()
        } else {
            buf.len().saturating_sub(keep)
        };
        let mut i = 0;
        while i < limit {
            let Some(pos) = find(&buf[i..], MARKER_PREFIX) else {
                break;
            };
            let start = i + pos;
            if start >= limit {
                break;
            }
            if let Some(v) = parse_record(&buf[start + MARKER_PREFIX.len()..]) {
                found.push(v);
            }
            i = start + 1;
        }
        if eof {
            return Ok(found);
        }
        // Every record starting before `limit` has been parsed; keep the tail,
        // which may hold a record that is not complete yet.
        buf.drain(..limit);
    }
}

/// Parse the `<version>\0` that follows a marker prefix, if well formed.
fn parse_record(rest: &[u8]) -> Option<Version> {
    let end = rest
        .iter()
        .take(MAX_VERSION_LEN + 1)
        .position(|&b| b == 0)?;
    let text = std::str::from_utf8(&rest[..end]).ok()?;
    if text.is_empty()
        || !text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
    {
        return None;
    }
    Version::parse(text).ok()
}

/// Position of the first occurrence of `needle` in `haystack`.
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(version: &str) -> Vec<u8> {
        let mut v = MARKER_PREFIX.to_vec();
        v.extend_from_slice(version.as_bytes());
        v.push(0);
        v
    }

    fn write_binary(dir: &Path, name: &str, body: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn own_version_is_the_crate_version() {
        assert_eq!(own_version(), env!("CARGO_PKG_VERSION"));
    }

    /// The record really survives into a linked binary: the running test
    /// executable carries it (the shipped agent is checked by an integration
    /// test against the real `termihub-agent` binary).
    #[test]
    fn the_running_executable_embeds_its_build_version() {
        let _ = own_version();
        let exe = std::env::current_exe().unwrap();
        let v = read_binary_version(&exe).unwrap();
        assert_eq!(v.to_string(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn reads_a_version_surrounded_by_other_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let mut body = vec![0xAAu8; 1000];
        body.extend(record("1.2.3"));
        body.extend(vec![0x55u8; 1000]);
        let path = write_binary(dir.path(), "bin", &body);
        assert_eq!(read_binary_version(&path).unwrap(), Version::new(1, 2, 3));
    }

    #[test]
    fn finds_a_record_straddling_a_chunk_boundary() {
        let dir = tempfile::tempdir().unwrap();
        for offset in [
            SCAN_CHUNK - 5,
            SCAN_CHUNK - MARKER_PREFIX.len(),
            SCAN_CHUNK + 1,
        ] {
            let mut body = vec![0x11u8; offset];
            body.extend(record("0.9.1-rc.1"));
            body.extend(vec![0x22u8; 3 * SCAN_CHUNK]);
            let path = write_binary(dir.path(), "bin", &body);
            assert_eq!(
                read_binary_version(&path).unwrap().to_string(),
                "0.9.1-rc.1",
                "offset {offset}"
            );
        }
    }

    #[test]
    fn record_at_the_very_end_is_found() {
        let dir = tempfile::tempdir().unwrap();
        let mut body = vec![0x11u8; 2 * SCAN_CHUNK + 7];
        body.extend(record("3.0.0"));
        let path = write_binary(dir.path(), "bin", &body);
        assert_eq!(read_binary_version(&path).unwrap(), Version::new(3, 0, 0));
    }

    #[test]
    fn a_binary_without_a_record_has_an_unknown_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_binary(dir.path(), "bin", b"not an agent");
        assert!(matches!(
            read_binary_version(&path),
            Err(VersionPolicyError::UnknownVersion(_))
        ));
    }

    #[test]
    fn conflicting_records_are_an_unknown_version() {
        let dir = tempfile::tempdir().unwrap();
        let mut body = record("1.0.0");
        body.extend(record("2.0.0"));
        let path = write_binary(dir.path(), "bin", &body);
        assert!(matches!(
            read_binary_version(&path),
            Err(VersionPolicyError::UnknownVersion(_))
        ));
    }

    #[test]
    fn duplicate_identical_records_and_a_bare_prefix_are_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        // A bare prefix (as the search needle itself may appear in a binary)
        // followed by junk is ignored; identical records count once.
        let mut body = MARKER_PREFIX.to_vec();
        body.extend_from_slice(b"\x01\x02junk");
        body.extend(record("1.0.0"));
        body.extend(record("1.0.0"));
        let path = write_binary(dir.path(), "bin", &body);
        assert_eq!(read_binary_version(&path).unwrap(), Version::new(1, 0, 0));
    }

    // ── policy ─────────────────────────────────────────────────────────

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn upgrades_and_same_version_reinstalls_are_allowed() {
        let policy = VersionPolicy::strict("0.5.0");
        assert!(policy.check(&v("0.6.0"), None).is_ok());
        assert!(policy.check(&v("0.5.0"), None).is_ok());
    }

    #[test]
    fn an_unpinned_downgrade_is_refused() {
        let policy = VersionPolicy::strict("0.5.0");
        assert_eq!(
            policy.check(&v("0.4.9"), None),
            Err(VersionPolicyError::Downgrade {
                current: "0.5.0".into(),
                candidate: "0.4.9".into()
            })
        );
    }

    #[test]
    fn a_pinned_downgrade_matching_the_binary_is_allowed() {
        let policy = VersionPolicy::strict("0.5.0");
        assert!(policy.check(&v("0.4.0"), Some("0.4.0")).is_ok());
        assert!(policy.check(&v("0.4.0"), Some("v0.4.0")).is_ok());
    }

    #[test]
    fn a_pin_that_does_not_name_the_binary_is_refused() {
        let policy = VersionPolicy::strict("0.5.0");
        assert!(matches!(
            policy.check(&v("0.3.0"), Some("0.4.0")),
            Err(VersionPolicyError::PinnedVersionMismatch { .. })
        ));
        // Also for an upgrade: a pin names an exact binary.
        assert!(matches!(
            policy.check(&v("0.6.0"), Some("0.4.0")),
            Err(VersionPolicyError::PinnedVersionMismatch { .. })
        ));
    }

    #[test]
    fn an_invalid_pin_is_refused() {
        let policy = VersionPolicy::strict("0.5.0");
        assert!(matches!(
            policy.check(&v("0.4.0"), Some("not-a-version")),
            Err(VersionPolicyError::InvalidVersion(_))
        ));
    }

    #[test]
    fn strict_policy_refuses_an_unknown_binary_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_binary(dir.path(), "bin", b"no record here");
        let policy = VersionPolicy::strict("0.5.0");
        assert!(matches!(
            policy.check_binary(&path, None),
            Err(VersionPolicyError::UnknownVersion(_))
        ));
    }

    #[test]
    fn check_binary_applies_the_policy_to_the_embedded_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_binary(dir.path(), "bin", &record("0.4.0"));
        let policy = VersionPolicy::strict("0.5.0");
        assert!(matches!(
            policy.check_binary(&path, None),
            Err(VersionPolicyError::Downgrade { .. })
        ));
        assert!(policy.check_binary(&path, Some("0.4.0")).is_ok());
    }

    #[test]
    fn pin_must_match_the_requesting_desktop_version() {
        assert!(check_pin_matches_desktop("0.4.0", Some("0.4.0")).is_ok());
        assert!(check_pin_matches_desktop("v0.4.0", Some("0.4.0")).is_ok());
        assert_eq!(
            check_pin_matches_desktop("0.4.0", Some("0.5.0")),
            Err(VersionPolicyError::PinNotDesktopVersion {
                pinned: "0.4.0".into(),
                desktop: "0.5.0".into()
            })
        );
        assert!(matches!(
            check_pin_matches_desktop("0.4.0", None),
            Err(VersionPolicyError::PinNotDesktopVersion { .. })
        ));
        assert!(matches!(
            check_pin_matches_desktop("0.4.0", Some("garbage")),
            Err(VersionPolicyError::PinNotDesktopVersion { .. })
        ));
    }
}

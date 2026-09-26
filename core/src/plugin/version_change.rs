//! Version comparison for plugin install/update (PLG-012).
//!
//! Installing a plugin whose id is already installed *replaces* the installed
//! copy. Before this module that replace was blind: an **older** build could
//! silently clobber a newer one, and a *different* build shipped under the same
//! version string was indistinguishable from a harmless reinstall.
//!
//! [`classify_version_change`] compares the incoming package against the
//! installed plugin and decides whether the replace is safe to perform silently
//! (a fresh install, an upgrade, or a byte-identical reinstall) or needs the
//! user's explicit confirmation (a downgrade, a same-version build with
//! different content, or a version that cannot be compared). The decision is
//! made by the backend, so no frontend can skip it — the
//! [`PluginManager`](super::PluginManager) refuses an unconfirmed replace with
//! [`PluginManagerError::VersionChangeUnconfirmed`](super::PluginManagerError::VersionChangeUnconfirmed).
//!
//! # Comparison rules
//!
//! Versions are compared as [Semantic Versioning 2.0](https://semver.org)
//! **precedence** (build metadata ignored, a pre-release sorts below its
//! release):
//!
//! | Installed → incoming | Result |
//! | --- | --- |
//! | not installed | [`Fresh`](VersionChangeKind::Fresh) — proceeds |
//! | `1.2.0` → `1.4.0` | [`Upgrade`](VersionChangeKind::Upgrade) — proceeds |
//! | `1.2.0` → `1.2.0`, same package hash | [`Reinstall`](VersionChangeKind::Reinstall) — proceeds |
//! | `1.2.0` → `1.2.0`, different / unknown hash | [`SameVersionChanged`](VersionChangeKind::SameVersionChanged) — **confirm** |
//! | `1.4.0` → `1.2.0` | [`Downgrade`](VersionChangeKind::Downgrade) — **confirm** |
//! | `1.2.0` → `1.2.0-beta.1` | [`Downgrade`](VersionChangeKind::Downgrade) — **confirm** |
//! | either side not valid semver | [`Unverifiable`](VersionChangeKind::Unverifiable) — **confirm** |
//!
//! Anything that cannot be proven safe fails closed to "confirm": an
//! unparseable version, a missing recorded hash, or an installed plugin whose
//! manifest cannot be read.

use std::cmp::Ordering;

use semver::Version;
use serde::{Deserialize, Serialize};

/// How an incoming plugin package relates to the installed copy of the same id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VersionChangeKind {
    /// No plugin with this id is installed.
    Fresh,
    /// The incoming version is newer than the installed one.
    Upgrade,
    /// Same version and byte-identical package — a harmless reinstall.
    Reinstall,
    /// Same version, but the package content differs from (or cannot be
    /// matched against) what was installed — a different build under the same
    /// version string.
    SameVersionChanged,
    /// The incoming version is older than the installed one.
    Downgrade,
    /// At least one side is not a valid semantic version (or the installed
    /// version could not be read), so the direction of the change is unknown.
    Unverifiable,
}

impl VersionChangeKind {
    /// Whether replacing the installed plugin with this change needs the user's
    /// explicit confirmation.
    #[must_use]
    pub fn requires_confirmation(self) -> bool {
        matches!(
            self,
            Self::SameVersionChanged | Self::Downgrade | Self::Unverifiable
        )
    }
}

/// A classified install/update: the kind of change plus both versions, as the
/// confirmation prompt shows them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionChange {
    /// The plugin id being installed.
    pub plugin_id: String,
    /// The display name from the incoming manifest.
    pub plugin_name: String,
    /// The installed version, when a plugin with this id is installed and its
    /// manifest is readable.
    pub installed_version: Option<String>,
    /// The incoming package's version.
    pub incoming_version: String,
    /// How the incoming package relates to the installed one.
    pub kind: VersionChangeKind,
}

impl VersionChange {
    /// Whether this change needs explicit confirmation before it is applied.
    #[must_use]
    pub fn requires_confirmation(&self) -> bool {
        self.kind.requires_confirmation()
    }
}

/// What is known about the currently installed copy of a plugin id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstalledSnapshot<'a> {
    /// Nothing is installed under this id.
    Absent,
    /// A plugin directory exists but its manifest could not be read, so its
    /// version is unknown.
    Unreadable,
    /// An installed plugin with a readable manifest.
    Present {
        /// The installed manifest's `version`.
        version: &'a str,
        /// The `sha256:`-prefixed digest of the package it was installed from,
        /// if one was recorded (installs predating PLG-012 have none).
        package_sha256: Option<&'a str>,
    },
}

/// Parse a manifest version as strict semantic versioning, tolerating
/// surrounding whitespace only.
fn parse_version(raw: &str) -> Option<Version> {
    Version::parse(raw.trim()).ok()
}

/// Classify replacing `installed` with an incoming package of
/// `incoming_version` whose content hash is `incoming_sha256`.
///
/// See the [module docs](self) for the full rule table. The result never
/// errs on the side of "silent": anything not provably a fresh install, an
/// upgrade, or an identical reinstall requires confirmation.
#[must_use]
pub fn classify_version_change(
    installed: InstalledSnapshot<'_>,
    incoming_version: &str,
    incoming_sha256: &str,
) -> VersionChangeKind {
    let (installed_version, installed_sha256) = match installed {
        InstalledSnapshot::Absent => return VersionChangeKind::Fresh,
        InstalledSnapshot::Unreadable => return VersionChangeKind::Unverifiable,
        InstalledSnapshot::Present {
            version,
            package_sha256,
        } => (version, package_sha256),
    };
    // Identical bytes are a reinstall only when the recorded hash matches; an
    // absent hash (pre-PLG-012 install) cannot prove identity.
    let same_bytes = installed_sha256.is_some_and(|h| h.eq_ignore_ascii_case(incoming_sha256));

    match (
        parse_version(installed_version),
        parse_version(incoming_version),
    ) {
        (Some(old), Some(new)) => match new.cmp_precedence(&old) {
            Ordering::Greater => VersionChangeKind::Upgrade,
            Ordering::Less => VersionChangeKind::Downgrade,
            Ordering::Equal if same_bytes => VersionChangeKind::Reinstall,
            Ordering::Equal => VersionChangeKind::SameVersionChanged,
        },
        // Unparseable on either side: only a byte-identical reinstall of the
        // exact same version string is provably safe.
        _ if same_bytes && installed_version.trim() == incoming_version.trim() => {
            VersionChangeKind::Reinstall
        }
        _ => VersionChangeKind::Unverifiable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H1: &str = "aa11";
    const H2: &str = "bb22";

    fn present<'a>(version: &'a str, hash: Option<&'a str>) -> InstalledSnapshot<'a> {
        InstalledSnapshot::Present {
            version,
            package_sha256: hash,
        }
    }

    #[test]
    fn fresh_install_needs_no_confirmation() {
        let kind = classify_version_change(InstalledSnapshot::Absent, "1.0.0", H1);
        assert_eq!(kind, VersionChangeKind::Fresh);
        assert!(!kind.requires_confirmation());
    }

    #[test]
    fn compare_matrix() {
        use VersionChangeKind::*;
        // (installed, installed hash, incoming, incoming hash, expected)
        let cases: &[(&str, Option<&str>, &str, &str, VersionChangeKind)] = &[
            // Newer.
            ("1.2.0", Some(H1), "1.4.0", H2, Upgrade),
            ("1.2.0", None, "2.0.0", H2, Upgrade),
            ("1.2.0", Some(H1), "1.2.1", H2, Upgrade),
            ("1.2.0-beta.1", Some(H1), "1.2.0", H2, Upgrade),
            ("1.2.0-alpha", Some(H1), "1.2.0-beta", H2, Upgrade),
            // Same version.
            ("1.2.0", Some(H1), "1.2.0", H1, Reinstall),
            ("1.2.0", Some("AA11"), "1.2.0", H1, Reinstall),
            ("1.2.0", Some(H1), "1.2.0", H2, SameVersionChanged),
            ("1.2.0", None, "1.2.0", H1, SameVersionChanged),
            // Build metadata does not affect precedence.
            ("1.2.0+build.1", Some(H1), "1.2.0+build.2", H2, SameVersionChanged),
            // Older.
            ("1.4.0", Some(H1), "1.2.0", H2, Downgrade),
            ("2.0.0", Some(H1), "1.9.9", H2, Downgrade),
            ("1.2.0", Some(H1), "1.2.0-rc.1", H2, Downgrade),
            ("1.2.0-beta", Some(H1), "1.2.0-alpha", H2, Downgrade),
            // Invalid / unparseable on either side.
            ("1.2", Some(H1), "1.4.0", H2, Unverifiable),
            ("1.2.0", Some(H1), "v1.4.0", H2, Unverifiable),
            ("latest", Some(H1), "nightly", H2, Unverifiable),
            ("latest", None, "latest", H1, Unverifiable),
            ("latest", Some(H1), "latest", H1, Reinstall),
        ];
        for (installed, hash, incoming, incoming_hash, expected) in cases {
            let got = classify_version_change(present(installed, *hash), incoming, incoming_hash);
            assert_eq!(
                got, *expected,
                "{installed} ({hash:?}) -> {incoming} ({incoming_hash})"
            );
        }
    }

    #[test]
    fn unreadable_installed_manifest_is_unverifiable() {
        let kind = classify_version_change(InstalledSnapshot::Unreadable, "1.0.0", H1);
        assert_eq!(kind, VersionChangeKind::Unverifiable);
        assert!(kind.requires_confirmation());
    }

    #[test]
    fn only_risky_kinds_require_confirmation() {
        use VersionChangeKind::*;
        for kind in [Fresh, Upgrade, Reinstall] {
            assert!(!kind.requires_confirmation(), "{kind:?}");
        }
        for kind in [SameVersionChanged, Downgrade, Unverifiable] {
            assert!(kind.requires_confirmation(), "{kind:?}");
        }
    }

    #[test]
    fn serializes_camel_case_for_the_frontend() {
        let change = VersionChange {
            plugin_id: "p".into(),
            plugin_name: "P".into(),
            installed_version: Some("1.4.0".into()),
            incoming_version: "1.2.0".into(),
            kind: VersionChangeKind::SameVersionChanged,
        };
        let json = serde_json::to_value(&change).unwrap();
        assert_eq!(json["pluginId"], "p");
        assert_eq!(json["installedVersion"], "1.4.0");
        assert_eq!(json["incomingVersion"], "1.2.0");
        assert_eq!(json["kind"], "sameVersionChanged");
    }
}

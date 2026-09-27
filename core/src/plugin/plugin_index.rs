//! Curated plugin **index** — the network-free half of in-app plugin discovery
//! (PROD-048).
//!
//! A plugin index is a small JSON document, hosted by the termiHub maintainer
//! (or, if the user points the setting elsewhere, by someone they chose), that
//! lists installable plugins:
//!
//! ```json
//! {
//!   "schemaVersion": 1,
//!   "plugins": [
//!     {
//!       "id": "my-plugin",
//!       "name": "My Plugin",
//!       "description": "What it does.",
//!       "author": "Jane Doe",
//!       "version": "1.2.0",
//!       "homepage": "https://example.com/my-plugin",
//!       "minHostAbi": "1.1",
//!       "native": true,
//!       "toolchain": { "rustc": "1.98.0 (88d9e12ae)", "panicStrategy": "unwind" },
//!       "packages": [
//!         {
//!           "platforms": ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"],
//!           "url": "https://example.com/my-plugin-1.2.0.termihub-plugin",
//!           "sha256": "<64 hex digits>"
//!         }
//!       ]
//!     }
//!   ]
//! }
//! ```
//!
//! This module owns strict parsing / validation ([`parse_plugin_index`]) and the
//! per-entry compatibility decision for this host ([`evaluate_index_entry`]). The
//! desktop crate does the (size-capped, HTTPS-only, redirect-bounded) fetching,
//! the streamed download, and the SHA-256 check; the downloaded package then
//! goes through the **unchanged** local install pipeline (package validation,
//! signature / trust gate, native-trust acknowledgement, version-change
//! confirmation). The index is a *discovery* aid, never a trust anchor: nothing
//! listed here is installed, enabled or trusted without the user.
//!
//! Rules, all failing closed:
//!
//! * The document is capped at [`MAX_INDEX_BYTES`] and [`MAX_INDEX_ENTRIES`];
//!   unknown fields are rejected, and `schemaVersion` must be
//!   [`INDEX_SCHEMA_VERSION`].
//! * Every `id` is a valid plugin id and unique; `version` is semver;
//!   `minHostAbi` canonical `major.minor`; every URL `https://`; every `sha256`
//!   exactly 64 hex digits; every platform a well-formed target triple or
//!   [`ANY_PLATFORM`].
//! * Free-text fields are length-capped and must not contain control
//!   characters (they are displayed verbatim, never rendered as markup).

use std::collections::{BTreeMap, BTreeSet};

use semver::Version;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use termihub_plugin_api::{AbiVersion, PanicStrategy, Toolchain, CURRENT_PLUGIN_ABI_VERSION};

use super::manifest::is_valid_plugin_id;
use super::platform::{host_target_triple, is_valid_target_triple};
use super::update_check::validate_https_url;

/// The only index schema version this host understands.
pub const INDEX_SCHEMA_VERSION: u32 = 1;

/// Maximum size of an index document, in bytes (1 MiB).
pub const MAX_INDEX_BYTES: usize = 1024 * 1024;

/// Maximum number of plugins one index may list.
pub const MAX_INDEX_ENTRIES: usize = 1000;

/// Maximum number of packages one entry may list.
pub const MAX_PACKAGES_PER_ENTRY: usize = 16;

/// Maximum number of platforms one package may list.
pub const MAX_PLATFORMS_PER_PACKAGE: usize = 16;

/// Maximum length of the `name` / `author` fields.
pub const MAX_SHORT_TEXT_LEN: usize = 128;

/// Maximum length of the `description` field.
pub const MAX_DESCRIPTION_LEN: usize = 1024;

/// Platform marker for a package with no native code, installable everywhere.
pub const ANY_PLATFORM: &str = "any";

/// The whole index document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginIndex {
    /// Must equal [`INDEX_SCHEMA_VERSION`].
    pub schema_version: u32,
    /// The listed plugins.
    pub plugins: Vec<PluginIndexEntry>,
}

/// One listed plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginIndexEntry {
    /// The plugin id; must match the package's manifest id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// One-paragraph description.
    pub description: String,
    /// Author / publisher as the index maintainer lists it (display only — the
    /// package's own signature, not this field, identifies the publisher).
    pub author: String,
    /// The listed version; must match the package's manifest version.
    pub version: String,
    /// Optional HTTPS project page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    /// The plugin ABI (`"major.minor"`) the listed version needs from the host.
    pub min_host_abi: String,
    /// Whether the plugin ships native (in-process) code.
    #[serde(default)]
    pub native: bool,
    /// The build-toolchain record of the native library (ABI 1.1, PLG-013).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toolchain: Option<IndexToolchain>,
    /// Downloadable packages, each covering one or more platforms.
    pub packages: Vec<PluginIndexPackage>,
}

/// The toolchain record as listed in the index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexToolchain {
    /// `"<release> (<commit-hash>)"`, exactly as the plugin API records it.
    pub rustc: String,
    /// `"unwind"` or `"abort"`.
    pub panic_strategy: String,
}

impl IndexToolchain {
    fn to_toolchain(&self) -> Toolchain {
        Toolchain {
            rustc: self.rustc.clone(),
            panic_strategy: match self.panic_strategy.as_str() {
                "unwind" => PanicStrategy::Unwind,
                "abort" => PanicStrategy::Abort,
                _ => PanicStrategy::Unknown,
            },
        }
    }
}

/// One downloadable package of a listed plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginIndexPackage {
    /// Target triples this package supports, or `["any"]`.
    pub platforms: Vec<String>,
    /// HTTPS download URL of the `.termihub-plugin` file.
    pub url: String,
    /// SHA-256 of the package file, as 64 hex digits.
    pub sha256: String,
}

/// Why an index document was rejected.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum PluginIndexError {
    /// The document exceeds [`MAX_INDEX_BYTES`].
    #[error("plugin index is larger than the {limit}-byte limit")]
    TooLarge {
        /// The enforced limit, in bytes.
        limit: usize,
    },
    /// Not valid JSON of the expected shape (including unknown fields).
    #[error("plugin index is malformed: {0}")]
    Malformed(String),
    /// A schema version this host does not understand.
    #[error("plugin index schema version {0} is not supported (expected {INDEX_SCHEMA_VERSION})")]
    UnsupportedSchema(u32),
    /// A structurally valid document with an invalid value.
    #[error("plugin index entry `{entry}`: field `{field}` is invalid: {reason}")]
    InvalidField {
        /// The entry id (or its position when the id itself is bad).
        entry: String,
        /// The offending field (JSON name).
        field: &'static str,
        /// Human-readable reason.
        reason: String,
    },
    /// Two entries share one id.
    #[error("plugin index lists `{0}` more than once")]
    DuplicateId(String),
}

/// Whether `sha256` is exactly 64 hex digits.
#[must_use]
pub fn is_valid_sha256_hex(sha256: &str) -> bool {
    sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit())
}

fn check_text(value: &str, max: usize, allow_newlines: bool) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("must not be empty".into());
    }
    if value.chars().count() > max {
        return Err(format!("longer than {max} characters"));
    }
    if value
        .chars()
        .any(|c| c.is_control() && !(allow_newlines && c == '\n'))
    {
        return Err("contains control characters".into());
    }
    Ok(())
}

/// Parse and strictly validate an index document from raw response bytes.
pub fn parse_plugin_index(bytes: &[u8]) -> Result<PluginIndex, PluginIndexError> {
    if bytes.len() > MAX_INDEX_BYTES {
        return Err(PluginIndexError::TooLarge {
            limit: MAX_INDEX_BYTES,
        });
    }
    let index: PluginIndex =
        serde_json::from_slice(bytes).map_err(|e| PluginIndexError::Malformed(e.to_string()))?;
    index.validate()?;
    Ok(index)
}

impl PluginIndex {
    /// Semantic validation of an already-deserialized index.
    pub fn validate(&self) -> Result<(), PluginIndexError> {
        if self.schema_version != INDEX_SCHEMA_VERSION {
            return Err(PluginIndexError::UnsupportedSchema(self.schema_version));
        }
        if self.plugins.len() > MAX_INDEX_ENTRIES {
            return Err(PluginIndexError::Malformed(format!(
                "lists more than {MAX_INDEX_ENTRIES} plugins"
            )));
        }
        let mut seen = BTreeSet::new();
        for (pos, entry) in self.plugins.iter().enumerate() {
            entry.validate(pos)?;
            if !seen.insert(entry.id.as_str()) {
                return Err(PluginIndexError::DuplicateId(entry.id.clone()));
            }
        }
        Ok(())
    }

    /// The entry listed under `id`, if any.
    #[must_use]
    pub fn entry(&self, id: &str) -> Option<&PluginIndexEntry> {
        self.plugins.iter().find(|e| e.id == id)
    }
}

impl PluginIndexEntry {
    fn validate(&self, pos: usize) -> Result<(), PluginIndexError> {
        let entry_name = if is_valid_plugin_id(&self.id) {
            self.id.clone()
        } else {
            format!("#{pos}")
        };
        let invalid = |field: &'static str, reason: String| PluginIndexError::InvalidField {
            entry: entry_name.clone(),
            field,
            reason,
        };
        if !is_valid_plugin_id(&self.id) {
            return Err(invalid("id", "not a valid plugin id".into()));
        }
        check_text(&self.name, MAX_SHORT_TEXT_LEN, false).map_err(|r| invalid("name", r))?;
        check_text(&self.author, MAX_SHORT_TEXT_LEN, false).map_err(|r| invalid("author", r))?;
        check_text(&self.description, MAX_DESCRIPTION_LEN, true)
            .map_err(|r| invalid("description", r))?;
        Version::parse(&self.version)
            .map_err(|e| invalid("version", format!("not a semantic version ({e})")))?;
        if let Some(homepage) = &self.homepage {
            validate_https_url(homepage).map_err(|r| invalid("homepage", r))?;
        }
        if AbiVersion::parse(&self.min_host_abi).is_none() {
            return Err(invalid(
                "minHostAbi",
                "must be a canonical `major.minor` version".into(),
            ));
        }
        if let Some(toolchain) = &self.toolchain {
            if !self.native {
                return Err(invalid(
                    "toolchain",
                    "only a native plugin carries a toolchain record".into(),
                ));
            }
            if !toolchain.to_toolchain().is_known() {
                return Err(invalid(
                    "toolchain",
                    "must name a rustc `<release> (<hash>)` and panicStrategy unwind|abort".into(),
                ));
            }
        }
        if self.packages.is_empty() || self.packages.len() > MAX_PACKAGES_PER_ENTRY {
            return Err(invalid(
                "packages",
                format!("must list 1..={MAX_PACKAGES_PER_ENTRY} packages"),
            ));
        }
        let mut platforms_seen = BTreeSet::new();
        for package in &self.packages {
            validate_https_url(&package.url).map_err(|r| invalid("url", r))?;
            if !is_valid_sha256_hex(&package.sha256) {
                return Err(invalid("sha256", "must be exactly 64 hex digits".into()));
            }
            if package.platforms.is_empty() || package.platforms.len() > MAX_PLATFORMS_PER_PACKAGE {
                return Err(invalid(
                    "platforms",
                    format!("must list 1..={MAX_PLATFORMS_PER_PACKAGE} platforms"),
                ));
            }
            for platform in &package.platforms {
                let any = platform == ANY_PLATFORM;
                if any && self.native {
                    return Err(invalid(
                        "platforms",
                        "a native plugin must list concrete target triples, not `any`".into(),
                    ));
                }
                if !any && !is_valid_target_triple(platform) {
                    return Err(invalid(
                        "platforms",
                        format!("`{platform}` is not a target triple"),
                    ));
                }
                if !platforms_seen.insert(platform.as_str()) {
                    return Err(invalid(
                        "platforms",
                        format!("`{platform}` is listed by more than one package"),
                    ));
                }
            }
        }
        Ok(())
    }

    /// The package to download on a host with target triple `host_triple`: the
    /// one listing that triple, else an `any` package.
    #[must_use]
    pub fn package_for(&self, host_triple: &str) -> Option<&PluginIndexPackage> {
        self.packages
            .iter()
            .find(|p| p.platforms.iter().any(|t| t == host_triple))
            .or_else(|| {
                self.packages
                    .iter()
                    .find(|p| p.platforms.iter().any(|t| t == ANY_PLATFORM))
            })
    }
}

/// How the listed toolchain compares with this host's (native plugins only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolchainStatus {
    /// Not a native plugin — no toolchain involved.
    NotApplicable,
    /// Exactly this host's rustc and panic strategy.
    Match,
    /// A different rustc or panic strategy — the host will refuse to load it.
    Mismatch,
    /// A native plugin that lists no toolchain (ABI 1.0-era build): the loader
    /// decides, and asks for an explicit acceptance.
    Undeclared,
}

/// How a listed plugin relates to what is installed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallStatus {
    /// Not installed.
    NotInstalled,
    /// The listed version is installed.
    Installed,
    /// An older version is installed; the index offers an update.
    UpdateAvailable,
    /// A newer version than listed is installed (never offered as a downgrade).
    InstalledNewer,
}

/// One index entry as the Browse view shows it: the listing plus this host's
/// compatibility verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginIndexEntryView {
    /// The listing.
    pub entry: PluginIndexEntry,
    /// Whether this host's plugin ABI satisfies `minHostAbi`.
    pub abi_compatible: bool,
    /// This host's plugin ABI (`"major.minor"`).
    pub host_abi: String,
    /// Whether a package exists for this host's platform.
    pub platform_supported: bool,
    /// This host's target triple.
    pub host_platform: String,
    /// The toolchain verdict.
    pub toolchain: ToolchainStatus,
    /// The installed version, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    /// Relation to the installed version.
    pub install_status: InstallStatus,
    /// Whether the Install / Update action is offered.
    pub installable: bool,
    /// When not installable (or already current), a short user-facing reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
}

/// The host facts an entry is evaluated against.
#[derive(Debug, Clone)]
pub struct HostFacts {
    /// Target triple.
    pub triple: String,
    /// Plugin ABI.
    pub abi: AbiVersion,
    /// Build toolchain.
    pub toolchain: Toolchain,
}

impl HostFacts {
    /// This running host.
    #[must_use]
    pub fn current() -> Self {
        Self {
            triple: host_target_triple().to_owned(),
            abi: CURRENT_PLUGIN_ABI_VERSION,
            toolchain: Toolchain::current(),
        }
    }
}

/// Evaluate `entry` for `host`, given the installed plugin versions by id.
#[must_use]
pub fn evaluate_index_entry(
    entry: &PluginIndexEntry,
    host: &HostFacts,
    installed: &BTreeMap<String, String>,
) -> PluginIndexEntryView {
    let abi_compatible = AbiVersion::parse(&entry.min_host_abi)
        .is_some_and(|abi| abi.check_host_compatibility(host.abi).is_ok());
    let platform_supported = entry.package_for(&host.triple).is_some();
    let toolchain = if !entry.native {
        ToolchainStatus::NotApplicable
    } else {
        match &entry.toolchain {
            None => ToolchainStatus::Undeclared,
            Some(t)
                if t.to_toolchain()
                    .check_host_compatibility(&host.toolchain)
                    .is_ok() =>
            {
                ToolchainStatus::Match
            }
            Some(_) => ToolchainStatus::Mismatch,
        }
    };
    let installed_version = installed.get(&entry.id).cloned();
    let install_status = match installed_version.as_deref() {
        None => InstallStatus::NotInstalled,
        Some(v) => match (Version::parse(v), Version::parse(&entry.version)) {
            (Ok(have), Ok(listed)) => match listed.cmp_precedence(&have) {
                std::cmp::Ordering::Greater => InstallStatus::UpdateAvailable,
                std::cmp::Ordering::Equal => InstallStatus::Installed,
                std::cmp::Ordering::Less => InstallStatus::InstalledNewer,
            },
            // An unparseable installed version cannot be compared: treat it as
            // "installed" so no update (or downgrade) is ever suggested.
            _ => InstallStatus::Installed,
        },
    };
    let blocked_reason = if !abi_compatible {
        Some(format!(
            "Needs plugin ABI {}; this termiHub provides {}. Update termiHub first.",
            entry.min_host_abi, host.abi
        ))
    } else if !platform_supported {
        Some(format!(
            "Not available for this computer ({}).",
            host.triple
        ))
    } else if toolchain == ToolchainStatus::Mismatch {
        Some(
            "Built with a different Rust toolchain than this termiHub; it would be refused at \
             load time."
                .to_string(),
        )
    } else {
        match install_status {
            InstallStatus::Installed => Some("This version is installed.".to_string()),
            InstallStatus::InstalledNewer => {
                Some("A newer version is already installed.".to_string())
            }
            InstallStatus::NotInstalled | InstallStatus::UpdateAvailable => None,
        }
    };
    PluginIndexEntryView {
        entry: entry.clone(),
        abi_compatible,
        host_abi: host.abi.to_string(),
        platform_supported,
        host_platform: host.triple.clone(),
        toolchain,
        installed_version,
        install_status,
        installable: blocked_reason.is_none(),
        blocked_reason,
    }
}

#[cfg(test)]
#[path = "plugin_index_tests.rs"]
mod tests;

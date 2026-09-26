//! Plugin update check — the pure, network-free half (PROD-051 / PLG-012).
//!
//! termiHub has no plugin registry for 0.1 and never updates a plugin silently.
//! A plugin may instead opt in to an **update check** by declaring an HTTPS
//! `updateUrl` in its manifest. That URL serves a small JSON **update document**:
//!
//! ```json
//! {
//!   "latestVersion": "1.3.0",
//!   "downloadUrl": "https://example.com/my-plugin-1.3.0.termihub-plugin",
//!   "sha256": "<64 hex chars: SHA-256 of the package file>",
//!   "minHostAbi": "1.0",
//!   "changelogUrl": "https://example.com/my-plugin/CHANGELOG"
//! }
//! ```
//!
//! This module owns everything about that document that does not need the
//! network: strict parsing and validation ([`parse_update_document`]), HTTPS URL
//! validation ([`validate_https_url`]), the decision of whether an update is
//! offered ([`evaluate_update`]), and the package-digest check
//! ([`verify_package_sha256`]). The desktop crate does the (size-capped,
//! timed-out, HTTPS-only) fetching and hands the bytes here.
//!
//! Rules, all failing closed:
//!
//! * The document is capped at [`MAX_UPDATE_DOCUMENT_BYTES`], must be UTF-8 JSON,
//!   and unknown fields are rejected.
//! * `latestVersion` must be a valid semantic version; `sha256` exactly 64 hex
//!   digits; `minHostAbi` a canonical `major.minor`; every URL `https://`.
//! * An update is offered only when `latestVersion` is **strictly newer** than
//!   the installed version — an older or equal version is "up to date", so the
//!   check can never lead a user into a downgrade.
//! * A newer version whose `minHostAbi` this host cannot load is reported as
//!   [`UpdateStatus::IncompatibleHost`] and cannot be downloaded.
//!
//! Downloading an offered update only produces a verified package file; it is
//! then installed through the ordinary install flow (trust / signature gate,
//! native-trust re-acknowledgement, version-change confirmation), never directly.

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use termihub_plugin_api::{AbiVersion, CURRENT_PLUGIN_ABI_VERSION};

/// Maximum size of an update document, in bytes. The document is a handful of
/// short fields; anything larger is refused rather than parsed.
pub const MAX_UPDATE_DOCUMENT_BYTES: usize = 64 * 1024;

/// Maximum length of any URL accepted in a manifest or update document.
pub const MAX_UPDATE_URL_LEN: usize = 2048;

/// The update document served at a plugin's `updateUrl`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateDocument {
    /// The newest published version, as a semantic version (`"1.3.0"`).
    pub latest_version: String,
    /// HTTPS URL of the `.termihub-plugin` package for `latest_version`.
    pub download_url: String,
    /// SHA-256 of that package file, as 64 hex digits.
    pub sha256: String,
    /// The plugin ABI (`"major.minor"`) the new version needs from the host.
    pub min_host_abi: String,
    /// Optional HTTPS URL of human-readable release notes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changelog_url: Option<String>,
}

/// Why an update document (or the installed plugin it is compared against) was
/// rejected.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum UpdateCheckError {
    /// The document exceeds [`MAX_UPDATE_DOCUMENT_BYTES`].
    #[error("update document is larger than the {limit}-byte limit")]
    TooLarge {
        /// The enforced limit, in bytes.
        limit: usize,
    },
    /// The document is not valid JSON of the expected shape (including unknown
    /// or missing fields, and non-UTF-8 bytes).
    #[error("update document is malformed: {0}")]
    Malformed(String),
    /// A field has the right type but an invalid value.
    #[error("update document field `{field}` is invalid: {reason}")]
    InvalidField {
        /// The offending field (JSON name).
        field: &'static str,
        /// Human-readable reason.
        reason: String,
    },
    /// The installed plugin's own version is not a semantic version, so no
    /// newer/older decision is possible.
    #[error("installed version `{0}` is not a semantic version; cannot compare")]
    InstalledVersionUnverifiable(String),
}

/// Validate that `url` is an absolute `https://` URL with a host and no
/// embedded credentials, within [`MAX_UPDATE_URL_LEN`]. Returns a short reason
/// on failure.
///
/// This is deliberately a conservative syntactic gate (the desktop fetcher
/// re-parses with a full URL parser and re-checks the scheme on every redirect).
pub fn validate_https_url(url: &str) -> Result<(), String> {
    if url.len() > MAX_UPDATE_URL_LEN {
        return Err(format!("longer than {MAX_UPDATE_URL_LEN} characters"));
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("contains whitespace or control characters".to_string());
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return Err("must be an https:// URL".to_string());
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return Err("must not embed credentials".to_string());
    }
    let host = authority.rsplit_once(':').map_or(authority, |(h, _)| h);
    if host.is_empty() || host.starts_with('.') {
        return Err("has no host".to_string());
    }
    Ok(())
}

/// Parse and strictly validate an update document from raw response bytes.
pub fn parse_update_document(bytes: &[u8]) -> Result<UpdateDocument, UpdateCheckError> {
    if bytes.len() > MAX_UPDATE_DOCUMENT_BYTES {
        return Err(UpdateCheckError::TooLarge {
            limit: MAX_UPDATE_DOCUMENT_BYTES,
        });
    }
    let doc: UpdateDocument =
        serde_json::from_slice(bytes).map_err(|e| UpdateCheckError::Malformed(e.to_string()))?;
    doc.validate()?;
    Ok(doc)
}

impl UpdateDocument {
    /// Semantic validation of an already-deserialized document.
    pub fn validate(&self) -> Result<(), UpdateCheckError> {
        let invalid =
            |field: &'static str, reason: String| UpdateCheckError::InvalidField { field, reason };
        Version::parse(&self.latest_version)
            .map_err(|e| invalid("latestVersion", format!("not a semantic version ({e})")))?;
        validate_https_url(&self.download_url).map_err(|r| invalid("downloadUrl", r))?;
        if self.sha256.len() != 64 || !self.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid(
                "sha256",
                "must be exactly 64 hex digits".to_string(),
            ));
        }
        if AbiVersion::parse(&self.min_host_abi).is_none() {
            return Err(invalid(
                "minHostAbi",
                "must be a canonical `major.minor` version".to_string(),
            ));
        }
        if let Some(changelog) = &self.changelog_url {
            validate_https_url(changelog).map_err(|r| invalid("changelogUrl", r))?;
        }
        Ok(())
    }
}

/// The result of comparing an update document against the installed plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    /// The published version is not newer than the installed one.
    UpToDate,
    /// A newer version is published and this host can load it.
    UpdateAvailable,
    /// A newer version is published but needs a plugin ABI this host does not
    /// support (update termiHub first).
    IncompatibleHost,
}

/// An evaluated update check for one plugin, as shown by the Plugins view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckOutcome {
    /// The plugin id checked.
    pub plugin_id: String,
    /// The installed version.
    pub installed_version: String,
    /// The version the update document advertises.
    pub latest_version: String,
    /// Whether an update is offered.
    pub status: UpdateStatus,
    /// Where the package for `latest_version` is downloaded from.
    pub download_url: String,
    /// The package's expected SHA-256 (lowercase hex).
    pub sha256: String,
    /// The plugin ABI the new version needs.
    pub min_host_abi: String,
    /// Optional release-notes link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changelog_url: Option<String>,
}

/// Decide whether `doc` offers an update over `installed_version`, against this
/// host's plugin ABI ([`CURRENT_PLUGIN_ABI_VERSION`]).
pub fn evaluate_update(
    plugin_id: &str,
    installed_version: &str,
    doc: &UpdateDocument,
) -> Result<UpdateCheckOutcome, UpdateCheckError> {
    evaluate_update_for_host(
        plugin_id,
        installed_version,
        doc,
        CURRENT_PLUGIN_ABI_VERSION,
    )
}

/// [`evaluate_update`] against an explicit host ABI (for tests).
fn evaluate_update_for_host(
    plugin_id: &str,
    installed_version: &str,
    doc: &UpdateDocument,
    host_abi: AbiVersion,
) -> Result<UpdateCheckOutcome, UpdateCheckError> {
    doc.validate()?;
    let installed = Version::parse(installed_version).map_err(|_| {
        UpdateCheckError::InstalledVersionUnverifiable(installed_version.to_string())
    })?;
    // Validated above, so this cannot fail; map defensively rather than unwrap.
    let latest =
        Version::parse(&doc.latest_version).map_err(|e| UpdateCheckError::InvalidField {
            field: "latestVersion",
            reason: e.to_string(),
        })?;
    let status = if latest.cmp_precedence(&installed).is_le() {
        UpdateStatus::UpToDate
    } else if AbiVersion::parse(&doc.min_host_abi)
        .is_some_and(|abi| abi.check_host_compatibility(host_abi).is_ok())
    {
        UpdateStatus::UpdateAvailable
    } else {
        UpdateStatus::IncompatibleHost
    };
    Ok(UpdateCheckOutcome {
        plugin_id: plugin_id.to_string(),
        installed_version: installed_version.to_string(),
        latest_version: doc.latest_version.clone(),
        status,
        download_url: doc.download_url.clone(),
        sha256: doc.sha256.to_ascii_lowercase(),
        min_host_abi: doc.min_host_abi.clone(),
        changelog_url: doc.changelog_url.clone(),
    })
}

/// Whether `bytes` hash to `expected_hex` (64 hex digits, case-insensitive).
#[must_use]
pub fn verify_package_sha256(bytes: &[u8], expected_hex: &str) -> bool {
    hex::encode(Sha256::digest(bytes)).eq_ignore_ascii_case(expected_hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn doc_json(latest: &str, abi: &str) -> String {
        format!(
            r#"{{"latestVersion":"{latest}","downloadUrl":"https://example.com/p.termihub-plugin","sha256":"{SHA}","minHostAbi":"{abi}","changelogUrl":"https://example.com/changes"}}"#
        )
    }

    fn doc(latest: &str, abi: &str) -> UpdateDocument {
        parse_update_document(doc_json(latest, abi).as_bytes()).expect("valid doc")
    }

    #[test]
    fn parses_a_valid_document() {
        let d = doc("1.3.0", "1.0");
        assert_eq!(d.latest_version, "1.3.0");
        assert_eq!(
            d.changelog_url.as_deref(),
            Some("https://example.com/changes")
        );
    }

    #[test]
    fn changelog_url_is_optional() {
        let json = format!(
            r#"{{"latestVersion":"1.0.1","downloadUrl":"https://e.com/p","sha256":"{SHA}","minHostAbi":"1.0"}}"#
        );
        assert!(parse_update_document(json.as_bytes())
            .unwrap()
            .changelog_url
            .is_none());
    }

    #[test]
    fn rejects_bad_json_and_unknown_or_missing_fields() {
        for bad in [
            "not json".to_string(),
            "[]".to_string(),
            doc_json("1.3.0", "1.0").replace("\"minHostAbi\"", "\"minHostApi\""),
            doc_json("1.3.0", "1.0").replace("}", ",\"extra\":1}"),
            format!(r#"{{"latestVersion":"1.0.0","sha256":"{SHA}","minHostAbi":"1.0"}}"#),
        ] {
            assert!(
                matches!(
                    parse_update_document(bad.as_bytes()),
                    Err(UpdateCheckError::Malformed(_))
                ),
                "should reject {bad}"
            );
        }
        assert!(matches!(
            parse_update_document(&[0xff, 0xfe, 0x00]),
            Err(UpdateCheckError::Malformed(_))
        ));
    }

    #[test]
    fn rejects_oversize_documents_before_parsing() {
        let big = vec![b' '; MAX_UPDATE_DOCUMENT_BYTES + 1];
        assert_eq!(
            parse_update_document(&big),
            Err(UpdateCheckError::TooLarge {
                limit: MAX_UPDATE_DOCUMENT_BYTES
            })
        );
    }

    #[test]
    fn rejects_invalid_field_values() {
        let cases = [
            (doc_json("1.3", "1.0"), "latestVersion"),
            (doc_json("latest", "1.0"), "latestVersion"),
            (doc_json("1.3.0", "1"), "minHostAbi"),
            (doc_json("1.3.0", "one.zero"), "minHostAbi"),
            (
                doc_json("1.3.0", "1.0").replace("https://example.com/p", "http://example.com/p"),
                "downloadUrl",
            ),
            (
                doc_json("1.3.0", "1.0").replace("https://example.com/changes", "ftp://x/y"),
                "changelogUrl",
            ),
            (doc_json("1.3.0", "1.0").replace(SHA, "abc"), "sha256"),
            (
                doc_json("1.3.0", "1.0").replace(SHA, &"z".repeat(64)),
                "sha256",
            ),
        ];
        for (json, field) in cases {
            match parse_update_document(json.as_bytes()) {
                Err(UpdateCheckError::InvalidField { field: f, .. }) => assert_eq!(f, field),
                other => panic!("expected {field} rejection, got {other:?}"),
            }
        }
    }

    #[test]
    fn https_url_validation() {
        for good in [
            "https://example.com/u.json",
            "https://example.com:8443/u",
            "https://a.b/c?d#e",
        ] {
            assert!(validate_https_url(good).is_ok(), "{good}");
        }
        let too_long = format!("https://e.com/{}", "a".repeat(MAX_UPDATE_URL_LEN));
        for bad in [
            "http://example.com/u.json",
            "HTTP://example.com",
            "file:///etc/passwd",
            "https://",
            "https:///path",
            "https://user:pw@example.com/u",
            "https://exa mple.com",
            "https://example.com/\n",
            "//example.com",
            too_long.as_str(),
        ] {
            assert!(
                validate_https_url(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn offers_only_strictly_newer_versions() {
        let host = AbiVersion::new(1, 0);
        let eval = |installed: &str, latest: &str| {
            evaluate_update_for_host("p", installed, &doc(latest, "1.0"), host)
                .unwrap()
                .status
        };
        assert_eq!(eval("1.2.0", "1.3.0"), UpdateStatus::UpdateAvailable);
        assert_eq!(eval("1.2.0", "1.2.0"), UpdateStatus::UpToDate);
        // Older published version: never offered (no downgrade via the check).
        assert_eq!(eval("1.2.0", "1.1.9"), UpdateStatus::UpToDate);
        // A pre-release sorts below its release.
        assert_eq!(eval("1.3.0", "1.3.0-beta.1"), UpdateStatus::UpToDate);
        assert_eq!(eval("1.3.0-beta.1", "1.3.0"), UpdateStatus::UpdateAvailable);
    }

    #[test]
    fn newer_version_needing_an_unsupported_abi_is_incompatible() {
        let host = AbiVersion::new(1, 0);
        for abi in ["1.1", "2.0", "0.9"] {
            let out = evaluate_update_for_host("p", "1.0.0", &doc("1.1.0", abi), host).unwrap();
            assert_eq!(out.status, UpdateStatus::IncompatibleHost, "abi {abi}");
        }
        // A host on a newer minor accepts an older-minor requirement.
        let out =
            evaluate_update_for_host("p", "1.0.0", &doc("1.1.0", "1.0"), AbiVersion::new(1, 2))
                .unwrap();
        assert_eq!(out.status, UpdateStatus::UpdateAvailable);
    }

    #[test]
    fn unverifiable_installed_version_is_an_error() {
        assert_eq!(
            evaluate_update("p", "v1", &doc("1.1.0", "1.0")),
            Err(UpdateCheckError::InstalledVersionUnverifiable(
                "v1".to_string()
            ))
        );
    }

    #[test]
    fn outcome_carries_the_document_and_normalises_the_digest() {
        let json = doc_json("2.0.0", "1.0").replace(SHA, &SHA.to_ascii_uppercase());
        let d = parse_update_document(json.as_bytes()).unwrap();
        let out = evaluate_update("my-plugin", "1.0.0", &d).unwrap();
        assert_eq!(out.plugin_id, "my-plugin");
        assert_eq!(out.installed_version, "1.0.0");
        assert_eq!(out.latest_version, "2.0.0");
        assert_eq!(out.sha256, SHA);
        assert_eq!(out.download_url, "https://example.com/p.termihub-plugin");
    }

    #[test]
    fn package_digest_verification() {
        let bytes = b"package bytes";
        let hex = hex::encode(Sha256::digest(bytes));
        assert!(verify_package_sha256(bytes, &hex));
        assert!(verify_package_sha256(bytes, &hex.to_ascii_uppercase()));
        assert!(!verify_package_sha256(b"tampered", &hex));
    }
}

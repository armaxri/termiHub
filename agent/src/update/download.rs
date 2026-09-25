//! Download, SHA-256-verify and signature-verify an agent binary for a
//! self-update.
//!
//! Applies the same fail-closed rule as the desktop deploy path (#1350): a
//! release binary is only staged if it is accompanied by a matching `.sha256`
//! sidecar. A missing sidecar, a malformed sidecar, or a digest mismatch aborts
//! the staging and removes any partially written files, so a tampered or
//! corrupt binary is never left on disk to be executed.
//!
//! On top of that, the `.sig` sidecar must carry a valid Ed25519 signature from
//! the compiled-in release key (AGT-005, #3213 — see [`super::signature`]). A
//! release-built agent refuses a binary with no signature asset; the verified
//! signature is returned so the apply path can re-verify it before the swap.

use std::path::Path;

use anyhow::{bail, Context, Result};
use tracing::debug;

use super::checksum::{checksum_sidecar_path, parse_sha256_sidecar, verify_file_checksum};
use super::github::AssetUrls;
use super::signature::{signature_sidecar_path, SignaturePolicy};

/// A staged binary that passed both the checksum and the signature check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedDownload {
    /// Lowercase-hex SHA-256 of the staged bytes (AGT-004).
    pub sha256: String,
    /// The verified base64 signature (AGT-005), or `None` only when a debug
    /// build's unsigned allowance let an unsigned binary through.
    pub signature: Option<String>,
}

/// Download `url` into `dest`, replacing any existing file.
async fn download_to_file(client: &reqwest::Client, url: &str, dest: &Path) -> Result<()> {
    let bytes = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("failed to download {url}"))?
        .error_for_status()
        .with_context(|| format!("download of {url} returned an error status"))?
        .bytes()
        .await
        .with_context(|| format!("failed to read response body for {url}"))?;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("failed to create staging directory {}", parent.display()))?;
    }
    tokio::fs::write(dest, &bytes)
        .await
        .with_context(|| format!("failed to write {}", dest.display()))?;
    Ok(())
}

/// Download the agent binary described by `urls` into `dest` and verify it
/// against its published `.sha256` sidecar and `.sig` signature.
///
/// On success `dest` holds the verified binary and its sidecars sit next to it
/// (`<dest>.sha256`, `<dest>.sig`), and the verified digest and signature are
/// returned so the caller can thread them to the apply path for re-verification
/// before the swap (AGT-004 / AGT-005). On any failure every file is removed and
/// an error is returned. A release with no published checksum is rejected, and
/// under a strict `policy` (every release build) so is one without a valid
/// signature — self-update never installs an unverifiable binary.
pub async fn download_and_verify(
    client: &reqwest::Client,
    urls: &AssetUrls,
    dest: &Path,
    policy: &SignaturePolicy,
) -> Result<VerifiedDownload> {
    let checksum_url = match urls.checksum_url.as_deref() {
        Some(url) => url,
        None => bail!(
            "No published SHA-256 checksum for {} — refusing to stage an unverifiable agent binary",
            urls.binary_url
        ),
    };

    if let Err(e) = download_to_file(client, &urls.binary_url, dest).await {
        let _ = tokio::fs::remove_file(dest).await;
        return Err(e);
    }

    let sidecar = checksum_sidecar_path(dest);
    let sig_sidecar = signature_sidecar_path(dest);
    let result = match verify_downloaded(client, checksum_url, dest, &sidecar).await {
        Ok(sha256) => verify_signature(
            client,
            urls.signature_url.as_deref(),
            &sha256,
            &sig_sidecar,
            policy,
        )
        .await
        .map(|signature| VerifiedDownload { sha256, signature }),
        Err(e) => Err(e),
    };
    if result.is_err() {
        let _ = tokio::fs::remove_file(dest).await;
        let _ = tokio::fs::remove_file(&sidecar).await;
        let _ = tokio::fs::remove_file(&sig_sidecar).await;
    }
    result
}

/// Fetch the `.sig` sidecar (when published) and verify it over `sha256`
/// under `policy`, returning the verified signature. With no published
/// signature, `policy` decides: a strict policy refuses, a debug build's
/// allowance tolerates it (with a loud warning) and returns `None`.
async fn verify_signature(
    client: &reqwest::Client,
    signature_url: Option<&str>,
    sha256: &str,
    sig_sidecar: &Path,
    policy: &SignaturePolicy,
) -> Result<Option<String>> {
    let signature = match signature_url {
        Some(url) => {
            download_to_file(client, url, sig_sidecar)
                .await
                .with_context(|| format!("failed to download published signature from {url}"))?;
            let content = tokio::fs::read_to_string(sig_sidecar)
                .await
                .with_context(|| {
                    format!("failed to read signature sidecar {}", sig_sidecar.display())
                })?;
            Some(content.trim().to_string())
        }
        None => None,
    };
    policy
        .verify(sha256, signature.as_deref())
        .context("refusing to stage an agent binary that failed signature verification")?;
    Ok(signature)
}

/// Fetch the checksum sidecar, verify the downloaded binary against it, and
/// return the verified expected digest.
async fn verify_downloaded(
    client: &reqwest::Client,
    checksum_url: &str,
    dest: &Path,
    sidecar: &Path,
) -> Result<String> {
    download_to_file(client, checksum_url, sidecar)
        .await
        .with_context(|| format!("failed to download published checksum from {checksum_url}"))?;
    let content = tokio::fs::read_to_string(sidecar)
        .await
        .with_context(|| format!("failed to read checksum sidecar {}", sidecar.display()))?;
    let expected = parse_sha256_sidecar(&content).ok_or_else(|| {
        anyhow::anyhow!(
            "Malformed checksum sidecar from {checksum_url} — refusing to stage an \
             unverifiable agent binary"
        )
    })?;
    verify_file_checksum(dest, &expected)?;
    debug!("Verified downloaded agent binary at {}", dest.display());
    Ok(expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::signature::test_support::{sign_digest, test_signing_key};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const SHA256_OF_ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    async fn mount_binary(server: &MockServer, body: &'static [u8]) {
        Mock::given(method("GET"))
            .and(path("/bin"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(server)
            .await;
    }

    async fn mount_checksum(server: &MockServer, body: String) {
        Mock::given(method("GET"))
            .and(path("/bin.sha256"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(server)
            .await;
    }

    fn urls(server: &MockServer, with_checksum: bool) -> AssetUrls {
        AssetUrls {
            binary_url: format!("{}/bin", server.uri()),
            checksum_url: with_checksum.then(|| format!("{}/bin.sha256", server.uri())),
            signature_url: None,
        }
    }

    fn signed_urls(server: &MockServer) -> AssetUrls {
        AssetUrls {
            signature_url: Some(format!("{}/bin.sig", server.uri())),
            ..urls(server, true)
        }
    }

    async fn mount_signature(server: &MockServer, body: String) {
        Mock::given(method("GET"))
            .and(path("/bin.sig"))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(server)
            .await;
    }

    /// The debug-build policy: the checksum-focused tests below serve no
    /// signature and rely on the dev allowance, exactly as before AGT-005.
    fn dev_policy() -> SignaturePolicy {
        SignaturePolicy::for_build()
    }

    fn strict_policy() -> SignaturePolicy {
        SignaturePolicy::strict(vec![test_signing_key(5).verifying_key()])
    }

    #[tokio::test]
    async fn stages_binary_when_checksum_matches() {
        let server = MockServer::start().await;
        mount_binary(&server, b"abc").await;
        mount_checksum(
            &server,
            format!("{SHA256_OF_ABC}  termihub-agent-linux-x64\n"),
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");
        let verified = download_and_verify(
            &reqwest::Client::new(),
            &urls(&server, true),
            &dest,
            &dev_policy(),
        )
        .await
        .unwrap();
        let digest = verified.sha256;

        assert_eq!(std::fs::read(&dest).unwrap(), b"abc");
        assert!(checksum_sidecar_path(&dest).is_file());
        // The verified digest is returned so it can be threaded to the apply
        // path for re-verification before the swap (AGT-004).
        assert_eq!(digest, SHA256_OF_ABC);
    }

    #[tokio::test]
    async fn rejects_and_removes_binary_on_checksum_mismatch() {
        let server = MockServer::start().await;
        mount_binary(&server, b"abc").await;
        mount_checksum(&server, "0".repeat(64)).await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");
        let err = download_and_verify(
            &reqwest::Client::new(),
            &urls(&server, true),
            &dest,
            &dev_policy(),
        )
        .await
        .unwrap_err();

        assert!(err.to_string().to_ascii_lowercase().contains("checksum"));
        assert!(!dest.exists(), "mismatched binary must be removed");
        assert!(!checksum_sidecar_path(&dest).exists());
    }

    #[tokio::test]
    async fn fails_closed_when_no_checksum_asset_published() {
        let server = MockServer::start().await;
        mount_binary(&server, b"abc").await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");
        // checksum_url = None → refuse before downloading anything.
        let err = download_and_verify(
            &reqwest::Client::new(),
            &urls(&server, false),
            &dest,
            &dev_policy(),
        )
        .await
        .unwrap_err();

        assert!(err.to_string().to_ascii_lowercase().contains("checksum"));
        assert!(!dest.exists());
    }

    #[tokio::test]
    async fn fails_closed_when_checksum_download_404s() {
        let server = MockServer::start().await;
        mount_binary(&server, b"abc").await;
        // No checksum mock mounted → the .sha256 GET gets wiremock's default 404.

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");
        let err = download_and_verify(
            &reqwest::Client::new(),
            &urls(&server, true),
            &dest,
            &dev_policy(),
        )
        .await
        .unwrap_err();

        assert!(err.to_string().to_ascii_lowercase().contains("checksum"));
        assert!(
            !dest.exists(),
            "binary must not remain without verification"
        );
    }

    // ── AGT-005: signature sidecar (#3213) ────────────────────────────────

    #[tokio::test]
    async fn stages_and_returns_a_validly_signed_binary() {
        let server = MockServer::start().await;
        mount_binary(&server, b"abc").await;
        mount_checksum(&server, SHA256_OF_ABC.to_string()).await;
        let sig = sign_digest(&test_signing_key(5), SHA256_OF_ABC);
        mount_signature(&server, format!("{sig}\n")).await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");
        let verified = download_and_verify(
            &reqwest::Client::new(),
            &signed_urls(&server),
            &dest,
            &strict_policy(),
        )
        .await
        .unwrap();

        assert_eq!(verified.sha256, SHA256_OF_ABC);
        assert_eq!(verified.signature.as_deref(), Some(sig.as_str()));
        assert!(signature_sidecar_path(&dest).is_file());
    }

    #[tokio::test]
    async fn strict_policy_refuses_a_release_without_a_signature_asset() {
        let server = MockServer::start().await;
        mount_binary(&server, b"abc").await;
        mount_checksum(&server, SHA256_OF_ABC.to_string()).await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");
        let err = download_and_verify(
            &reqwest::Client::new(),
            &urls(&server, true),
            &dest,
            &strict_policy(),
        )
        .await
        .unwrap_err();

        assert!(format!("{err:#}").contains("signature"));
        assert!(!dest.exists(), "an unsigned binary must not stay staged");
        assert!(!checksum_sidecar_path(&dest).exists());
    }

    #[tokio::test]
    async fn refuses_and_removes_a_binary_signed_by_a_foreign_key() {
        let server = MockServer::start().await;
        mount_binary(&server, b"abc").await;
        mount_checksum(&server, SHA256_OF_ABC.to_string()).await;
        mount_signature(&server, sign_digest(&test_signing_key(6), SHA256_OF_ABC)).await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");
        let err = download_and_verify(
            &reqwest::Client::new(),
            &signed_urls(&server),
            &dest,
            &strict_policy(),
        )
        .await
        .unwrap_err();

        assert!(format!("{err:#}").contains("signature"));
        assert!(!dest.exists());
        assert!(!checksum_sidecar_path(&dest).exists());
        assert!(!signature_sidecar_path(&dest).exists());
    }

    #[tokio::test]
    async fn refuses_when_the_advertised_signature_404s() {
        let server = MockServer::start().await;
        mount_binary(&server, b"abc").await;
        mount_checksum(&server, SHA256_OF_ABC.to_string()).await;
        // `.sig` advertised but not served → fail closed, even for a dev policy.

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");
        let err = download_and_verify(
            &reqwest::Client::new(),
            &signed_urls(&server),
            &dest,
            &dev_policy(),
        )
        .await
        .unwrap_err();

        assert!(format!("{err:#}").contains("signature"));
        assert!(!dest.exists());
    }
}

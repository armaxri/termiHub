//! Download and SHA-256-verify an agent binary for a self-update.
//!
//! Applies the same fail-closed rule as the desktop deploy path (#1350): a
//! release binary is only staged if it is accompanied by a matching `.sha256`
//! sidecar. A missing sidecar, a malformed sidecar, or a digest mismatch aborts
//! the staging and removes any partially written files, so a tampered or
//! corrupt binary is never left on disk to be executed.

use std::path::Path;

use anyhow::{bail, Context, Result};
use tracing::debug;

use super::checksum::{checksum_sidecar_path, parse_sha256_sidecar, verify_file_checksum};
use super::github::AssetUrls;

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
/// against its published `.sha256` sidecar.
///
/// On success `dest` holds the verified binary and its sidecar sits next to it
/// (`<dest>.sha256`). On any failure both files are removed and an error is
/// returned. A release with no published checksum is rejected — self-update
/// never installs an unverifiable binary.
pub async fn download_and_verify(
    client: &reqwest::Client,
    urls: &AssetUrls,
    dest: &Path,
) -> Result<()> {
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
    let result = verify_downloaded(client, checksum_url, dest, &sidecar).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(dest).await;
        let _ = tokio::fs::remove_file(&sidecar).await;
    }
    result
}

/// Fetch the checksum sidecar and verify the downloaded binary against it.
async fn verify_downloaded(
    client: &reqwest::Client,
    checksum_url: &str,
    dest: &Path,
    sidecar: &Path,
) -> Result<()> {
    download_to_file(client, checksum_url, sidecar)
        .await
        .with_context(|| {
            format!("failed to download published checksum from {checksum_url}")
        })?;
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
        }
    }

    #[tokio::test]
    async fn stages_binary_when_checksum_matches() {
        let server = MockServer::start().await;
        mount_binary(&server, b"abc").await;
        mount_checksum(&server, format!("{SHA256_OF_ABC}  termihub-agent-linux-x64\n")).await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");
        download_and_verify(&reqwest::Client::new(), &urls(&server, true), &dest)
            .await
            .unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), b"abc");
        assert!(checksum_sidecar_path(&dest).is_file());
    }

    #[tokio::test]
    async fn rejects_and_removes_binary_on_checksum_mismatch() {
        let server = MockServer::start().await;
        mount_binary(&server, b"abc").await;
        mount_checksum(&server, "0".repeat(64)).await;

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("termihub-agent-linux-x64");
        let err = download_and_verify(&reqwest::Client::new(), &urls(&server, true), &dest)
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
        let err = download_and_verify(&reqwest::Client::new(), &urls(&server, false), &dest)
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
        let err = download_and_verify(&reqwest::Client::new(), &urls(&server, true), &dest)
            .await
            .unwrap_err();

        assert!(err.to_string().to_ascii_lowercase().contains("checksum"));
        assert!(!dest.exists(), "binary must not remain without verification");
    }
}

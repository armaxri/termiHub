//! The narrow HTTPS client every plugin network fetch goes through: the update
//! check (PROD-051) and plugin discovery (PROD-048).
//!
//! The webview never fetches anything itself (the CSP forbids it); these
//! helpers run in the backend and fail closed:
//!
//! * **HTTPS only** — every URL is validated before a request, the client is
//!   `https_only`, and the redirect policy refuses any hop to a non-HTTPS URL and
//!   caps the chain at [`MAX_REDIRECTS`]. No cookies, credentials or auth
//!   headers are ever sent.
//! * **Size-capped** — an oversize `Content-Length` is refused before reading,
//!   and the streamed body is cut off at the cap (a lying or absent
//!   `Content-Length` cannot get past it).
//! * **Timed out** — a short connect timeout plus an overall request timeout.
//! * **Checksum before parse** — [`download_verified`] streams a package into a
//!   private temp file (`0600`, in a `0700` directory on Unix) while hashing it,
//!   and only a file whose SHA-256 matches is ever moved into place; a mismatch
//!   deletes it. Nothing opens, parses or unpacks the bytes before that.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};
use termihub_core::plugin::validate_https_url;

/// Maximum number of redirects followed for one request.
pub const MAX_REDIRECTS: usize = 3;

/// Connect timeout for every plugin fetch.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Which URL schemes a fetch accepts. Production code only ever uses
/// [`FetchPolicy::STRICT`]; plain HTTP exists solely so unit tests can serve
/// fixtures from a local HTTP server (and even then redirects must be HTTPS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FetchPolicy {
    allow_plain_http: bool,
}

impl FetchPolicy {
    /// HTTPS only — the only policy production code uses.
    pub const STRICT: FetchPolicy = FetchPolicy {
        allow_plain_http: false,
    };

    /// Tests only: also accept an initial `http://` URL (a local fixture
    /// server). Redirects must still target HTTPS.
    #[cfg(test)]
    pub const TEST_ALLOW_HTTP: FetchPolicy = FetchPolicy {
        allow_plain_http: true,
    };

    /// Validate `url` for this policy.
    pub fn check_url(self, url: &str) -> Result<(), String> {
        if self.allow_plain_http && url.starts_with("http://") {
            return reqwest::Url::parse(url)
                .map(|_| ())
                .map_err(|e| format!("URL `{url}` is invalid: {e}"));
        }
        validate_https_url(url).map_err(|r| format!("URL `{url}` {r}"))
    }
}

/// Decide whether a redirect hop to `url` may be followed after `previous`
/// hops: only HTTPS targets, and at most [`MAX_REDIRECTS`].
pub(crate) fn redirect_allowed(url: &reqwest::Url, previous: usize) -> Result<(), &'static str> {
    if previous >= MAX_REDIRECTS {
        return Err("too many redirects");
    }
    if url.scheme() != "https" {
        return Err("redirect to a non-HTTPS URL refused");
    }
    Ok(())
}

/// Build the client with bounded timeouts and the HTTPS-only redirect policy.
fn build_client(
    policy: FetchPolicy,
    timeout: Duration,
    purpose: &str,
) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(!policy.allow_plain_http)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .user_agent(format!("termiHub/{} {purpose}", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(
            |attempt| match redirect_allowed(attempt.url(), attempt.previous().len()) {
                Ok(()) => attempt.follow(),
                Err(reason) => attempt.error(reason),
            },
        ))
        .build()
        .map_err(|e| format!("could not build HTTP client: {e}"))
}

/// Append `chunk` to `buf`, refusing to grow past `cap` bytes.
pub(crate) fn push_capped(buf: &mut Vec<u8>, chunk: &[u8], cap: usize) -> Result<(), String> {
    if buf.len().saturating_add(chunk.len()) > cap {
        return Err(format!("response is larger than the {cap}-byte limit"));
    }
    buf.extend_from_slice(chunk);
    Ok(())
}

/// Send a GET for `url` and check status and `Content-Length` against `cap`.
async fn start_get(
    url: &str,
    cap: u64,
    timeout: Duration,
    policy: FetchPolicy,
    purpose: &str,
) -> Result<reqwest::Response, String> {
    policy.check_url(url)?;
    let client = build_client(policy, timeout, purpose)?;
    let response = client.get(url).send().await.map_err(|e| {
        // Surface the redirect-policy reason, which reqwest wraps.
        let detail = std::error::Error::source(&e)
            .map(ToString::to_string)
            .unwrap_or_default();
        format!("request to {url} failed: {e} {detail}")
            .trim_end()
            .to_string()
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url} returned HTTP {status}"));
    }
    if response.content_length().is_some_and(|len| len > cap) {
        return Err(format!("{url} is larger than the {cap}-byte limit"));
    }
    Ok(response)
}

/// GET `url` and return its body, refusing anything over `cap` bytes — by
/// `Content-Length` up front, and while streaming.
pub async fn fetch_capped(
    url: &str,
    cap: usize,
    timeout: Duration,
    policy: FetchPolicy,
    purpose: &str,
) -> Result<Vec<u8>, String> {
    let mut response = start_get(url, cap as u64, timeout, policy, purpose).await?;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("reading {url} failed: {e}"))?
    {
        push_capped(&mut body, &chunk, cap)?;
    }
    Ok(body)
}

/// Create `dir` (and parents), restricting it to the current user on Unix.
fn create_private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("could not restrict {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// Stream `url` into a private temp file in `dir`, hashing as it goes. Only when
/// the body is within `cap` bytes **and** its SHA-256 equals `expected_sha256`
/// is the file moved to `dir/file_name` and that path returned; otherwise the
/// temp file is deleted and an error returned. The bytes are never parsed here.
///
/// `file_name` must be a bare file name (no separators) — callers derive it
/// from validated ids / versions.
pub async fn download_verified(
    url: &str,
    expected_sha256: &str,
    cap: u64,
    timeout: Duration,
    policy: FetchPolicy,
    dir: &Path,
    file_name: &str,
) -> Result<PathBuf, String> {
    if file_name.is_empty() || file_name.contains(['/', '\\']) || file_name.starts_with('.') {
        return Err(format!("refusing unsafe download file name `{file_name}`"));
    }
    let mut response = start_get(url, cap, timeout, policy, "plugin-download").await?;
    create_private_dir(dir)?;
    let mut temp = tempfile::Builder::new()
        .prefix(".download-")
        .suffix(".part")
        .tempfile_in(dir)
        .map_err(|e| format!("could not create a temp file in {}: {e}", dir.display()))?;
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("reading {url} failed: {e}"))?
    {
        total = total.saturating_add(chunk.len() as u64);
        if total > cap {
            return Err(format!("{url} is larger than the {cap}-byte limit"));
        }
        hasher.update(&chunk);
        temp.write_all(&chunk)
            .map_err(|e| format!("could not write the download: {e}"))?;
    }
    let actual = hex::encode(hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err(format!(
            "download from {url} does not match the expected SHA-256 (got {actual})"
        ));
    }
    temp.as_file()
        .sync_all()
        .map_err(|e| format!("could not flush the download: {e}"))?;
    let dest = dir.join(file_name);
    temp.persist(&dest)
        .map_err(|e| format!("could not store the download: {}", e.error))?;
    Ok(dest)
}

/// Replace every character outside `[A-Za-z0-9.-]` with `-`, so a validated
/// id / version can be used as a single file-name component.
pub fn sanitize_file_component(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

#[cfg(test)]
#[path = "plugin_fetch_tests.rs"]
mod tests;

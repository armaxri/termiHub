//! Shared HTTP download helper.
//!
//! [`download_to_file`] centralizes the `reqwest::blocking` "GET a URL, report
//! progress, write the body to a destination path" boilerplate that agent-binary
//! resolution ([`crate::terminal::agent_binary`]) and VcXsrv acquisition
//! ([`crate::terminal::xserver::acquire`]) both need (consolidated per #1077).

use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use tracing::info;

/// Download `url` and write the full response body to `dest`, creating parent
/// directories as needed.
///
/// `on_progress` is invoked once, after the body has been read, with
/// `(bytes_downloaded, total_bytes)`. `total_bytes` is 0 when the server does not
/// send a `Content-Length` header.
///
/// Uses `reqwest::blocking`, so it must be called off the async reactor (e.g.
/// inside `spawn_blocking`). A non-success status is an error and nothing is
/// written to `dest`.
pub fn download_to_file<F>(url: &str, dest: &Path, on_progress: F) -> Result<()>
where
    F: Fn(u64, u64),
{
    let response = reqwest::blocking::Client::new()
        .get(url)
        .send()
        .with_context(|| format!("Failed to start download from {url}"))?;

    if !response.status().is_success() {
        bail!("Download failed: HTTP {} for {url}", response.status());
    }

    let total = response.content_length().unwrap_or(0);
    let bytes = response
        .bytes()
        .with_context(|| format!("Failed to read response body from {url}"))?;
    on_progress(bytes.len() as u64, total);

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create {}", parent.display()))?;
    }
    fs::write(dest, &bytes)
        .with_context(|| format!("Failed to write download to {}", dest.display()))?;

    info!(
        "Downloaded {url} to {} ({} bytes)",
        dest.display(),
        bytes.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    /// Spawn a one-shot HTTP/1.1 responder on an ephemeral loopback port.
    ///
    /// It accepts a single connection, drains the request, and replies with the
    /// given status line, an optional `Content-Length`, and `body`. Returns the
    /// bound `http://127.0.0.1:PORT` base URL and the server thread's join handle.
    fn serve_once(
        status_line: &'static str,
        send_content_length: bool,
        body: &'static [u8],
    ) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            // Every test connects immediately (the client is `download_to_file`,
            // invoked right after), so a blocking accept is safe; a hung test is
            // caught by the test-runner timeout.
            let (mut stream, _) = listener.accept().unwrap();
            drain_request(&mut stream);
            let mut header = format!("HTTP/1.1 {status_line}\r\nConnection: close\r\n");
            if send_content_length {
                header.push_str(&format!("Content-Length: {}\r\n", body.len()));
            }
            header.push_str("\r\n");
            stream.write_all(header.as_bytes()).unwrap();
            stream.write_all(body).unwrap();
            stream.flush().unwrap();
        });
        (format!("http://{addr}/file"), handle)
    }

    /// Read the pending request so the client's write side completes before we
    /// respond (avoids a connection reset on close). One read is enough for a
    /// small GET over loopback.
    fn drain_request(stream: &mut TcpStream) {
        let _ = stream.read(&mut [0u8; 1024]);
    }

    #[test]
    fn writes_body_creates_parent_and_reports_progress() {
        const BODY: &[u8] = b"hello download helper payload";
        let (url, server) = serve_once("200 OK", true, BODY);

        let tmp = tempfile::tempdir().unwrap();
        // `nested/` does not exist yet — the helper must create it.
        let dest = tmp.path().join("nested").join("out.bin");
        let progress: RefCell<Vec<(u64, u64)>> = RefCell::new(Vec::new());

        download_to_file(&url, &dest, |received, total| {
            progress.borrow_mut().push((received, total))
        })
        .unwrap();
        server.join().unwrap();

        assert_eq!(fs::read(&dest).unwrap(), BODY);
        let seen = progress.borrow();
        assert!(
            seen.iter()
                .any(|(r, t)| *r == BODY.len() as u64 && *t == BODY.len() as u64),
            "expected a progress report of ({}, {}), got {seen:?}",
            BODY.len(),
            BODY.len()
        );
    }

    #[test]
    fn reports_zero_total_when_content_length_absent() {
        const BODY: &[u8] = b"no content-length here";
        let (url, server) = serve_once("200 OK", false, BODY);

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("out.bin");
        let progress: RefCell<Vec<(u64, u64)>> = RefCell::new(Vec::new());

        download_to_file(&url, &dest, |received, total| {
            progress.borrow_mut().push((received, total))
        })
        .unwrap();
        server.join().unwrap();

        assert_eq!(fs::read(&dest).unwrap(), BODY);
        let seen = progress.borrow();
        assert!(
            seen.iter().any(|(r, t)| *r == BODY.len() as u64 && *t == 0),
            "expected total=0 when Content-Length is omitted, got {seen:?}"
        );
    }

    /// Spawn a responder that streams `body` in several small TCP writes with a
    /// short pause between them, so the client's read loop observes the body
    /// arriving in multiple chunks rather than as one buffer.
    fn serve_chunked(body: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            drain_request(&mut stream);
            let header = format!(
                "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).unwrap();
            stream.flush().unwrap();
            // Emit the body in fixed-size slices with a small delay so the
            // download loop wakes up repeatedly and reports incremental progress.
            for slice in body.chunks(16 * 1024) {
                stream.write_all(slice).unwrap();
                stream.flush().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        });
        (format!("http://{addr}/file"), handle)
    }

    #[test]
    fn streams_to_disk_with_incremental_monotonic_progress() {
        // A payload larger than the read buffer, delivered over multiple TCP
        // writes, must surface several progress reports (not one 0->100% jump).
        let body: Vec<u8> = (0..256 * 1024).map(|i| (i % 251) as u8).collect();
        let total = body.len() as u64;
        let (url, server) = serve_chunked(body.clone());

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("big.bin");
        let progress: RefCell<Vec<(u64, u64)>> = RefCell::new(Vec::new());

        download_to_file(&url, &dest, |received, t| {
            progress.borrow_mut().push((received, t))
        })
        .unwrap();
        server.join().unwrap();

        assert_eq!(fs::read(&dest).unwrap(), body, "streamed bytes must match");

        let seen = progress.borrow();
        assert!(
            seen.len() >= 2,
            "expected multiple incremental progress reports, got {}: {seen:?}",
            seen.len()
        );
        // `received` must be strictly increasing and `total` constant.
        for pair in seen.windows(2) {
            assert!(
                pair[1].0 > pair[0].0,
                "received must increase monotonically, got {seen:?}"
            );
        }
        assert!(
            seen.iter().all(|(_, t)| *t == total),
            "total must be the Content-Length for every report, got {seen:?}"
        );
        assert_eq!(
            seen.last().map(|(r, _)| *r),
            Some(total),
            "final report must cover the whole body"
        );
    }

    #[test]
    fn errors_on_non_success_status_and_writes_nothing() {
        const BODY: &[u8] = b"not found body";
        let (url, server) = serve_once("404 Not Found", true, BODY);

        let tmp = tempfile::tempdir().unwrap();
        let dest = tmp.path().join("out.bin");

        let err = download_to_file(&url, &dest, |_, _| {}).unwrap_err();
        server.join().unwrap();

        assert!(
            err.to_string().contains("404"),
            "error should mention the HTTP status, got: {err}"
        );
        assert!(
            !dest.exists(),
            "nothing must be written to dest on a failed download"
        );
    }
}

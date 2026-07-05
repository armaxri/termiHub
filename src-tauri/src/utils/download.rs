//! Shared HTTP download helper.
//!
//! [`download_to_file`] centralizes the `reqwest::blocking` "GET a URL, report
//! progress, write the body to a destination path" boilerplate that agent-binary
//! resolution ([`crate::terminal::agent_binary`]) and VcXsrv acquisition
//! ([`crate::terminal::xserver::acquire`]) both need (consolidated per #1077).

use std::path::Path;

use anyhow::{bail, Result};

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
pub fn download_to_file<F>(_url: &str, _dest: &Path, _on_progress: F) -> Result<()>
where
    F: Fn(u64, u64),
{
    bail!("download_to_file not implemented yet")
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
        // Non-blocking accept with a bounded deadline so the server thread always
        // terminates — `join()` can never deadlock even if the client never
        // connects (e.g. a regression that stops `download_to_file` sending a
        // request).
        listener.set_nonblocking(true).unwrap();
        let handle = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() >= deadline {
                            return; // give up — no client connected
                        }
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(e) => panic!("accept failed: {e}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
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

    /// Read the request headers (up to the blank line) so the client's write side
    /// completes before we respond.
    fn drain_request(stream: &mut TcpStream) {
        let mut buf = [0u8; 1024];
        loop {
            let n = stream.read(&mut buf).unwrap_or(0);
            if n == 0 {
                break;
            }
            if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
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

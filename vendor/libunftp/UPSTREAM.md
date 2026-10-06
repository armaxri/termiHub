# Upstreaming the PROXY header EOF fix

Prepared bug report and patch for [bolcom/libunftp](https://github.com/bolcom/libunftp), so
the fork can be retired (#4099). Nothing has been submitted yet: a maintainer opens the upstream
issue and pull request (see [How to submit](#how-to-submit)).

- **Base:** upstream `0.23.1`, tag `libunftp-0.23.1`, commit
  `8d3f28c20c53acdd3c9a939957e4727e18e18af0` (also the tip of upstream `master` when this was
  prepared, 2026-10-06; `src/server/proxy_protocol.rs` last changed upstream in `ff18d9c`).
- **Upstream search:** no open or closed issue or pull request covers the header reader spinning
  at EOF. Related history: #208 ("potential block when using proxy protocol") and #429, which
  moved header reading into its own task (so the spin no longer blocks the accept loop, but the
  task still never ends).
- **Verified:** the patch below applies cleanly to `libunftp-0.23.1` (`git apply --check`). The
  reproduction prints about 2.7 s of CPU time for 3 s of idle wall time against 0.23.1 and
  0.3 ms with the patch; `cargo test --lib` passes with it.

## Suggested issue

**Title:** `PROXY protocol mode: header reader task spins forever when a connection closes before the header`

**Body:**

> In proxy protocol mode, a TCP connection that closes before sending a complete PROXY v1
> header (no `\n`) leaves its header-parsing task looping forever, using a full CPU core
> until the server stops.
>
> `read_proxy_header` (`src/server/proxy_protocol.rs`) peeks at the stream and looks for a
> newline. At EOF, `peek` returns `Ok(0)`. No newline is found, so the `None` branch calls
> `read(&mut rbuf[i..i + 0])`, which also returns `Ok(0)` at once, and the loop starts over.
> Nothing in the loop ever returns, so the task spawned by `spawn_proxy_header_parsing`
> never ends. The same happens after a partial header (`PROXY TCP4 1.2.3.4` and then FIN).
>
> Anything that can reach the proxy-mode listener can trigger it: a load-balancer health
> check that opens and closes a TCP connection, a port scanner, or a client that gives up.
> Each such connection adds one more spinning task.
>
> **Reproduction** (libunftp 0.23.1, unftp-sbe-fs 0.4, Linux or macOS):
>
> ```toml
> [dependencies]
> libunftp = "=0.23.1"
> unftp-sbe-fs = "0.4"
> libc = "0.2"
> tokio = { version = "1", features = ["macros", "rt", "net", "time"] }
> ```
>
> ```rust
> use std::time::{Duration, Instant};
> use unftp_sbe_fs::Filesystem;
>
> /// CPU time (user + system) this process has used so far.
> fn cpu_time() -> Duration {
>     let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
>     unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
>     let tv = |t: libc::timeval| Duration::new(t.tv_sec as u64, t.tv_usec as u32 * 1000);
>     tv(ru.ru_utime) + tv(ru.ru_stime)
> }
>
> #[tokio::main(flavor = "current_thread")]
> async fn main() {
>     let server = libunftp::ServerBuilder::new(Box::new(|| Filesystem::new(std::env::temp_dir()).unwrap()))
>         .proxy_protocol_mode(2121)
>         .build()
>         .unwrap();
>     tokio::spawn(server.listen("127.0.0.1:2122"));
>     tokio::time::sleep(Duration::from_millis(200)).await;
>
>     // Connect to the PROXY-mode listener and close without sending a header.
>     drop(std::net::TcpStream::connect("127.0.0.1:2122").unwrap());
>
>     let (cpu, wall) = (cpu_time(), Instant::now());
>     tokio::time::sleep(Duration::from_secs(3)).await;
>     println!("idle for {:?}, CPU used: {:?}", wall.elapsed(), cpu_time() - cpu);
> }
> ```
>
> Output with 0.23.1: `idle for 3.0s, CPU used: 2.68s`. With the fix below: `CPU used: 299µs`.
> Alternatively connect with `nc -z 127.0.0.1 2122` against any proxy-mode server and watch
> `top`.
>
> **Expected:** the header task treats EOF as an error, logs it like other header errors
> ("proxy protocol read error") and ends.
>
> I have a patch with tests ready and will open a pull request.

## Suggested pull request

**Title:** `Return an error at EOF while reading the PROXY protocol header`

**Description:**

> Fixes #&lt;issue&gt;.
>
> `read_proxy_header` loops forever when the peer closes the connection before the header's
> newline arrives: `peek` returns `Ok(0)` at EOF, no newline is found, and the zero-length
> `read` in the `None` branch returns `Ok(0)` too.
>
> `peek` only returns `Ok(0)` at EOF (the buffer is never empty), so this checks for it right
> after the peek and returns `ProxyError::ReadError` with `io::ErrorKind::UnexpectedEof`. The
> spawned header task then logs "proxy protocol read error" and ends, like for every other
> header error. Behaviour for connections that do send a header is unchanged.
>
> Two tests cover EOF before any byte and EOF after a partial header; both used to hang and now
> return the error (they are bounded by a 5 s timeout so a regression fails instead of hanging).

## The patch

Against `libunftp-0.23.1`. It is the fork's code delta without the termiHub-specific
`termiHub fork delta (armaxri/termiHub#4099)` comment markers. The vendored copy's other
differences from upstream are packaging only and are **not** part of the submission (see
`README.md` → "What this fork changes").

```diff
--- a/src/server/proxy_protocol.rs
+++ b/src/server/proxy_protocol.rs
@@ -54,6 +54,13 @@
         // Peek at the next data in the stream and map the error to a `ProxyError`
         let n = tcp_stream.peek(&mut pbuf).await.map_err(ProxyError::ReadError)?;

+        // `peek` returns `Ok(0)` only at EOF. Without this check no newline is ever found and the
+        // zero-length `read` below also returns `Ok(0)`, so the loop would spin forever on a
+        // connection that is closed before its header is complete.
+        if n == 0 {
+            return Err(ProxyError::ReadError(std::io::ErrorKind::UnexpectedEof.into()));
+        }
+
         match pbuf.iter().position(|b| *b == b'\n') {
             // If a newline character is found, the proxy header should be complete
             Some(pos) => {
@@ -182,6 +189,34 @@
     }

     #[tokio::test]
+    async fn eof_before_header_returns_error() {
+        let (mut s, c) = get_connected_tcp_streams().await;
+        drop(c);
+
+        let res = tokio::time::timeout(Duration::from_secs(5), super::read_proxy_header(&mut s))
+            .await
+            .expect("read_proxy_header must return at EOF instead of spinning");
+
+        assert!(matches!(res, Err(ProxyError::ReadError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof));
+    }
+
+    #[tokio::test]
+    async fn eof_after_partial_header_returns_error() {
+        let (mut s, mut c) = get_connected_tcp_streams().await;
+
+        let server = tokio::spawn(async move { tokio::time::timeout(Duration::from_secs(5), super::read_proxy_header(&mut s)).await });
+        let client = tokio::spawn(async move {
+            c.write_all("PROXY TCP4 127.0.0.1".as_ref()).await.unwrap();
+            c.shutdown().await.unwrap();
+        });
+
+        let res = tokio::join!(server, client);
+        let res = res.0.unwrap().expect("read_proxy_header must return at EOF instead of spinning");
+
+        assert!(matches!(res, Err(ProxyError::ReadError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof));
+    }
+
+    #[tokio::test]
     async fn bad_crlf_throws_error() {
         let (mut s, mut c) = get_connected_tcp_streams().await;

```

## How to submit

1. Open the issue above on `bolcom/libunftp` and note its number.
2. Fork `bolcom/libunftp` and branch from `master` (check that `master` still has no
   equivalent fix; if upstream moved, re-apply by hand, the delta is one check and two tests).
3. Save the diff above as `proxy-header-eof.patch` and apply it with
   `git apply proxy-header-eof.patch`.
4. Run `cargo test -p libunftp --lib proxy_protocol` and `cargo fmt --check` (upstream's
   `rustfmt.toml`).
5. Open the pull request with the title and description above, filling in the issue number.
6. Record both links in `vendor/vendored-forks.json` (the delta's `refs`), in
   `docs/supply-chain.md` → "Upstreaming status", and on termiHub #4099.

## Retiring the fork

Once a `libunftp` release contains the fix:

1. Remove the `[patch.crates-io]` entry for `libunftp` and `vendor/libunftp` from the `exclude`
   list in the root `Cargo.toml`, bump the `core/Cargo.toml` `libunftp` requirement to that
   release if it is on a new line, and run `cargo update -p libunftp`.
2. Delete `vendor/libunftp/`, its entry in `vendor/vendored-forks.json`, its rows in the
   "Vendored forks" and "Upstreaming status" tables of `docs/supply-chain.md`, and update the
   parser watchlist row.
3. Keep `backend_header_reader_ends_when_a_connection_closes_without_a_header` in
   `core/src/embedded_servers/ftp_server/relay_tests.rs`: it then guards the upstream fix.

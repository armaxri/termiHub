# Upstreaming the fork deltas

Upstream submissions for [bolcom/libunftp](https://github.com/bolcom/libunftp), so the fork can
be retired. Both deltas were submitted on 2026-10-06 (maintainer-approved). The two deltas are
independent.

1. [PROXY header EOF fix](#1-proxy-header-eof-fix-4099) (#4099): a bug fix. **Submitted
   2026-10-06:** issue [libunftp#580](https://github.com/bolcom/libunftp/issues/580), pull request
   [libunftp#582](https://github.com/bolcom/libunftp/pull/582).
2. [Prebound listener and PROXY peer filter](#2-prebound-listener-and-proxy-peer-filter-4100)
   (#4100): an API proposal. **Submitted 2026-10-06:** issue
   [libunftp#581](https://github.com/bolcom/libunftp/issues/581); the pull request waits for the
   maintainers to welcome the direction.

## 1. PROXY header EOF fix (#4099)

Bug report and patch for [bolcom/libunftp](https://github.com/bolcom/libunftp), so the fork can
be retired (#4099).

- **Status: submitted 2026-10-06.** Issue
  [libunftp#580](https://github.com/bolcom/libunftp/issues/580) (the text below) and pull request
  [libunftp#582](https://github.com/bolcom/libunftp/pull/582) (the patch below, applied to
  `master` at `8d3f28c`). Next: follow up on review comments; once a release contains the fix,
  [retire the fork](#retiring-the-fork).

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

### Suggested issue

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

### Suggested pull request

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

### The patch

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

### How to submit

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

## 2. Prebound listener and PROXY peer filter (#4100)

An additive API proposal: no behaviour change for existing callers. termiHub uses it so that
each session's loopback libunftp server only serves connections termiHub's relay opened.

- **Status: issue submitted 2026-10-06** as
  [libunftp#581](https://github.com/bolcom/libunftp/issues/581) (the text below). The pull
  request is not opened yet: it waits for a maintainer to welcome the direction (step 1 of
  [How to submit](#how-to-submit-1)).

- **Base:** upstream `0.23.1`, commit `8d3f28c20c53acdd3c9a939957e4727e18e18af0` (tip of
  `master` on 2026-10-06).
- **Upstream search:** no issue or pull request proposes a pre-bound listener or an accept
  filter. Related: #208 and #429 (PROXY header handling in the accept loop).
- **Verified:** the patch below applies cleanly to `libunftp-0.23.1` (`git apply --check`),
  passes `cargo clippy --lib -- -D warnings` and `cargo fmt --check` with upstream's
  `rustfmt.toml`, and `cargo test --lib` passes (71 tests, including the two new ones).

### Suggested issue

**Title:** `Proposal: Server::listen_with_listener and a peer filter for PROXY protocol mode`

**Body:**

> In PROXY protocol mode, libunftp trusts the PROXY header of every connection it accepts. That
> is fine when only the proxy can reach the listening port. But when the proxy runs on the same
> host and libunftp listens on loopback (a common sidecar or embedded setup), every local
> process can connect to the port directly, send its own header and claim any client address.
> That spoofs the IP in logs and in `Credentials::source_ip`, and the passive-data switchboard
> key (source IP + reserved port). It also bypasses anything the proxy enforces, such as limits
> on control-line length.
>
> Today there is no way to restrict who the listener serves:
>
> 1. `Server::listen` always binds the address itself. A caller that wants a free port has to
>    bind, release and pass the address, and another process can take the port in between. The
>    caller also cannot hand in a socket it configured itself.
> 2. `listen_proxy_protocol` accepts every connection and parses its header. There is no hook
>    between `accept` and the header read.
>
> **Proposal** (both additive, defaults unchanged):
>
> ```rust
> impl<Storage, User> Server<Storage, User> {
>     /// Like `listen`, but accepts on a listener the caller already bound.
>     pub async fn listen_with_listener(self, listener: tokio::net::TcpListener)
>         -> Result<(), ServerError>;
> }
>
> impl<Storage, User> ServerBuilder<Storage, User> {
>     /// PROXY protocol mode only: called with each accepted connection's peer address
>     /// before anything is read. `false` logs and closes the connection.
>     #[cfg(feature = "proxy_protocol")]
>     pub fn proxy_protocol_peer_filter<F>(self, filter: F) -> Self
>     where
>         F: Fn(SocketAddr) -> bool + Send + Sync + 'static;
> }
> ```
>
> With both, a same-host proxy can bind libunftp's listener itself, bind each outbound socket to
> a known local address before connecting, and only allow the addresses it bound. A simpler use
> is `.proxy_protocol_peer_filter(|peer| allowed_proxies.contains(&peer.ip()))` for a proxy on
> another host.
>
> `listen_with_listener` works in every listener mode (legacy, pooled, proxy): each mode takes
> its control listener from one helper that uses the prebound listener if there is one. It also
> removes the bind-release-rebind race for callers that pick a port with `:0`.
>
> I have a patch with tests ready and will open a pull request if this direction is welcome.

### Suggested pull request

**Title:** `Add Server::listen_with_listener and ServerBuilder::proxy_protocol_peer_filter`

**Description:**

> Implements #&lt;issue&gt;.
>
> - `Server::listen_with_listener(tokio::net::TcpListener)`: `listen` and it share one body
>   (`listen_on`). The legacy, pooled and proxy listeners get their control listener from
>   `bind_control_listener`, which uses the prebound listener if one was passed and binds
>   `bind_address` otherwise. Behaviour of `listen` is unchanged.
> - `ServerBuilder::proxy_protocol_peer_filter`: stored as `Option<Arc<dyn Fn(SocketAddr) ->
bool + Send + Sync>>` and passed to the proxy listener. Right after `accept`, a peer the
>   filter refuses is logged (`warn`) and dropped, so no header-reading task is spawned for it.
>   Without a filter, nothing changes.
> - Tests: a proxy-mode server on a prebound loopback listener answers `220` to a peer the
>   filter allows, and closes a refused peer without sending a byte.

### The patch

Against `libunftp-0.23.1`. It is the fork's code delta for #4100 without the termiHub-specific
`termiHub fork delta (armaxri/termiHub#4100).` marker lines.

<details>
<summary>libunftp-listen-with-listener-and-peer-filter.patch (5 files, +164 −5)</summary>

````diff
diff --git a/src/server/ftpserver.rs b/src/server/ftpserver.rs
index 9439038..5e7950d 100644
--- a/src/server/ftpserver.rs
+++ b/src/server/ftpserver.rs
@@ -29,6 +29,10 @@ use std::{
 use unftp_core::auth::{Authenticator, DefaultUser, DefaultUserDetailProvider, UserDetail, UserDetailProvider};
 use unftp_core::storage::{Metadata, StorageBackend};

+/// Decides, from the peer address of a freshly accepted TCP connection, whether a PROXY
+/// protocol mode listener serves it. See [`ServerBuilder::proxy_protocol_peer_filter`].
+pub(crate) type ProxyPeerFilter = Arc<dyn Fn(SocketAddr) -> bool + Send + Sync>;
+
 /// An instance of an FTP(S) server. It aggregates an [`Authenticator`](unftp_core::auth::Authenticator)
 /// implementation that will be used for authentication, and a [`StorageBackend`](unftp_core::storage::StorageBackend)
 /// implementation that will be used as the virtual file system.
@@ -81,6 +85,9 @@ where
     connection_helper: Option<OsString>,
     connection_helper_args: Vec<OsString>,
     binder: Arc<std::sync::Mutex<Option<Box<dyn crate::options::Binder>>>>,
+    // See `ServerBuilder::proxy_protocol_peer_filter`.
+    #[cfg_attr(not(feature = "proxy_protocol"), allow(dead_code))]
+    proxy_peer_filter: Option<ProxyPeerFilter>,
 }

 /// Used to create [`Server`]s.
@@ -116,6 +123,8 @@ where
     connection_helper: Option<OsString>,
     connection_helper_args: Vec<OsString>,
     binder: Option<Box<dyn crate::options::Binder>>,
+    // See `ServerBuilder::proxy_protocol_peer_filter`.
+    proxy_peer_filter: Option<ProxyPeerFilter>,
 }

 impl<Storage> ServerBuilder<Storage, DefaultUser>
@@ -167,6 +176,7 @@ where
             connection_helper: None,
             connection_helper_args: Vec::new(),
             binder: None,
+            proxy_peer_filter: None,
         }
     }

@@ -242,6 +252,7 @@ where
             connection_helper: self.connection_helper,
             connection_helper_args: self.connection_helper_args,
             binder: self.binder,
+            proxy_peer_filter: self.proxy_peer_filter,
         }
     }
 }
@@ -300,6 +311,7 @@ where
             connection_helper: None,
             connection_helper_args: Vec::new(),
             binder: None,
+            proxy_peer_filter: None,
         }
     }

@@ -382,6 +394,7 @@ where
             connection_helper: self.connection_helper,
             connection_helper_args: self.connection_helper_args,
             binder,
+            proxy_peer_filter: self.proxy_peer_filter,
         })
     }

@@ -723,6 +736,39 @@ where
         self
     }

+    /// Restricts which TCP peers the PROXY protocol mode listener serves.
+    ///
+    /// A PROXY protocol listener trusts the header each connection starts with, so anything
+    /// that can reach the listening port can claim any client address. When the proxy runs on
+    /// the same host, the listener is reachable by every local process, not just the proxy.
+    ///
+    /// The filter is called with the peer address of each accepted connection, before a single
+    /// byte is read. A connection it returns `false` for is logged and closed at once, so its
+    /// header is never parsed. For example, a proxy can bind each outbound socket itself and
+    /// only allow the local addresses it bound.
+    ///
+    /// Only used in PROXY protocol mode (see [`proxy_protocol_mode`](Self::proxy_protocol_mode)).
+    ///
+    /// # Example
+    ///
+    /// ```rust
+    /// use libunftp::ServerBuilder;
+    /// use unftp_sbe_fs::Filesystem;
+    ///
+    /// let server = ServerBuilder::new(Box::new(|| Filesystem::new("/tmp").unwrap()))
+    ///     .proxy_protocol_mode(2121)
+    ///     .proxy_protocol_peer_filter(|peer| peer.ip().is_loopback())
+    ///     .build();
+    /// ```
+    #[cfg(feature = "proxy_protocol")]
+    pub fn proxy_protocol_peer_filter<F>(mut self, filter: F) -> Self
+    where
+        F: Fn(SocketAddr) -> bool + Send + Sync + 'static,
+    {
+        self.proxy_peer_filter = Some(Arc::new(filter));
+        self
+    }
+
     /// Allows telling libunftp when and how to shutdown gracefully.
     ///
     /// The passed argument is a future that resolves when libunftp should shut down. The future
@@ -936,8 +982,44 @@ where
     ///
     #[tracing_attributes::instrument]
     pub async fn listen<T: Into<String> + Debug>(self, bind_address: T) -> std::result::Result<(), ServerError> {
-        let logger = self.logger.clone();
         let bind_address: SocketAddr = bind_address.into().parse()?;
+        self.listen_on(bind_address, None).await
+    }
+
+    /// Runs the server like [`listen`](Server::listen), but accepts control connections (and, in
+    /// PROXY protocol mode, all connections) on a listener the caller has already bound.
+    ///
+    /// The caller owns the socket from the start: there is no window between picking a free
+    /// port and libunftp binding it in which another process could take the port, and the
+    /// caller knows the bound address before the server runs. In pooled mode the passive
+    /// listeners are bound on the listener's IP, as with [`listen`](Server::listen).
+    ///
+    /// # Example
+    ///
+    /// ```rust
+    /// use libunftp::ServerBuilder;
+    /// use unftp_sbe_fs::Filesystem;
+    /// use tokio::runtime::Runtime;
+    ///
+    /// let mut rt = Runtime::new().unwrap();
+    /// rt.spawn(async {
+    ///     let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
+    ///     println!("serving on {}", listener.local_addr().unwrap());
+    ///     let server = ServerBuilder::new(Box::new(|| Filesystem::new("/srv/ftp").unwrap())).build().unwrap();
+    ///     server.listen_with_listener(listener).await
+    /// });
+    /// // ...
+    /// drop(rt);
+    /// ```
+    pub async fn listen_with_listener(self, listener: tokio::net::TcpListener) -> std::result::Result<(), ServerError> {
+        let bind_address = listener.local_addr()?;
+        self.listen_on(bind_address, Some(listener)).await
+    }
+
+    // Shared body of `listen` and `listen_with_listener`: binds `bind_address` unless a
+    // `prebound` listener is passed (see `bind_control_listener`).
+    async fn listen_on(self, bind_address: SocketAddr, prebound: Option<tokio::net::TcpListener>) -> std::result::Result<(), ServerError> {
+        let logger = self.logger.clone();
         let shutdown_notifier = Arc::new(shutdown::Notifier::new());

         let failed_logins = self.failed_logins_policy.as_ref().map(|policy| FailedLoginsCache::new(policy.clone()));
@@ -950,8 +1032,10 @@ where
                 Box::pin(
                     listen_prebound::PreboundListener {
                         bind_address,
+                        prebound,
                         logger: self.logger.clone(),
                         external_control_port,
+                        peer_filter: self.proxy_peer_filter.clone(),
                         options: (&self).into(),
                         switchboard,
                         shutdown_topic: shutdown_notifier.clone(),
@@ -966,8 +1050,10 @@ where
                 Box::pin(
                     listen_prebound::PreboundListener {
                         bind_address,
+                        prebound,
                         logger: self.logger.clone(),
                         external_control_port: None,
+                        peer_filter: None,
                         options: (&self).into(),
                         switchboard,
                         shutdown_topic: shutdown_notifier.clone(),
@@ -979,6 +1065,7 @@ where
             ListenerMode::Legacy => Box::pin(
                 listen::Listener {
                     bind_address,
+                    prebound,
                     logger: self.logger.clone(),
                     options: (&self).into(),
                     shutdown_topic: shutdown_notifier.clone(),
@@ -1133,6 +1220,15 @@ where
     }
 }

+// Every listener mode binds its control listener through this, so
+// `Server::listen_with_listener` can hand in one the caller already bound.
+async fn bind_control_listener(prebound: Option<tokio::net::TcpListener>, bind_address: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
+    match prebound {
+        Some(listener) => Ok(listener),
+        None => tokio::net::TcpListener::bind(bind_address).await,
+    }
+}
+
 #[derive(Clone, Copy, Debug)]
 pub(in crate::server) enum ListenerMode {
     Legacy,
@@ -1222,4 +1318,52 @@ mod tests {
         assert!(result.is_err());
         assert!(result.unwrap_err().to_string().contains("user_detail_provider"));
     }
+
+    // Tests for `listen_with_listener` and `proxy_protocol_peer_filter`.
+
+    /// Start a PROXY protocol server on a prebound loopback listener with `filter`, send one
+    /// control connection with a PROXY header and return what the server answered.
+    #[cfg(feature = "proxy_protocol")]
+    async fn proxy_greeting_with_filter(filter: impl Fn(SocketAddr) -> bool + Send + Sync + 'static) -> Vec<u8> {
+        use tokio::io::{AsyncReadExt, AsyncWriteExt};
+
+        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
+        let addr = listener.local_addr().unwrap();
+        let server = builder().proxy_protocol_mode(2121).proxy_protocol_peer_filter(filter).build().unwrap();
+        let task = tokio::spawn(server.listen_with_listener(listener));
+
+        // No retry loop: the listener is bound before the server task runs.
+        let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
+        // A refused connection may be reset before or after this write; either way the server
+        // must not answer it.
+        let _ = client.write_all(b"PROXY TCP4 192.0.2.7 192.0.2.1 40000 2121\r\n").await;
+        let mut reply = Vec::new();
+        let mut buf = [0u8; 64];
+        let read = tokio::time::timeout(Duration::from_secs(5), async {
+            while !reply.ends_with(b"\r\n") {
+                match client.read(&mut buf).await {
+                    Ok(0) | Err(_) => break,
+                    Ok(n) => reply.extend_from_slice(&buf[..n]),
+                }
+            }
+        })
+        .await;
+        task.abort();
+        assert!(read.is_ok(), "server neither answered nor closed the connection");
+        reply
+    }
+
+    #[cfg(feature = "proxy_protocol")]
+    #[tokio::test]
+    async fn proxy_peer_filter_allowing_the_peer_serves_it() {
+        let reply = proxy_greeting_with_filter(|peer| peer.ip().is_loopback()).await;
+        assert!(reply.starts_with(b"220"), "reply: {:?}", String::from_utf8_lossy(&reply));
+    }
+
+    #[cfg(feature = "proxy_protocol")]
+    #[tokio::test]
+    async fn proxy_peer_filter_refusing_the_peer_closes_it_unserved() {
+        let reply = proxy_greeting_with_filter(|_| false).await;
+        assert!(reply.is_empty(), "refused peer was served: {:?}", String::from_utf8_lossy(&reply));
+    }
 }
diff --git a/src/server/ftpserver/listen.rs b/src/server/ftpserver/listen.rs
index e729c90..e083953 100644
--- a/src/server/ftpserver/listen.rs
+++ b/src/server/ftpserver/listen.rs
@@ -19,6 +19,8 @@ where
     User: UserDetail,
 {
     pub bind_address: SocketAddr,
+    // Set by `Server::listen_with_listener`.
+    pub prebound: Option<TcpListener>,
     pub logger: slog::Logger,
     pub options: OptionsHolder<Storage, User>,
     pub shutdown_topic: Arc<shutdown::Notifier>,
@@ -37,13 +39,14 @@ where
         let Listener {
             logger,
             bind_address,
+            prebound,
             options,
             shutdown_topic,
             failed_logins,
             connection_helper,
             connection_helper_args,
         } = self;
-        let listener = TcpListener::bind(bind_address).await?;
+        let listener = super::bind_control_listener(prebound, bind_address).await?;
         loop {
             let shutdown_listener = shutdown_topic.subscribe().await;
             match listener.accept().await {
diff --git a/src/server/ftpserver/listen_prebound.rs b/src/server/ftpserver/listen_prebound.rs
index aaff8bf..1331568 100644
--- a/src/server/ftpserver/listen_prebound.rs
+++ b/src/server/ftpserver/listen_prebound.rs
@@ -28,9 +28,14 @@ where
     User: UserDetail,
 {
     pub bind_address: SocketAddr,
+    // Set by `Server::listen_with_listener`.
+    pub prebound: Option<tokio::net::TcpListener>,
     pub logger: slog::Logger,
     #[cfg_attr(not(feature = "proxy_protocol"), allow(dead_code))]
     pub external_control_port: Option<u16>,
+    // See `ServerBuilder::proxy_protocol_peer_filter`.
+    #[cfg_attr(not(feature = "proxy_protocol"), allow(dead_code))]
+    pub peer_filter: Option<crate::server::ftpserver::ProxyPeerFilter>,
     pub options: OptionsHolder<Storage, User>,
     pub switchboard: Switchboard<Storage, User>,
     pub shutdown_topic: Arc<shutdown::Notifier>,
diff --git a/src/server/ftpserver/mode/pooled.rs b/src/server/ftpserver/mode/pooled.rs
index 55cd867..7a883f8 100644
--- a/src/server/ftpserver/mode/pooled.rs
+++ b/src/server/ftpserver/mode/pooled.rs
@@ -55,7 +55,7 @@ where
     User: UserDetail + 'static,
 {
     pub async fn listen_pooled(mut self) -> std::result::Result<(), ServerError> {
-        let control_listener = tokio::net::TcpListener::bind(self.bind_address).await?;
+        let control_listener = crate::server::ftpserver::bind_control_listener(self.prebound.take(), self.bind_address).await?;

         let mut passive_listeners: Vec<tokio::net::TcpListener> = Vec::new();
         let listener_ip = control_listener.local_addr()?.ip();
diff --git a/src/server/ftpserver/mode/proxy.rs b/src/server/ftpserver/mode/proxy.rs
index e52774b..46a3920 100644
--- a/src/server/ftpserver/mode/proxy.rs
+++ b/src/server/ftpserver/mode/proxy.rs
@@ -14,7 +14,7 @@ where
     User: UserDetail + 'static,
 {
     pub async fn listen_proxy_protocol(mut self) -> std::result::Result<(), ServerError> {
-        let listener = tokio::net::TcpListener::bind(self.bind_address).await?;
+        let listener = crate::server::ftpserver::bind_control_listener(self.prebound.take(), self.bind_address).await?;

         // all sessions use this callback to request for a passive listening port.
         let (switchboard_msg_tx, mut switchboard_msg_rx): (SwitchboardSender<Storage, User>, SwitchboardReceiver<Storage, User>) = channel(1);
@@ -27,7 +27,14 @@ where
             // - channel messages originating from PASV, to handle the passive listening port

             tokio::select! {
-                Ok((tcp_stream, _socket_addr)) = listener.accept() => {
+                Ok((tcp_stream, socket_addr)) = listener.accept() => {
+                    // Refuse peers the filter does not allow before reading anything, so their
+                    // PROXY header is never trusted.
+                    if let Some(filter) = &self.peer_filter && !filter(socket_addr) {
+                        slog::warn!(self.logger, "Refused proxy connection from {:?}: not allowed by the peer filter", socket_addr);
+                        drop(tcp_stream);
+                        continue;
+                    }
                     let socket_addr = tcp_stream.peer_addr();
                     slog::info!(self.logger, "Incoming proxy connection from {:?}", socket_addr);
                     spawn_proxy_header_parsing(self.logger.clone(), tcp_stream, proxy_msg_tx.clone());
````

</details>

### How to submit

1. Open the issue above on `bolcom/libunftp` and note its number. Wait for a maintainer to agree
   with the direction (it adds public API), or open the pull request right away and link it.
2. Fork `bolcom/libunftp` and branch from `master` (check that `master` still has no equivalent
   API; if the listener code moved, re-apply by hand).
3. Save the diff above as `listen-with-listener.patch` and apply it with
   `git apply listen-with-listener.patch`.
4. Run `cargo test -p libunftp --lib`, `cargo clippy -p libunftp -- -D warnings` and
   `cargo fmt --check`. Upstream may also want an entry in `CHANGELOG.md`.
5. Open the pull request with the title and description above, filling in the issue number.
6. Record both links in `vendor/vendored-forks.json` (the delta's `refs`), in
   `docs/supply-chain.md` → "Upstreaming status", and on termiHub #4100.

If upstream picks a different API (for example a general accept hook for all modes, or a
`listen_with_listener` that takes a `std::net::TcpListener`), adapt `start_backend` and
`BackendDialer` in `core/src/embedded_servers/` to it; the termiHub side only needs "serve on
my listener" and "refuse peers I did not open".

## Retiring the fork

Once a `libunftp` release contains both deltas (or equivalents):

1. Remove the `[patch.crates-io]` entry for `libunftp` and `vendor/libunftp` from the `exclude`
   list in the root `Cargo.toml`, bump the `core/Cargo.toml` `libunftp` requirement to that
   release if it is on a new line, and run `cargo update -p libunftp`.
2. Delete `vendor/libunftp/`, its entry in `vendor/vendored-forks.json`, its rows in the
   "Vendored forks" and "Upstreaming status" tables of `docs/supply-chain.md`, and update the
   parser watchlist row.
3. Keep `backend_header_reader_ends_when_a_connection_closes_without_a_header` and
   `direct_loopback_connection_with_a_forged_proxy_header_is_refused` in
   `core/src/embedded_servers/ftp_server/relay_tests.rs`: they then guard the upstream changes.

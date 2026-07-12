//! Protocol-agnostic local-IPC transport: a Unix domain socket on unix and a
//! Windows named pipe on windows, behind one small bind/accept/connect API.
//!
//! The transport moves opaque byte streams — it imposes no framing — so any
//! protocol (NDJSON request/response, length-prefixed binary frames, …) can be
//! layered on top. Concrete socket/pipe types are erased behind [`BoxedReader`]
//! and [`BoxedWriter`] so consumers stay fully platform-independent.
//!
//! ```text
//!  bind(address) ─► LocalSocketListener ─► accept() ─► (BoxedReader, BoxedWriter)
//!  connect(address) ───────────────────────────────► (BoxedReader, BoxedWriter)
//! ```
//!
//! Semantics are deliberately **fail-fast one-shot** by default:
//! - [`connect`] tries once and returns the underlying error immediately (no
//!   retry) — suited to a "is a rendezvous instance already running?" probe.
//! - [`LocalSocketListener::bind`] only reclaims a socket path that is *stale*
//!   (present on disk but with nothing listening); if a live instance owns the
//!   endpoint, `bind` fails so the caller can treat that as "not the
//!   rendezvous". On windows this maps to `first_pipe_instance(true)`.
//!
//! Consumers that need a **retrying** connect or a **security-hardened**
//! listener (e.g. the agent session daemon) express that policy additively
//! rather than baking it into the fail-fast primitives:
//! - [`connect_with_retry`] wraps [`connect`] with a bounded retry loop.
//! - [`LocalSocketListener::bind_with_options`] takes a [`ListenerOptions`]
//!   selecting a [`ListenerSecurity`] policy (unix `0o700` / windows per-user
//!   DACL) and a [`StaleReclaim`] policy (conservative probe vs. unconditional
//!   removal). The plain [`LocalSocketListener::bind`] is exactly
//!   `bind_with_options` with the default (inherit permissions, probe-then-
//!   remove) options, so existing rendezvous callers are unchanged.

use std::io;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};

/// Boxed reader half of a local-IPC connection (Unix socket or named pipe).
pub type BoxedReader = Box<dyn AsyncRead + Send + Unpin>;
/// Boxed writer half of a local-IPC connection (Unix socket or named pipe).
pub type BoxedWriter = Box<dyn AsyncWrite + Send + Unpin>;

/// Permission policy applied to a listener endpoint at bind time.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ListenerSecurity {
    /// Default OS permissions — no extra hardening. This is what the desktop
    /// spawn rendezvous uses.
    #[default]
    Inherit,
    /// Restrict the endpoint to the current user only. On unix the socket's
    /// parent directory and the socket file are set to `0o700`; on windows the
    /// pipe is created with a per-user DACL granting `GENERIC_ALL` to the
    /// current user's SID and `LocalSystem`. The named-pipe DACL is the direct
    /// security analog of the Unix socket's `0o700` permissions.
    CurrentUserOnly,
}

/// How [`LocalSocketListener::bind_with_options`] reclaims a pre-existing
/// endpoint path.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StaleReclaim {
    /// Only remove a unix socket file if a connect probe shows nothing is
    /// listening; a live owner keeps its path and the subsequent `bind` fails
    /// with `AddrInUse` (the "not the rendezvous" signal). No-op on windows,
    /// where `first_pipe_instance(true)` already rejects a live owner.
    #[default]
    IfProbeDead,
    /// Unconditionally remove any pre-existing unix socket file before binding
    /// — the owner reclaims its own per-session path on restart. No-op on
    /// windows (a crashed owner's pipe vanishes with its process, so there is
    /// never a stale path to reclaim).
    Unconditional,
}

/// Options controlling how a [`LocalSocketListener`] binds its endpoint.
#[derive(Clone, Copy, Debug, Default)]
pub struct ListenerOptions {
    /// Permission hardening applied to the bound endpoint.
    pub security: ListenerSecurity,
    /// How a pre-existing endpoint path is reclaimed.
    pub stale_reclaim: StaleReclaim,
}

#[cfg(unix)]
pub use unix_impl::{connect, LocalSocketListener};
#[cfg(windows)]
pub use windows_impl::{connect, LocalSocketListener};

#[cfg(unix)]
use unix_impl::is_retryable;
#[cfg(windows)]
use windows_impl::is_retryable;

/// Connect to `address`, retrying while the endpoint is not yet available.
///
/// Repeatedly calls the fail-fast [`connect`] until it succeeds or `timeout`
/// elapses, sleeping `poll_interval` between tries whenever the connect fails
/// with a "not ready yet" error (the endpoint owner is still binding during
/// slow startup work). Once the deadline passes, the last underlying error is
/// returned. A *non*-retryable error (e.g. a permission failure) is returned
/// immediately, so a caller racing this against the owner process exiting still
/// fails fast on a real error.
///
/// The retry policy lives here in one place; only the per-platform "endpoint
/// not ready yet" error predicate differs and is supplied internally.
pub async fn connect_with_retry(
    address: &str,
    timeout: Duration,
    poll_interval: Duration,
) -> io::Result<(BoxedReader, BoxedWriter)> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match connect(address).await {
            Ok(halves) => return Ok(halves),
            Err(e) if is_retryable(&e) && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(poll_interval).await;
            }
            Err(e) => return Err(e),
        }
    }
}

// ── Unix domain socket transport ────────────────────────────────────

#[cfg(unix)]
mod unix_impl {
    use super::{BoxedReader, BoxedWriter, ListenerOptions, ListenerSecurity, StaleReclaim};
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use tokio::net::{UnixListener, UnixStream};

    /// A listening Unix domain socket.
    pub struct LocalSocketListener {
        listener: UnixListener,
        path: PathBuf,
    }

    impl LocalSocketListener {
        /// Bind a listener at the socket path `address`, reclaiming a stale
        /// socket file if present.
        ///
        /// "Stale" means the file exists on disk but nothing is listening: a
        /// connect probe fails, so the file is safe to remove (a crashed
        /// instance left it behind). If a *live* instance owns the path, the
        /// probe succeeds, the file is left untouched, and the subsequent
        /// `bind` fails with `AddrInUse` — the caller's "not the rendezvous"
        /// signal.
        ///
        /// Equivalent to [`Self::bind_with_options`] with the default options
        /// (inherit permissions, probe-then-remove).
        pub async fn bind(address: &str) -> io::Result<Self> {
            Self::bind_with_options(address, ListenerOptions::default()).await
        }

        /// Bind a listener at the socket path `address`, applying the given
        /// [`ListenerOptions`] security and stale-reclaim policies.
        pub async fn bind_with_options(
            address: &str,
            options: ListenerOptions,
        ) -> io::Result<Self> {
            let path = PathBuf::from(address);

            // Security (pre-bind): ensure the socket's parent directory exists
            // and is restricted to the current user, so the endpoint is only
            // reachable by its owner.
            if options.security == ListenerSecurity::CurrentUserOnly {
                if let Some(parent) = path.parent() {
                    ensure_current_user_dir(parent)?;
                }
            }

            // Reclaim any pre-existing socket file.
            match options.stale_reclaim {
                StaleReclaim::IfProbeDead => {
                    if path.exists() && UnixStream::connect(&path).await.is_err() {
                        let _ = std::fs::remove_file(&path);
                    }
                }
                StaleReclaim::Unconditional => {
                    let _ = std::fs::remove_file(&path);
                }
            }

            let listener = UnixListener::bind(&path)?;

            // Security (post-bind): restrict the socket file itself.
            if options.security == ListenerSecurity::CurrentUserOnly {
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
            }

            Ok(Self { listener, path })
        }

        /// Accept the next client connection, returning erased read/write halves.
        pub async fn accept(&mut self) -> io::Result<(BoxedReader, BoxedWriter)> {
            let (stream, _addr) = self.listener.accept().await?;
            let (reader, writer) = stream.into_split();
            Ok((Box::new(reader), Box::new(writer)))
        }

        /// Remove the socket file. Call on listener shutdown when the endpoint
        /// owns a per-session path that should not outlive the process.
        pub fn cleanup(&self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    /// Ensure `dir` exists with mode `0o700`.
    fn ensure_current_user_dir(dir: &Path) -> io::Result<()> {
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        Ok(())
    }

    /// Connect once to a socket path, failing fast if nothing is listening.
    pub async fn connect(address: &str) -> io::Result<(BoxedReader, BoxedWriter)> {
        let (reader, writer) = UnixStream::connect(address).await?.into_split();
        Ok((Box::new(reader), Box::new(writer)))
    }

    /// Whether a failed [`connect`] means "endpoint not ready yet" (worth a
    /// retry) rather than a fatal error.
    pub(super) fn is_retryable(e: &io::Error) -> bool {
        matches!(
            e.kind(),
            io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
        )
    }
}

// ── Windows named-pipe transport ────────────────────────────────────

#[cfg(windows)]
mod windows_impl {
    use super::{BoxedReader, BoxedWriter, ListenerOptions, ListenerSecurity};
    use std::ffi::c_void;
    use std::io;

    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};

    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY};

    /// A listening Windows named pipe.
    ///
    /// Named pipes serve one client per server instance, so the listener keeps
    /// the next (not-yet-connected) instance ready and stages a fresh one each
    /// time a client is accepted. When a [`ListenerSecurity::CurrentUserOnly`]
    /// policy is used, every instance is created with the same per-user DACL.
    pub struct LocalSocketListener {
        name: String,
        /// The per-user security descriptor applied to each pipe instance, or
        /// `None` for the default (inherit) permission policy.
        security: Option<security::SecurityAttributes>,
        /// The next pipe instance, waiting for a client to connect.
        next: Option<NamedPipeServer>,
    }

    impl LocalSocketListener {
        /// Bind the first pipe instance at pipe name `address`.
        ///
        /// `first_pipe_instance(true)` fails if another instance already owns
        /// the pipe — the caller's "not the rendezvous" signal, the exact
        /// analog of the unix `AddrInUse` case.
        ///
        /// Equivalent to [`Self::bind_with_options`] with the default options
        /// (inherit permissions).
        pub async fn bind(address: &str) -> io::Result<Self> {
            Self::bind_with_options(address, ListenerOptions::default()).await
        }

        /// Bind the first pipe instance at pipe name `address`, applying the
        /// given [`ListenerOptions`] security policy.
        ///
        /// `stale_reclaim` has no analog on windows: `first_pipe_instance(true)`
        /// already rejects a live owner, and a crashed owner's pipe vanishes
        /// with its process, so there is never a stale path to reclaim.
        pub async fn bind_with_options(
            address: &str,
            options: ListenerOptions,
        ) -> io::Result<Self> {
            let security = match options.security {
                ListenerSecurity::CurrentUserOnly => {
                    Some(security::SecurityAttributes::for_current_user()?)
                }
                ListenerSecurity::Inherit => None,
            };
            let next = create_instance(address, security.as_ref(), true)?;
            Ok(Self {
                name: address.to_string(),
                security,
                next: Some(next),
            })
        }

        /// Accept the next client connection, returning erased read/write halves.
        pub async fn accept(&mut self) -> io::Result<(BoxedReader, BoxedWriter)> {
            let server = self
                .next
                .as_ref()
                .expect("listener always holds a pending pipe instance");
            server.connect().await?;

            // Hand off the connected instance and stage a fresh one for the
            // next client before serving this one, so no client races into a
            // missing pipe.
            let connected = self.next.take().expect("pending instance present");
            self.next = Some(create_instance(&self.name, self.security.as_ref(), false)?);

            let (reader, writer) = tokio::io::split(connected);
            Ok((Box::new(reader), Box::new(writer)))
        }

        /// No-op on windows: the pipe disappears when its instances are dropped.
        pub fn cleanup(&self) {}
    }

    /// Create a named-pipe server instance, optionally with a per-user security
    /// descriptor.
    fn create_instance(
        name: &str,
        security: Option<&security::SecurityAttributes>,
        first: bool,
    ) -> io::Result<NamedPipeServer> {
        match security {
            Some(security) => {
                // SAFETY: `security` outlives this call (owned by the
                // `LocalSocketListener`), and `as_ptr` points at a valid
                // `SECURITY_ATTRIBUTES` whose descriptor is owned and freed by
                // `security`.
                unsafe {
                    ServerOptions::new()
                        .first_pipe_instance(first)
                        .create_with_security_attributes_raw(name, security.as_ptr() as *mut c_void)
                }
            }
            None => ServerOptions::new().first_pipe_instance(first).create(name),
        }
    }

    /// Connect once to a pipe name, failing fast if it is not present.
    pub async fn connect(address: &str) -> io::Result<(BoxedReader, BoxedWriter)> {
        let client = ClientOptions::new().open(address)?;
        let (reader, writer) = tokio::io::split(client);
        Ok((Box::new(reader), Box::new(writer)))
    }

    /// Whether a failed [`connect`] means "endpoint not ready yet" (worth a
    /// retry) rather than a fatal error: the pipe is not yet created
    /// (`ERROR_FILE_NOT_FOUND`) or every instance is momentarily busy
    /// (`ERROR_PIPE_BUSY`).
    pub(super) fn is_retryable(e: &io::Error) -> bool {
        matches!(
            e.raw_os_error(),
            Some(code)
                if code == ERROR_FILE_NOT_FOUND as i32 || code == ERROR_PIPE_BUSY as i32
        )
    }

    /// Per-user security descriptor construction for the named pipe.
    mod security {
        use std::io;
        use std::ptr;

        use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
        use windows_sys::Win32::Security::Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        };
        use windows_sys::Win32::Security::{
            GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
            TOKEN_USER,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        /// Owns a security descriptor restricting the pipe to the current user
        /// and `LocalSystem`, plus the `SECURITY_ATTRIBUTES` referencing it.
        pub struct SecurityAttributes {
            descriptor: PSECURITY_DESCRIPTOR,
            attributes: SECURITY_ATTRIBUTES,
        }

        // The owned raw pointers are exclusively managed here; sending the
        // listener (and thus this owner) across threads is safe.
        unsafe impl Send for SecurityAttributes {}
        unsafe impl Sync for SecurityAttributes {}

        impl SecurityAttributes {
            /// Build a DACL granting `GENERIC_ALL` only to the current user's
            /// SID and `LocalSystem` (`SY`), protected from inheritance (`P`).
            pub fn for_current_user() -> io::Result<Self> {
                let sid_string = current_user_sid_string()?;
                let sddl = format!("D:P(A;;GA;;;{sid_string})(A;;GA;;;SY)");
                let sddl_wide = to_wide(&sddl);

                let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
                // SAFETY: `sddl_wide` is a valid null-terminated UTF-16 string;
                // `descriptor` receives a LocalAlloc'd descriptor we free on drop.
                let ok = unsafe {
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        sddl_wide.as_ptr(),
                        SDDL_REVISION_1,
                        &mut descriptor,
                        ptr::null_mut(),
                    )
                };
                if ok == 0 {
                    return Err(io::Error::last_os_error());
                }

                let attributes = SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: descriptor,
                    bInheritHandle: 0,
                };
                Ok(Self {
                    descriptor,
                    attributes,
                })
            }

            /// Pointer to the `SECURITY_ATTRIBUTES` for passing to pipe creation.
            pub fn as_ptr(&self) -> *const SECURITY_ATTRIBUTES {
                &self.attributes
            }
        }

        impl Drop for SecurityAttributes {
            fn drop(&mut self) {
                if !self.descriptor.is_null() {
                    // SAFETY: `descriptor` was allocated by
                    // ConvertStringSecurityDescriptorToSecurityDescriptorW.
                    unsafe { LocalFree(self.descriptor as HLOCAL) };
                }
            }
        }

        /// Resolve the current process user's SID into its string form.
        fn current_user_sid_string() -> io::Result<String> {
            // SAFETY: standard token-query FFI sequence; every handle and
            // allocation is released before returning.
            unsafe {
                let mut token: HANDLE = ptr::null_mut();
                if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                    return Err(io::Error::last_os_error());
                }

                // First call sizes the buffer; it is expected to "fail".
                let mut len: u32 = 0;
                GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut len);
                if len == 0 {
                    CloseHandle(token);
                    return Err(io::Error::last_os_error());
                }

                let mut buf = vec![0u8; len as usize];
                let ok = GetTokenInformation(
                    token,
                    TokenUser,
                    buf.as_mut_ptr() as *mut _,
                    len,
                    &mut len,
                );
                CloseHandle(token);
                if ok == 0 {
                    return Err(io::Error::last_os_error());
                }

                let token_user = &*(buf.as_ptr() as *const TOKEN_USER);
                let mut sid_ptr: *mut u16 = ptr::null_mut();
                if ConvertSidToStringSidW(token_user.User.Sid, &mut sid_ptr) == 0 {
                    return Err(io::Error::last_os_error());
                }
                let sid_string = wide_to_string(sid_ptr);
                LocalFree(sid_ptr as HLOCAL);
                Ok(sid_string)
            }
        }

        /// Encode a Rust string as a null-terminated UTF-16 buffer.
        fn to_wide(s: &str) -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        }

        /// Read a null-terminated UTF-16 string into a Rust `String`.
        fn wide_to_string(ptr: *const u16) -> String {
            if ptr.is_null() {
                return String::new();
            }
            let mut len = 0usize;
            // SAFETY: `ptr` is a valid null-terminated wide string from Win32.
            unsafe {
                while *ptr.add(len) != 0 {
                    len += 1;
                }
                let slice = std::slice::from_raw_parts(ptr, len);
                String::from_utf16_lossy(slice)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Monotonic per-process counter for building unique endpoint addresses.
    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Build a unique per-process endpoint address so concurrent tests don't
    /// collide on the same socket path / pipe name.
    fn unique_address(tag: &str) -> String {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        #[cfg(unix)]
        {
            std::env::temp_dir()
                .join(format!("termihub-core-ipc-{tag}-{pid}-{n}.sock"))
                .to_string_lossy()
                .into_owned()
        }
        #[cfg(windows)]
        {
            format!(r"\\.\pipe\termihub-core-ipc-{tag}-{pid}-{n}")
        }
    }

    /// Round-trip opaque bytes through the platform transport: bind, accept on a
    /// server task, connect from the client, echo the bytes back.
    #[tokio::test]
    async fn bind_accept_connect_round_trip() {
        let address = unique_address("rt");
        let mut listener = LocalSocketListener::bind(&address).await.expect("bind");

        let server = tokio::spawn(async move {
            let (mut reader, mut writer) = listener.accept().await.expect("accept");
            let mut buf = [0u8; 5];
            reader.read_exact(&mut buf).await.expect("server read");
            writer.write_all(&buf).await.expect("server echo");
            writer.flush().await.expect("server flush");
        });

        let (mut reader, mut writer) = connect(&address).await.expect("connect");
        writer.write_all(b"hello").await.expect("client write");
        writer.flush().await.expect("client flush");
        let mut got = [0u8; 5];
        reader.read_exact(&mut got).await.expect("client read");
        assert_eq!(&got, b"hello");

        server.await.expect("server task");
    }

    /// A second connection to the same listener must also succeed (verifies the
    /// listener stages a fresh instance after each accept on windows).
    #[tokio::test]
    async fn listener_accepts_sequential_connections() {
        let address = unique_address("seq");
        let mut listener = LocalSocketListener::bind(&address).await.expect("bind");

        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut reader, mut writer) = listener.accept().await.expect("accept");
                let mut b = [0u8; 1];
                reader.read_exact(&mut b).await.expect("server read");
                writer.write_all(&b).await.expect("server echo");
                writer.flush().await.expect("server flush");
            }
        });

        for i in 0..2u8 {
            let (mut reader, mut writer) = connect(&address).await.expect("connect");
            writer.write_all(&[i]).await.expect("client write");
            writer.flush().await.expect("client flush");
            let mut got = [0u8; 1];
            reader.read_exact(&mut got).await.expect("client read");
            assert_eq!(got[0], i);
            drop(reader);
            drop(writer);
        }

        server.await.expect("server task");
    }

    /// `connect` fails fast (does not hang/retry) when no listener is present.
    #[tokio::test]
    async fn connect_fails_fast_when_absent() {
        let address = unique_address("absent");
        let result = connect(&address).await;
        assert!(result.is_err(), "connect to a dead endpoint must error");
    }

    /// [`connect_with_retry`] waits for an endpoint that only appears after a
    /// delay, then connects successfully.
    #[tokio::test]
    async fn connect_with_retry_waits_for_a_late_listener() {
        let address = unique_address("retry-late");

        let listener_address = address.clone();
        let server = tokio::spawn(async move {
            // Bind only after a delay so the first connect attempts fail with a
            // retryable "endpoint not ready yet" error.
            tokio::time::sleep(Duration::from_millis(150)).await;
            let mut listener = LocalSocketListener::bind(&listener_address)
                .await
                .expect("bind");
            let (mut reader, mut writer) = listener.accept().await.expect("accept");
            let mut buf = [0u8; 2];
            reader.read_exact(&mut buf).await.expect("server read");
            writer.write_all(&buf).await.expect("server echo");
            writer.flush().await.expect("server flush");
        });

        let (mut reader, mut writer) =
            connect_with_retry(&address, Duration::from_secs(5), Duration::from_millis(20))
                .await
                .expect("retry connect should succeed once the listener appears");
        writer.write_all(b"hi").await.expect("client write");
        writer.flush().await.expect("client flush");
        let mut got = [0u8; 2];
        reader.read_exact(&mut got).await.expect("client read");
        assert_eq!(&got, b"hi");

        server.await.expect("server task");
    }

    /// [`connect_with_retry`] gives up once the timeout elapses when the
    /// endpoint never appears, honoring the timeout window.
    #[tokio::test]
    async fn connect_with_retry_times_out_when_endpoint_never_appears() {
        let address = unique_address("retry-timeout");
        let start = tokio::time::Instant::now();
        let result = connect_with_retry(
            &address,
            Duration::from_millis(200),
            Duration::from_millis(20),
        )
        .await;
        assert!(
            result.is_err(),
            "retry connect must fail when no listener ever appears"
        );
        assert!(
            start.elapsed() >= Duration::from_millis(200),
            "retry connect should honor the timeout window before giving up"
        );
    }

    /// A stale unix socket file (present on disk, nothing listening) is removed
    /// so `bind` succeeds — the crashed-instance recovery path.
    #[cfg(unix)]
    #[tokio::test]
    async fn bind_reclaims_stale_unix_socket() {
        let address = unique_address("stale");

        // Bind then drop a listener: tokio does not unlink the socket file on
        // drop, so the path is left behind with nothing listening (stale).
        let first = tokio::net::UnixListener::bind(&address).expect("first bind");
        drop(first);
        assert!(
            std::path::Path::new(&address).exists(),
            "stale socket file should remain on disk"
        );

        // A fresh bind must reclaim the stale path and be usable.
        let mut listener = LocalSocketListener::bind(&address)
            .await
            .expect("bind reclaims stale socket");
        let server = tokio::spawn(async move {
            let (mut reader, mut writer) = listener.accept().await.expect("accept");
            let mut b = [0u8; 2];
            reader.read_exact(&mut b).await.expect("server read");
            writer.write_all(&b).await.expect("server echo");
            writer.flush().await.expect("server flush");
        });
        let (mut reader, mut writer) = connect(&address).await.expect("connect");
        writer.write_all(b"ok").await.expect("write");
        writer.flush().await.expect("flush");
        let mut got = [0u8; 2];
        reader.read_exact(&mut got).await.expect("read");
        assert_eq!(&got, b"ok");
        server.await.expect("server task");
    }

    /// Binding an endpoint a live instance already owns fails (the "not the
    /// rendezvous" signal), rather than stealing it.
    #[cfg(unix)]
    #[tokio::test]
    async fn bind_rejects_live_endpoint() {
        let address = unique_address("live");
        let _held = LocalSocketListener::bind(&address)
            .await
            .expect("first bind");
        let second = LocalSocketListener::bind(&address).await;
        assert!(
            second.is_err(),
            "binding an endpoint owned by a live listener must fail"
        );
    }

    /// The [`ListenerSecurity::CurrentUserOnly`] policy creates the socket's
    /// parent directory and the socket file with `0o700` permissions (the unix
    /// analog of the windows per-user DACL).
    #[cfg(unix)]
    #[tokio::test]
    async fn current_user_only_binds_0700_dir_and_socket() {
        use std::os::unix::fs::PermissionsExt;

        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("termihub-core-ipc-perm-{}-{n}", std::process::id()));
        // Ensure a clean slate so the policy is what creates the directory.
        let _ = std::fs::remove_dir_all(&dir);
        let address = dir.join("perm.sock").to_string_lossy().into_owned();

        let listener = LocalSocketListener::bind_with_options(
            &address,
            ListenerOptions {
                security: ListenerSecurity::CurrentUserOnly,
                stale_reclaim: StaleReclaim::Unconditional,
            },
        )
        .await
        .expect("bind with current-user policy");

        let dir_mode = std::fs::metadata(&dir)
            .expect("dir metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            dir_mode, 0o700,
            "socket dir must be 0o700, got {dir_mode:o}"
        );

        let file_mode = std::fs::metadata(&address)
            .expect("socket metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            file_mode, 0o700,
            "socket file must be 0o700, got {file_mode:o}"
        );

        listener.cleanup();
        let _ = std::fs::remove_dir_all(&dir);
    }
}

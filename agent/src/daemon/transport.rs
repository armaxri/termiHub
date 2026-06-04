//! Transport abstraction for the session daemon.
//!
//! The persistent-session daemon and its agent-side client exchange
//! length-prefixed frames (see [`super::protocol`]) over a local IPC channel.
//! This module abstracts that channel so the same daemon logic runs over a
//! **Unix domain socket** on unix and a **Windows named pipe** on windows.
//!
//! Both transports are restricted to the current user: on unix via a `0o700`
//! socket directory and socket file, on windows via a per-pipe DACL that grants
//! access only to the current user's SID and `LocalSystem`. The named-pipe DACL
//! is the direct security analog of the Unix socket's `0o700` permissions —
//! no exposed TCP port, no access for other local users.
//!
//! ```text
//!  bind() ──► DaemonListener ──► accept() ──► (BoxedReader, BoxedWriter)
//!  connect(endpoint) ─────────────────────► (BoxedReader, BoxedWriter)
//! ```
//!
//! The concrete socket/pipe types are erased behind [`BoxedReader`] and
//! [`BoxedWriter`] so the daemon event loop in [`super::process`] is fully
//! platform-independent.

use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};

/// Boxed reader half of a daemon connection (Unix socket or named pipe).
pub type BoxedReader = Box<dyn AsyncRead + Send + Unpin>;
/// Boxed writer half of a daemon connection (Unix socket or named pipe).
pub type BoxedWriter = Box<dyn AsyncWrite + Send + Unpin>;

// `connect` (and the shared retry helper it uses) are the client side of the
// transport. They are exercised by the round-trip tests below; the production
// agent client and Windows launcher are wired onto them in #767, so they read
// as dead code in the plain binary build until then.

/// How long [`connect`] waits for the daemon endpoint to appear before failing.
#[allow(dead_code)]
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// How often [`connect`] retries while the endpoint is not yet available.
#[allow(dead_code)]
const CONNECT_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Retry `attempt` until it succeeds or [`CONNECT_TIMEOUT`] elapses, sleeping
/// [`CONNECT_POLL_INTERVAL`] between tries whenever `retryable` accepts the
/// error (the daemon binds its endpoint during slow startup work). Once the
/// deadline passes, the last underlying error is returned.
///
/// Shared by the unix and windows [`connect`] implementations so the retry
/// policy lives in one place; only the per-platform attempt and the
/// "endpoint not ready yet" error predicate differ.
#[allow(dead_code)]
async fn connect_with_retry<A, Fut, R>(
    mut attempt: A,
    retryable: R,
) -> std::io::Result<(BoxedReader, BoxedWriter)>
where
    A: FnMut() -> Fut,
    Fut: std::future::Future<Output = std::io::Result<(BoxedReader, BoxedWriter)>>,
    R: Fn(&std::io::Error) -> bool,
{
    let deadline = tokio::time::Instant::now() + CONNECT_TIMEOUT;
    loop {
        match attempt().await {
            Ok(halves) => return Ok(halves),
            Err(e) if retryable(&e) && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(CONNECT_POLL_INTERVAL).await;
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(unix)]
#[allow(unused_imports)]
pub use unix_impl::{connect, endpoint_alive, session_endpoint, DaemonListener};
#[cfg(windows)]
#[allow(unused_imports)]
pub use windows_impl::{connect, endpoint_alive, session_endpoint, DaemonListener};

// ── Unix domain socket transport ────────────────────────────────────

#[cfg(unix)]
mod unix_impl {
    use super::*;
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    use tokio::net::{UnixListener, UnixStream};

    /// Compute the default endpoint (socket path) for a session.
    pub fn session_endpoint(session_id: &str) -> String {
        socket_dir()
            .join(format!("session-{session_id}.sock"))
            .to_string_lossy()
            .into_owned()
    }

    /// Cheap liveness pre-check: whether the socket file is present on disk.
    ///
    /// A bound daemon keeps its socket file; recovery uses this to skip dead
    /// sessions without paying the [`connect`] retry timeout.
    pub fn endpoint_alive(endpoint: &str) -> bool {
        Path::new(endpoint).exists()
    }

    /// Get the per-user socket directory (`/tmp/termihub/{user}`).
    fn socket_dir() -> PathBuf {
        let user = std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());
        PathBuf::from("/tmp/termihub").join(user)
    }

    /// Ensure the socket directory exists with mode `0700`.
    fn ensure_socket_dir(dir: &Path) -> io::Result<()> {
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        Ok(())
    }

    /// A listening Unix domain socket bound to a per-user, `0o700` path.
    pub struct DaemonListener {
        listener: UnixListener,
        path: PathBuf,
    }

    impl DaemonListener {
        /// Bind a listener at `endpoint`, creating the `0o700` socket directory
        /// and removing any stale socket file. The socket file appearing on
        /// disk signals readiness to connecting clients.
        pub fn bind(endpoint: &str) -> io::Result<Self> {
            let path = PathBuf::from(endpoint);
            if let Some(parent) = path.parent() {
                ensure_socket_dir(parent)?;
            }
            // Remove a stale socket file from a previous daemon.
            let _ = std::fs::remove_file(&path);
            let listener = UnixListener::bind(&path)?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
            Ok(Self { listener, path })
        }

        /// Accept the next agent connection, returning erased read/write halves.
        pub async fn accept(&mut self) -> io::Result<(BoxedReader, BoxedWriter)> {
            let (stream, _addr) = self.listener.accept().await?;
            let (reader, writer) = stream.into_split();
            Ok((Box::new(reader), Box::new(writer)))
        }

        /// Remove the socket file. Call on daemon shutdown.
        pub fn cleanup(&self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    /// Connect to a daemon endpoint, retrying briefly while the socket is not
    /// yet present (the daemon binds it during slow startup work).
    #[allow(dead_code)] // wired into the agent client/launcher in #767
    pub async fn connect(endpoint: &str) -> io::Result<(BoxedReader, BoxedWriter)> {
        super::connect_with_retry(
            || async {
                let (reader, writer) = UnixStream::connect(endpoint).await?.into_split();
                Ok((
                    Box::new(reader) as BoxedReader,
                    Box::new(writer) as BoxedWriter,
                ))
            },
            |e| {
                matches!(
                    e.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                )
            },
        )
        .await
    }
}

// ── Windows named-pipe transport ────────────────────────────────────

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::ffi::c_void;
    use std::io;

    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};

    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY};

    /// Compute the default endpoint (pipe name) for a session.
    ///
    /// Pipe names live in the `\\.\pipe\` namespace and are unique per session.
    pub fn session_endpoint(session_id: &str) -> String {
        format!(r"\\.\pipe\termihub-session-{session_id}")
    }

    /// Cheap liveness pre-check: whether a named-pipe instance exists.
    ///
    /// Uses `WaitNamedPipeW` with a 1 ms timeout, which does not consume an
    /// instance. Recovery uses this to skip dead sessions without paying the
    /// [`connect`] retry timeout. A non-existent pipe yields
    /// `ERROR_FILE_NOT_FOUND` (not alive); a busy one yields `ERROR_SEM_TIMEOUT`
    /// (the daemon is up but every instance is momentarily connected → alive).
    pub fn endpoint_alive(endpoint: &str) -> bool {
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_SEM_TIMEOUT};
        use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

        let wide: Vec<u16> = endpoint.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is a valid null-terminated UTF-16 string.
        if unsafe { WaitNamedPipeW(wide.as_ptr(), 1) } != 0 {
            return true;
        }
        unsafe { GetLastError() == ERROR_SEM_TIMEOUT }
    }

    /// A listening named pipe restricted to the current user via a DACL.
    ///
    /// Named pipes serve one client per server instance, so the listener keeps
    /// the next (not-yet-connected) instance ready and creates a fresh one each
    /// time a client is accepted.
    pub struct DaemonListener {
        name: String,
        security: security::SecurityAttributes,
        /// The next pipe instance, waiting for a client to connect.
        next: Option<NamedPipeServer>,
    }

    impl DaemonListener {
        /// Bind the first pipe instance with a per-user DACL.
        pub fn bind(endpoint: &str) -> io::Result<Self> {
            let security = security::SecurityAttributes::for_current_user()?;
            let next = create_instance(endpoint, &security, true)?;
            Ok(Self {
                name: endpoint.to_string(),
                security,
                next: Some(next),
            })
        }

        /// Accept the next agent connection, returning erased read/write halves.
        pub async fn accept(&mut self) -> io::Result<(BoxedReader, BoxedWriter)> {
            let server = self
                .next
                .as_ref()
                .expect("listener always holds a pending pipe instance");
            server.connect().await?;

            // Hand off the connected instance and stage a fresh one for the
            // next client before serving this one.
            let connected = self.next.take().expect("pending instance present");
            self.next = Some(create_instance(&self.name, &self.security, false)?);

            let (reader, writer) = tokio::io::split(connected);
            Ok((Box::new(reader), Box::new(writer)))
        }

        /// No-op on windows: the pipe disappears when its instances are dropped.
        pub fn cleanup(&self) {}
    }

    /// Create a named-pipe server instance with the given security descriptor.
    fn create_instance(
        name: &str,
        security: &security::SecurityAttributes,
        first: bool,
    ) -> io::Result<NamedPipeServer> {
        // SAFETY: `security` outlives this call (owned by the `DaemonListener`),
        // and `attrs_ptr` points at a valid `SECURITY_ATTRIBUTES` whose
        // descriptor is owned and freed by `security`.
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .create_with_security_attributes_raw(name, security.as_ptr() as *mut c_void)
        }
    }

    /// Connect to a daemon pipe, retrying while it is not yet created or all
    /// instances are momentarily busy.
    #[allow(dead_code)] // wired into the agent client/launcher in #767
    pub async fn connect(endpoint: &str) -> io::Result<(BoxedReader, BoxedWriter)> {
        super::connect_with_retry(
            || async {
                let client = ClientOptions::new().open(endpoint)?;
                let (reader, writer) = tokio::io::split(client);
                Ok((
                    Box::new(reader) as BoxedReader,
                    Box::new(writer) as BoxedWriter,
                ))
            },
            |e| {
                matches!(
                    e.raw_os_error(),
                    Some(code)
                        if code == ERROR_FILE_NOT_FOUND as i32 || code == ERROR_PIPE_BUSY as i32
                )
            },
        )
        .await
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
    use crate::daemon::protocol;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Generate a unique session id so concurrent tests don't collide on the
    /// same socket path / pipe name.
    fn unique_session(tag: &str) -> String {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        format!(
            "itest-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        )
    }

    #[test]
    fn session_endpoint_contains_session_id() {
        let endpoint = session_endpoint("abc-123");
        assert!(endpoint.contains("abc-123"), "endpoint was {endpoint}");
    }

    #[cfg(unix)]
    #[test]
    fn unix_endpoint_is_per_user_socket_path() {
        let endpoint = session_endpoint("xyz");
        assert!(endpoint.starts_with("/tmp/termihub/"), "got {endpoint}");
        assert!(endpoint.ends_with("session-xyz.sock"), "got {endpoint}");
    }

    #[cfg(windows)]
    #[test]
    fn windows_endpoint_is_pipe_name() {
        let endpoint = session_endpoint("xyz");
        assert!(endpoint.starts_with(r"\\.\pipe\"), "got {endpoint}");
        assert!(endpoint.contains("xyz"), "got {endpoint}");
    }

    /// Round-trip a frame through the platform transport: bind a listener,
    /// accept on one task, connect from another, and echo a frame back.
    #[tokio::test]
    async fn bind_accept_connect_round_trip() {
        let endpoint = session_endpoint(&unique_session("rt"));

        let mut listener = DaemonListener::bind(&endpoint).expect("bind listener");
        let server = tokio::spawn(async move {
            let (mut reader, mut writer) = listener.accept().await.expect("accept");
            let frame = protocol::read_frame_async(&mut reader)
                .await
                .expect("read frame")
                .expect("frame present");
            protocol::write_frame_async(&mut writer, frame.msg_type, &frame.payload)
                .await
                .expect("echo frame");
            listener.cleanup();
        });

        let (mut reader, mut writer) = connect(&endpoint).await.expect("client connect");
        protocol::write_frame_async(&mut writer, protocol::MSG_INPUT, b"hello")
            .await
            .expect("client write");
        let echoed = protocol::read_frame_async(&mut reader)
            .await
            .expect("client read")
            .expect("frame present");

        assert_eq!(echoed.msg_type, protocol::MSG_INPUT);
        assert_eq!(echoed.payload, b"hello");

        server.await.expect("server task");
    }

    /// A second connection to the same listener must also succeed (verifies the
    /// listener stages a fresh instance after each accept on windows).
    #[tokio::test]
    async fn listener_accepts_sequential_connections() {
        let endpoint = session_endpoint(&unique_session("seq"));

        let mut listener = DaemonListener::bind(&endpoint).expect("bind listener");
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut reader, mut writer) = listener.accept().await.expect("accept");
                let frame = protocol::read_frame_async(&mut reader)
                    .await
                    .expect("read frame")
                    .expect("frame present");
                protocol::write_frame_async(&mut writer, frame.msg_type, &frame.payload)
                    .await
                    .expect("echo frame");
            }
            listener.cleanup();
        });

        for i in 0..2u8 {
            let (mut reader, mut writer) = connect(&endpoint).await.expect("client connect");
            protocol::write_frame_async(&mut writer, protocol::MSG_INPUT, &[i])
                .await
                .expect("client write");
            let echoed = protocol::read_frame_async(&mut reader)
                .await
                .expect("client read")
                .expect("frame present");
            assert_eq!(echoed.payload, vec![i]);
            // Drop the connection so the daemon's accept loop advances.
            drop(reader);
            drop(writer);
        }

        server.await.expect("server task");
    }
}

//! End-to-end tests for the FTP front relay (#3996): the control-line cap,
//! normal passive-mode traffic through the relay, client-IP attribution, the
//! data-channel source check, shutdown, the backend PROXY header reader on
//! early close (#4099), and the relay-only loopback hop (#4100).

use std::io::{BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::*;
use crate::embedded_servers::config::AtomicServerStats;
use crate::embedded_servers::service::BindSignal;

pub(super) const IO_TIMEOUT: Duration = Duration::from_secs(10);

/// A real FTP server thread on an ephemeral loopback port.
pub(super) struct RunningServer {
    pub(super) addr: SocketAddr,
    pub(super) stats: Arc<AtomicServerStats>,
    shutdown: ShutdownSignal,
    handle: Option<JoinHandle<Result<()>>>,
}

impl RunningServer {
    pub(super) fn start(root: &Path, auth: Option<FtpAuth>) -> Self {
        let mut config = super::tests::ftp_test_config(root);
        config.ftp_auth = auth;
        Self::start_config(config)
    }

    /// Start a server for an explicit `config`.
    pub(super) fn start_config(config: EmbeddedServerConfig) -> Self {
        let limits = FtpLimits::for_config(&config);
        Self::start_limits(config, limits)
    }

    /// Start a server for `config` with explicit connection `limits` (for
    /// example a short pre-login timeout).
    pub(super) fn start_limits(config: EmbeddedServerConfig, limits: FtpLimits) -> Self {
        let stats = AtomicServerStats::new();
        let shutdown = ShutdownSignal::new();
        let (ready, ready_rx) = BindSignal::for_test();
        let (server_stats, server_shutdown) = (Arc::clone(&stats), shutdown.clone());
        let handle = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime")
                .block_on(run_ftp_server(
                    &config,
                    limits,
                    server_shutdown,
                    server_stats,
                    ready,
                ))
        });
        let addr = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("bind confirmation")
            .expect("bind ok")
            .expect("bound address");
        Self {
            addr,
            stats,
            shutdown,
            handle: Some(handle),
        }
    }

    /// Trigger shutdown and join the server thread, returning how long it took.
    pub(super) fn stop(mut self) -> Duration {
        let start = Instant::now();
        self.shutdown.trigger();
        if let Some(handle) = self.handle.take() {
            handle.join().expect("no panic").expect("clean exit");
        }
        start.elapsed()
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        self.shutdown.trigger();
    }
}

/// Minimal blocking FTP control-channel client.
pub(super) struct Control {
    pub(super) writer: TcpStream,
    pub(super) reader: BufReader<TcpStream>,
}

impl Control {
    pub(super) fn connect(addr: SocketAddr) -> Self {
        let stream = TcpStream::connect(addr).expect("connect control");
        stream.set_read_timeout(Some(IO_TIMEOUT)).expect("timeout");
        let writer = stream.try_clone().expect("clone");
        let mut control = Self {
            writer,
            reader: BufReader::new(stream),
        };
        let greeting = control.reply();
        assert!(greeting.starts_with("220"), "greeting: {greeting:?}");
        control
    }

    /// Read one (possibly multi-line) reply; returns its first line.
    pub(super) fn reply(&mut self) -> String {
        super::tests::read_reply(&mut self.reader)
    }

    pub(super) fn cmd(&mut self, line: &str) -> String {
        self.writer
            .write_all(format!("{line}\r\n").as_bytes())
            .expect("send command");
        self.reply()
    }

    fn login(&mut self, user: &str, pass: &str) {
        assert!(self.cmd(&format!("USER {user}")).starts_with("331"));
        let reply = self.cmd(&format!("PASS {pass}"));
        assert!(reply.starts_with("230"), "login: {reply}");
        assert!(self.cmd("TYPE I").starts_with("200"));
    }

    /// Enter passive mode via `PASV`, returning the announced data address.
    fn pasv(&mut self) -> SocketAddr {
        let reply = self.cmd("PASV");
        assert!(reply.starts_with("227"), "{reply}");
        let nums: Vec<u16> = reply[reply.find('(').expect("(") + 1..reply.find(')').expect(")")]
            .split(',')
            .map(|n| n.trim().parse().expect("pasv number"))
            .collect();
        let ip =
            std::net::Ipv4Addr::new(nums[0] as u8, nums[1] as u8, nums[2] as u8, nums[3] as u8);
        SocketAddr::from((ip, nums[4] * 256 + nums[5]))
    }

    /// Enter passive mode via `EPSV`, returning the announced data port.
    fn epsv(&mut self) -> u16 {
        let reply = self.cmd("EPSV");
        assert!(reply.starts_with("229"), "{reply}");
        let inner = &reply[reply.find("(|||").expect("(|||") + 4..];
        inner[..inner.find('|').expect("|")]
            .parse()
            .expect("epsv port")
    }
}

fn connect_data(addr: SocketAddr) -> TcpStream {
    let data = TcpStream::connect(addr).expect("data connect");
    data.set_read_timeout(Some(IO_TIMEOUT)).expect("timeout");
    data
}

pub(super) fn wait_for_log(
    stats: &AtomicServerStats,
    pred: impl Fn(&[crate::embedded_servers::activity::AccessLogEntry]) -> bool,
) -> Vec<crate::embedded_servers::activity::AccessLogEntry> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let log = super::tests::entries(&stats.activity);
        if pred(&log) || Instant::now() > deadline {
            return log;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

// ── Control-line cap (#3996) ──────────────────────────────────────────────────

/// Regression for #3996: a pre-auth control line without CRLF that exceeds the
/// cap is answered with `500` and the connection is closed — the server does
/// not keep buffering an unbounded line.
#[test]
fn overlong_preauth_control_line_gets_500_and_close() {
    let dir = tempfile::tempdir().expect("temp dir");
    let server = RunningServer::start(dir.path(), None);
    let mut control = Control::connect(server.addr);

    // Stream up to 64 MiB with no line terminator from a separate thread, so
    // the reply can be read while the client is still sending. Far more than
    // any kernel socket buffer, so the writes can only stop early if the
    // server closes the connection.
    const FLOOD_BYTES: usize = 64 * 1024 * 1024;
    let mut writer = control.writer.try_clone().expect("clone writer");
    let flood = std::thread::spawn(move || {
        let chunk = vec![b'A'; 16 * 1024];
        let mut sent = 0usize;
        while sent < FLOOD_BYTES {
            match writer.write(&chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => sent += n,
            }
        }
        sent
    });

    let reply = control.reply();
    assert!(reply.starts_with("500"), "expected 500, got {reply:?}");

    // The server closes the connection after the 500: EOF (or a reset).
    let mut rest = Vec::new();
    let closed = match control.reader.read_to_end(&mut rest) {
        Ok(_) => true,
        Err(e) => matches!(
            e.kind(),
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
        ),
    };
    assert!(closed, "connection must be closed after the 500");
    assert!(rest.is_empty(), "nothing after the 500: {rest:?}");

    let sent = flood.join().expect("flood thread");
    assert!(
        sent < FLOOD_BYTES,
        "the server must stop reading instead of buffering the whole line ({sent} bytes accepted)"
    );
    server.stop();
}

/// A long but in-bounds control line is still served normally.
#[test]
fn control_line_under_the_cap_is_served() {
    let dir = tempfile::tempdir().expect("temp dir");
    let server = RunningServer::start(dir.path(), None);
    let mut control = Control::connect(server.addr);
    // The cap is 8 KiB of control bytes before the line terminator.
    let user = "u".repeat(8 * 1024 - "USER \r".len());
    let reply = control.cmd(&format!("USER {user}"));
    assert!(reply.starts_with("331"), "{reply}");
    server.stop();
}

// ── Normal traffic through the relay ──────────────────────────────────────────

/// Login, store, list and retrieve over passive mode (`PASV` and `EPSV`) all
/// work through the relay, and the access log attributes them to the client.
#[test]
fn passive_store_list_and_retrieve_work_through_the_relay() {
    let dir = tempfile::tempdir().expect("temp dir");
    let server = RunningServer::start(
        dir.path(),
        Some(FtpAuth::Credentials {
            username: "alice".to_string(),
            password: "secret".to_string(),
        }),
    );
    let mut control = Control::connect(server.addr);
    control.login("alice", "secret");

    // STOR over PASV.
    let data_addr = control.pasv();
    assert!(PASSIVE_PORTS.contains(&data_addr.port()), "{data_addr}");
    assert_eq!(data_addr.ip(), server.addr.ip(), "announced data host");
    let mut data = connect_data(data_addr);
    let reply = control.cmd("STOR up.txt");
    assert!(
        reply.starts_with("150") || reply.starts_with("125"),
        "{reply}"
    );
    data.write_all(b"uploaded through the relay")
        .expect("upload");
    drop(data);
    assert!(control.reply().starts_with("226"));
    assert_eq!(
        std::fs::read(dir.path().join("up.txt")).expect("stored file"),
        b"uploaded through the relay"
    );

    // LIST over EPSV (translated to PASV for libunftp's proxy mode).
    let port = control.epsv();
    assert!(PASSIVE_PORTS.contains(&port), "{port}");
    let mut data = connect_data(SocketAddr::new(server.addr.ip(), port));
    let reply = control.cmd("LIST");
    assert!(
        reply.starts_with("150") || reply.starts_with("125"),
        "{reply}"
    );
    let mut listing = String::new();
    data.read_to_string(&mut listing).expect("listing");
    assert!(listing.contains("up.txt"), "{listing}");
    assert!(control.reply().starts_with("226"));

    // RETR over PASV.
    let mut data = connect_data(control.pasv());
    let reply = control.cmd("RETR up.txt");
    assert!(
        reply.starts_with("150") || reply.starts_with("125"),
        "{reply}"
    );
    let mut body = Vec::new();
    data.read_to_end(&mut body).expect("download");
    assert_eq!(body, b"uploaded through the relay");
    assert!(control.reply().starts_with("226"));
    assert!(control.cmd("QUIT").starts_with("221"));

    let log = wait_for_log(&server.stats, |log| log.iter().any(|e| e.method == "RETR"));
    let client = Some(server.addr.ip().to_string());
    for method in ["LOGIN", "STOR", "LIST", "RETR"] {
        let entry = log
            .iter()
            .find(|e| e.method == method)
            .unwrap_or_else(|| panic!("{method} logged: {log:?}"));
        assert_eq!(entry.client, client, "{method} client");
        assert_eq!(entry.user.as_deref(), Some("alice"), "{method} user");
    }
    server.stop();
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

/// Shutdown with a logged-in session stops the relay and libunftp promptly,
/// and the client's control connection is closed.
#[test]
fn shutdown_with_an_open_session_closes_it_promptly() {
    let dir = tempfile::tempdir().expect("temp dir");
    let server = RunningServer::start(dir.path(), None);
    let addr = server.addr;
    let mut control = Control::connect(addr);
    control.login("anonymous", "x");

    let elapsed = server.stop();
    assert!(
        elapsed < Duration::from_secs(5),
        "shutdown took {elapsed:?} with an open session"
    );

    // Whatever the server said on the way out (e.g. 421), the connection ends.
    let mut rest = String::new();
    let _ = control.reader.read_to_string(&mut rest);
    assert!(
        TcpStream::connect(addr).is_err(),
        "the public control port must be released after shutdown"
    );
}

// ── Client identity and the data-channel source check ─────────────────────────

/// Run `fut` on its own current-thread runtime in a background thread.
fn spawn_runtime<F>(fut: F) -> JoinHandle<()>
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(fut)
    })
}

/// A relay session whose client presents a non-loopback address. The access
/// log carries that address, and a data connection from any other IP (here:
/// the real loopback socket) is refused instead of reaching the session.
#[test]
fn relay_attributes_the_client_ip_and_refuses_data_from_another_ip() {
    let dir = tempfile::tempdir().expect("temp dir");
    let config = Arc::new(super::tests::ftp_test_config(dir.path()));
    let stats = AtomicServerStats::new();
    let shutdown = ShutdownSignal::new();
    let claimed: SocketAddr = "198.51.100.4:51000".parse().expect("addr");

    let (addr_tx, addr_rx) = std::sync::mpsc::channel();
    let (session_stats, session_shutdown) = (Arc::clone(&stats), shutdown.clone());
    let server = spawn_runtime(async move {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        addr_tx.send(addr).expect("send addr");
        let (stream, _) = listener.accept().await.expect("accept");
        serve_session(
            config,
            session_stats,
            Arc::new(LoginThrottle::new()),
            stream,
            claimed,
            RelayParams {
                public_port: addr.port(),
                prelogin_timeout: crate::embedded_servers::ftp_relay::PRELOGIN_TIMEOUT,
            },
            session_shutdown,
        )
        .await;
    });
    let addr = addr_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("relay addr");

    let mut control = Control::connect(addr);
    control.login("anonymous", "x");
    let log = wait_for_log(&stats, |log| log.iter().any(|e| e.method == "LOGIN"));
    let login = log.iter().find(|e| e.method == "LOGIN").expect("LOGIN");
    assert_eq!(login.client.as_deref(), Some("198.51.100.4"));

    // The data connection comes from 127.0.0.1, not the session's client IP.
    let mut data = connect_data(control.pasv());
    let mut buf = [0u8; 16];
    let refused = match data.read(&mut buf) {
        Ok(n) => n == 0,
        Err(e) => matches!(
            e.kind(),
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
        ),
    };
    assert!(refused, "a data connection from another IP must be closed");

    drop(control);
    server.join().expect("session thread");
}

// ── Session backend, driven directly (#3996, #4099, #4100) ───────────────────

/// A session's libunftp backend on its own runtime thread, as `serve_session`
/// starts it, with the relay's control connection handed to the test.
struct DirectBackend {
    /// The relay's (header-less) control connection.
    upstream: TcpStream,
    dialer: BackendDialer,
    rt: tokio::runtime::Handle,
    stats: Arc<AtomicServerStats>,
    shutdown: ShutdownSignal,
    /// Whether the backend task stopped within its grace period.
    done: std::sync::mpsc::Receiver<bool>,
    thread: JoinHandle<()>,
}

impl DirectBackend {
    fn start(root: &Path, client: SocketAddr, public_port: u16) -> Self {
        let config = super::tests::ftp_test_config(root);
        let stats = AtomicServerStats::new();
        let shutdown = ShutdownSignal::new();
        let (tx, rx) = std::sync::mpsc::channel();
        let (done_tx, done) = std::sync::mpsc::channel();
        let (backend_stats, backend_shutdown) = (Arc::clone(&stats), shutdown.clone());
        let thread = spawn_runtime(async move {
            let backend = start_backend(
                &config,
                &backend_stats,
                &Arc::new(LoginThrottle::new()),
                client.ip(),
                public_port,
                &backend_shutdown,
            )
            .await
            .expect("backend");
            let upstream = backend.upstream.into_std().expect("std stream");
            upstream.set_nonblocking(false).expect("blocking");
            upstream
                .set_read_timeout(Some(IO_TIMEOUT))
                .expect("timeout");
            tx.send((upstream, backend.dialer, tokio::runtime::Handle::current()))
                .expect("send");
            backend_shutdown.wait().await;
            let stopped = tokio::time::timeout(BACKEND_GRACE * 2, backend.task).await;
            done_tx.send(stopped.is_ok()).expect("send");
        });
        let (upstream, dialer, rt) = rx.recv_timeout(Duration::from_secs(5)).expect("backend");
        Self {
            upstream,
            dialer,
            rt,
            stats,
            shutdown,
            done,
            thread,
        }
    }

    /// A connection to the backend opened the way the relay opens one.
    fn dial(&self) -> TcpStream {
        let stream = self
            .rt
            .block_on(self.dialer.connect())
            .expect("relay connect")
            .into_std()
            .expect("std stream");
        stream.set_nonblocking(false).expect("blocking");
        stream.set_read_timeout(Some(IO_TIMEOUT)).expect("timeout");
        stream
    }

    /// The relay's control connection after sending `header`, as a client.
    fn control(&self, header: &str) -> Control {
        let mut writer = self.upstream.try_clone().expect("clone");
        writer.write_all(header.as_bytes()).expect("proxy header");
        let reader = BufReader::new(self.upstream.try_clone().expect("clone"));
        let mut control = Control { writer, reader };
        assert!(control.reply().starts_with("220"));
        control
    }

    /// A data connection to a port libunftp has not reserved: it reads the
    /// PROXY header, then shuts the stream down. Seeing EOF proves the listener
    /// has accepted every connection made before this one (accept order is
    /// FIFO).
    fn barrier(&self) {
        let mut probe = self.dial();
        probe
            .write_all(b"PROXY TCP4 127.0.0.1 127.0.0.1 40000 1\r\n")
            .expect("barrier header");
        let mut rest = Vec::new();
        probe
            .read_to_end(&mut rest)
            .expect("barrier closed by libunftp");
    }

    /// Shut the backend down; asserts it stopped promptly.
    fn stop(self) {
        let start = Instant::now();
        self.shutdown.trigger();
        let stopped = self
            .done
            .recv_timeout(Duration::from_secs(10))
            .expect("done");
        self.thread.join().expect("backend thread");
        assert!(stopped, "the libunftp backend did not stop in time");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "backend shutdown took {:?}",
            start.elapsed()
        );
    }
}

/// Whether the peer closed `stream` without sending a byte.
fn closed_unserved(stream: &mut TcpStream) -> bool {
    let mut buf = [0u8; 16];
    match stream.read(&mut buf) {
        Ok(n) => n == 0,
        Err(e) => matches!(
            e.kind(),
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
        ),
    }
}

/// libunftp's own check behind the relay: its passive switchboard only hands
/// a data connection to the session whose control connection's PROXY source
/// IP matches. Driven over relay-opened connections with crafted headers,
/// which also exercises a non-loopback client end to end.
#[test]
fn backend_switchboard_rejects_a_mismatched_data_source() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("seen.txt"), b"x").expect("seed");
    let public_port = 2121;
    let backend = DirectBackend::start(
        dir.path(),
        "198.51.100.4:51000".parse().expect("addr"),
        public_port,
    );

    let mut control = backend.control(&format!(
        "PROXY TCP4 198.51.100.4 192.0.2.1 51000 {public_port}\r\n"
    ));
    control.login("anonymous", "x");
    let announced = control.pasv();
    assert_eq!(announced.ip().to_string(), "192.0.2.1", "PROXY destination");
    let reserved = announced.port();

    let data_from = |source: &str| {
        let mut data = backend.dial();
        data.write_all(format!("PROXY TCP4 {source} 192.0.2.1 40000 {reserved}\r\n").as_bytes())
            .expect("data header");
        data
    };

    // Wrong source IP: libunftp closes the connection without serving it.
    let mut wrong = data_from("203.0.113.9");
    assert!(closed_unserved(&mut wrong), "mismatched source served");

    // Matching source IP: the listing is served.
    let mut right = data_from("198.51.100.4");
    let reply = control.cmd("LIST");
    assert!(
        reply.starts_with("150") || reply.starts_with("125"),
        "{reply}"
    );
    let mut listing = String::new();
    right.read_to_string(&mut listing).expect("listing");
    assert!(listing.contains("seen.txt"), "{listing}");
    assert!(control.reply().starts_with("226"));

    drop(control);
    backend.stop();
}

// ── Relay-only loopback hop (#4100) ───────────────────────────────────────────

/// Regression for #4100: a local process that connects to a session's
/// loopback libunftp port directly, with a forged PROXY header, is refused
/// before libunftp reads the header and is logged. That covers a forged
/// control connection (spoofed client IP, no control-line cap) and a forged
/// data connection carrying the session's own switchboard key, which must
/// neither be served nor use up the reservation. Relay-opened control and
/// data connections keep working, and refused connections leave no task.
#[test]
fn direct_loopback_connection_with_a_forged_proxy_header_is_refused() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("seen.txt"), b"x").expect("seed");
    let public_port = 2121;
    let backend = DirectBackend::start(
        dir.path(),
        "198.51.100.4:51000".parse().expect("addr"),
        public_port,
    );
    let backend_addr = backend.dialer.backend();

    let mut control = backend.control(&format!(
        "PROXY TCP4 198.51.100.4 192.0.2.1 51000 {public_port}\r\n"
    ));
    control.login("anonymous", "x");
    let reserved = control.pasv().port();
    backend.barrier();
    let baseline = settled_task_count(&backend.rt);

    // A forged control connection claiming another client IP.
    let mut forged_control = connect_data(backend_addr);
    let _ = forged_control.write_all(
        format!("PROXY TCP4 203.0.113.66 192.0.2.1 51001 {public_port}\r\nUSER x\r\n").as_bytes(),
    );
    assert!(
        closed_unserved(&mut forged_control),
        "a forged control connection was served"
    );

    // A forged data connection with the session's exact switchboard key.
    let mut forged_data = connect_data(backend_addr);
    let _ = forged_data
        .write_all(format!("PROXY TCP4 198.51.100.4 192.0.2.1 40000 {reserved}\r\n").as_bytes());
    assert!(
        closed_unserved(&mut forged_data),
        "a forged data connection was served"
    );

    // Refused connections spawn nothing (not even a header reader).
    backend.barrier();
    let alive = settled_task_count(&backend.rt);
    assert!(
        alive <= baseline,
        "{alive} tasks alive (baseline {baseline}) after refused connections"
    );

    let log = wait_for_log(&backend.stats, |log| {
        log.iter()
            .filter(|e| e.status == "rejected" && !e.success)
            .count()
            >= 2
    });
    let rejected: Vec<_> = log
        .iter()
        .filter(|e| e.status == "rejected" && !e.success)
        .collect();
    assert_eq!(rejected.len(), 2, "{log:?}");
    for entry in rejected {
        assert_eq!(entry.method, "CONTROL");
        assert_eq!(entry.client.as_deref(), Some("127.0.0.1"));
        assert_eq!(
            entry.detail.as_deref(),
            Some("loopback backend connection not opened by the relay")
        );
    }

    // The reservation is intact: the relay's data connection gets the listing.
    let mut data = backend.dial();
    data.write_all(format!("PROXY TCP4 198.51.100.4 192.0.2.1 40000 {reserved}\r\n").as_bytes())
        .expect("data header");
    let reply = control.cmd("LIST");
    assert!(
        reply.starts_with("150") || reply.starts_with("125"),
        "{reply}"
    );
    let mut listing = String::new();
    data.read_to_string(&mut listing).expect("listing");
    assert!(listing.contains("seen.txt"), "{listing}");
    assert!(control.reply().starts_with("226"));

    drop(control);
    backend.stop();
}

// ── PROXY header reader on early close (#4099) ────────────────────────────────

/// Wait until the runtime's live task count has not changed for 100 ms and
/// return it.
fn settled_task_count(rt: &tokio::runtime::Handle) -> usize {
    let deadline = Instant::now() + Duration::from_secs(5);
    let (mut last, mut stable) = (rt.metrics().num_alive_tasks(), 0);
    while stable < 10 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
        let now = rt.metrics().num_alive_tasks();
        stable = if now == last { stable + 1 } else { 0 };
        last = now;
    }
    last
}

/// A connection to a session's loopback libunftp port that closes before
/// sending a PROXY header must not leave a task behind: libunftp 0.23.1's
/// header reader looped forever on `peek` returning `Ok(0)` at EOF, burning
/// CPU until the server stopped (#4099, fixed in the vendored fork). Since
/// #4100 only relay-opened connections reach the header reader, so the probes
/// are opened the relay's way. The header task has to end, and the backend
/// still stops promptly.
#[test]
fn backend_header_reader_ends_when_a_connection_closes_without_a_header() {
    let dir = tempfile::tempdir().expect("temp dir");
    let backend = DirectBackend::start(dir.path(), "127.0.0.1:51000".parse().expect("addr"), 2121);

    backend.barrier();
    let baseline = settled_task_count(&backend.rt);

    // Connect and close at once, without a single byte of PROXY header.
    for _ in 0..3 {
        drop(backend.dial());
    }
    backend.barrier();

    let deadline = Instant::now() + Duration::from_secs(5);
    while backend.rt.metrics().num_alive_tasks() > baseline && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let alive = backend.rt.metrics().num_alive_tasks();
    assert!(
        alive <= baseline,
        "{alive} tasks alive (baseline {baseline}): a header reader is still \
         spinning on a connection closed before its header"
    );

    backend.stop();
}

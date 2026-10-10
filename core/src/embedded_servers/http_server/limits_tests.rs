//! End-to-end regression tests for the HTTP server's resource and brute-force
//! limits (#4399): the concurrent-connection cap and the failed Basic-auth
//! throttle, over real loopback sockets.
//!
//! Every wait is event-driven (a blocking read with a generous safety timeout,
//! or a poll until a condition holds); no test asserts that something happens
//! faster than a wall-clock bound, so a loaded CI runner only makes them slower.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::*;
use crate::embedded_servers::activity::AccessLogEntry;
use crate::embedded_servers::auth_guard::MAX_FAILED_LOGINS;
use crate::embedded_servers::config::{ServerType, DEFAULT_MAX_CONCURRENT_SESSIONS};

/// Safety timeout for a single socket read or for a polled condition. Only a
/// hang reaches it.
const SAFETY_TIMEOUT: Duration = Duration::from_secs(30);

fn test_config(root: &Path) -> EmbeddedServerConfig {
    EmbeddedServerConfig {
        id: "test-http-limits".to_string(),
        name: "test".to_string(),
        server_type: ServerType::Http,
        root_directory: root.to_string_lossy().into_owned(),
        bind_host: "127.0.0.1".to_string(),
        // Ephemeral: the server reports the port it bound (#3533).
        port: 0,
        auto_start: false,
        read_only: true,
        directory_listing: Some(false),
        ftp_auth: None,
        http_auth: None,
        max_transfer_bytes: None,
        max_concurrent_sessions: None,
        extra: Default::default(),
    }
}

/// An HTTP server running on its own thread over a temp dir holding
/// `hello.txt`.
struct RunningServer {
    addr: SocketAddr,
    stats: Arc<AtomicServerStats>,
    shutdown: ShutdownSignal,
    handle: Option<JoinHandle<Result<()>>>,
    _dir: tempfile::TempDir,
}

impl RunningServer {
    fn start(configure: impl FnOnce(&mut EmbeddedServerConfig)) -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("hello.txt"), "hello world").expect("write file");
        let mut config = test_config(dir.path());
        configure(&mut config);
        let shutdown = ShutdownSignal::new();
        let stats = AtomicServerStats::new();
        let (ready, ready_rx) = BindSignal::for_test();
        let server_shutdown = shutdown.clone();
        let server_stats = Arc::clone(&stats);
        let handle = std::thread::spawn(move || {
            start_http_server(&config, server_shutdown, server_stats, ready)
        });
        let addr = ready_rx
            .recv_timeout(SAFETY_TIMEOUT)
            .expect("server should confirm its bind")
            .expect("bind failed")
            .expect("HTTP server reports its bound address");
        Self {
            addr,
            stats,
            shutdown,
            handle: Some(handle),
            _dir: dir,
        }
    }

    fn log(&self) -> Vec<AccessLogEntry> {
        self.stats
            .activity
            .snapshot(None, &self.stats.snapshot())
            .entries
    }

    /// Poll the access log until `pred` holds (or the safety timeout passes)
    /// and return it.
    fn wait_for_log(&self, pred: impl Fn(&[AccessLogEntry]) -> bool) -> Vec<AccessLogEntry> {
        let deadline = Instant::now() + SAFETY_TIMEOUT;
        loop {
            let log = self.log();
            if pred(&log) || Instant::now() > deadline {
                return log;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        self.shutdown.trigger();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// A parsed HTTP response.
struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

fn connect(addr: SocketAddr) -> BufReader<TcpStream> {
    let stream = TcpStream::connect(addr).expect("connect");
    stream
        .set_read_timeout(Some(SAFETY_TIMEOUT))
        .expect("read timeout");
    BufReader::new(stream)
}

/// Read one response (status line, headers, `Content-Length` body).
fn read_reply(reader: &mut BufReader<TcpStream>) -> Reply {
    let mut line = String::new();
    reader.read_line(&mut line).expect("status line");
    let status = line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or_else(|| panic!("bad status line: {line:?}"));
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).expect("header line");
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        let (k, v) = line.split_once(':').expect("header separator");
        headers.push((k.trim().to_string(), v.trim().to_string()));
    }
    let len: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .map_or(0, |(_, v)| v.parse().expect("content length"));
    let mut body = vec![0; len];
    reader.read_exact(&mut body).expect("body");
    Reply {
        status,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    }
}

/// Send a keep-alive `GET /hello.txt` (with optional Basic credentials) on an
/// open connection and read its response.
fn request(reader: &mut BufReader<TcpStream>, auth: Option<(&str, &str)>) -> Reply {
    let mut req = String::from("GET /hello.txt HTTP/1.1\r\nHost: x\r\n");
    if let Some((user, pass)) = auth {
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
        req.push_str(&format!("Authorization: Basic {token}\r\n"));
    }
    req.push_str("\r\n");
    reader
        .get_mut()
        .write_all(req.as_bytes())
        .expect("send request");
    read_reply(reader)
}

/// Send `GET /hello.txt` on a fresh connection and return the response status,
/// or `None` when the connection was refused before a status line arrived
/// (a refused connection may be reset before the client reads the `503`).
fn try_get_status(addr: SocketAddr) -> Option<u16> {
    let mut reader = connect(addr);
    let _ = reader
        .get_mut()
        .write_all(b"GET /hello.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    line.split_whitespace().nth(1)?.parse().ok()
}

/// Whether the server has closed `reader`'s connection (EOF or reset).
fn closed(reader: &mut BufReader<TcpStream>) -> bool {
    let mut rest = Vec::new();
    match reader.read_to_end(&mut rest) {
        Ok(_) => rest.is_empty(),
        Err(e) => matches!(
            e.kind(),
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
        ),
    }
}

#[test]
fn default_connection_cap_is_the_shared_session_default() {
    let dir = Path::new(".");
    let limits = HttpLimits::for_config(&test_config(dir));
    assert_eq!(limits.connection_cap, DEFAULT_MAX_CONCURRENT_SESSIONS);
    assert_eq!(DEFAULT_MAX_CONCURRENT_SESSIONS, 32);
    let mut zero = test_config(dir);
    zero.max_concurrent_sessions = Some(0);
    assert_eq!(HttpLimits::for_config(&zero).connection_cap, 1);
    let mut custom = test_config(dir);
    custom.max_concurrent_sessions = Some(5);
    assert_eq!(HttpLimits::for_config(&custom).connection_cap, 5);
}

/// A connection beyond the cap gets `503` and is closed without being served,
/// the connections holding the slots keep working, and a slot frees up again
/// once a connection ends.
#[test]
fn connections_beyond_the_cap_are_refused() {
    let server = RunningServer::start(|c| c.max_concurrent_sessions = Some(2));

    // A completed keep-alive request proves the server admitted the connection
    // (and so holds its slot) before the next one connects.
    let mut first = connect(server.addr);
    assert_eq!(request(&mut first, None).status, 200);
    let mut second = connect(server.addr);
    assert_eq!(request(&mut second, None).status, 200);

    // The over-cap connection is answered before it sends anything.
    let mut third = connect(server.addr);
    let refused = read_reply(&mut third);
    assert_eq!(refused.status, 503);
    assert_eq!(refused.header("Connection"), Some("close"));
    assert!(closed(&mut third), "the over-cap connection must be closed");

    // The connections inside the cap are unaffected.
    assert_eq!(request(&mut first, None).body, "hello world");
    assert_eq!(request(&mut second, None).body, "hello world");

    let log = server.wait_for_log(|log| {
        log.iter()
            .any(|e| e.method == "CONNECT" && e.status == "busy")
    });
    let busy = log
        .iter()
        .find(|e| e.method == "CONNECT" && e.status == "busy")
        .expect("a refused CONNECT record");
    assert!(!busy.success);
    assert_eq!(busy.client.as_deref(), Some("127.0.0.1"));

    // Ending a connection releases its slot (asynchronously, so retry).
    drop(first);
    let deadline = Instant::now() + SAFETY_TIMEOUT;
    while try_get_status(server.addr) != Some(200) {
        assert!(Instant::now() < deadline, "slot never freed");
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(second);
}

/// Repeated failed Basic-auth attempts from one IP lock it out: further
/// requests get `429` without their credentials being checked (even correct
/// ones), and the refusal is logged as `throttled`.
#[test]
fn repeated_failed_basic_auth_attempts_are_throttled() {
    let server = RunningServer::start(|c| {
        c.http_auth = Some(HttpBasicAuth {
            username: "admin".to_string(),
            password: "s3cret".to_string(),
        });
    });

    // Each attempt on its own connection: the throttle is per IP, not per
    // connection.
    for attempt in 0..MAX_FAILED_LOGINS {
        let mut conn = connect(server.addr);
        let reply = request(&mut conn, Some(("admin", "wrong")));
        assert_eq!(reply.status, 401, "attempt {attempt}");
    }

    let mut conn = connect(server.addr);
    let throttled = request(&mut conn, Some(("admin", "s3cret")));
    assert_eq!(throttled.status, 429);
    assert!(throttled.header("Retry-After").is_some());
    assert!(
        throttled.header("WWW-Authenticate").is_none(),
        "a throttled reply must not re-prompt"
    );

    let log = server.wait_for_log(|log| log.iter().any(|e| e.status == "throttled"));
    let entry = log
        .iter()
        .find(|e| e.status == "throttled")
        .expect("a throttled record");
    assert!(!entry.success);
    assert_eq!(entry.client.as_deref(), Some("127.0.0.1"));
    assert!(
        entry.user.is_none(),
        "a throttled user must not be recorded"
    );
}

/// Correct credentials are accepted over a real socket, and a successful login
/// clears earlier failures so they do not add up to a lockout.
#[test]
fn correct_credentials_are_accepted() {
    let server = RunningServer::start(|c| {
        c.http_auth = Some(HttpBasicAuth {
            username: "admin".to_string(),
            password: "s3cret".to_string(),
        });
    });

    let mut conn = connect(server.addr);
    for _ in 0..MAX_FAILED_LOGINS - 1 {
        assert_eq!(request(&mut conn, Some(("admin", "typo"))).status, 401);
    }
    let ok = request(&mut conn, Some(("admin", "s3cret")));
    assert_eq!(ok.status, 200);
    assert_eq!(ok.body, "hello world");

    // The success reset the count: another near-limit run still is not locked.
    for _ in 0..MAX_FAILED_LOGINS - 1 {
        assert_eq!(request(&mut conn, Some(("admin", "typo"))).status, 401);
    }
    assert_eq!(request(&mut conn, Some(("admin", "s3cret"))).status, 200);
}

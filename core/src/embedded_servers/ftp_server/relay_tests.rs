//! End-to-end tests for the FTP front relay (#3996): the control-line cap,
//! normal passive-mode traffic through the relay, client-IP attribution, the
//! data-channel source check, and shutdown.

use std::io::{BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::*;
use crate::embedded_servers::config::AtomicServerStats;
use crate::embedded_servers::service::BindSignal;

const IO_TIMEOUT: Duration = Duration::from_secs(10);

/// A real FTP server thread on an ephemeral loopback port.
struct RunningServer {
    addr: SocketAddr,
    stats: Arc<AtomicServerStats>,
    shutdown: ShutdownSignal,
    handle: Option<JoinHandle<Result<()>>>,
}

impl RunningServer {
    fn start(root: &Path, auth: Option<FtpAuth>) -> Self {
        let mut config = super::tests::ftp_test_config(root);
        config.ftp_auth = auth;
        let stats = AtomicServerStats::new();
        let shutdown = ShutdownSignal::new();
        let (ready, ready_rx) = BindSignal::for_test();
        let (server_stats, server_shutdown) = (Arc::clone(&stats), shutdown.clone());
        let handle = std::thread::spawn(move || {
            start_ftp_server(&config, server_shutdown, server_stats, ready)
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
    fn stop(mut self) -> Duration {
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
struct Control {
    writer: TcpStream,
    reader: BufReader<TcpStream>,
}

impl Control {
    fn connect(addr: SocketAddr) -> Self {
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
    fn reply(&mut self) -> String {
        super::tests::read_reply(&mut self.reader)
    }

    fn cmd(&mut self, line: &str) -> String {
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

fn wait_for_log(
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

    // Stream 1 MiB with no line terminator from a separate thread, so the
    // reply can be read while the client is still sending.
    let mut writer = control.writer.try_clone().expect("clone writer");
    let flood = std::thread::spawn(move || {
        let chunk = vec![b'A'; 16 * 1024];
        let mut sent = 0usize;
        while sent < 1024 * 1024 {
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
        sent < 1024 * 1024,
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

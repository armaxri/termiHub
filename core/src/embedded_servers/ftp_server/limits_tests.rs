//! End-to-end regression tests for the FTP server's resource and brute-force
//! limits (CORE2-002, CORE2-003, #4292): the concurrent-session cap and the
//! cross-session failed-login throttle, both enforced at the relay's accept.

use std::io::{BufReader, Read};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use super::relay_tests::{wait_for_log, Control, RunningServer, IO_TIMEOUT};
use super::*;
use crate::embedded_servers::auth_guard::MAX_FAILED_LOGINS;

/// Connect without expecting a greeting; return the first reply line and the
/// open reader.
fn first_reply(addr: SocketAddr) -> (String, BufReader<TcpStream>) {
    let stream = TcpStream::connect(addr).expect("connect");
    stream.set_read_timeout(Some(IO_TIMEOUT)).expect("timeout");
    let mut reader = BufReader::new(stream);
    let reply = super::tests::read_reply(&mut reader);
    (reply, reader)
}

/// Connect, return the first reply line and whether the server closed the
/// connection right after it.
fn first_reply_then_closed(addr: SocketAddr) -> (String, bool) {
    let (reply, mut reader) = first_reply(addr);
    let mut rest = Vec::new();
    let closed = match reader.read_to_end(&mut rest) {
        Ok(_) => rest.is_empty(),
        Err(e) => matches!(
            e.kind(),
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
        ),
    };
    (reply, closed)
}

#[test]
fn default_session_cap_is_documented_value() {
    let config = super::tests::ftp_test_config(Path::new("."));
    assert_eq!(session_cap(&config), DEFAULT_MAX_CONCURRENT_FTP_SESSIONS);
    assert_eq!(DEFAULT_MAX_CONCURRENT_FTP_SESSIONS, 32);
    let mut zero = config.clone();
    zero.max_concurrent_sessions = Some(0);
    assert_eq!(session_cap(&zero), 1, "a zero cap still serves one session");
    let mut custom = config;
    custom.max_concurrent_sessions = Some(5);
    assert_eq!(session_cap(&custom), 5);
}

/// Regression for CORE2-002: a connection beyond the cap gets `421` and is
/// closed, while the sessions holding the slots keep working, and a slot frees
/// up again once a session ends.
#[test]
fn connections_beyond_the_session_cap_get_421() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut config = super::tests::ftp_test_config(dir.path());
    config.max_concurrent_sessions = Some(2);
    let server = RunningServer::start_config(config);

    let mut first = Control::connect(server.addr);
    let mut second = Control::connect(server.addr);

    let (reply, closed) = first_reply_then_closed(server.addr);
    assert!(reply.starts_with("421"), "expected 421, got {reply:?}");
    assert!(closed, "the over-cap connection must be closed");

    // The sessions inside the cap are unaffected.
    assert!(first.cmd("NOOP").starts_with("200"));
    assert!(second.cmd("NOOP").starts_with("200"));

    let log = wait_for_log(&server.stats, |log| {
        log.iter()
            .any(|e| e.method == "CONNECT" && e.status == "busy")
    });
    let busy = log
        .iter()
        .find(|e| e.method == "CONNECT" && e.status == "busy")
        .expect("a rejected CONNECT record");
    assert!(!busy.success);
    assert_eq!(busy.client.as_deref(), Some("127.0.0.1"));

    // Ending a session releases its slot (asynchronously, so retry briefly).
    drop(first);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (reply, _) = first_reply(server.addr);
        if reply.starts_with("220") {
            break;
        }
        assert!(Instant::now() < deadline, "slot never freed: {reply:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(second);
    server.stop();
}

/// Regression for CORE2-003: failed logins on separate control connections
/// add up, and once the limit is reached that client is refused at connect.
#[test]
fn repeated_failed_logins_are_throttled_across_sessions() {
    let dir = tempfile::tempdir().expect("temp dir");
    let server = RunningServer::start(
        dir.path(),
        Some(FtpAuth::Credentials {
            username: "alice".to_string(),
            password: "secret".to_string(),
        }),
    );

    for attempt in 0..MAX_FAILED_LOGINS {
        let mut control = Control::connect(server.addr);
        assert!(control.cmd("USER alice").starts_with("331"));
        let reply = control.cmd("PASS wrong");
        assert!(reply.starts_with("530"), "attempt {attempt}: {reply}");
    }

    let (reply, closed) = first_reply_then_closed(server.addr);
    assert!(reply.starts_with("421"), "expected 421, got {reply:?}");
    assert!(closed, "a throttled client's connection must be closed");
    let log = wait_for_log(&server.stats, |log| {
        log.iter()
            .any(|e| e.method == "CONNECT" && e.status == "throttled")
    });
    assert!(log
        .iter()
        .any(|e| e.method == "CONNECT" && e.status == "throttled" && !e.success));
    server.stop();
}

/// The correct password still logs in through the relay.
#[test]
fn correct_password_logs_in_through_the_relay() {
    let dir = tempfile::tempdir().expect("temp dir");
    let server = RunningServer::start(
        dir.path(),
        Some(FtpAuth::Credentials {
            username: "alice".to_string(),
            password: "secret".to_string(),
        }),
    );
    let mut control = Control::connect(server.addr);
    assert!(control.cmd("USER alice").starts_with("331"));
    let reply = control.cmd("PASS secret");
    assert!(reply.starts_with("230"), "{reply}");
    server.stop();
}

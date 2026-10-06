//! Lifecycle tests of the real `termihub-plugin-runner` binary, driven over a
//! socketpair exactly as the host spawns it (#4182): argument checking, the
//! handshake order, `LoadFailed` for a library it cannot load, exit on
//! end-of-stream, and exit on a protocol violation.
#![cfg(unix)]

use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use termihub_plugin_runner::ipc::{
    Configure, FrameReader, Message, Sender, IPC_FD, PROTOCOL_ARG, PROTOCOL_VERSION,
};

const RUNNER: &str = env!("CARGO_BIN_EXE_termihub-plugin-runner");

/// Spawn the runner with `args` and its channel end as fd 3.
fn spawn(args: &[&str]) -> (Child, UnixStream) {
    let (host, runner) = UnixStream::pair().unwrap();
    let fd = runner.as_raw_fd();
    let mut cmd = Command::new(RUNNER);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: only async-signal-safe `dup2`/`fcntl` between fork and exec.
    unsafe {
        cmd.pre_exec(move || {
            if fd == IPC_FD {
                libc::fcntl(IPC_FD, libc::F_SETFD, 0);
            } else if libc::dup2(fd, IPC_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn().unwrap();
    drop(runner);
    host.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    (child, host)
}

fn protocol_args() -> Vec<String> {
    vec![PROTOCOL_ARG.to_owned(), PROTOCOL_VERSION.to_string()]
}

fn spawn_ok() -> (Child, UnixStream) {
    let args = protocol_args();
    spawn(&args.iter().map(String::as_str).collect::<Vec<_>>())
}

fn next(stream: &UnixStream) -> Message {
    let frame = FrameReader::new(stream)
        .read_frame()
        .expect("a frame")
        .expect("not EOF");
    Message::decode_from_peer(frame, Sender::Host).expect("a valid runner frame")
}

fn wait_exit(child: &mut Child) -> ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(Instant::now() < deadline, "the runner did not exit");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_wrong_protocol_argument_is_refused() {
    let (mut child, _host) = spawn(&[PROTOCOL_ARG, "999"]);
    assert_eq!(wait_exit(&mut child).code(), Some(64));
    let (mut child, _host) = spawn(&[]);
    assert_eq!(wait_exit(&mut child).code(), Some(64));
}

#[test]
fn hello_comes_first_and_eof_before_configure_exits_cleanly() {
    let (mut child, host) = spawn_ok();
    match next(&host) {
        Message::Hello(hello) => {
            assert_eq!(hello.protocol_version, PROTOCOL_VERSION);
            assert_eq!(hello.pid, child.id());
        }
        other => panic!("expected Hello, got {other:?}"),
    }
    // The host goes away: the runner must not outlive it.
    drop(host);
    assert_eq!(wait_exit(&mut child).code(), Some(0));
}

#[test]
fn a_library_that_cannot_load_is_reported_then_the_runner_exits() {
    let (mut child, mut host) = spawn_ok();
    assert!(matches!(next(&host), Message::Hello(_)));
    let configure = Message::Configure(Configure {
        library_path: "/definitely/not/a/plugin.so".into(),
        expected_digest: None,
        manifest_api_version: None,
        accept_unverified_toolchain: false,
        plugin_id: "missing".into(),
        host_version: "0.0.0".into(),
    });
    host.write_all(&configure.encode().unwrap()).unwrap();
    assert!(matches!(next(&host), Message::SandboxReport(_)));
    match next(&host) {
        Message::LoadFailed(failed) => {
            assert!(!failed.incompatible);
            assert!(
                failed.message.contains("failed to open plugin library"),
                "{}",
                failed.message
            );
        }
        other => panic!("expected LoadFailed, got {other:?}"),
    }
    assert_eq!(wait_exit(&mut child).code(), Some(3));
}

#[test]
fn a_protocol_violation_ends_the_runner() {
    let (mut child, mut host) = spawn_ok();
    assert!(matches!(next(&host), Message::Hello(_)));
    // An oversized length prefix instead of a Configure frame.
    host.write_all(&u32::MAX.to_be_bytes()).unwrap();
    assert_eq!(wait_exit(&mut child).code(), Some(2));
}

#[test]
fn a_frame_only_the_runner_may_send_is_a_violation() {
    let (mut child, mut host) = spawn_ok();
    assert!(matches!(next(&host), Message::Hello(_)));
    let bogus = Message::Output {
        session_id: 1,
        data: b"x".to_vec(),
    };
    host.write_all(&bogus.encode().unwrap()).unwrap();
    assert_eq!(wait_exit(&mut child).code(), Some(2));
}

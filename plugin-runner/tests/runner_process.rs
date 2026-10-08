//! Lifecycle tests of the real `termihub-plugin-runner` binary, driven over
//! its channel exactly as the host spawns it (#4182, Windows #4201): argument
//! checking, the handshake order, `LoadFailed` for a library it cannot load,
//! exit on end-of-stream, and exit on a protocol violation. On Windows also:
//! the runner dies with its job object, and inherits no stray handle.

use std::io::Write;
use std::process::ExitStatus;
use std::time::{Duration, Instant};

use termihub_plugin_runner::ipc::{
    Configure, FrameReader, Message, ResourceLimits, Sender, PROTOCOL_ARG, PROTOCOL_VERSION,
};

const RUNNER: &str = env!("CARGO_BIN_EXE_termihub-plugin-runner");

#[cfg(unix)]
type Child = std::process::Child;
#[cfg(unix)]
type HostEnd = std::os::unix::net::UnixStream;
#[cfg(windows)]
type Child = termihub_plugin_runner::process::JobChild;
#[cfg(windows)]
type HostEnd = termihub_plugin_runner::ipc::pipe::PipeStream;

/// Spawn the runner with `args` and its channel end as fd 3.
#[cfg(unix)]
fn spawn(args: &[&str]) -> (Child, HostEnd) {
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    use termihub_plugin_runner::ipc::IPC_FD;

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

/// Spawn the runner with `args` (plus `--ipc-handle <value>`) inside its job
/// object, with its end of a private pipe as its only inherited handle.
/// It runs under the plugin default limits, as the host starts it.
#[cfg(windows)]
fn spawn(args: &[&str]) -> (Child, HostEnd) {
    use std::os::windows::io::AsHandle;

    use termihub_plugin_runner::ipc::pipe::PipeStream;
    use termihub_plugin_runner::ipc::ChannelStream;
    use termihub_plugin_runner::process::RunnerCommand;

    let (host, runner) = PipeStream::pair().unwrap();
    let mut command = RunnerCommand::new(RUNNER);
    for arg in args {
        command.arg(arg);
    }
    let system_root = std::env::var_os("SystemRoot").expect("SystemRoot is set");
    let child = command
        .envs([("SystemRoot", system_root)])
        .limits(ResourceLimits::plugin_defaults())
        .spawn(runner.as_handle())
        .unwrap();
    drop(runner);
    host.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    (child, host)
}

fn protocol_args() -> Vec<String> {
    vec![PROTOCOL_ARG.to_owned(), PROTOCOL_VERSION.to_string()]
}

fn spawn_ok() -> (Child, HostEnd) {
    let args = protocol_args();
    spawn(&args.iter().map(String::as_str).collect::<Vec<_>>())
}

fn next(stream: &HostEnd) -> Message {
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
        // The limits are applied before the load, so they must not break it.
        limits: ResourceLimits::plugin_defaults(),
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

/// The job object, not end of stream, ends the runner when the host drops its
/// handle on it (what happens to every host handle when the host process
/// dies): the channel stays open here, and the exit code is the kill code.
#[cfg(windows)]
#[test]
fn the_runner_dies_with_its_job_object() {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };

    let (child, host) = spawn_ok();
    assert!(matches!(next(&host), Message::Hello(_)));
    // SAFETY: opens the runner's process for waiting; owned below.
    let raw = unsafe {
        OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            child.id(),
        )
    };
    assert!(!raw.is_null(), "open the runner process");
    // SAFETY: a fresh handle from `OpenProcess`.
    let process = unsafe { OwnedHandle::from_raw_handle(raw) };
    drop(child);
    // SAFETY: waits on a process handle we own.
    let waited = unsafe { WaitForSingleObject(process.as_raw_handle(), 5_000) };
    assert_eq!(waited, WAIT_OBJECT_0, "the runner outlived its job");
    let mut code = 0u32;
    // SAFETY: reads the exit code of a process handle we own.
    assert_ne!(
        unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) },
        0
    );
    assert_eq!(code, termihub_plugin_runner::process::KILLED_EXIT_CODE);
    drop(host);
}

/// Only the channel and the standard handles cross into the runner: an
/// inheritable handle the host holds at spawn time does not. If the runner had
/// inherited this pipe's write end, the read below would block until it exits.
#[cfg(windows)]
#[test]
fn the_runner_inherits_no_stray_handle() {
    use std::io::Read;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, TRUE};
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::System::Pipes::CreatePipe;

    let inheritable = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: TRUE,
    };
    let mut read: HANDLE = std::ptr::null_mut();
    let mut write: HANDLE = std::ptr::null_mut();
    // SAFETY: both ends are owned below.
    assert_ne!(
        unsafe { CreatePipe(&mut read, &mut write, &inheritable, 0) },
        0
    );
    // SAFETY: only the write end stays inheritable — the stray handle.
    unsafe { SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0) };
    // SAFETY: fresh handles from `CreatePipe`.
    let (read, write) = unsafe {
        (
            OwnedHandle::from_raw_handle(read),
            OwnedHandle::from_raw_handle(write),
        )
    };

    let (mut child, host) = spawn_ok();
    assert!(matches!(next(&host), Message::Hello(_)));
    drop(write);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut read = std::fs::File::from(read);
        let _ = tx.send(read.read(&mut [0u8; 1]));
    });
    match rx.recv_timeout(Duration::from_secs(5)) {
        // End of stream: a closed anonymous pipe reads as `BrokenPipe`.
        Ok(Ok(0)) => {}
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::BrokenPipe => {}
        other => panic!("the stray handle leaked into the runner: {other:?}"),
    }
    assert!(child.try_wait().unwrap().is_none(), "the runner still runs");
    drop(host);
    assert_eq!(wait_exit(&mut child).code(), Some(0));
}

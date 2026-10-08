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
use termihub_plugin_runner::sandbox::{Isolation, SandboxPolicy};

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
        sandbox: None,
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

fn configure_with(library_path: &str, sandbox: Option<SandboxPolicy>) -> Message {
    Message::Configure(Configure {
        library_path: library_path.into(),
        expected_digest: None,
        manifest_api_version: None,
        accept_unverified_toolchain: false,
        plugin_id: "sandboxed".into(),
        host_version: "0.0.0".into(),
        limits: ResourceLimits::plugin_defaults(),
        sandbox,
    })
}

/// A policy the runner cannot apply is reported as failed and the plugin is
/// never loaded: no `LoadFailed`, no `Loaded`, a distinct exit code (#4186).
#[test]
fn a_sandbox_that_cannot_be_applied_never_loads_the_plugin() {
    let (mut child, mut host) = spawn_ok();
    assert!(matches!(next(&host), Message::Hello(_)));
    let policy = SandboxPolicy {
        install_dir: "relative/install".into(),
        ..SandboxPolicy::default()
    };
    host.write_all(
        &configure_with("/definitely/not/a/plugin.so", Some(policy))
            .encode()
            .unwrap(),
    )
    .unwrap();
    match next(&host) {
        Message::SandboxReport(report) => {
            assert_eq!(report.isolation(), Isolation::Failed, "{report:?}");
        }
        other => panic!("expected SandboxReport, got {other:?}"),
    }
    assert_eq!(wait_exit(&mut child).code(), Some(4));
}

/// macOS: a valid policy is enforced with Seatbelt before the load is even
/// attempted; the load then fails normally (the library does not exist).
#[cfg(target_os = "macos")]
#[test]
fn macos_applies_seatbelt_before_the_load() {
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let install = root.join("install");
    let data = root.join("data");
    std::fs::create_dir_all(&install).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let policy = SandboxPolicy {
        install_dir: install.to_str().unwrap().into(),
        data_dir: Some(data.to_str().unwrap().into()),
        denied_dirs: vec![root.to_str().unwrap().into()],
        ..SandboxPolicy::default()
    };
    let (mut child, mut host) = spawn_ok();
    assert!(matches!(next(&host), Message::Hello(_)));
    let lib = install.join("libmissing.dylib");
    host.write_all(
        &configure_with(lib.to_str().unwrap(), Some(policy))
            .encode()
            .unwrap(),
    )
    .unwrap();
    match next(&host) {
        Message::SandboxReport(report) => {
            assert_eq!(report.isolation(), Isolation::Full, "{report:?}");
            assert_eq!(report.enforced, vec!["seatbelt".to_owned()]);
        }
        other => panic!("expected SandboxReport, got {other:?}"),
    }
    assert!(matches!(next(&host), Message::LoadFailed(_)));
    assert_eq!(wait_exit(&mut child).code(), Some(3));
}

/// Linux: a valid policy is enforced with landlock + seccomp before the load
/// is attempted; the load then fails normally (the library does not exist),
/// and the `LoadFailed` frame still reaches the host through the confined
/// channel (#4185).
#[cfg(target_os = "linux")]
#[test]
fn linux_applies_landlock_and_seccomp_before_the_load() {
    let report = linux_report_for(Vec::new());
    assert_eq!(report.isolation(), Isolation::Full, "{report:?}");
    assert_eq!(
        report.enforced,
        vec!["seccomp".to_owned(), "landlock".to_owned()]
    );
}

/// Linux: the debug-only `simulate_missing` hook forces the reduced path —
/// seccomp enforced, landlock reported missing (#4185).
#[cfg(all(target_os = "linux", debug_assertions))]
#[test]
fn linux_reports_reduced_isolation_without_landlock() {
    let report = linux_report_for(vec!["landlock".to_owned()]);
    assert_eq!(report.isolation(), Isolation::Reduced, "{report:?}");
    assert_eq!(report.enforced, vec!["seccomp".to_owned()]);
    assert_eq!(report.missing, vec!["landlock".to_owned()]);
}

/// Run the handshake with a valid Linux policy and return the sandbox report;
/// asserts the load then fails cleanly (`LoadFailed`, exit code 3).
#[cfg(target_os = "linux")]
fn linux_report_for(simulate_missing: Vec<String>) -> termihub_plugin_runner::ipc::SandboxReport {
    let tmp = tempfile::TempDir::new().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let install = root.join("install");
    let data = root.join("data");
    std::fs::create_dir_all(&install).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let policy = SandboxPolicy {
        install_dir: install.to_str().unwrap().into(),
        data_dir: Some(data.to_str().unwrap().into()),
        simulate_missing,
        ..SandboxPolicy::default()
    };
    let (mut child, mut host) = spawn_ok();
    assert!(matches!(next(&host), Message::Hello(_)));
    let lib = install.join("libmissing.so");
    host.write_all(
        &configure_with(lib.to_str().unwrap(), Some(policy))
            .encode()
            .unwrap(),
    )
    .unwrap();
    let report = match next(&host) {
        Message::SandboxReport(report) => report,
        other => panic!("expected SandboxReport, got {other:?}"),
    };
    assert!(matches!(next(&host), Message::LoadFailed(_)));
    assert_eq!(wait_exit(&mut child).code(), Some(3));
    report
}

/// The job object, not end of stream, ends the runner when the host drops its
/// handle on it (what happens to every host handle when the host process
/// dies). The channel stays open throughout, so the runner had no reason of
/// its own to exit: its death within the deadline is the job's kill.
/// (`KILL_ON_JOB_CLOSE` terminates with exit code 0, so the code itself cannot
/// tell the two apart; holding the channel open is what does.)
#[cfg(windows)]
#[test]
fn the_runner_dies_with_its_job_object() {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
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
    // Still running with its channel open.
    // SAFETY: a zero-timeout wait on a process handle we own.
    assert_eq!(
        unsafe { WaitForSingleObject(process.as_raw_handle(), 0) },
        WAIT_TIMEOUT,
        "the runner exited before its job was closed"
    );
    drop(child);
    // SAFETY: waits on a process handle we own.
    let waited = unsafe { WaitForSingleObject(process.as_raw_handle(), 5_000) };
    assert_eq!(waited, WAIT_OBJECT_0, "the runner outlived its job");
    // The host's end only now sees the runner gone.
    assert!(
        FrameReader::new(&host).read_frame().unwrap().is_none(),
        "end of stream after the kill"
    );
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

/// Windows: a sandbox requested of a runner the host did **not** start in an
/// AppContainer is refused, not reported as enforced: the runner verifies its
/// own token before the load (#4187).
#[cfg(windows)]
#[test]
fn windows_refuses_a_policy_outside_an_appcontainer() {
    let tmp = tempfile::TempDir::new().unwrap();
    let install = tmp.path().join("install");
    std::fs::create_dir_all(&install).unwrap();
    let policy = SandboxPolicy {
        install_dir: install.to_str().unwrap().into(),
        ..SandboxPolicy::default()
    };
    let (mut child, mut host) = spawn_ok();
    assert!(matches!(next(&host), Message::Hello(_)));
    let lib = install.join("missing.dll");
    host.write_all(
        &configure_with(lib.to_str().unwrap(), Some(policy))
            .encode()
            .unwrap(),
    )
    .unwrap();
    match next(&host) {
        Message::SandboxReport(report) => {
            assert_eq!(report.isolation(), Isolation::Failed, "{report:?}");
            let failed = report.failed.unwrap_or_default();
            assert!(failed.contains("not inside an AppContainer"), "{failed}");
        }
        other => panic!("expected SandboxReport, got {other:?}"),
    }
    assert_eq!(wait_exit(&mut child).code(), Some(4));
}

/// Windows: the runner started in a per-plugin Less-Privileged AppContainer
/// inside its job (#4187) verifies both and reports the sandbox as fully
/// enforced before the load; the load then fails normally (the library does
/// not exist), and that reply still crosses the inherited pipe.
#[cfg(windows)]
#[test]
fn windows_starts_the_runner_in_an_lpac_inside_its_job() {
    use std::os::windows::io::AsHandle;
    use std::path::Path;

    use termihub_plugin_runner::appcontainer::{
        delete_profile, AppContainer, MODIFY, READ_EXECUTE,
    };
    use termihub_plugin_runner::ipc::pipe::PipeStream;
    use termihub_plugin_runner::ipc::ChannelStream;
    use termihub_plugin_runner::process::RunnerCommand;

    let id = format!("runner-process-lpac-{}", std::process::id());
    let container = AppContainer::ensure(&id).unwrap();
    let runner = Path::new(RUNNER);
    let runner_dir = runner.parent().unwrap();
    container.grant_object(runner_dir, READ_EXECUTE).unwrap();
    container.grant_object(runner, READ_EXECUTE).unwrap();
    let tmp = tempfile::TempDir::new().unwrap();
    let install = tmp.path().join("install");
    let data = tmp.path().join("data");
    std::fs::create_dir_all(&install).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    container.grant_tree(&install, READ_EXECUTE).unwrap();
    container.grant_tree(&data, MODIFY).unwrap();

    let (mut host, end) = PipeStream::pair_with_access(&[container.sid_string()]).unwrap();
    let system_root = std::env::var_os("SystemRoot").expect("SystemRoot is set");
    let mut child = RunnerCommand::new(RUNNER)
        .arg(PROTOCOL_ARG)
        .arg(PROTOCOL_VERSION.to_string())
        .envs([("SystemRoot", system_root)])
        .limits(ResourceLimits::plugin_defaults())
        .app_container(container.clone())
        .current_dir(runner_dir)
        .spawn(end.as_handle())
        .unwrap();
    drop(end);
    host.set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    assert!(matches!(next(&host), Message::Hello(_)));
    let policy = SandboxPolicy {
        install_dir: install.to_str().unwrap().into(),
        data_dir: Some(data.to_str().unwrap().into()),
        ..SandboxPolicy::default()
    };
    let lib = install.join("missing.dll");
    host.write_all(
        &configure_with(lib.to_str().unwrap(), Some(policy))
            .encode()
            .unwrap(),
    )
    .unwrap();
    match next(&host) {
        Message::SandboxReport(report) => {
            assert_eq!(report.isolation(), Isolation::Full, "{report:?}");
            assert_eq!(
                report.enforced,
                vec!["appcontainer".to_owned(), "job-object".to_owned()]
            );
        }
        other => panic!("expected SandboxReport, got {other:?}"),
    }
    assert!(matches!(next(&host), Message::LoadFailed(_)));
    assert_eq!(wait_exit(&mut child).code(), Some(3));
    delete_profile(&id).unwrap();
}

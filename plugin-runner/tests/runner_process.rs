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
    Configure, FrameReader, Message, ResourceLimits, Sender, IPC_FD, PROTOCOL_ARG, PROTOCOL_VERSION,
};
use termihub_plugin_runner::sandbox::{Isolation, SandboxPolicy};

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
        // The limits are applied before the load, so they must not break it.
        limits: ResourceLimits::plugin_defaults(),
        sandbox: None,
        accept_reduced_isolation: false,
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
    configure_accepting(library_path, sandbox, false)
}

fn configure_accepting(
    library_path: &str,
    sandbox: Option<SandboxPolicy>,
    accept_reduced_isolation: bool,
) -> Message {
    Message::Configure(Configure {
        library_path: library_path.into(),
        expected_digest: None,
        manifest_api_version: None,
        accept_unverified_toolchain: false,
        plugin_id: "sandboxed".into(),
        host_version: "0.0.0".into(),
        limits: ResourceLimits::plugin_defaults(),
        sandbox,
        accept_reduced_isolation,
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
    let report = linux_report_for(Vec::new(), false);
    assert_eq!(report.isolation(), Isolation::Full, "{report:?}");
    assert_eq!(
        report.enforced,
        vec!["seccomp".to_owned(), "landlock".to_owned()]
    );
}

/// Linux: the debug-only `simulate_missing` hook forces the reduced path —
/// seccomp enforced, landlock reported missing (#4185). With the
/// `reducedIsolationAccepted` acknowledgement the load is attempted (#4188).
#[cfg(all(target_os = "linux", debug_assertions))]
#[test]
fn linux_reports_reduced_isolation_without_landlock() {
    let report = linux_report_for(vec!["landlock".to_owned()], true);
    assert_eq!(report.isolation(), Isolation::Reduced, "{report:?}");
    assert_eq!(report.enforced, vec!["seccomp".to_owned()]);
    assert_eq!(report.missing, vec!["landlock".to_owned()]);
}

/// Linux: without the acknowledgement, reduced isolation is reported and the
/// runner exits without even attempting the load (#4188).
#[cfg(all(target_os = "linux", debug_assertions))]
#[test]
fn linux_refuses_reduced_isolation_without_the_acknowledgement() {
    let report = linux_report_for(vec!["landlock".to_owned()], false);
    assert_eq!(report.isolation(), Isolation::Reduced, "{report:?}");
}

/// Run the handshake with a valid Linux policy and return the sandbox report.
/// Asserts the load then fails cleanly (`LoadFailed`, exit code 3) — or, for
/// reduced isolation without `accept_reduced`, that the runner exits with
/// code 5 before any load.
#[cfg(target_os = "linux")]
fn linux_report_for(
    simulate_missing: Vec<String>,
    accept_reduced: bool,
) -> termihub_plugin_runner::ipc::SandboxReport {
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
        &configure_accepting(lib.to_str().unwrap(), Some(policy), accept_reduced)
            .encode()
            .unwrap(),
    )
    .unwrap();
    let report = match next(&host) {
        Message::SandboxReport(report) => report,
        other => panic!("expected SandboxReport, got {other:?}"),
    };
    if report.isolation() == Isolation::Reduced && !accept_reduced {
        assert_eq!(wait_exit(&mut child).code(), Some(5));
    } else {
        assert!(matches!(next(&host), Message::LoadFailed(_)));
        assert_eq!(wait_exit(&mut child).code(), Some(3));
    }
    report
}

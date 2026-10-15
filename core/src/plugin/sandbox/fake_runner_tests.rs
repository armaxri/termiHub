//! The host's process-level startup checks on an untrusted runner (#4335,
//! TBE2-002), on every OS (#4550): a fake runner *process*
//! (`termihub-plugin-fake-runner`, a test-only workspace binary) is spawned
//! through the real spawn path — fd 3 on Unix, the inherited named-pipe handle
//! on Windows — and reports what the host handed it.
//!
//! * its standard output is the null device, not the host's;
//! * a watchdog or stderr-forwarder thread that cannot start ends it and fails
//!   the start;
//! * a forged `Loaded` gets it killed.
//!
//! The in-memory handshake refusals live in `client_tests.rs`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use termihub_plugin_api::CURRENT_PLUGIN_ABI_VERSION;
use termihub_plugin_runner::ipc::{Configure, ResourceLimits};

use super::client::SandboxedPlugin;
use super::handle::PluginRunnerConfig;
use crate::plugin::log_rate_limit::PluginLogLimiter;
use crate::plugin::HostError;

/// Overrides the build of the fake runner with a prebuilt binary.
const FAKE_RUNNER_ENV: &str = "TERMIHUB_PLUGIN_FAKE_RUNNER";

/// One fake runner: its own copy of the binary in a private folder, where it
/// also writes its `stdout` and `pid` reports (it runs unconfined here).
struct FakeRunner {
    exe: PathBuf,
    dir: tempfile::TempDir,
}

impl FakeRunner {
    /// A copy named for `mode` (the fake reads its mode from its file name).
    fn named(mode: &str) -> Self {
        let dir = tempfile::TempDir::new().unwrap();
        let exe = dir.path().join(format!(
            "fake-runner-{mode}{}",
            std::env::consts::EXE_SUFFIX
        ));
        std::fs::copy(fake_runner_binary(), &exe).expect("copy the fake runner");
        Self { exe, dir }
    }

    /// A runner whose handshake is honest.
    fn honest() -> Self {
        Self::named("honest")
    }

    /// A runner whose `Loaded` claims an ABI one major past this host's.
    fn forging_abi() -> Self {
        Self::named("forge-abi")
    }

    /// Wait (bounded) for the fake to have written report `name`.
    fn read(&self, name: &str) -> String {
        let file = self.dir.path().join(name);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(text) = std::fs::read_to_string(&file) {
                if text.ends_with('\n') {
                    return text.trim().to_owned();
                }
            }
            assert!(
                Instant::now() < deadline,
                "the fake runner never wrote {name}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn pid(&self) -> u32 {
        self.read("pid").parse().expect("a pid")
    }

    /// Spawn it as the runner for an unsandboxed plugin. A binary just copied
    /// can briefly be "text file busy" on Linux while another test thread's
    /// fork still holds its write descriptor: retry that only.
    fn spawn(&self) -> Result<Arc<SandboxedPlugin>, HostError> {
        let config = PluginRunnerConfig::new(&self.exe);
        let configure = configure();
        let mut attempts = 0;
        loop {
            match SandboxedPlugin::spawn(&config, &configure, Arc::new(PluginLogLimiter::default()))
            {
                Err(HostError::RunnerUnavailable { detail, .. })
                    if attempts < 50 && detail.contains("busy") =>
                {
                    attempts += 1;
                    std::thread::sleep(Duration::from_millis(20));
                }
                other => return other,
            }
        }
    }
}

/// What the host sends for an unsandboxed plugin `probe` (the fake mirrors
/// the id into `Loaded`).
fn configure() -> Configure {
    Configure {
        library_path: "/plugins/probe/backend/libprobe.so".into(),
        expected_digest: None,
        manifest_api_version: Some(format!(
            "{}.{}",
            CURRENT_PLUGIN_ABI_VERSION.major, CURRENT_PLUGIN_ABI_VERSION.minor
        )),
        accept_unverified_toolchain: false,
        plugin_id: "probe".into(),
        host_version: "0.0.0".into(),
        limits: ResourceLimits::default(),
        sandbox: None,
        accept_reduced_isolation: false,
    }
}

/// The fake runner binary, built once per test process into its own target
/// folder next to the integration tests' scratch folder (`<target>/tmp`): the
/// outer `cargo test` holds the workspace build-directory lock, so building
/// into the workspace target folder from inside a test would deadlock.
fn fake_runner_binary() -> &'static Path {
    static BUILT: OnceLock<PathBuf> = OnceLock::new();
    BUILT.get_or_init(|| {
        if let Some(path) = std::env::var_os(FAKE_RUNNER_ENV) {
            return PathBuf::from(path);
        }
        let (args, profile): (&[&str], &str) = if cfg!(debug_assertions) {
            (&[], "debug")
        } else {
            (&["--release"], "release")
        };
        // `<target>/<profile>/deps/<this test binary>`.
        let exe = std::env::current_exe().expect("the test binary");
        let target = exe.ancestors().nth(3).expect("a cargo target folder");
        let target_dir = target
            .join("tmp")
            .join(format!("termihub-plugin-fake-runner-{profile}"));
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("core sits inside the workspace");
        let status = std::process::Command::new(env!("CARGO"))
            .current_dir(workspace)
            .args(["build", "-p", "termihub-plugin-fake-runner", "--target-dir"])
            .arg(&target_dir)
            .args(args)
            .status()
            .expect("spawn cargo");
        assert!(status.success(), "building the fake runner failed");
        target_dir.join(profile).join(format!(
            "termihub-plugin-fake-runner{}",
            std::env::consts::EXE_SUFFIX
        ))
    })
}

/// Whether process `pid` still exists — not even a zombie (Unix).
#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    let pid = i32::try_from(pid).unwrap();
    // SAFETY: signal 0 only checks for existence.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Whether process `pid` still runs (Windows).
#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    // SAFETY: opens the process for waiting only; the handle is closed below.
    let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if process.is_null() {
        return false;
    }
    // SAFETY: a zero-timeout wait on the handle opened above.
    let running = unsafe { WaitForSingleObject(process, 0) } == WAIT_TIMEOUT;
    // SAFETY: closes the handle opened above, once.
    unsafe { CloseHandle(process) };
    running
}

#[test]
fn the_runner_gets_the_null_device_as_stdout_not_the_hosts() {
    let fake = FakeRunner::honest();
    let plugin = fake.spawn().expect("the fake runner's handshake is honest");
    assert_eq!(fake.read("stdout"), "null", "the runner inherited stdout");
    plugin.shutdown();
}

#[test]
fn a_watchdog_that_cannot_start_ends_the_runner_and_fails_the_start() {
    let fake = FakeRunner::honest();
    let result = {
        let _fail = super::threads::fail_spawns_named("plugin-runner-watchdog");
        fake.spawn()
    };
    match result {
        Err(HostError::RunnerProtocol(detail)) => {
            assert!(detail.starts_with("watchdog thread"), "{detail}");
        }
        other => panic!("expected the watchdog-thread error, got {other:?}"),
    }
    // Killed and reaped: no process (not even a zombie) is left.
    assert!(!process_exists(fake.pid()));
}

#[test]
fn a_stderr_forwarder_that_cannot_start_ends_the_runner_and_fails_the_start() {
    let fake = FakeRunner::honest();
    let result = {
        let _fail = super::threads::fail_spawns_named("plugin-runner-stderr");
        fake.spawn()
    };
    assert!(
        matches!(&result, Err(HostError::RunnerProtocol(d)) if d.starts_with("stderr thread")),
        "{result:?}"
    );
    // The fake may not have written its pid yet when it was killed; if it
    // did, it is gone now.
    if let Ok(pid) = std::fs::read_to_string(fake.dir.path().join("pid")) {
        if let Ok(pid) = pid.trim().parse() {
            assert!(!process_exists(pid));
        }
    }
}

#[test]
fn a_forged_handshake_ends_the_runner() {
    // `Loaded` claims an ABI the host cannot run: refused, killed, reaped.
    let fake = FakeRunner::forging_abi();
    assert!(matches!(fake.spawn(), Err(HostError::IncompatibleAbi(_))));
    assert!(!process_exists(fake.pid()));
}

//! The host's startup checks on the untrusted runner (#4335, TBE2-002): the
//! handshake driven over an in-memory channel scripted with forged runner
//! frames, each refused with its specific [`HostError`]; and, on Unix, a fake
//! runner process that checks what the host hands it and how a failed
//! safety-thread start ends it.

use std::io::{Cursor, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use termihub_plugin_api::{AbiVersion, CURRENT_PLUGIN_ABI_VERSION};
use termihub_plugin_runner::ipc::{
    ChannelStream, Configure, Hello, LoadFailed, Loaded, Log, Message, ResourceLimits,
    SandboxReport, MAX_FRAME_LEN, PROTOCOL_VERSION,
};
use termihub_plugin_runner::sandbox::{required_layers, SandboxPolicy};

use super::*;

/// Deadlines short enough for a test that waits for one to expire.
const SHORT: Deadlines = Deadlines {
    hello: Duration::from_millis(100),
    load: Duration::from_millis(100),
};

/// A channel whose runner side is a fixed script of bytes. Once the script
/// is used up it reports end of stream, or — `stall` — blocks until the read
/// timeout, like a runner that never answers.
struct Scripted {
    input: Arc<Mutex<Cursor<Vec<u8>>>>,
    written: Arc<Mutex<Vec<u8>>>,
    timeout: Arc<Mutex<Option<Duration>>>,
    stall: bool,
}

impl Scripted {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            input: Arc::new(Mutex::new(Cursor::new(bytes))),
            written: Arc::new(Mutex::new(Vec::new())),
            timeout: Arc::new(Mutex::new(None)),
            stall: false,
        }
    }

    fn of(messages: &[Message]) -> Self {
        Self::new(encode(messages))
    }

    fn stalling(mut self) -> Self {
        self.stall = true;
        self
    }
}

impl Read for Scripted {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.input.lock().unwrap().read(buf)?;
        if n == 0 && self.stall && !buf.is_empty() {
            let wait = self
                .timeout
                .lock()
                .unwrap()
                .unwrap_or(Duration::from_secs(1));
            std::thread::sleep(wait);
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        Ok(n)
    }
}

impl Write for Scripted {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.written.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl ChannelStream for Scripted {
    fn try_clone(&self) -> std::io::Result<Self> {
        Ok(Self {
            input: Arc::clone(&self.input),
            written: Arc::clone(&self.written),
            timeout: Arc::clone(&self.timeout),
            stall: self.stall,
        })
    }

    fn set_read_timeout(&self, timeout: Option<Duration>) -> std::io::Result<()> {
        *self.timeout.lock().unwrap() = timeout;
        Ok(())
    }

    fn set_write_timeout(&self, _timeout: Option<Duration>) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode(messages: &[Message]) -> Vec<u8> {
    messages
        .iter()
        .flat_map(|m| m.encode().expect("encodable"))
        .collect()
}

fn hello() -> Message {
    hello_speaking(PROTOCOL_VERSION)
}

fn hello_speaking(protocol_version: u32) -> Message {
    Message::Hello(Hello {
        runner_version: "0.0.0-forged".into(),
        protocol_version,
        pid: 1,
    })
}

/// A report that every layer this platform requires is enforced.
fn full_report() -> Message {
    Message::SandboxReport(SandboxReport {
        enforced: required_layers().iter().map(|l| (*l).to_owned()).collect(),
        missing: Vec::new(),
        failed: None,
    })
}

fn loaded(abi: AbiVersion) -> Message {
    Message::Loaded(Loaded {
        id: "probe".into(),
        name: "Probe".into(),
        version: "1.0.0".into(),
        abi_version: abi.to_packed(),
        toolchain: None,
    })
}

/// What the host sends: a sandbox policy and the manifest's `apiVersion`
/// (the current ABI), as for an installed plugin.
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
        sandbox: Some(SandboxPolicy {
            install_dir: "/plugins/probe".into(),
            data_dir: None,
            denied_dirs: Vec::new(),
            simulate_missing: Vec::new(),
        }),
        accept_reduced_isolation: false,
    }
}

fn run(mut stream: Scripted) -> Result<(LoadedPluginInfo, SandboxReport), HostError> {
    handshake(&mut stream, &configure(), SHORT)
}

fn protocol_error(result: Result<(LoadedPluginInfo, SandboxReport), HostError>) -> String {
    match result {
        Err(HostError::RunnerProtocol(detail)) => detail,
        other => panic!("expected RunnerProtocol, got {other:?}"),
    }
}

#[test]
fn an_honest_runner_completes_the_handshake() {
    let stream = Scripted::of(&[hello(), full_report(), loaded(CURRENT_PLUGIN_ABI_VERSION)]);
    let written = Arc::clone(&stream.written);
    let (info, report) = run(stream).expect("the honest sequence is accepted");
    assert_eq!(info.id, "probe");
    assert_eq!(info.abi_version, CURRENT_PLUGIN_ABI_VERSION);
    assert_eq!(report.missing_required(required_layers()), None);
    // The host sent its `Configure` (after `Hello`) and nothing else.
    let sent = Message::Configure(configure()).encode().unwrap();
    assert_eq!(*written.lock().unwrap(), sent);
}

#[test]
fn a_runner_speaking_another_protocol_is_refused() {
    let detail = protocol_error(run(Scripted::of(&[
        hello_speaking(PROTOCOL_VERSION + 1),
        full_report(),
        loaded(CURRENT_PLUGIN_ABI_VERSION),
    ])));
    assert!(detail.contains("protocol"), "{detail}");
}

#[test]
fn a_runner_that_skips_hello_is_refused() {
    let detail = protocol_error(run(Scripted::of(&[
        full_report(),
        loaded(CURRENT_PLUGIN_ABI_VERSION),
    ])));
    assert!(detail.contains("expected Hello"), "{detail}");
}

#[test]
fn loaded_before_a_sandbox_report_is_refused() {
    let stream = Scripted::of(&[hello(), loaded(CURRENT_PLUGIN_ABI_VERSION)]);
    let detail = protocol_error(run(stream));
    assert!(detail.contains("expected SandboxReport"), "{detail}");
}

#[test]
fn a_report_missing_a_required_layer_is_refused() {
    // The policy was requested, the report claims less than required.
    let weak = Message::SandboxReport(SandboxReport::default());
    match run(Scripted::of(&[
        hello(),
        weak,
        loaded(CURRENT_PLUGIN_ABI_VERSION),
    ])) {
        Err(HostError::SandboxSetupFailed(detail)) => {
            assert!(detail.contains(required_layers()[0]), "{detail}");
        }
        other => panic!("expected SandboxSetupFailed, got {other:?}"),
    }
}

#[test]
fn a_report_of_a_failed_setup_is_refused() {
    let failed = Message::SandboxReport(SandboxReport {
        enforced: required_layers().iter().map(|l| (*l).to_owned()).collect(),
        missing: Vec::new(),
        failed: Some("forged".into()),
    });
    assert!(matches!(
        run(Scripted::of(&[hello(), failed, loaded(CURRENT_PLUGIN_ABI_VERSION)])),
        Err(HostError::SandboxSetupFailed(detail)) if detail == "forged"
    ));
}

#[test]
fn reduced_isolation_without_the_acknowledgement_is_refused() {
    let reduced = Message::SandboxReport(SandboxReport {
        enforced: required_layers().iter().map(|l| (*l).to_owned()).collect(),
        missing: vec!["landlock".into()],
        failed: None,
    });
    assert!(matches!(
        run(Scripted::of(&[hello(), reduced, loaded(CURRENT_PLUGIN_ABI_VERSION)])),
        Err(HostError::ReducedIsolationNotAccepted { missing }) if missing == ["landlock"]
    ));
}

#[test]
fn loaded_with_an_abi_newer_than_the_host_is_refused() {
    let future = AbiVersion::new(CURRENT_PLUGIN_ABI_VERSION.major + 1, 0);
    assert!(matches!(
        run(Scripted::of(&[hello(), full_report(), loaded(future)])),
        Err(HostError::IncompatibleAbi(_))
    ));
}

#[test]
fn loaded_with_an_abi_other_than_the_manifest_is_refused() {
    // A host-compatible ABI that is not what the manifest declares.
    let older = AbiVersion::new(CURRENT_PLUGIN_ABI_VERSION.major, 0);
    assert_ne!(older, CURRENT_PLUGIN_ABI_VERSION);
    assert!(matches!(
        run(Scripted::of(&[hello(), full_report(), loaded(older)])),
        Err(HostError::ManifestAbiMismatch { library, .. }) if library == older
    ));
}

#[test]
fn a_reported_load_failure_is_the_runner_load_error() {
    let failed = Message::LoadFailed(LoadFailed {
        incompatible: true,
        message: "nope".into(),
    });
    assert!(matches!(
        run(Scripted::of(&[hello(), full_report(), failed])),
        Err(HostError::RunnerLoad { incompatible: true, message }) if message == "nope"
    ));
}

#[test]
fn any_other_frame_instead_of_loaded_is_refused() {
    let chatter = Message::Log(Log {
        session_id: None,
        level: 3,
        message: "hi".into(),
        truncated: false,
        denied: None,
    });
    let detail = protocol_error(run(Scripted::of(&[hello(), full_report(), chatter])));
    assert!(detail.contains("expected Loaded"), "{detail}");
}

#[test]
fn a_runner_that_never_says_hello_times_out() {
    let started = Instant::now();
    let detail = protocol_error(run(Scripted::new(Vec::new()).stalling()));
    assert_eq!(detail, "timed out waiting for Hello");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn a_runner_that_stalls_before_loaded_times_out() {
    let stream = Scripted::of(&[hello(), full_report()]).stalling();
    assert_eq!(protocol_error(run(stream)), "timed out waiting for Loaded");
}

#[test]
fn a_runner_that_exits_mid_handshake_is_reported() {
    let detail = protocol_error(run(Scripted::of(&[hello()])));
    assert!(detail.contains("the runner exited"), "{detail}");
    assert!(detail.contains("SandboxReport"), "{detail}");
}

#[test]
fn an_oversized_frame_is_refused() {
    // A length prefix past the codec's cap: never allocated, never trusted.
    let mut bytes = encode(&[hello()]);
    let len = u32::try_from(MAX_FRAME_LEN + 1).unwrap();
    bytes.extend_from_slice(&len.to_be_bytes());
    bytes.extend_from_slice(&[0; 64]);
    let detail = protocol_error(run(Scripted::new(bytes)));
    assert!(detail.contains("SandboxReport"), "{detail}");
}

#[test]
fn a_frame_of_an_unknown_kind_is_refused() {
    let detail = protocol_error(run(Scripted::new(vec![0, 0, 0, 1, 0xEE])));
    assert!(detail.contains("Hello"), "{detail}");
}

/// A fake runner: a shell script that records what it was handed, then
/// plays forged frames to the host and waits to be killed.
#[cfg(unix)]
mod fake_runner {
    use std::path::{Path, PathBuf};

    use super::*;

    pub(super) struct FakeRunner {
        pub(super) script: PathBuf,
        pub(super) dir: tempfile::TempDir,
    }

    impl FakeRunner {
        /// A runner that sends `frames` and then sleeps.
        pub(super) fn new(frames: &[Message]) -> Self {
            let dir = tempfile::TempDir::new().unwrap();
            let path = |name: &str| dir.path().join(name).to_str().unwrap().to_owned();
            std::fs::write(dir.path().join("frames"), encode(frames)).unwrap();
            let script = dir.path().join("runner.sh");
            std::fs::write(
                &script,
                format!(
                    "#!/bin/sh\n\
                     if [ /dev/fd/1 -ef /dev/null ]; then echo null > '{stdout}';\n\
                     else echo inherited > '{stdout}'; fi\n\
                     echo $$ > '{pid}'\n\
                     /bin/cat '{frames}' >&3\n\
                     exec /bin/sleep 30\n",
                    stdout = path("stdout"),
                    pid = path("pid"),
                    frames = path("frames"),
                ),
            )
            .unwrap();
            let mut perms = std::fs::metadata(&script).unwrap().permissions();
            std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
            std::fs::set_permissions(&script, perms).unwrap();
            Self { script, dir }
        }

        /// A runner whose handshake is honest (no sandbox requested).
        pub(super) fn honest() -> Self {
            Self::new(&[
                hello(),
                Message::SandboxReport(SandboxReport::default()),
                loaded(CURRENT_PLUGIN_ABI_VERSION),
            ])
        }

        /// Wait (bounded) for the script to have written `name`.
        pub(super) fn read(&self, name: &str) -> String {
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

        pub(super) fn pid(&self) -> u32 {
            self.read("pid").parse().expect("a pid")
        }

        /// Spawn it as the runner for an unsandboxed plugin.
        pub(super) fn spawn(&self) -> Result<Arc<SandboxedPlugin>, HostError> {
            spawn_with_retry(&self.script)
        }
    }

    /// `SandboxedPlugin::spawn` for `runner`. A script just written can
    /// briefly be "text file busy" on Linux while another test thread's
    /// fork still holds its write descriptor: retry that only.
    fn spawn_with_retry(runner: &Path) -> Result<Arc<SandboxedPlugin>, HostError> {
        let config = PluginRunnerConfig::new(runner);
        let configure = Configure {
            sandbox: None,
            manifest_api_version: None,
            ..configure()
        };
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

    pub(super) fn process_exists(pid: u32) -> bool {
        let pid = i32::try_from(pid).unwrap();
        // SAFETY: signal 0 only checks for existence.
        unsafe { libc::kill(pid, 0) == 0 }
    }
}

#[cfg(unix)]
#[test]
fn the_runner_gets_the_null_device_as_stdout_not_the_hosts() {
    let fake = fake_runner::FakeRunner::honest();
    let plugin = fake.spawn().expect("the fake runner's handshake is honest");
    assert_eq!(fake.read("stdout"), "null", "the runner inherited stdout");
    plugin.shutdown();
}

#[cfg(unix)]
#[test]
fn a_watchdog_that_cannot_start_ends_the_runner_and_fails_the_start() {
    let fake = fake_runner::FakeRunner::honest();
    let result = {
        let _fail = super::super::threads::fail_spawns_named("plugin-runner-watchdog");
        fake.spawn()
    };
    match result {
        Err(HostError::RunnerProtocol(detail)) => {
            assert!(detail.starts_with("watchdog thread"), "{detail}");
        }
        other => panic!("expected the watchdog-thread error, got {other:?}"),
    }
    // Killed and reaped: no process (not even a zombie) is left.
    assert!(!fake_runner::process_exists(fake.pid()));
}

#[cfg(unix)]
#[test]
fn a_stderr_forwarder_that_cannot_start_ends_the_runner_and_fails_the_start() {
    let fake = fake_runner::FakeRunner::honest();
    let result = {
        let _fail = super::super::threads::fail_spawns_named("plugin-runner-stderr");
        fake.spawn()
    };
    assert!(
        matches!(&result, Err(HostError::RunnerProtocol(d)) if d.starts_with("stderr thread")),
        "{result:?}"
    );
    // The script may not have run yet when it was killed; if it did, it is
    // gone now.
    if let Ok(pid) = std::fs::read_to_string(fake.dir.path().join("pid")) {
        if let Ok(pid) = pid.trim().parse() {
            assert!(!fake_runner::process_exists(pid));
        }
    }
}

#[cfg(unix)]
#[test]
fn a_forged_handshake_ends_the_runner() {
    // `Loaded` claims an ABI the host cannot run: refused, killed, reaped.
    let future = AbiVersion::new(CURRENT_PLUGIN_ABI_VERSION.major + 1, 0);
    let fake = fake_runner::FakeRunner::new(&[
        hello(),
        Message::SandboxReport(SandboxReport::default()),
        loaded(future),
    ]);
    assert!(matches!(fake.spawn(), Err(HostError::IncompatibleAbi(_))));
    assert!(!fake_runner::process_exists(fake.pid()));
}

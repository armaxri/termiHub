//! The host's startup checks on the untrusted runner (#4335, TBE2-002): the
//! handshake driven over an in-memory channel scripted with forged runner
//! frames, each refused with its specific [`HostError`]. The same checks
//! against a real (fake) runner process live in `fake_runner_tests.rs`.

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
    /// Refuse every read timeout with this error, like macOS does on a
    /// socket whose peer already closed it (EINVAL, #4786).
    refuse_timeout: Option<std::io::ErrorKind>,
}

impl Scripted {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            input: Arc::new(Mutex::new(Cursor::new(bytes))),
            written: Arc::new(Mutex::new(Vec::new())),
            timeout: Arc::new(Mutex::new(None)),
            stall: false,
            refuse_timeout: None,
        }
    }

    fn of(messages: &[Message]) -> Self {
        Self::new(encode(messages))
    }

    fn stalling(mut self) -> Self {
        self.stall = true;
        self
    }

    fn refusing_timeouts(mut self, kind: std::io::ErrorKind) -> Self {
        self.refuse_timeout = Some(kind);
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
            refuse_timeout: self.refuse_timeout,
        })
    }

    fn set_read_timeout(&self, timeout: Option<Duration>) -> std::io::Result<()> {
        if let Some(kind) = self.refuse_timeout {
            return Err(kind.into());
        }
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
            tls_roots_file: None,
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
fn a_runner_gone_before_the_deadline_is_armed_is_reported_as_exited() {
    // macOS refuses the read timeout (EINVAL) once the peer has closed the
    // socket; that is still an early exit, not an I/O failure (#4786).
    let stream = Scripted::new(Vec::new()).refusing_timeouts(std::io::ErrorKind::InvalidInput);
    let detail = protocol_error(run(stream));
    assert_eq!(
        detail,
        "the runner exited while the host was waiting for Hello"
    );
}

#[test]
fn frames_sent_before_the_runner_closed_are_still_read() {
    let stream = Scripted::of(&[hello()]).refusing_timeouts(std::io::ErrorKind::InvalidInput);
    let detail = protocol_error(run(stream));
    assert!(detail.contains("the runner exited"), "{detail}");
    assert!(detail.contains("SandboxReport"), "{detail}");
}

#[test]
fn any_other_failure_to_arm_the_deadline_is_refused() {
    let stream = Scripted::of(&[hello()]).refusing_timeouts(std::io::ErrorKind::PermissionDenied);
    let detail = protocol_error(run(stream));
    assert!(detail.starts_with("waiting for Hello: "), "{detail}");
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

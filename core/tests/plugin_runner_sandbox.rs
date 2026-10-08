//! The OS sandbox of out-of-process plugins (#4186, plugin OS-sandbox phase
//! 5a), end to end through the real `termihub-plugin-runner`.
//!
//! The escape-probe fixture (`tests/fixtures/test-plugin`, feature
//! `escape-probe`) runs inside the confined runner and, on command, tries every
//! operation the sandbox must deny — reading outside its folders, listing
//! `$HOME`, `/etc/hosts`, writing outside its data folder, new TCP / Unix
//! connections, `bind`, DNS, `spawn`, `fork` — plus the positive controls that
//! must keep working: reading its install folder, reading and writing its data
//! folder (also through `TMPDIR`), and a network connection through the
//! capability bridge, whose socket the host opens and passes in.
//!
//! **Per OS.** macOS asserts the Seatbelt confinement (#4186), Linux the
//! landlock + seccomp confinement (#4185). Windows (#4187) reuses this file:
//! until its phase lands the runner reports no enforced layer, so there only
//! the positive controls and the report are asserted, and the probe results
//! are printed. That phase flips [`expect_confined`] for its OS.
//!
//! The resource limits are switched off here so that every denial is the
//! sandbox's own (macOS `RLIMIT_NPROC = 0` would deny `spawn` / `fork` too).
#![cfg(all(feature = "plugin", unix))]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod plugin_fixture;
mod plugin_runner_support;
use plugin_fixture::{fixture_library, Variant};
use plugin_runner_support::{install_plugin, new_connection, runner_binary, InstalledEcho};

use termihub_core::connection::{ConnectionType, ConnectionTypeRegistry, OutputReceiver};
use termihub_core::plugin::sandbox::{
    Isolation, PluginRunnerConfig, ResourceLimits, SandboxPolicy, SandboxReport,
};
use termihub_core::plugin::{HostError, PluginHost};

const WAIT: Duration = Duration::from_secs(10);

const PROBE_MANIFEST: &str = r#"{
    "id": "escape-probe",
    "name": "Escape Probe",
    "version": "0.1.0",
    "author": "termiHub tests",
    "description": "Tries to escape the OS sandbox (#4186)",
    "license": "MIT",
    "apiVersion": "1.1",
    "platforms": ["windows", "linux", "macos"],
    "permissions": ["terminal", "network"],
    "extensions": {
        "terminalBackend": {
            "connectionType": "probe",
            "displayName": "Probe",
            "configSchema": { "type": "object", "properties": {} }
        }
    }
}"#;

/// Whether this OS's runner must report an enforced sandbox. #4187 adds
/// Windows here.
fn expect_confined() -> bool {
    cfg!(any(target_os = "macos", target_os = "linux"))
}

/// Canary targets the plugin must not reach, owned by the test.
struct Canaries {
    /// A secret file outside the plugin's folders.
    secret: PathBuf,
    /// A folder outside the plugin's folders to write into.
    outside_dir: PathBuf,
    /// A TCP listener and how many connections it accepted.
    tcp_port: u16,
    tcp_accepted: Arc<AtomicUsize>,
    /// A Unix socket (stands in for `SSH_AUTH_SOCK` / the ADR-13 spawn socket)
    /// and how many connections it accepted.
    unix_path: PathBuf,
    unix_accepted: Arc<AtomicUsize>,
}

fn canaries(work: &Path) -> Canaries {
    let outside_dir = work.join("outside");
    std::fs::create_dir_all(&outside_dir).unwrap();
    let secret = outside_dir.join("canary.txt");
    std::fs::write(&secret, b"secret").unwrap();

    let tcp = TcpListener::bind("127.0.0.1:0").unwrap();
    let tcp_port = tcp.local_addr().unwrap().port();
    let tcp_accepted = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&tcp_accepted);
    std::thread::spawn(move || {
        for _ in tcp.incoming().flatten() {
            counter.fetch_add(1, Ordering::SeqCst);
        }
    });

    let unix_path = work.join("agent.sock");
    let unix = UnixListener::bind(&unix_path).unwrap();
    let unix_accepted = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&unix_accepted);
    std::thread::spawn(move || {
        for _ in unix.incoming().flatten() {
            counter.fetch_add(1, Ordering::SeqCst);
        }
    });
    Canaries {
        secret,
        outside_dir,
        tcp_port,
        tcp_accepted,
        unix_path,
        unix_accepted,
    }
}

/// A local TCP echo server for the bridge's positive control.
fn echo_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut sock in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut buf = [0u8; 64];
                while let Ok(n) = sock.read(&mut buf) {
                    if n == 0 || sock.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            });
        }
    });
    port
}

/// The probe plugin, installed under `<work>/plugins` and loaded out of
/// process.
struct Probe {
    installed: InstalledEcho,
    host: PluginHost,
    registry: Arc<Mutex<ConnectionTypeRegistry>>,
}

impl Probe {
    fn install(work: &Path) -> InstalledEcho {
        let lib = fixture_library(Variant::Escape, work);
        install_plugin(work, &lib, PROBE_MANIFEST)
    }

    fn load(installed: InstalledEcho, config: PluginRunnerConfig) -> Result<Self, HostError> {
        let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
        let host =
            PluginHost::new(&installed.root, Arc::clone(&registry)).with_runner(Some(config));
        host.load(&installed.plugin)?;
        Ok(Self {
            installed,
            host,
            registry,
        })
    }

    fn id(&self) -> &str {
        &self.installed.plugin.manifest.id
    }

    fn report(&self) -> SandboxReport {
        self.host
            .sandboxed_plugin(self.id())
            .and_then(|h| h.running())
            .expect("a running runner")
            .sandbox_report()
            .clone()
    }

    /// The denial events the host recorded for the running runner.
    #[cfg(target_os = "linux")]
    fn denials(&self) -> Vec<termihub_core::plugin::sandbox::BridgeDenial> {
        self.host
            .sandboxed_plugin(self.id())
            .and_then(|h| h.running())
            .expect("a running runner")
            .bridge_denials()
    }

    fn install_dir(&self) -> PathBuf {
        self.installed.root.join(self.id())
    }

    async fn session(
        &self,
        settings: serde_json::Value,
    ) -> (Box<dyn ConnectionType>, OutputReceiver) {
        let mut conn = new_connection(&self.registry, &self.installed.type_id);
        let rx = conn.subscribe_output();
        conn.connect(settings)
            .await
            .expect("the session starts in the runner");
        (conn, rx)
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        let id = self.id().to_owned();
        self.host.unload(&id);
    }
}

async fn read_line(rx: &mut OutputReceiver) -> String {
    let chunk = tokio::time::timeout(WAIT, rx.recv())
        .await
        .expect("output within the timeout")
        .expect("an output chunk");
    String::from_utf8(chunk).expect("UTF-8 output")
}

/// Run `?probe <op> <arg>` and return (allowed, the whole line).
async fn probe(
    conn: &dyn ConnectionType,
    rx: &mut OutputReceiver,
    op: &str,
    arg: &str,
) -> (bool, String) {
    conn.write(format!("?probe {op} {arg}").as_bytes()).unwrap();
    let line = read_line(rx).await;
    let prefix = format!("PROBE {op} ");
    let verdict = line
        .strip_prefix(&prefix)
        .unwrap_or_else(|| panic!("unexpected probe reply: {line}"));
    (verdict.starts_with("ALLOWED"), line)
}

fn config() -> PluginRunnerConfig {
    PluginRunnerConfig::new(runner_binary()).with_limits(ResourceLimits::default())
}

fn canonical(path: &Path) -> String {
    path.canonicalize().unwrap().to_str().unwrap().to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn escape_attempts_fail_and_positive_controls_work() {
    let work = tempfile::TempDir::new().unwrap();
    let canary = canaries(work.path());
    let probe_plugin = Probe::load(Probe::install(work.path()), config()).expect("the probe loads");

    let report = probe_plugin.report();
    if expect_confined() {
        assert_eq!(report.isolation(), Isolation::Full, "{report:?}");
    } else {
        assert_eq!(report.isolation(), Isolation::Unconfined, "{report:?}");
    }

    let (mut conn, mut rx) = probe_plugin.session(serde_json::json!({})).await;
    // Canonical paths, as the host hands them to the plugin: the kernel
    // matches resolved paths, and `/var` → `/private/var` is not readable.
    let data_dir = PathBuf::from(canonical(
        &probe_plugin
            .installed
            .root
            .join(".data")
            .join(probe_plugin.id()),
    ));
    let install_dir = PathBuf::from(canonical(&probe_plugin.install_dir()));
    let manifest = install_dir.join("manifest.json");
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_owned());

    // --- Positive controls: the sandbox is not simply broken. ---
    let data_file = data_dir.join("probe-data.txt");
    for (op, arg) in [
        ("read", manifest.to_str().unwrap()),
        ("write", data_file.to_str().unwrap()),
        ("read", data_file.to_str().unwrap()),
        ("list", data_dir.to_str().unwrap()),
        ("tmp", ""),
    ] {
        let (allowed, line) = probe(conn.as_ref(), &mut rx, op, arg).await;
        assert!(allowed, "positive control failed: {line}");
    }
    if expect_confined() {
        // HOME and TMPDIR point into the data folder.
        let (_, line) = probe(conn.as_ref(), &mut rx, "env", "HOME").await;
        assert!(line.ends_with(&canonical(&data_dir)), "{line}");
        let (_, line) = probe(conn.as_ref(), &mut rx, "env", "TMPDIR").await;
        assert!(line.contains(&canonical(&data_dir)), "{line}");
    }

    // --- Escape attempts. ---
    let outside_file = canary.outside_dir.join("escaped.txt");
    let install_file = install_dir.join("escaped.txt");
    let tcp = format!("127.0.0.1:{}", canary.tcp_port);
    let host_pid = std::process::id();
    let attempts: Vec<(&str, String)> = vec![
        ("read", canonical(&canary.secret)),
        ("list", home.clone()),
        ("read", "/etc/hosts".to_owned()),
        (
            "write",
            format!("{}/escaped.txt", canonical(&canary.outside_dir)),
        ),
        ("write", install_file.display().to_string()),
        ("tcp", tcp),
        ("unix", canonical(&canary.unix_path)),
        ("bind", String::new()),
        ("dns", "localhost".to_owned()),
        ("spawn", String::new()),
        ("fork", String::new()),
        ("env", "SSH_AUTH_SOCK".to_owned()),
        // The host's memory and environment (Linux /proc; absent elsewhere).
        ("read", format!("/proc/{host_pid}/mem")),
        ("read", format!("/proc/{host_pid}/environ")),
        // A serial device.
        ("read", "/dev/ttyS0".to_owned()),
    ];
    let mut escaped = Vec::new();
    for (op, arg) in &attempts {
        let (allowed, line) = probe(conn.as_ref(), &mut rx, op, arg).await;
        println!("{line}");
        if allowed {
            escaped.push(line);
        }
    }
    if expect_confined() {
        assert!(escaped.is_empty(), "sandbox escapes: {escaped:#?}");
        assert!(!outside_file.exists() && !install_file.exists());
        // Give a late connection a moment to land, then require none.
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(canary.tcp_accepted.load(Ordering::SeqCst), 0);
        assert_eq!(canary.unix_accepted.load(Ordering::SeqCst), 0);
    }
    conn.disconnect().await.unwrap();

    // --- The capability bridge still reaches the network: the host opens the
    // connection and passes the socket into the confined runner. ---
    let port = echo_server();
    let (mut bridged, mut rx) = probe_plugin
        .session(serde_json::json!({
            "probe": "netecho", "probeHost": "127.0.0.1", "probePort": port
        }))
        .await;
    assert_eq!(read_line(&mut rx).await, "NETECHO:ping");
    bridged.disconnect().await.unwrap();
}

/// Control run: without the sandbox the same probes escape, so every denial
/// above is the sandbox's doing (the scrubbed environment still hides
/// `SSH_AUTH_SOCK`, and DNS needs a network, so neither is asserted here).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_the_sandbox_the_probes_escape() {
    let work = tempfile::TempDir::new().unwrap();
    let canary = canaries(work.path());
    let probe_plugin = Probe::load(Probe::install(work.path()), config().without_os_sandbox())
        .expect("the probe loads");
    assert_eq!(probe_plugin.report().isolation(), Isolation::Unconfined);
    let (mut conn, mut rx) = probe_plugin.session(serde_json::json!({})).await;
    let tcp = format!("127.0.0.1:{}", canary.tcp_port);
    let outside_file = canary.outside_dir.join("escaped.txt");
    for (op, arg) in [
        ("read", canonical(&canary.secret)),
        ("read", "/etc/hosts".to_owned()),
        ("write", outside_file.display().to_string()),
        ("tcp", tcp),
        ("unix", canonical(&canary.unix_path)),
        ("bind", String::new()),
        ("spawn", String::new()),
        ("fork", String::new()),
    ] {
        let (allowed, line) = probe(conn.as_ref(), &mut rx, op, &arg).await;
        assert!(allowed, "the control probe should escape: {line}");
    }
    conn.disconnect().await.unwrap();
}

/// A sandbox the runner cannot apply leaves the plugin unloaded: the load
/// fails with `SandboxSetupFailed`, nothing is registered, no runner lingers.
#[test]
fn a_sandbox_setup_failure_leaves_the_plugin_unloaded() {
    let work = tempfile::TempDir::new().unwrap();
    let installed = Probe::install(work.path());
    let type_id = installed.type_id.clone();
    let broken = SandboxPolicy {
        install_dir: "not/absolute".to_owned(),
        ..SandboxPolicy::default()
    };
    let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
    let host = PluginHost::new(&installed.root, Arc::clone(&registry))
        .with_runner(Some(config().with_sandbox_policy_for_tests(broken)));
    match host.load(&installed.plugin) {
        Err(HostError::SandboxSetupFailed(detail)) => {
            assert!(detail.contains("not absolute"), "{detail}");
        }
        other => panic!("expected SandboxSetupFailed, got {other:?}"),
    }
    assert!(host
        .sandboxed_plugin(&installed.plugin.manifest.id)
        .is_none());
    assert!(registry.lock().unwrap().create(&type_id).is_err());
}

/// Measure the cost of starting a confined runner: the first start of a
/// runner binary copied to a fresh path (macOS assesses a new executable once
/// — the spike saw about 330 ms), then a warm start of the same binary. Prints
/// the numbers; only a generous ceiling is asserted, as CI machines vary.
#[test]
fn confined_startup_cost_is_measured() {
    let work = tempfile::TempDir::new().unwrap();
    let fresh = work.path().join("runner-copy");
    std::fs::create_dir_all(&fresh).unwrap();
    let runner = fresh.join(runner_binary().file_name().unwrap());
    std::fs::copy(runner_binary(), &runner).unwrap();
    let installed = Probe::install(work.path());

    let mut installed = Some(installed);
    let mut start = |sandboxed: bool| {
        let mut config = PluginRunnerConfig::new(&runner).with_limits(ResourceLimits::default());
        if !sandboxed {
            config = config.without_os_sandbox();
        }
        let started = Instant::now();
        let probe = Probe::load(installed.take().unwrap(), config).expect("the probe loads");
        let elapsed = started.elapsed();
        let isolation = probe.report().isolation();
        let id = probe.id().to_owned();
        probe.host.unload(&id);
        // Reuse the installation for the next start.
        installed = Some(clone_installed(&probe.installed));
        (elapsed, isolation)
    };
    let (first, isolation) = start(true);
    if expect_confined() {
        assert_eq!(isolation, Isolation::Full);
    }
    let confined = [start(true).0, start(true).0];
    let unconfined = [start(false).0, start(false).0];
    println!(
        "runner start (spawn → sandbox → dlopen → Loaded): first launch of a fresh binary \
         {first:?}; warm confined {confined:?}; warm unconfined {unconfined:?}"
    );
    assert!(first < Duration::from_secs(10));
}

fn clone_installed(installed: &InstalledEcho) -> InstalledEcho {
    InstalledEcho {
        root: installed.root.clone(),
        plugin: installed.plugin.clone(),
        type_id: installed.type_id.clone(),
    }
}

/// Linux: a kernel without landlock (simulated with the debug-only
/// `simulate_missing` hook) still gets seccomp — no network, no processes —
/// but no filesystem confinement, and the report says so: **reduced**
/// isolation, which loads only with the hash-bound `reducedIsolationAccepted`
/// acknowledgement (#4188).
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_landlock_the_runner_reports_reduced_isolation() {
    use termihub_core::plugin::sandbox::{layer, sandbox_policy, IsolationStatus};
    use termihub_core::plugin::{native_library_hash, AckAcceptances, NativeTrustStore};

    let work = tempfile::TempDir::new().unwrap();
    let canary = canaries(work.path());
    let installed = Probe::install(work.path());
    let mut policy =
        sandbox_policy(&installed.root, &installed.plugin.manifest.id).expect("a policy");
    policy.simulate_missing = vec![layer::LANDLOCK.to_owned()];
    let config_for =
        |policy: &SandboxPolicy| config().with_sandbox_policy_for_tests(policy.clone());

    // Fail closed: a plain trust acknowledgement does not load it.
    let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
    let host = PluginHost::new(&installed.root, Arc::clone(&registry))
        .with_runner(Some(config_for(&policy)));
    match host.load(&installed.plugin) {
        Err(HostError::ReducedIsolationNotAccepted { missing }) => {
            assert_eq!(missing, vec![layer::LANDLOCK.to_owned()]);
        }
        other => panic!("expected ReducedIsolationNotAccepted, got {other:?}"),
    }
    let id = installed.plugin.manifest.id.clone();
    let status = host.sandbox_status(&id).expect("the refusal is recorded");
    assert_eq!(status.isolation, IsolationStatus::Unavailable);
    assert!(!host.is_loaded(&id));

    // Accept reduced isolation for this exact library: now it loads.
    let hash = native_library_hash(&installed.root, &id).unwrap();
    NativeTrustStore::load(&installed.root)
        .acknowledge_with(
            &id,
            hash,
            AckAcceptances {
                reduced_isolation: true,
                ..AckAcceptances::default()
            },
        )
        .unwrap();
    let probe_plugin = Probe::load(installed, config_for(&policy))
        .expect("reduced isolation loads once it is accepted (#4188)");
    let report = probe_plugin.report();
    assert_eq!(report.isolation(), Isolation::Reduced, "{report:?}");
    assert_eq!(report.enforced, vec![layer::SECCOMP.to_owned()]);
    assert_eq!(report.missing, vec![layer::LANDLOCK.to_owned()]);

    let (mut conn, mut rx) = probe_plugin.session(serde_json::json!({})).await;
    // Without landlock the canary is readable: this is what "reduced" means.
    let (allowed, line) = probe(conn.as_ref(), &mut rx, "read", &canonical(&canary.secret)).await;
    assert!(allowed, "{line}");
    // seccomp still closes the network and process creation.
    let tcp = format!("127.0.0.1:{}", canary.tcp_port);
    for (op, arg) in [
        ("tcp", tcp.as_str()),
        ("bind", ""),
        ("spawn", ""),
        ("fork", ""),
    ] {
        let (allowed, line) = probe(conn.as_ref(), &mut rx, op, arg).await;
        assert!(!allowed, "seccomp must deny {op}: {line}");
    }
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(canary.tcp_accepted.load(Ordering::SeqCst), 0);
    conn.disconnect().await.unwrap();
}

/// Linux: every reported seccomp denial reaches the host as a
/// `Denied{syscall}` report (#4236) while the plugin still sees `EPERM`; a
/// burst is coalesced (rate-limited) into a few reports; and the plugin cannot
/// replace the `SIGSYS` handler the reports rely on.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn seccomp_denials_reach_the_host_as_denied_reports() {
    use termihub_core::plugin::sandbox::DenialReason;

    const EPERM_TEXT: &str = "Operation not permitted";
    let work = tempfile::TempDir::new().unwrap();
    let canary = canaries(work.path());
    let probe_plugin = Probe::load(Probe::install(work.path()), config()).expect("the probe loads");
    let (mut conn, mut rx) = probe_plugin.session(serde_json::json!({})).await;

    // The denied calls still fail with EPERM, exactly as before the trap.
    let tcp = format!("127.0.0.1:{}", canary.tcp_port);
    let unix = canonical(&canary.unix_path);
    for (op, arg) in [("tcp", tcp.as_str()), ("unix", &unix), ("bind", "")] {
        let (allowed, line) = probe(conn.as_ref(), &mut rx, op, arg).await;
        assert!(!allowed && line.contains(EPERM_TEXT), "{line}");
    }
    // The plugin cannot take the SIGSYS handler over, and denials keep
    // answering EPERM afterwards.
    let (allowed, line) = probe(conn.as_ref(), &mut rx, "sigsys", "").await;
    assert!(!allowed && line.contains(EPERM_TEXT), "{line}");
    let (allowed, line) = probe(conn.as_ref(), &mut rx, "tcp", &tcp).await;
    assert!(!allowed && line.contains(EPERM_TEXT), "{line}");

    let syscall_count = |name: &str| -> (usize, u32) {
        let denials: Vec<_> = probe_plugin
            .denials()
            .into_iter()
            .filter(|d| d.reason == DenialReason::Syscall && d.operation == name)
            .collect();
        (denials.len(), denials.iter().map(|d| d.count).sum())
    };
    // Four `socket` calls were refused above (tcp, unix, bind, tcp).
    let deadline = Instant::now() + WAIT;
    while syscall_count("socket").1 < 4 {
        assert!(Instant::now() < deadline, "no socket denial reported");
        std::thread::sleep(Duration::from_millis(50));
    }
    // Let the last report interval pass, then fire a burst.
    std::thread::sleep(Duration::from_millis(1500));
    let (events_before, calls_before) = syscall_count("socket");
    assert_eq!(calls_before, 4, "{:?}", probe_plugin.denials());
    let (allowed, line) = probe(conn.as_ref(), &mut rx, "sockets", "1000").await;
    assert!(!allowed && line.contains(EPERM_TEXT), "{line}");
    let deadline = Instant::now() + WAIT;
    while syscall_count("socket").1 < calls_before + 1000 {
        assert!(Instant::now() < deadline, "the burst was not reported");
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(1500));
    let (events_after, calls_after) = syscall_count("socket");
    assert_eq!(
        calls_after,
        calls_before + 1000,
        "every refused call is counted"
    );
    assert!(
        events_after - events_before <= 3,
        "1000 denials must be coalesced into a few reports, got {}",
        events_after - events_before
    );
    assert_eq!(canary.tcp_accepted.load(Ordering::SeqCst), 0);
    assert_eq!(canary.unix_accepted.load(Ordering::SeqCst), 0);
    conn.disconnect().await.unwrap();
}

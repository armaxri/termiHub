//! Crash, hang and resource-limit isolation of out-of-process plugins (#4184,
//! plugin OS-sandbox phase 3), end to end through the real
//! `termihub-plugin-runner`.
//!
//! A test-only fixture plugin (`tests/fixtures/test-plugin`, feature
//! `crash-commands`) misbehaves on command: it segfaults, aborts, spins, sends
//! garbage frames, allocates without bound, opens descriptors, tries to start
//! a process, floods output past the rate cap and probes for descriptors it
//! should not have inherited (#4203). Next to it the real `echo-backend` example runs in its own
//! runner. Every test asserts that the host (this process) survives, that the
//! other plugin's sessions are unaffected, and that the backend records the
//! right exit cause per session; the crash budget restarts three crashes and
//! auto-disables the plugin on the fourth, persisting the reason.
#![cfg(all(feature = "plugin", unix))]

use std::sync::{Arc, Mutex};
use std::time::Duration;

mod plugin_fixture;
mod plugin_runner_support;
use plugin_fixture::{fixture_library, Variant};
use plugin_runner_support::{
    echo_backend_library, install_plugin_tagged, new_connection, process_exists, runner_binary,
    wait_until, InstalledEcho,
};

use termihub_core::connection::{ConnectionType, ConnectionTypeRegistry, OutputReceiver};
use termihub_core::plugin::sandbox::{
    OutputRateCap, PluginRunnerConfig, ResourceLimits, RunnerExitCause, WatchdogConfig,
};
use termihub_core::plugin::{PluginHost, PluginManager, PluginState};

const WAIT: Duration = Duration::from_secs(10);

const CRASH_MANIFEST: &str = r#"{
    "id": "crash-fixture",
    "name": "Crash Fixture",
    "version": "0.1.0",
    "author": "termiHub tests",
    "description": "Misbehaves on command (#4184)",
    "license": "MIT",
    "apiVersion": "1.1",
    "platforms": ["windows", "linux", "macos"],
    "permissions": ["terminal"],
    "extensions": {
        "terminalBackend": {
            "connectionType": "crash",
            "displayName": "Crash",
            "configSchema": { "type": "object", "properties": {} }
        }
    }
}"#;

/// The crash fixture and the echo-backend example, installed under one root
/// and served by one host out of process.
struct Fixture {
    _work: tempfile::TempDir,
    crash: InstalledEcho,
    echo: InstalledEcho,
    host: PluginHost,
    registry: Arc<Mutex<ConnectionTypeRegistry>>,
}

/// A fast watchdog so a hang is detected in about two seconds, with enough
/// slack that a loaded CI runner answering late is not mistaken for one.
fn fast_watchdog() -> WatchdogConfig {
    WatchdogConfig {
        ping_interval: Duration::from_millis(200),
        hang_timeout: Duration::from_secs(2),
        ..WatchdogConfig::default()
    }
}

fn fixture(config: PluginRunnerConfig) -> Fixture {
    let work = tempfile::TempDir::new().unwrap();
    let crash_lib = fixture_library(Variant::Crash, work.path());
    let crash = install_plugin_tagged(work.path(), "-crash", &crash_lib, CRASH_MANIFEST);
    let echo_lib = echo_backend_library(work.path());
    let echo_manifest = std::fs::read_to_string(
        plugin_runner_support::workspace_root().join("examples/plugins/echo-backend/manifest.json"),
    )
    .unwrap();
    let echo = install_plugin_tagged(work.path(), "-echo", &echo_lib, &echo_manifest);
    assert_eq!(crash.root, echo.root);

    let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
    let host = PluginHost::new(&crash.root, Arc::clone(&registry)).with_runner(Some(config));
    host.load(&crash.plugin).expect("the crash fixture loads");
    host.load(&echo.plugin).expect("echo-backend loads");
    Fixture {
        _work: work,
        crash,
        echo,
        host,
        registry,
    }
}

fn default_config() -> PluginRunnerConfig {
    PluginRunnerConfig::new(runner_binary()).with_watchdog(fast_watchdog())
}

async fn connect(
    registry: &Arc<Mutex<ConnectionTypeRegistry>>,
    type_id: &str,
) -> (Box<dyn ConnectionType>, OutputReceiver) {
    let mut conn = new_connection(registry, type_id);
    let rx = conn.subscribe_output();
    conn.connect(serde_json::json!({}))
        .await
        .expect("the session starts in the runner");
    (conn, rx)
}

async fn read_line(rx: &mut OutputReceiver) -> String {
    let chunk = tokio::time::timeout(WAIT, rx.recv())
        .await
        .expect("output within the timeout")
        .expect("an output chunk");
    String::from_utf8(chunk).expect("UTF-8 output")
}

/// The echo plugin still answers on `conn`.
async fn assert_echo_alive(conn: &dyn ConnectionType, rx: &mut OutputReceiver, text: &str) {
    assert!(conn.is_connected(), "the other plugin's session survived");
    conn.write(text.as_bytes()).unwrap();
    assert_eq!(read_line(rx).await, text);
}

/// Send `command` on a fresh crash session next to a second one, and return
/// the cause both report once their runner is gone.
async fn crash_with(f: &Fixture, command: &str) -> RunnerExitCause {
    let (victim, _rx) = connect(&f.registry, &f.crash.type_id).await;
    let (bystander, _rx2) = connect(&f.registry, &f.crash.type_id).await;
    let pid = f
        .host
        .sandboxed_plugin(&f.crash.plugin.manifest.id)
        .and_then(|h| h.running())
        .and_then(|p| p.pid())
        .expect("a runner pid");
    victim.write(command.as_bytes()).unwrap();
    assert!(
        wait_until(WAIT, || !victim.is_connected() && !bystander.is_connected()),
        "{command}: both sessions of the crashed plugin end"
    );
    assert!(wait_until(WAIT, || !process_exists(pid)), "{command}");
    assert!(
        wait_until(WAIT, || victim.plugin_exit_cause().is_some()),
        "{command}: the session reports why it ended"
    );
    let cause = victim.plugin_exit_cause().unwrap();
    assert_eq!(bystander.plugin_exit_cause(), Some(cause.clone()));
    cause
}

fn crashes(f: &Fixture) -> u32 {
    f.host
        .plugin_health(&f.crash.plugin.manifest.id)
        .map_or(0, |h| h.crashes)
}

#[tokio::test(flavor = "multi_thread")]
async fn crashes_are_isolated_counted_and_the_fourth_auto_disables() {
    let f = fixture(default_config());
    let crash_id = f.crash.plugin.manifest.id.clone();
    let (echo, mut echo_rx) = connect(&f.registry, &f.echo.type_id).await;
    assert_echo_alive(echo.as_ref(), &mut echo_rx, "before").await;

    // 1: segfault.
    let cause = crash_with(&f, "!segv").await;
    assert!(
        matches!(
            cause,
            RunnerExitCause::Crashed {
                signal: Some(s),
                ..
            } if s == libc::SIGSEGV || s == libc::SIGBUS
        ),
        "{cause:?}"
    );
    assert!(wait_until(WAIT, || crashes(&f) == 1));
    assert_echo_alive(echo.as_ref(), &mut echo_rx, "after segv").await;

    // The runner is respawned at once: a new session works.
    let handle = f.host.sandboxed_plugin(&crash_id).unwrap();
    assert!(wait_until(WAIT, || handle.running().is_some()));
    {
        let (fresh, mut rx) = connect(&f.registry, &f.crash.type_id).await;
        fresh.write(b"hello").unwrap();
        assert_eq!(read_line(&mut rx).await, "hello");
        assert_eq!(fresh.plugin_exit_cause(), None);
    }

    // 2: abort (what a `panic = "abort"` plugin does).
    let cause = crash_with(&f, "!abort").await;
    assert_eq!(
        cause,
        RunnerExitCause::Crashed {
            signal: Some(libc::SIGABRT),
            exit_code: None
        }
    );
    assert!(wait_until(WAIT, || crashes(&f) == 2));
    assert_echo_alive(echo.as_ref(), &mut echo_rx, "after abort").await;

    // 3: a hostile frame on the IPC channel.
    let cause = crash_with(&f, "!garbage").await;
    assert!(
        matches!(cause, RunnerExitCause::InvalidData { .. }),
        "{cause:?}"
    );
    assert!(wait_until(WAIT, || crashes(&f) == 3));
    assert!(f.host.is_active(&crash_id), "three crashes are restarted");
    assert_echo_alive(echo.as_ref(), &mut echo_rx, "after garbage").await;

    // 4: a hang: no pong → killed as not responding → the budget is spent.
    let cause = crash_with(&f, "!spin").await;
    assert_eq!(cause, RunnerExitCause::NotResponding);
    let health = || f.host.plugin_health(&crash_id).unwrap();
    assert!(wait_until(WAIT, || health().auto_disabled.is_some()));
    assert_eq!(
        health().auto_disabled.as_deref(),
        Some("Disabled after 3 crashes")
    );
    assert_eq!(health().last_exit, Some(RunnerExitCause::NotResponding));
    assert!(!f.host.is_active(&crash_id));
    assert!(!f.host.is_loaded(&crash_id));
    // Its connection type is gone and nothing respawned it.
    assert!(wait_until(WAIT, || f
        .registry
        .lock()
        .unwrap()
        .create(&f.crash.type_id)
        .is_err()));
    assert!(handle.running().is_none());

    // Persisted: the management layer reports it disabled, with the reason.
    let manager = PluginManager::new(&f.crash.root);
    assert!(wait_until(WAIT, || manager.get(&crash_id).unwrap().state
        == PluginState::Disabled));
    assert_eq!(
        manager.get(&crash_id).unwrap().error_message.as_deref(),
        Some("Disabled after 3 crashes")
    );

    // The other plugin never noticed.
    assert_echo_alive(echo.as_ref(), &mut echo_rx, "after auto-disable").await;
    assert!(f.host.is_active(&f.echo.plugin.manifest.id));

    // Re-enable: a fresh load, a fresh budget.
    let reenabled = manager.enable(&crash_id).unwrap();
    assert_eq!(reenabled.error_message, None);
    f.host.load(&reenabled).expect("re-enabled plugin loads");
    assert!(f.host.is_active(&crash_id));
    assert_eq!(crashes(&f), 0);
    let (again, mut rx) = connect(&f.registry, &f.crash.type_id).await;
    again.write(b"back").unwrap();
    assert_eq!(read_line(&mut rx).await, "back");
    drop(again);
    f.host.unload(&crash_id);
    f.host.unload(&f.echo.plugin.manifest.id);
}

/// The memory limits the out-of-memory tests run under: Linux enforces the
/// 512 MiB address-space cap; macOS has none, so the host's resident-size
/// poll ends the runner there.
fn memory_limited(watchdog: WatchdogConfig, rss_limit: u64) -> PluginRunnerConfig {
    default_config()
        .with_limits(ResourceLimits {
            address_space_bytes: Some(512 * 1024 * 1024),
            ..ResourceLimits::plugin_defaults()
        })
        .with_watchdog(WatchdogConfig {
            rss_limit: cfg!(target_os = "macos").then_some(rss_limit),
            rss_poll_interval: Duration::from_millis(50),
            ..watchdog
        })
}

#[tokio::test(flavor = "multi_thread")]
async fn unbounded_allocation_is_killed_as_out_of_memory() {
    // The allocation loop runs inside a plugin call, so the runner also stops
    // answering pings. A hang timeout far beyond the test's wait keeps the
    // memory path the only one that can end it (#4239): no timer race.
    let config = memory_limited(
        WatchdogConfig {
            hang_timeout: Duration::from_secs(600),
            ..fast_watchdog()
        },
        128 * 1024 * 1024,
    );
    let f = fixture(config);
    let (echo, mut echo_rx) = connect(&f.registry, &f.echo.type_id).await;

    let cause = crash_with(&f, "!alloc").await;
    assert_eq!(cause, RunnerExitCause::OutOfMemory);
    assert!(wait_until(WAIT, || crashes(&f) == 1));
    assert_echo_alive(echo.as_ref(), &mut echo_rx, "after alloc").await;
    f.host.unload(&f.crash.plugin.manifest.id);
    f.host.unload(&f.echo.plugin.manifest.id);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hang_close_to_the_memory_limit_is_out_of_memory() {
    // The plugin holds ~90 % of its memory limit and then stops answering:
    // the hang verdict reports out of memory, not "not responding" (#4239).
    let f = fixture(memory_limited(fast_watchdog(), 512 * 1024 * 1024));
    let (conn, mut rx) = connect(&f.registry, &f.crash.type_id).await;
    // ~90 % of the limit. On Linux the runner's own address space (libraries,
    // stacks, malloc arenas) counts too, so the hoard may instead hit the cap
    // and abort: that is out of memory as well.
    let mib = if cfg!(target_os = "linux") { 420 } else { 460 };
    conn.write(format!("!hoard:{mib}").as_bytes()).unwrap();
    assert_eq!(read_line(&mut rx).await, "HOARDING");
    // The hoard grows on a plugin thread, so pings keep being answered.
    let done = format!("HOARDED:{mib}");
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    let mut hoarded = false;
    while conn.is_connected() {
        if conn.write(b"!hoarded").is_err() {
            break;
        }
        match tokio::time::timeout(WAIT, rx.recv()).await {
            Ok(Some(chunk)) if chunk == done.as_bytes() => {
                hoarded = true;
                break;
            }
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => panic!("no answer from the hoarding plugin"),
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the hoard never finished"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if hoarded {
        // Now stall: the hang verdict sees the memory pressure.
        conn.write(b"!spin").unwrap();
    }
    assert!(wait_until(WAIT, || conn.plugin_exit_cause().is_some()));
    assert_eq!(conn.plugin_exit_cause(), Some(RunnerExitCause::OutOfMemory));
    drop(conn);
    f.host.unload(&f.crash.plugin.manifest.id);
    f.host.unload(&f.echo.plugin.manifest.id);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_plugin_runs_under_the_descriptor_limit() {
    let f = fixture(default_config());
    let (conn, mut rx) = connect(&f.registry, &f.crash.type_id).await;
    conn.write(b"!fds").unwrap();
    let line = read_line(&mut rx).await;
    let count: u64 = line
        .strip_prefix("FDS:")
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("unexpected reply {line}"));
    assert!(
        count < ResourceLimits::DEFAULT_MAX_OPEN_FILES,
        "opened {count} descriptors"
    );
    // Running out of descriptors is the plugin's problem, not a crash.
    conn.write(b"still here").unwrap();
    assert_eq!(read_line(&mut rx).await, "still here");
    assert_eq!(crashes(&f), 0);
    drop(conn);
    f.host.unload(&f.crash.plugin.manifest.id);
}

/// macOS enforces "no child processes" with `RLIMIT_NPROC`; on Linux that
/// limit also counts threads, so it waits for the seccomp phase.
#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread")]
async fn the_plugin_cannot_start_child_processes() {
    let f = fixture(default_config());
    let (conn, mut rx) = connect(&f.registry, &f.crash.type_id).await;
    conn.write(b"!spawn").unwrap();
    assert_eq!(read_line(&mut rx).await, "SPAWN_DENIED");
    drop(conn);
    f.host.unload(&f.crash.plugin.manifest.id);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_quiet_runner_answers_pings_and_is_left_alone() {
    // Pings are answered while the runner idles: well past the hang timeout
    // nothing is killed and nothing is counted.
    let f = fixture(default_config());
    let (conn, mut rx) = connect(&f.registry, &f.crash.type_id).await;
    tokio::time::sleep(fast_watchdog().hang_timeout * 2).await;
    assert!(conn.is_connected());
    conn.write(b"awake").unwrap();
    assert_eq!(read_line(&mut rx).await, "awake");
    assert_eq!(crashes(&f), 0);
    drop(conn);
    f.host.unload(&f.crash.plugin.manifest.id);
}

/// Read `rx` on a background task until `marker` arrives (or the channel
/// ends), so the host's delivery never backpressures the runner. Returns
/// whether the marker came.
fn drain_until(mut rx: OutputReceiver, marker: &'static [u8]) -> tokio::task::JoinHandle<bool> {
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            if chunk.ends_with(marker) {
                return true;
            }
        }
        false
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn output_beyond_the_rate_cap_kills_the_runner_and_spares_the_other_plugin() {
    // A small cap so the test's flood surely exceeds it; the hang timer is
    // out of reach (the flood runs inside a plugin call), so only the cap can
    // end the runner.
    let config = PluginRunnerConfig::new(runner_binary())
        .with_watchdog(WatchdogConfig {
            hang_timeout: Duration::from_secs(600),
            ..fast_watchdog()
        })
        .with_output_rate_cap(OutputRateCap {
            bytes_per_second: 4 * 1024 * 1024,
            burst_bytes: 16 * 1024 * 1024,
        });
    let f = fixture(config);
    let (echo, mut echo_rx) = connect(&f.registry, &f.echo.type_id).await;
    let (victim, rx) = connect(&f.registry, &f.crash.type_id).await;
    let (bystander, _rx2) = connect(&f.registry, &f.crash.type_id).await;
    let pid = f
        .host
        .sandboxed_plugin(&f.crash.plugin.manifest.id)
        .and_then(|h| h.running())
        .and_then(|p| p.pid())
        .expect("a runner pid");
    // Everything the flood sends is consumed, as a live terminal would.
    let drained = drain_until(rx, b"FLOODED");
    victim.write(b"!flood:1024").unwrap();
    // The other plugin answers while the flood is on and after it.
    assert_echo_alive(echo.as_ref(), &mut echo_rx, "during the flood").await;

    assert!(
        wait_until(WAIT, || !victim.is_connected() && !bystander.is_connected()),
        "every session of the flooding plugin ends"
    );
    assert!(wait_until(WAIT, || !process_exists(pid)));
    // The flood never finished: the runner was cut off mid-way.
    assert!(!drained.is_finished() || !drained.await.unwrap());
    assert!(wait_until(WAIT, || victim.plugin_exit_cause().is_some()));
    let cause = victim.plugin_exit_cause().unwrap();
    assert!(
        matches!(&cause, RunnerExitCause::InvalidData { detail } if detail.contains("output rate cap")),
        "{cause:?}"
    );
    assert_eq!(bystander.plugin_exit_cause(), Some(cause));
    assert!(wait_until(WAIT, || crashes(&f) == 1));
    assert_echo_alive(echo.as_ref(), &mut echo_rx, "after the flood").await;
    drop((victim, bystander));
    f.host.unload(&f.crash.plugin.manifest.id);
    f.host.unload(&f.echo.plugin.manifest.id);
}

#[tokio::test(flavor = "multi_thread")]
async fn output_within_the_default_cap_is_left_alone() {
    let f = fixture(default_config());
    let (conn, rx) = connect(&f.registry, &f.crash.type_id).await;
    let drained = drain_until(rx, b"FLOODED");
    // 64 MiB at full speed: well inside the default burst budget.
    conn.write(b"!flood:64").unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(60), drained)
            .await
            .expect("the flood finishes")
            .unwrap(),
        "the whole flood arrived"
    );
    assert!(conn.is_connected());
    assert_eq!(crashes(&f), 0);
    drop(conn);
    f.host.unload(&f.crash.plugin.manifest.id);
    f.host.unload(&f.echo.plugin.manifest.id);
}

/// A descriptor the host holds **without** close-on-exec when the runner is
/// spawned (a library's, say) must not reach the runner (#4203): only 0-3 are
/// inherited. The plugin, inside the runner, reports what that descriptor
/// number is there: nothing, or some other file the runner opened itself.
#[tokio::test(flavor = "multi_thread")]
async fn the_runner_inherits_no_stray_descriptor() {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;

    let stray = tempfile::tempfile().unwrap();
    let fd = stray.as_raw_fd();
    // SAFETY: `fd` is open and owned by `stray` for the whole test.
    assert_eq!(unsafe { libc::fcntl(fd, libc::F_SETFD, 0) }, 0);
    let meta = stray.metadata().unwrap();
    let leaked = format!("FDSTAT:{}:{}", meta.dev(), meta.ino());

    // The runner is spawned at load, after the stray descriptor exists.
    let f = fixture(default_config());
    let (conn, mut rx) = connect(&f.registry, &f.crash.type_id).await;
    conn.write(format!("!fdstat:{fd}").as_bytes()).unwrap();
    let seen = read_line(&mut rx).await;
    assert!(seen.starts_with("FDSTAT:"), "unexpected reply {seen}");
    assert!(!seen.starts_with("FDSTAT:ERR"), "probe failed: {seen}");
    assert_ne!(seen, leaked, "the runner inherited descriptor {fd}");
    // The probe itself works: the runner's own channel is descriptor 3.
    conn.write(b"!fdstat:3").unwrap();
    let ipc = read_line(&mut rx).await;
    assert!(
        ipc.starts_with("FDSTAT:") && ipc != "FDSTAT:CLOSED" && !ipc.starts_with("FDSTAT:ERR"),
        "{ipc}"
    );
    drop(conn);
    drop(stray);
    f.host.unload(&f.crash.plugin.manifest.id);
    f.host.unload(&f.echo.plugin.manifest.id);
}

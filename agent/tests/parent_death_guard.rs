//! Regression test for the test-harness parent-death guard (#3641).
//!
//! A killed test binary (Ctrl-C, CI timeout, IDE stop) never runs its drop
//! guards, so any `termihub-agent --listen` worker it spawned used to be
//! re-parented to init/launchd and live on — one kept a registry daemon alive
//! for 13 days. [`common::parent_death`] arms every spawned agent to exit when
//! the test process dies.
//!
//! The test reproduces exactly that: it starts a *helper* process (this test
//! binary again, running only [`parent_death_guard_helper`]) that spawns an
//! agent worker the way every suite does, SIGKILLs the helper (on Windows:
//! `TerminateProcess`), and asserts the orphaned worker exits within a few
//! seconds. Only processes this test spawned are touched, and only by PID.

mod common;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::daemon_reaper::{kill_pid, pid_alive};
use common::parent_death::GuardedSpawn;
use tempfile::TempDir;

/// Set on the helper process only: where it writes the spawned agent's PID.
const HELPER_OUT_ENV: &str = "TERMIHUB_TEST_PARENT_DEATH_HELPER_OUT";

/// Name of the helper test, run by exact name in the child process.
const HELPER_TEST: &str = "parent_death_guard_helper";

/// How long the orphaned worker may take to notice and exit. The Unix watchdog
/// polls every 200 ms; the rest is headroom for a loaded CI runner.
const EXIT_DEADLINE: Duration = Duration::from_secs(10);

/// Generous: the helper is a fresh test-binary process plus an agent cold start.
const STARTUP_DEADLINE: Duration = Duration::from_secs(60);

/// Upper bound on the helper's life if the test that started it never kills
/// it, so a failed run cannot leak the helper either.
const HELPER_MAX_LIFE: Duration = Duration::from_secs(120);

fn agent_binary() -> &'static str {
    env!("CARGO_BIN_EXE_termihub-agent")
}

fn agent_log(out: &Path) -> PathBuf {
    out.with_extension("agent.log")
}

/// Poll `probe` until it yields a value or `deadline` passes.
fn wait_for<T>(deadline: Duration, mut probe: impl FnMut() -> Option<T>) -> Option<T> {
    let end = Instant::now() + deadline;
    loop {
        if let Some(v) = probe() {
            return Some(v);
        }
        if Instant::now() >= end {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The helper role. Ignored in normal runs, and a no-op when run without the
/// helper env (e.g. by a blanket `cargo test -- --ignored`).
#[test]
#[ignore = "helper process for killed_harness_parent_takes_its_agent_worker_down; not a test"]
fn parent_death_guard_helper() {
    let Some(out) = std::env::var_os(HELPER_OUT_ENV).map(PathBuf::from) else {
        return;
    };
    let dir = out.parent().expect("helper out path has a parent");
    let config_home = dir.join("config");
    std::fs::create_dir_all(&config_home).expect("create config home");
    let log = std::fs::File::create(agent_log(&out)).expect("create agent log");

    let mut cmd = Command::new(agent_binary());
    cmd.args(["--listen", "127.0.0.1:0"])
        .env("XDG_CONFIG_HOME", &config_home)
        // Nothing here needs the host-wide registry; do not start one.
        .env("TERMIHUB_AGENT_SKIP_REGISTRY_DAEMON", "1")
        .env("TERMIHUB_AGENT_WORKER_THREADS", "2")
        .env("TERMIHUB_AGENT_SKIP_DOCKER_PROBE", "1")
        .env("RUST_LOG", "info")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log));
    #[cfg(unix)]
    cmd.envs(common::isolated_registry_env(&config_home));
    #[cfg(windows)]
    cmd.env(
        "TERMIHUB_REGISTRY_ENDPOINT",
        format!(r"\\.\pipe\termihub-pdg-{}", std::process::id()),
    );
    let mut child = cmd.spawn_guarded().expect("spawn agent worker");

    // Publish the PID atomically so the parent never reads a partial write.
    let tmp = out.with_extension("tmp");
    std::fs::write(&tmp, child.id().to_string()).expect("write agent pid");
    std::fs::rename(&tmp, &out).expect("publish agent pid");

    // Wait to be killed. Only reached if the parent test never kills us.
    std::thread::sleep(HELPER_MAX_LIFE);
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn killed_harness_parent_takes_its_agent_worker_down() {
    let dir = TempDir::new().expect("temp dir");
    let out = dir.path().join("agent.pid");

    let mut helper = Command::new(std::env::current_exe().expect("current test exe"))
        .args([HELPER_TEST, "--exact", "--ignored", "--test-threads=1"])
        .env(HELPER_OUT_ENV, &out)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn helper process");

    let agent_pid = wait_for(STARTUP_DEADLINE, || {
        std::fs::read_to_string(&out)
            .ok()?
            .trim()
            .parse::<u32>()
            .ok()
    });
    let Some(agent_pid) = agent_pid else {
        let _ = helper.kill();
        let _ = helper.wait();
        panic!("helper never reported its agent worker's PID");
    };

    // Let the worker come fully up (its watchdog is armed before the runtime
    // even starts; this just makes sure we kill a running agent, not one still
    // mid-exec).
    let listening = wait_for(STARTUP_DEADLINE, || {
        let log = std::fs::read_to_string(agent_log(&out)).unwrap_or_default();
        (!common::listen_addrs(&log).is_empty()).then_some(())
    });
    if listening.is_none() {
        let _ = helper.kill();
        let _ = helper.wait();
        kill_pid(agent_pid);
        let log = std::fs::read_to_string(agent_log(&out)).unwrap_or_default();
        panic!("agent worker never started listening; its log:\n{log}");
    }
    assert!(pid_alive(agent_pid), "agent worker died before the test");

    // The point of the test: kill the parent outright (SIGKILL on Unix,
    // TerminateProcess on Windows) — no drop guard, no graceful shutdown.
    helper.kill().expect("kill helper");
    helper.wait().expect("reap helper");

    let exited = wait_for(EXIT_DEADLINE, || (!pid_alive(agent_pid)).then_some(()));
    if exited.is_none() {
        kill_pid(agent_pid);
        panic!(
            "agent worker {agent_pid} outlived its killed parent by {EXIT_DEADLINE:?} \
             — the parent-death guard did not fire"
        );
    }
}

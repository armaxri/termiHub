use super::live_channel_support::{channel_rpc, read_counter_until, wait_for_output};
use super::*;
use base64::engine::general_purpose::STANDARD as B64;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use termihub_core::test_fixtures;

/// Overall ceiling for the fresh-create + echo round-trip after reconnect.
/// Generous so a slow CI shell cold-start never flakes it.
const RECOVERY_CEILING: Duration = Duration::from_secs(45);

/// Tight ceiling on the `reconnect_agent` call itself — the regression guard
/// for the bug this test found and fixed (#2476).
///
/// Before the fix, killing the sshd tree also killed the setsid'd session
/// daemon (leaving its socket file), so the fresh agent's startup
/// `recover_sessions` paid the full 30s spawn-path connect timeout on the
/// dead-but-lingering socket **before** answering `initialize` — so
/// `reconnect_agent` sat blocked ~31s (30s recovery + ~1s backoff), the
/// "transport restored but stuck Reconnecting" symptom. With recovery now
/// fast-failing the dead socket, reconnect settles in a few seconds. This
/// bound sits comfortably above that (SSH connect + agent cold-start +
/// backoff, with CI jitter) yet far below the pre-fix ~31s, so a regression
/// to the long recovery path trips it.
const RECONNECT_SETTLE_CEILING: Duration = Duration::from_secs(20);

/// Locate a usable `sshd` binary, or `None` to skip.
fn find_sshd() -> Option<PathBuf> {
    for cand in ["/usr/sbin/sshd", "/sbin/sshd"] {
        let p = Path::new(cand);
        if p.is_file() {
            return Some(p.to_path_buf());
        }
    }
    // PATH fallback.
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|d| d.join("sshd"))
            .find(|p| p.is_file())
    })
}

/// Locate the built `termihub-agent` binary, or `None` to skip.
///
/// `termihub-agent` is a *separate* workspace crate, so `cargo test` for this
/// crate does not build it and there is no `CARGO_BIN_EXE_termihub-agent` for
/// us (that env exists only for the agent crate's own integration tests).
/// Resolve it relative to the test binary (`target/<profile>/deps/<test>` →
/// `target/<profile>/termihub-agent`), with an explicit env override for
/// non-standard layouts. Skip gracefully when absent (build it first with
/// `cargo build -p termihub-agent`).
fn find_agent_binary() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("TERMIHUB_TEST_AGENT_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().ok()?;
    // exe = target/<profile>/deps/<test-bin>; profile dir is two up.
    let profile_dir = exe.parent()?.parent()?;
    [
        profile_dir.join("termihub-agent"),
        exe.parent()?.join("termihub-agent"),
    ]
    .into_iter()
    .find(|cand| cand.is_file())
}

/// How to provide what the local-sshd tests need.
const SSHD_HINT: &str = "install an OpenSSH server and client (e.g. openssh-server)";

/// The local `sshd` to stand up, or `None` to skip. Panics instead of skipping
/// under `TERMIHUB_REQUIRE_LOCAL_SSHD`, which the CI lanes that run these tests
/// set, so the reconnect regression guard cannot pass without running (#4338).
fn require_sshd() -> Option<PathBuf> {
    let sshd = find_sshd();
    test_fixtures::require(
        sshd.is_some(),
        test_fixtures::REQUIRE_LOCAL_SSHD_ENV,
        "no sshd binary found — cannot stand up a local agent endpoint",
        SSHD_HINT,
    )
    .then_some(sshd)
    .flatten()
}

/// The local `sshd` and the prebuilt agent binary, or `None` to skip. Like
/// [`require_sshd`], panics instead of skipping under
/// `TERMIHUB_REQUIRE_LOCAL_SSHD`.
fn require_sshd_and_agent() -> Option<(PathBuf, PathBuf)> {
    let sshd = require_sshd()?;
    let agent_bin = find_agent_binary();
    test_fixtures::require(
        agent_bin.is_some(),
        test_fixtures::REQUIRE_LOCAL_SSHD_ENV,
        "termihub-agent binary not found",
        "run `cargo build -p termihub-agent`, or set TERMIHUB_TEST_AGENT_BIN",
    )
    .then_some(agent_bin)
    .flatten()
    .map(|agent_bin| {
        warn_if_no_parent_watchdog(&agent_bin);
        (sshd, agent_bin)
    })
}

/// Env var that arms the agent's test-only parent-death watchdog (#3641).
/// Mirrors `PARENT_PID_ENV` in `agent/src/test_parent_watchdog.rs`.
const PARENT_PID_ENV: &str = "TERMIHUB_TEST_PARENT_PID";

/// Whether an agent binary's bytes carry the parent-death watchdog. The
/// watchdog — and with it the env-var name — is compiled only into debug and
/// `test-hooks` agents, never into a default `--release` one (WA-RS2-003).
fn has_parent_watchdog(binary: &[u8]) -> bool {
    binary
        .windows(PARENT_PID_ENV.len())
        .any(|w| w == PARENT_PID_ENV.as_bytes())
}

/// Say so, once, when the agent under test cannot arm its parent-death
/// watchdog: a killed test run would then leak the agent and its daemons.
///
/// The `cargo test` debug agent always has it. A release-profile run must
/// build the agent with the hooks: `cargo test --release --workspace
/// --features termihub-agent/test-hooks` (or point `TERMIHUB_TEST_AGENT_BIN` at
/// such a build). The tests still run without it; only the leak guard is off.
fn warn_if_no_parent_watchdog(agent_bin: &Path) {
    static CHECKED: std::sync::Once = std::sync::Once::new();
    CHECKED.call_once(|| {
        if std::fs::read(agent_bin).is_ok_and(|bytes| !has_parent_watchdog(&bytes)) {
            eprintln!(
                "warning: {} has no parent-death watchdog ({PARENT_PID_ENV} is ignored); \
                 build it with `--features termihub-agent/test-hooks` so a killed test \
                 run cannot leak agents (#4362)",
                agent_bin.display()
            );
        }
    });
}

#[test]
fn parent_watchdog_detection_matches_the_env_name() {
    assert!(has_parent_watchdog(
        b"\0prefix TERMIHUB_TEST_PARENT_PID suffix\0"
    ));
    assert!(!has_parent_watchdog(b"\0release agent bytes\0"));
    assert!(!has_parent_watchdog(b"TERMIHUB_TEST_PARENT_PI"));
}

/// Lowest port of the kernel's ephemeral (auto-assigned) range: every port-0
/// bind and every outgoing connect's local port is drawn from `[this, 65535]`.
/// Falls back to the IANA/Linux-default floor when it cannot be read.
fn ephemeral_port_floor() -> u16 {
    const DEFAULT_FLOOR: u16 = 32768;
    #[cfg(target_os = "linux")]
    let floor = std::fs::read_to_string("/proc/sys/net/ipv4/ip_local_port_range")
        .ok()
        .and_then(|range| range.split_whitespace().next()?.parse::<u16>().ok());
    #[cfg(target_os = "macos")]
    let floor = Command::new("sysctl")
        .args(["-n", "net.inet.ip.portrange.first"])
        .output()
        .ok()
        .and_then(|out| {
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse::<u16>()
                .ok()
        });
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let floor: Option<u16> = None;
    floor.unwrap_or(DEFAULT_FLOOR).min(DEFAULT_FLOOR)
}

/// Pick a loopback TCP port for the throwaway `sshd`, which must bind it itself
/// and re-bind the *same* port across a stop/restart (the reconnect target is
/// fixed).
///
/// The old "bind `127.0.0.1:0`, read the port, drop the listener" idiom handed
/// sshd a freed **ephemeral** port — which the kernel is free to hand straight
/// to any concurrent test's port-0 bind or outgoing connect before sshd binds
/// it (and again during the stop → restart gap), so sshd's bind failed or the
/// agent reconnected to a stranger (#3533). A port *below* the ephemeral range
/// is never auto-assigned, so no port-0 bind or connect anywhere on the host can
/// take it; only an explicit bind of that exact number could. The candidate
/// sequence is spread by PID and a per-process counter so concurrent instances
/// (in this process or a parallel checkout's) start on different ports, and a
/// port already held by something else is skipped.
///
/// The spread alone still let two harness instances share a port (#3129): an
/// instance's port is free during its stop → restart gap and before its sshd
/// first binds, so another instance's probe could pick it (or hold it for the
/// instant of its probe bind, failing this sshd's bind). Every harness port is
/// therefore also [`PortLease`]d for the instance's lifetime, and a leased port
/// is never probed.
fn sshd_port() -> (u16, PortLease) {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(0);

    const RANGE_START: u16 = 10_000;
    let range_end = ephemeral_port_floor();
    assert!(
        range_end > RANGE_START + 1_000,
        "ephemeral port range starts too low ({range_end}) to pick a stable sshd port"
    );
    let span = u32::from(range_end - RANGE_START);
    let seed = std::process::id()
        .wrapping_mul(7919)
        .wrapping_add(NEXT.fetch_add(1, Ordering::Relaxed).wrapping_mul(104_729));
    (0..span)
        .map(|i| RANGE_START + ((seed.wrapping_add(i) % span) as u16))
        .find_map(|port| {
            let lease = PortLease::try_acquire(port)?;
            std::net::TcpListener::bind(("127.0.0.1", port))
                .is_ok()
                .then_some((port, lease))
        })
        .expect("no free non-ephemeral loopback port for sshd")
}

/// A host-wide claim on one sshd port, held for a harness instance's whole
/// lifetime so no other instance — in this process, a helper process or a
/// parallel checkout — picks it, even while this instance's sshd is down
/// (#3129). It is an exclusive `flock` on a per-port file: the kernel drops the
/// lock when the file closes or the process dies, so a killed test run never
/// leaves a stale claim behind. The lock files themselves are left in place;
/// an unlocked file claims nothing.
struct PortLease {
    _file: std::fs::File,
}

impl PortLease {
    /// Claim `port`, or `None` if another instance holds it.
    fn try_acquire(port: u16) -> Option<Self> {
        use std::os::unix::io::AsRawFd;
        // Safety: `getuid` only reads the calling process's real user id.
        let uid = unsafe { libc::getuid() };
        let dir = std::env::temp_dir().join(format!("termihub-russh-sshd-ports-{uid}"));
        std::fs::create_dir_all(&dir).ok()?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join(format!("{port}.lock")))
            .ok()?;
        // Safety: `flock` on a descriptor this function owns. Rust opens it
        // close-on-exec, so no child process inherits the lock.
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        (rc == 0).then_some(Self { _file: file })
    }
}

/// Write the harness `sshd_config`: `template` with its `Port 0` placeholder
/// set to `port`.
fn write_sshd_config(path: &Path, template: &str, port: u16) -> std::io::Result<()> {
    std::fs::write(
        path,
        template.replacen("Port 0", &format!("Port {port}"), 1),
    )
}

/// The start of one sshd's stderr log, drained on a thread so sshd (and its
/// per-connection children, which share the pipe) never block on a full pipe.
/// Keeps only the first lines: the start-up and bind messages are all
/// `start()` needs, and memory stays bounded however long the sshd runs.
#[derive(Clone, Default)]
struct SshdLog(Arc<std::sync::Mutex<Vec<String>>>);

impl SshdLog {
    const MAX_LINES: usize = 200;

    fn drain(stderr: std::process::ChildStderr) -> Self {
        use std::io::BufRead;
        let log = Self::default();
        let sink = log.clone();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stderr)
                .lines()
                .map_while(Result::ok)
            {
                let mut lines = sink
                    .0
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if lines.len() < Self::MAX_LINES {
                    lines.push(line);
                }
            }
        });
        log
    }

    fn text(&self) -> String {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .join("\n")
    }
}

/// Whether an sshd log shows it exited because its port was taken.
fn is_bind_failure(log: &str) -> bool {
    log.contains("Address already in use") || log.contains("Cannot bind any address")
}

/// A process-unique suffix for per-instance temp dirs.
fn unique_suffix() -> u32 {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn is_listening(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(500),
    )
    .is_ok()
}

/// SIGKILL the whole process subtree rooted at `root` (master sshd + its
/// per-connection privilege-separation children + the shell + the agent).
///
/// Killing only the `-D` master leaves established connections (and the agent
/// they spawned) alive, so it would *not* model a transport drop. We walk the
/// live process table by ppid — the dependency-free analog of the Python
/// harness's `psutil` recursive kill — and kill every descendant. Only
/// processes descended from our own sshd are touched (never a name pattern).
fn kill_subtree(root: u32) {
    // pid -> ppid for every live process.
    let out = match Command::new("ps")
        .args(["-ax", "-o", "pid=,ppid="])
        .output()
    {
        Ok(o) => o,
        Err(_) => return,
    };
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = line.split_whitespace();
        if let (Some(pid), Some(ppid)) = (it.next(), it.next()) {
            if let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) {
                children.entry(ppid).or_default().push(pid);
            }
        }
    }
    // DFS the subtree.
    let mut victims = Vec::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        victims.push(pid);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    if victims.is_empty() {
        return;
    }
    // Kill leaves first so a parent cannot re-fork a replacement mid-teardown.
    victims.reverse();
    let mut cmd = Command::new("kill");
    cmd.arg("-KILL");
    for pid in &victims {
        cmd.arg(pid.to_string());
    }
    let _ = cmd.stderr(Stdio::null()).status();
}

/// The normalised command name of a pid, reduced to what the sshd-family match
/// keys on. Mirrors the retired `agent-reconnect-transport.sh`'s `comm_of`
/// (#2550; the shell harness was removed once the grade was automated, #2574): on
/// macOS 26 / OpenSSH 10 `ps -o comm=` is the rewritten process TITLE whose
/// first token carries a trailing colon (`sshd:`, `sshd-session:`), so take the
/// first token, basename it, and strip a trailing colon.
fn comm_of(pid: u32) -> String {
    let out = match Command::new("ps")
        .args(["-o", "comm=", "-p", &pid.to_string()])
        .output()
    {
        Ok(o) => o,
        Err(_) => return String::new(),
    };
    let raw = String::from_utf8_lossy(&out.stdout);
    let first = raw.split_whitespace().next().unwrap_or("");
    let base = first.rsplit('/').next().unwrap_or(first);
    base.strip_suffix(':').unwrap_or(base).to_string()
}

/// Whether a normalised comm names an sshd-family transport process — the
/// master listener (`sshd`) or a per-connection handler (`sshd-session`,
/// `sshd-sess`, `sshd-auth`, …). Matches the shell harness's `is_sshd_family`.
fn is_sshd_family(comm: &str) -> bool {
    comm == "sshd" || comm.starts_with("sshd-")
}

/// Whether `pid` is a session leader (its session id equals its pid) — the
/// property `setsid` establishes and the one that distinguishes the detached
/// session **daemon** from the `--stdio` agent that spawned it (the agent
/// shares the daemon's binary but is not a session leader). Mirrors the
/// `getsid` check in `agent::daemon::spawn`'s own detachment test.
fn is_session_leader(pid: u32) -> bool {
    // Safety: `getsid` merely reads the session id of an existing pid.
    let sid = unsafe { libc::getsid(pid as libc::pid_t) };
    sid != -1 && sid == pid as libc::pid_t
}

/// The setsid'd session-daemon PIDs the agent spawned under our sshd `root`,
/// identified while they are still live descendants (before a sever reparents
/// them to init). A session daemon is the descendant that is its own session
/// leader (`setsid`) AND whose command is the agent binary — the `--stdio`
/// agent shares the binary but is not a session leader, and sshd-family
/// processes never match the agent comm. Scoped strictly to our own sshd
/// subtree and identity-matched, never a global name pattern (#2580).
fn session_daemon_pids(root: u32, agent_comm: &str) -> Vec<u32> {
    descendant_pids(root)
        .into_iter()
        .filter(|&pid| is_session_leader(pid) && comm_of(pid) == agent_comm)
        .collect()
}

/// Every live descendant of `root` (not `root` itself), found by walking the
/// process table by ppid. Empty when `ps` cannot be run.
fn descendant_pids(root: u32) -> Vec<u32> {
    let out = match Command::new("ps")
        .args(["-ax", "-o", "pid=,ppid="])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = line.split_whitespace();
        if let (Some(pid), Some(ppid)) = (it.next(), it.next()) {
            if let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) {
                children.entry(ppid).or_default().push(pid);
            }
        }
    }
    let mut found = Vec::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if pid != root {
            found.push(pid);
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    found
}

/// Union the session daemons currently under `root` into `sink` (dedup), so a
/// later `Drop` can reap them by exact PID.
fn record_daemons_into(sink: &std::sync::Mutex<Vec<u32>>, root: u32, agent_comm: &str) {
    let found = session_daemon_pids(root, agent_comm);
    if found.is_empty() {
        return;
    }
    if let Ok(mut guard) = sink.lock() {
        for pid in found {
            if !guard.contains(&pid) {
                guard.push(pid);
            }
        }
    }
}

/// Best-effort SIGKILL of the recorded session daemons by exact PID —
/// re-verifying identity (still the agent binary, still a session leader) at
/// kill time so a recycled PID is never touched. An already-exited daemon
/// (the recovery path, an explicit `connection.close`, or the daemon's own
/// idle-exit may have reaped it) yields an empty comm and is skipped, so no
/// ESRCH is raised (#2580).
fn reap_session_daemons(pids: &[u32], agent_comm: &str) {
    for &pid in pids {
        if is_session_leader(pid) && comm_of(pid) == agent_comm {
            // Safety: `kill` signals an existing pid; the identity re-check
            // above guards against PID reuse and the result is ignored
            // (best-effort teardown).
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
}

/// How long teardown lets an agent process that is already on its way out
/// finish exiting before it falls back to SIGKILL (#3831). A clean exit takes
/// milliseconds; the bound only matters when something is wrong.
const AGENT_EXIT_GRACE: Duration = Duration::from_secs(10);

/// Whether `pid` has exited but is not yet reaped. A zombie has finished its
/// `atexit` work (including any coverage profile write), so it counts as gone.
fn is_zombie(pid: u32) -> bool {
    Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim_start()
                .starts_with('Z')
        })
        .unwrap_or(false)
}

/// The `termihub-agent --stdio` workers under our sshd `root`: agent-binary
/// descendants that are NOT session leaders (the setsid'd session and registry
/// daemons are), and have not yet exited.
fn agent_worker_pids(root: u32, agent_comm: &str) -> Vec<u32> {
    descendant_pids(root)
        .into_iter()
        .filter(|&pid| !is_session_leader(pid) && comm_of(pid) == agent_comm && !is_zombie(pid))
        .collect()
}

/// Poll `pending` until it reports no processes or `grace` runs out. Returns
/// whether everything exited in time.
fn wait_until_gone(grace: Duration, mut pending: impl FnMut() -> Vec<u32>) -> bool {
    let deadline = Instant::now() + grace;
    loop {
        if pending().is_empty() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Whether `pid` is still the running session daemon for `session_id` (its
/// command line is `<agent> --daemon <session_id>`). A recycled PID or an exited
/// daemon does not match.
fn is_running_session_daemon(pid: u32, session_id: &str, agent_comm: &str) -> bool {
    let args = Command::new("ps")
        .args(["-o", "args=", "-p", &pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    args.contains(&format!("--daemon {session_id}"))
        && comm_of(pid) == agent_comm
        && !is_zombie(pid)
}

/// After a test closed session `session_id` (`connection.close`), wait for its
/// recorded session daemon to finish exiting on its own, so the exact-PID reap
/// in `Drop` never SIGKILLs it mid-exit. Under `cargo llvm-cov` the daemon
/// writes its `.profraw` in an `atexit` handler, and a SIGKILL during that
/// write truncates it (#3742, #3831). Bounded by [`AGENT_EXIT_GRACE`].
fn wait_for_closed_session_daemon(
    sink: &std::sync::Mutex<Vec<u32>>,
    session_id: &str,
    agent_comm: &str,
) -> bool {
    let pids = sink.lock().map(|g| g.clone()).unwrap_or_default();
    wait_until_gone(AGENT_EXIT_GRACE, || {
        pids.iter()
            .copied()
            .filter(|&pid| is_running_session_daemon(pid, session_id, agent_comm))
            .collect()
    })
}

/// Env var the LLVM profiling runtime reads to decide where an instrumented
/// process writes its `.profraw` coverage profile.
const LLVM_PROFILE_FILE_ENV: &str = "LLVM_PROFILE_FILE";

/// The `LLVM_PROFILE_FILE` the harness hands every agent sshd launches (#3831).
///
/// sshd starts a session with a scrubbed environment, in the user's home dir.
/// Without this an instrumented agent — and every session/registry daemon it
/// spawns, which inherit its environment — writes `default_*.profraw` into
/// `$HOME`, and its coverage never reaches the `cargo llvm-cov` merge.
///
/// `test_value` is this test process's own setting (under `cargo llvm-cov`,
/// a path in `target/llvm-cov-target/`). It is made absolute against `cwd`,
/// because a relative path would resolve against the session's cwd: `$HOME`.
/// Without one, the profile goes to `scratch` (the harness's temp dir), so an
/// instrumented agent can never fall back to `$HOME` either way.
fn agent_profile_file(test_value: Option<&std::ffi::OsStr>, cwd: &Path, scratch: &Path) -> PathBuf {
    match test_value.filter(|v| !v.is_empty()) {
        Some(value) => cwd.join(value),
        None => scratch.join("agent-%p.profraw"),
    }
}

/// One `NAME=value` token for an sshd_config `SetEnv` line. sshd splits the
/// line shell-style, so a value holding whitespace, a quote or a backslash is
/// double-quoted with those characters escaped.
fn sshd_setenv_token(name: &str, value: &str) -> String {
    let token = format!("{name}={value}");
    if token.contains(|c: char| c.is_whitespace() || c == '"' || c == '\\') {
        let escaped = token.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{escaped}\"")
    } else {
        token
    }
}

/// SIGKILL only the **sshd-family** processes in the subtree rooted at `root`
/// (the master listener + its per-connection handlers), sparing the
/// `termihub-agent --stdio` the handler exec'd and — crucially — the setsid'd
/// session **daemon** that agent spawned.
///
/// This is the automated analog of the *fixed* (now retired)
/// `agent-reconnect-transport.sh drop` (#2550): killing the sshd handler closes the SSH channel, so the
/// `--stdio` agent hits EOF and exits on its own, while the reparented daemon
/// (a different session/pgroup) keeps its shell + running process alive for the
/// recovery. `kill_subtree` above kills the daemon too (it is still a ppid-child
/// at kill time, #2508/#995), so it can only test *fresh-create* recovery —
/// this daemon-sparing variant is what lets a test assert **live-session
/// continuity** (#2512). Scoped to our own sshd's subtree, comm-matched, never a
/// name-pattern kill.
fn kill_sshd_only(root: u32) {
    let out = match Command::new("ps")
        .args(["-ax", "-o", "pid=,ppid="])
        .output()
    {
        Ok(o) => o,
        Err(_) => return,
    };
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = line.split_whitespace();
        if let (Some(pid), Some(ppid)) = (it.next(), it.next()) {
            if let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) {
                children.entry(ppid).or_default().push(pid);
            }
        }
    }
    // Walk the whole subtree, but select ONLY sshd-family pids to kill.
    let mut victims = Vec::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if is_sshd_family(&comm_of(pid)) {
            victims.push(pid);
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    if victims.is_empty() {
        return;
    }
    // Kill leaves first so the master cannot re-fork a handler mid-teardown.
    victims.reverse();
    let mut cmd = Command::new("kill");
    cmd.arg("-KILL");
    for pid in &victims {
        cmd.arg(pid.to_string());
    }
    let _ = cmd.stderr(Stdio::null()).status();
}

/// Watchdog script for [`SshdParentGuard`]. `$1` is the sshd master PID, `$2`
/// the harness temp dir. It blocks reading its stdin, a pipe whose only write
/// end lives in this test process: a disarm line means a clean `stop()` (exit
/// quietly); EOF means the test process died (the kernel closed the write end),
/// so SIGKILL the sshd — only if that PID still names an sshd, never a reused
/// PID — and drop the temp dir. INT/HUP/TERM/QUIT are ignored so a Ctrl-C sent
/// to the test's process group cannot take the watchdog down before it acts.
const SSHD_GUARD_SCRIPT: &str = r#"trap '' INT HUP TERM QUIT
if read -r _; then exit 0; fi
case "$(ps -o comm= -p "$1" 2>/dev/null)" in
  *sshd*) kill -KILL "$1" 2>/dev/null ;;
esac
rm -rf -- "$2"
"#;

/// Parent-death guard for the throwaway `sshd -D` master (#3649).
///
/// The agent that sshd launches is armed through `TERMIHUB_TEST_PARENT_PID`
/// (#3641), but sshd itself ignores that variable: when the test binary is
/// killed before `Drop` runs, the master is re-parented to init/launchd and
/// keeps listening. This guard is an external `sh` watchdog holding the read
/// end of a pipe whose write end only this process holds (Rust creates pipes
/// close-on-exec, so no other child inherits it). The kernel closes the write
/// end however this process dies, so the watchdog sees EOF and kills the sshd.
///
/// Why not Linux `PR_SET_PDEATHSIG`: it fires when the spawning *thread* exits,
/// and each libtest test runs on its own thread (see #3648); it also has no
/// macOS equivalent. The pipe EOF is process-level and portable to every Unix.
struct SshdParentGuard {
    watchdog: Child,
    disarm: Option<std::process::ChildStdin>,
}

impl SshdParentGuard {
    /// Arm a watchdog for the sshd master `pid`, owning temp dir `dir`.
    fn arm(pid: u32, dir: &Path) -> std::io::Result<Self> {
        let mut watchdog = Command::new("/bin/sh")
            .arg("-c")
            .arg(SSHD_GUARD_SCRIPT)
            .arg("termihub-sshd-guard")
            .arg(pid.to_string())
            .arg(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        let disarm = watchdog.stdin.take();
        Ok(Self { watchdog, disarm })
    }

    /// Stand the watchdog down without killing anything (a clean `stop()`),
    /// and reap it so no zombie lingers.
    fn disarm(mut self) {
        if let Some(mut stdin) = self.disarm.take() {
            use std::io::Write;
            let _ = stdin.write_all(b"disarm\n");
        }
        let _ = self.watchdog.wait();
    }
}

/// A killable/restartable loopback `sshd` with the real agent binary
/// reachable over key auth — the Rust analog of the Python `LocalAgentSshd`
/// (#2481). `start`/`stop` own the whole process tree so a `stop` severs an
/// established agent connection at once (the server-side transport drop).
struct LocalAgentSshd {
    sshd: PathBuf,
    dir: PathBuf,
    config: PathBuf,
    client_key: PathBuf,
    port: u16,
    username: String,
    agent_bin: PathBuf,
    child: Option<Child>,
    /// Basename of `agent_bin`, matched against `ps -o comm=` to pick the
    /// setsid'd session daemon out of our sshd's descendants.
    agent_comm: String,
    /// PIDs of setsid'd session daemons this instance's agent spawned,
    /// captured while they were still live descendants. A continuity sever
    /// spares the daemon and reparents it to init, so `stop()`'s subtree kill
    /// can no longer reach it — only an exact-PID reap in `Drop` cleans it up
    /// (#2580). Shared via `Arc` so a driver thread that spawns/severs a
    /// daemon-backed session off this instance can record into the same sink.
    daemon_pids: Arc<std::sync::Mutex<Vec<u32>>>,
    /// Watchdog that kills the running sshd master if this test process dies
    /// before `stop()`/`Drop` can (#3649). Armed per `start()`.
    guard: Option<SshdParentGuard>,
    /// Absolute `LLVM_PROFILE_FILE` forwarded to every agent this sshd
    /// launches, so an instrumented agent never writes into `$HOME` (#3831).
    profile_file: PathBuf,
    /// `(pid, comm)` of every process that was under the sshd master when
    /// [`close_listener`](Self::close_listener) killed only the master. They
    /// are reparented to init, so `Drop` reaps them by exact PID (#3129).
    orphans: Vec<(u32, String)>,
    /// Claim on `port` for this instance's lifetime (#3129).
    lease: PortLease,
    /// The `sshd_config` text with a `Port 0` placeholder, so a first start
    /// that loses its port can move to another one.
    config_template: String,
    /// Whether an sshd of this instance ever listened. Until then the port is
    /// not yet load-bearing and a lost bind can move to another one.
    listened: bool,
}

impl LocalAgentSshd {
    fn new(sshd: PathBuf, agent_bin: PathBuf) -> std::io::Result<Self> {
        let dir = std::env::temp_dir().join(format!(
            "termihub-russh-reconnect-{}-{}",
            std::process::id(),
            unique_suffix()
        ));
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;

        let host_key = dir.join("host_key");
        let client_key = dir.join("client_key");
        for key in [&host_key, &client_key] {
            let status = Command::new("ssh-keygen")
                .args(["-t", "ed25519", "-N", "", "-q", "-f"])
                .arg(key)
                .status()?;
            if !status.success() {
                return Err(std::io::Error::other("ssh-keygen failed"));
            }
            std::fs::set_permissions(key, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
        }

        let username = std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());
        let registry_endpoint = dir.join("registry.sock");
        let xdg = dir.join("xdg");
        std::fs::create_dir_all(&xdg)?;

        let config = dir.join("sshd_config");
        // Loopback-only key auth, no PAM/strict-modes so it runs unprivileged
        // (mirrors scripts/dev.sh and the Python harness). `SetEnv` forces the
        // per-test registry endpoint + config home into the agent's env so it
        // never touches shared ADR-11 registry state (#2489), and bounds how
        // long the registry and any session daemon the agent spawns (both
        // inherit it) outlive the test if `Drop` never runs (#3636).
        // `TERMIHUB_TEST_PARENT_PID` arms the agent's test-only parent-death
        // watchdog on this test process, so a killed test run takes the agent
        // and its daemons down with it instead of leaking them (#3641). Only
        // debug and `test-hooks` agents have the watchdog (#4362); see
        // `warn_if_no_parent_watchdog`.
        // `LLVM_PROFILE_FILE` sends an instrumented agent's coverage profile
        // (and its daemons') to the llvm-cov target instead of `$HOME` (#3831).
        let cwd = std::env::current_dir()?;
        let profile_file = agent_profile_file(
            std::env::var_os(LLVM_PROFILE_FILE_ENV).as_deref(),
            &cwd,
            &dir,
        );
        let config_body = [
            format!("Port {}", 0), // placeholder, rewritten per start
            "ListenAddress 127.0.0.1".to_string(),
            format!("HostKey {}", host_key.display()),
            format!("AuthorizedKeysFile {}.pub", client_key.display()),
            "UsePAM no".to_string(),
            "PasswordAuthentication no".to_string(),
            "PubkeyAuthentication yes".to_string(),
            "StrictModes no".to_string(),
            // INFO so sshd's stderr log carries the `Server listening` line
            // that `start()` uses to confirm it is OUR sshd on the port.
            "LogLevel INFO".to_string(),
            format!(
                "SetEnv TERMIHUB_REGISTRY_ENDPOINT={} XDG_CONFIG_HOME={} \
                 TERMIHUB_REGISTRY_IDLE_TIMEOUT_SECS=15 \
                 TERMIHUB_DAEMON_DETACHED_TIMEOUT_SECS=120 \
                 TERMIHUB_TEST_PARENT_PID={} {}",
                registry_endpoint.display(),
                xdg.display(),
                std::process::id(),
                sshd_setenv_token(LLVM_PROFILE_FILE_ENV, &profile_file.to_string_lossy()),
            ),
            String::new(),
        ]
        .join("\n");
        // The port is fixed for the lifetime of the instance (drop/restore
        // must reuse it), so pick it now and write the final config.
        let (port, lease) = sshd_port();
        write_sshd_config(&config, &config_body, port)?;

        let agent_comm = agent_bin
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        Ok(Self {
            sshd,
            dir,
            config,
            client_key,
            port,
            username,
            agent_bin,
            child: None,
            agent_comm,
            daemon_pids: Arc::new(std::sync::Mutex::new(Vec::new())),
            guard: None,
            profile_file,
            orphans: Vec::new(),
            lease,
            config_template: config_body,
            listened: false,
        })
    }

    /// Launch sshd (foreground `-D` so we own the tree) and wait until it
    /// is listening on `port`.
    ///
    /// "Something accepts on the port" is not enough (#3129): if another
    /// process holds the port, our sshd exits on its failed bind while the
    /// probe connects to the stranger, and the test's first connect then gets
    /// a reset or a refusal. So this waits for our own sshd to log that it is
    /// listening. If the very first start loses its port, the instance moves to
    /// a fresh one; a restart must keep its port, so losing it there panics.
    fn start(&mut self) {
        assert!(self.child.is_none(), "already running");
        for _ in 0..5 {
            match self.spawn_and_confirm_listening() {
                Ok(()) => {
                    self.listened = true;
                    return;
                }
                Err(log) if !self.listened && is_bind_failure(&log) => {
                    let (port, lease) = sshd_port();
                    write_sshd_config(&self.config, &self.config_template, port)
                        .expect("rewrite sshd_config for a fresh port");
                    self.port = port;
                    self.lease = lease;
                }
                Err(log) => panic!("sshd on 127.0.0.1:{} did not start:\n{log}", self.port),
            }
        }
        panic!("sshd could not bind a port after 5 tries");
    }

    /// One sshd start: `Ok` once our sshd logs that it listens on `port` and
    /// the port accepts; `Err(log)` if sshd exited first.
    ///
    /// sshd logs to stderr (`-e`), drained by a thread into memory rather than
    /// written to a file: its per-connection children inherit the log target,
    /// and a log file in the instance dir would be re-created by a late child
    /// after the parent-death guard removed the dir.
    fn spawn_and_confirm_listening(&mut self) -> Result<(), String> {
        let mut child = Command::new(&self.sshd)
            .arg("-D")
            .arg("-e")
            .arg("-f")
            .arg(&self.config)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sshd");
        // Arm before anything can panic, so even a failed start is covered.
        self.guard = Some(SshdParentGuard::arm(child.id(), &self.dir).expect("arm sshd guard"));
        let log = SshdLog::drain(child.stderr.take().expect("sshd stderr"));
        self.child = Some(child);

        let listening = format!("Server listening on 127.0.0.1 port {}.", self.port);
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            let exited = self
                .child
                .as_mut()
                .and_then(|c| c.try_wait().ok())
                .flatten();
            if let Some(status) = exited {
                if let Some(guard) = self.guard.take() {
                    guard.disarm();
                }
                self.child = None;
                return Err(format!("sshd exited ({status}):\n{}", log.text()));
            }
            if log.text().contains(&listening) && is_listening(self.port) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!(
            "sshd did not listen on 127.0.0.1:{} in time:\n{}",
            self.port,
            log.text()
        );
    }

    /// Kill the sshd tree (SIGKILL) — an abrupt server-side drop that severs
    /// the established agent connection, then wait for the port to close.
    fn stop(&mut self) {
        // Disarm first: once we kill + reap the master its PID is free for
        // reuse, and the watchdog must never act on a stale PID.
        if let Some(guard) = self.guard.take() {
            guard.disarm();
        }
        if let Some(mut child) = self.child.take() {
            kill_subtree(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if !is_listening(self.port) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Close the listening port while keeping every established connection up
    /// (#3129): SIGKILL only the `-D` master. Its per-connection handlers and
    /// the agents they launched are separate processes that survive, so an
    /// agent transport stays connected; only new connections are refused.
    ///
    /// This makes a later transport drop a deterministic *permanent* loss. The
    /// alternative, severing first and then `stop()`, races the reconnect: once
    /// the sever lands, the first backoff (as short as 500 ms with jitter) can
    /// dial the master before `stop()` has snapshotted and killed the subtree,
    /// and a handler forked after that snapshot survives the kill.
    ///
    /// The survivors are recorded now, while they are still descendants, and
    /// reaped by exact PID in `Drop`.
    fn close_listener(&mut self) {
        if let Some(guard) = self.guard.take() {
            guard.disarm();
        }
        if let Some(mut child) = self.child.take() {
            self.orphans = descendant_pids(child.id())
                .into_iter()
                .map(|pid| (pid, comm_of(pid)))
                .filter(|(_, comm)| !comm.is_empty())
                .collect();
            let _ = child.kill();
            let _ = child.wait();
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if !is_listening(self.port) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!(
            "sshd still listening on 127.0.0.1:{} after close",
            self.port
        );
    }

    /// Reap what [`close_listener`](Self::close_listener) left running. The
    /// handlers and `--stdio` agents exit on their own once the transport is
    /// gone, so give them [`AGENT_EXIT_GRACE`] (a SIGKILL mid-exit would
    /// truncate an instrumented agent's coverage profile, #3831), then SIGKILL
    /// whatever is left. Every signal re-checks that the PID still runs the
    /// recorded command, so a recycled PID is never touched.
    fn reap_orphans(&mut self) {
        let orphans = std::mem::take(&mut self.orphans);
        let still_running = |o: &(u32, String)| !is_zombie(o.0) && comm_of(o.0) == o.1;
        wait_until_gone(AGENT_EXIT_GRACE, || {
            orphans
                .iter()
                .filter(|o| !is_session_leader(o.0) && still_running(o))
                .map(|o| o.0)
                .collect()
        });
        for orphan in orphans.iter().filter(|o| still_running(o)) {
            // Safety: `kill` signals an existing pid whose identity was just
            // re-checked; the result is ignored (best-effort teardown).
            unsafe {
                libc::kill(orphan.0 as libc::pid_t, libc::SIGKILL);
            }
        }
    }

    /// Teardown after the test dropped its transport: let the `--stdio` agent
    /// worker(s) finish exiting before `stop()`'s subtree SIGKILL (#3831).
    ///
    /// A dropped transport makes the agent hit EOF and exit on its own, and
    /// under `cargo llvm-cov` it writes its `.profraw` in an `atexit` handler.
    /// A SIGKILL that lands during that write truncates the profile, and
    /// `llvm-profdata merge` then rejects the whole run (the #3742 failure).
    /// Bounded by [`AGENT_EXIT_GRACE`]; a worker still running after that is
    /// killed as before. Use plain `stop()` for a mid-test transport drop.
    fn stop_after_disconnect(&mut self) {
        if let Some(root) = self.master_pid() {
            let comm = self.agent_comm.clone();
            wait_until_gone(AGENT_EXIT_GRACE, || agent_worker_pids(root, &comm));
        }
        self.stop();
    }

    /// After the test closed session `session_id`, wait for its recorded
    /// session daemon to exit on its own before `Drop` reaps the recorded PIDs
    /// (see [`wait_for_closed_session_daemon`]).
    fn wait_for_closed_daemon(&self, session_id: &str) {
        wait_for_closed_session_daemon(&self.daemon_pids, session_id, &self.agent_comm);
    }

    /// Sever the transport the way the fixed `drop` harness does: kill only the
    /// sshd master + handlers, **sparing the setsid'd session daemon** so a live
    /// session survives the outage (the #2512 continuity path). The established
    /// russh channel still goes down (the handler is gone), but the daemon keeps
    /// the shell + its running process alive for the reconnect to recover.
    ///
    /// Reaps our master `Child` handle (it is now dead) so no zombie lingers,
    /// and waits for the port to close so `start()` can rebind it.
    fn stop_sparing_daemon(&mut self) {
        // Record the spared daemon(s) NOW, while they are still descendants —
        // after the sshd kill the reparented daemon is no longer reachable via
        // the subtree, so only an exact-PID reap in `Drop` can clean it (#2580).
        self.record_session_daemons();
        if let Some(guard) = self.guard.take() {
            guard.disarm();
        }
        if let Some(mut child) = self.child.take() {
            kill_sshd_only(child.id());
            let _ = child.wait();
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if !is_listening(self.port) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// The live PID of our sshd `-D` master, if running.
    fn master_pid(&self) -> Option<u32> {
        self.child.as_ref().map(|c| c.id())
    }

    /// The agent binary basename used to identify our session daemon(s).
    fn agent_comm(&self) -> &str {
        &self.agent_comm
    }

    /// A cheap clone of the daemon-PID sink so a driver thread that spawns +
    /// severs a daemon-backed session off this instance can record the spared
    /// daemon for teardown (used by the manager-driven test, whose sever runs
    /// on a blocking worker that does not hold the `sshd` handle).
    fn daemon_sink(&self) -> Arc<std::sync::Mutex<Vec<u32>>> {
        Arc::clone(&self.daemon_pids)
    }

    /// Record the setsid'd session daemon(s) currently living under our sshd
    /// master so `Drop` can reap them by exact PID. Call this while the daemon
    /// is still a descendant — i.e. BEFORE a continuity sever detaches it
    /// (#2580). No-op if the master is gone or no daemon is present.
    fn record_session_daemons(&self) {
        if let Some(root) = self.master_pid() {
            record_daemons_into(&self.daemon_pids, root, &self.agent_comm);
        }
    }

    fn agent_config(&self) -> RemoteAgentConfig {
        RemoteAgentConfig {
            host: "127.0.0.1".to_string(),
            port: self.port,
            username: self.username.clone(),
            auth_method: "key".to_string(),
            password: None,
            key_path: Some(self.client_key.to_string_lossy().into_owned()),
            save_password: None,
            agent_path: Some(self.agent_bin.to_string_lossy().into_owned()),
            external_connection_files: vec![],
            ..Default::default()
        }
    }
}

impl Drop for LocalAgentSshd {
    fn drop(&mut self) {
        // The test may have just disconnected its agent (#3831).
        self.stop_after_disconnect();
        self.reap_orphans();
        // Reap any setsid'd session daemon a continuity sever spared — by the
        // exact PID captured while it was a live descendant, never a name
        // pattern (which could hit a parallel checkout's daemon) (#2580).
        if let Ok(pids) = self.daemon_pids.lock() {
            reap_session_daemons(&pids, &self.agent_comm);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Trust every host key for the duration of the test (process-wide, set-once).
///
/// The desktop SSH path is strict known_hosts-only by default; a throwaway
/// sshd on an unknown host would otherwise block the connect pre-auth. This
/// mirrors the sftp integration test's `trust_fixture_host_keys()` and, unlike
/// seeding `~/.ssh/known_hosts`, mutates no shared on-disk state.
fn trust_all_host_keys() {
    use termihub_core::backends::ssh::host_key::{
        set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
    };
    struct TrustAll;
    #[async_trait::async_trait]
    impl HostKeyVerifier for TrustAll {
        async fn verify(&self, _info: &HostKeyInfo) -> bool {
            true
        }
    }
    let _ = set_host_key_verifier(Arc::new(TrustAll));
}

/// Create a shell session over `channel`, attach, echo a unique marker, and
/// assert the marker comes back — i.e. the session is usable end to end.
async fn create_and_verify_usable(
    channel: &mut russh::Channel<russh::client::Msg>,
    request_id: &mut u64,
    marker: &str,
    deadline: Instant,
) -> String {
    let created = channel_rpc(
        channel,
        request_id,
        "connection.create",
        serde_json::json!({ "type": "shell", "title": marker }),
    )
    .await
    .unwrap_or_else(|e| panic!("connection.create failed for {marker}: {e}"));
    let sid = created["session_id"]
        .as_str()
        .unwrap_or_else(|| panic!("create response missing session_id: {created}"))
        .to_string();

    channel_rpc(
        channel,
        request_id,
        "connection.attach",
        serde_json::json!({ "session_id": sid }),
    )
    .await
    .unwrap_or_else(|e| panic!("connection.attach failed for {marker}: {e}"));

    // `connection.write` is fire-and-forget (no response); send it directly.
    *request_id += 1;
    let encoded = B64.encode(format!("echo {marker}\n").as_bytes());
    let write_line = serialize_request(
        *request_id,
        "connection.write",
        serde_json::json!({ "session_id": sid, "data": encoded }),
    )
    .expect("serialize write");
    channel
        .data(write_line.as_bytes())
        .await
        .expect("write session input");

    assert!(
        wait_for_output(channel, marker, deadline).await,
        "session '{marker}' never echoed its marker — created but unusable \
             (the live 'stuck Reconnecting' symptom)"
    );
    sid
}

/// The definitive last-layer test: after a real russh transport drop and the
/// sshd's return, [`reconnect_agent`] must re-establish the real transport and
/// a fresh `connection.create` over it must yield a usable session — the exact
/// recovery that failed live (#2476 / #2480).
///
/// A stall at this layer FAILS the test (bounded by [`RECOVERY_CEILING`])
/// rather than hanging a display-backed run. A pass proves the desktop
/// reconnect *logic* is correct headlessly at every layer, pinning the live
/// failure on the webview occlusion throttle (#957 / #2460).
///
/// Requires `cargo build -p termihub-agent` and a local `sshd`; skips
/// gracefully otherwise (mirrors the Docker sftp integration test).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconnect_agent_reestablishes_russh_transport_and_drives_fresh_create() {
    let Some((sshd, agent_bin)) = require_sshd_and_agent() else {
        return;
    };

    trust_all_host_keys();

    let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
    sshd.start();

    let config = sshd.agent_config();
    let settings = AgentSettings::default();
    let alive = AgentAlive::new();
    let mut request_id = 0u64;

    // ── Initial establish: connect over russh, exec the agent, initialize.
    // `reconnect_agent` performs the full establishment, so it doubles as the
    // "before" connect here.
    let (session, mut channel, _buffered, _token_path, _capabilities) =
        reconnect_agent(&config, &settings, &mut request_id, &alive)
            .await
            .expect("initial agent establishment over local sshd failed");

    // Pre-drop: a live, usable session (models the maintainer's connected tab).
    let deadline = Instant::now() + RECOVERY_CEILING;
    let _pre_sid =
        create_and_verify_usable(&mut channel, &mut request_id, "pre-drop-marker", deadline).await;

    // ── Real server-side transport drop: kill the sshd tree. The established
    // russh channel must go down (EOF), proving this is a genuine transport
    // loss, not just a closed listener.
    sshd.stop();
    let old_channel_closed = {
        let close_deadline = Instant::now() + Duration::from_secs(10);
        let mut buf = LineSplitter::new();
        loop {
            if Instant::now() >= close_deadline {
                break false;
            }
            match tokio::time::timeout(
                Duration::from_millis(500),
                read_handshake_line(&mut channel, "test-agent", &mut buf),
            )
            .await
            {
                Ok(Err(_)) => break true, // channel closed — transport is down
                Ok(Ok(_)) => continue,    // drain any buffered line
                Err(_) => continue,       // read timeout — keep polling
            }
        }
    };
    assert!(
        old_channel_closed,
        "the established russh channel did not close after the sshd was killed — \
             the drop was not a real transport loss"
    );
    // Drop the dead session/channel explicitly before re-establishing.
    drop(channel);
    drop(session);

    // ── Restore the transport (same host key/config/port).
    sshd.start();

    // ── The layer under test: reconnect_agent must re-establish the real
    // russh transport now that the sshd is back, within the recovery ceiling.
    let reconnect_started = Instant::now();
    let reconnected = reconnect_agent(&config, &settings, &mut request_id, &alive).await;
    let reconnect_elapsed = reconnect_started.elapsed();
    let (session2, mut channel2, _buffered2, _token_path, _capabilities2) = reconnected
        .unwrap_or_else(|e| {
            panic!(
                "reconnect_agent failed to re-establish the russh transport after the sshd \
                 returned (elapsed {reconnect_elapsed:?}): {e}"
            )
        });
    assert!(
        reconnect_elapsed < RECONNECT_SETTLE_CEILING,
        "reconnect_agent took {reconnect_elapsed:?}, over the \
             {RECONNECT_SETTLE_CEILING:?} settle ceiling — the fresh agent's startup \
             session recovery is stalling initialize again (the dead-but-lingering \
             daemon-socket 30s connect-timeout regression, #2476)"
    );

    // ── The redrive drives a FRESH create over the re-established transport;
    // the new session must be usable — the exact recovery that failed live.
    let recover_deadline = Instant::now() + RECOVERY_CEILING;
    let _post_sid = create_and_verify_usable(
        &mut channel2,
        &mut request_id,
        "post-reconnect-marker",
        recover_deadline,
    )
    .await;

    // Record the fresh-create daemon while it is still a live descendant:
    // dropping the transport below makes the `--stdio` agent exit, which
    // reparents the setsid'd daemon to init and out of the sshd subtree
    // `stop()` kills — so only an exact-PID reap in `Drop` reaches it (#2580).
    sshd.record_session_daemons();

    // Explicit teardown so the sshd tree (and the agent it spawned) are gone
    // before the temp dir is removed.
    drop(channel2);
    drop(session2);
    sshd.stop_after_disconnect();
}

/// The #2512 continuity invariant over a REAL SSH transport, headless: a
/// daemon-backed session's running process survives a genuine transport drop and
/// is CONTINUED — same session id, same live process — after the backend
/// re-establishes the transport. It must not restart (counter back to 0) or pause
/// (counter unchanged). This is the automated form of the reconnect grade's
/// headline check — now also driven end-to-end through the UI by the
/// `test_agent_reconnect_ui.py` bridge system-test (#2574), which retired the
/// manual `verify-agent-reconnect.sh` operator harness.
///
/// Distinct from `..._drives_fresh_create` above: that kills the whole sshd tree,
/// taking the setsid'd daemon with it (#2508/#995), so it can only prove
/// *fresh-create* recovery. This severs the transport with `stop_sparing_daemon`
/// — killing only the sshd master + handlers — so the daemon and its running
/// process live through the outage and can be re-attached to.
///
/// Requires `cargo build -p termihub-agent` and a local `sshd`; skips gracefully
/// otherwise (mirrors the fresh-create test and the Docker sftp integration test).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconnect_reattaches_same_daemon_session_and_process_keeps_running() {
    let Some((sshd, agent_bin)) = require_sshd_and_agent() else {
        return;
    };

    trust_all_host_keys();

    let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
    sshd.start();

    let config = sshd.agent_config();
    let settings = AgentSettings::default();
    let alive = AgentAlive::new();
    let mut request_id = 0u64;

    // ── Establish, create a DAEMON-BACKED session ("local" is persistent, so the
    // agent runs it in a setsid'd daemon subprocess), attach, and start a
    // self-incrementing counter in it.
    let (session, mut channel, _buffered, _token_path, _) =
        reconnect_agent(&config, &settings, &mut request_id, &alive)
            .await
            .expect("initial agent establishment over local sshd failed");

    let created = channel_rpc(
        &mut channel,
        &mut request_id,
        "connection.create",
        serde_json::json!({ "type": "local", "title": "continuity", "config": {} }),
    )
    .await
    .expect("connection.create (persistent local shell) failed");
    let sid = created["session_id"]
        .as_str()
        .unwrap_or_else(|| panic!("create response missing session_id: {created}"))
        .to_string();

    channel_rpc(
        &mut channel,
        &mut request_id,
        "connection.attach",
        serde_json::json!({ "session_id": sid }),
    )
    .await
    .expect("initial attach failed");

    // Fire-and-forget: a 5 Hz counter that never stops (echoes `TICK=<n>`).
    request_id += 1;
    let counter_cmd = "i=0; while true; do echo TICK=$i; i=$((i+1)); sleep 0.2; done\n";
    let write_line = serialize_request(
        request_id,
        "connection.write",
        serde_json::json!({ "session_id": sid, "data": B64.encode(counter_cmd.as_bytes()) }),
    )
    .expect("serialize write");
    channel
        .data(write_line.as_bytes())
        .await
        .expect("write counter command");

    let before = read_counter_until(&mut channel, |m| m >= 3, Instant::now() + RECOVERY_CEILING)
        .await
        .expect("counter never produced TICK values before the drop");
    assert!(
        before >= 3,
        "counter not clearly running before drop: {before}"
    );

    // ── Real transport drop, SPARING the daemon: the established russh channel
    // must go down (genuine transport loss), but the daemon keeps the counter
    // running with nobody attached.
    sshd.stop_sparing_daemon();
    let channel_closed = {
        let close_deadline = Instant::now() + Duration::from_secs(10);
        let mut buf = LineSplitter::new();
        loop {
            if Instant::now() >= close_deadline {
                break false;
            }
            match tokio::time::timeout(
                Duration::from_millis(500),
                read_handshake_line(&mut channel, "test-agent", &mut buf),
            )
            .await
            {
                Ok(Err(_)) => break true, // channel closed — transport is down
                Ok(Ok(_)) => continue,    // drain any buffered line
                Err(_) => continue,       // read timeout — keep polling
            }
        }
    };
    assert!(
        channel_closed,
        "the russh channel did not close after stop_sparing_daemon — the transport \
             drop was not real"
    );
    drop(channel);
    drop(session);

    // Disconnected gap: no agent attached, but the daemon's counter keeps ticking.
    std::thread::sleep(Duration::from_millis(1500));

    // ── Restore + reconnect: the fresh `--stdio` agent's startup recovery
    // re-adopts the surviving daemon session.
    sshd.start();
    let (session2, mut channel2, _buffered2, _token_path, _) =
        reconnect_agent(&config, &settings, &mut request_id, &alive)
            .await
            .expect("reconnect_agent failed to re-establish the russh transport");

    // Same-session recovery: the SAME id must reappear (not a fresh one).
    let list = channel_rpc(
        &mut channel2,
        &mut request_id,
        "connection.list",
        serde_json::json!({}),
    )
    .await
    .expect("connection.list after reconnect failed");
    let recovered = list["sessions"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .any(|s| s["session_id"].as_str() == Some(sid.as_str()))
        })
        .unwrap_or(false);
    assert!(
        recovered,
        "daemon session {sid} was not recovered after reconnect (a fresh shell, not the \
             continued one) — list: {list}"
    );

    // Re-attach to the SAME id — never a fresh create.
    channel_rpc(
        &mut channel2,
        &mut request_id,
        "connection.attach",
        serde_json::json!({ "session_id": sid }),
    )
    .await
    .unwrap_or_else(|e| panic!("re-attach to the same session {sid} failed: {e}"));

    // Continuity: the replay must carry a counter value strictly BEYOND the
    // pre-drop one — the loop neither reset to 0 (restart) nor stalled (pause)
    // across the outage.
    let after_gap = read_counter_until(
        &mut channel2,
        |m| m > before,
        Instant::now() + RECOVERY_CEILING,
    )
    .await
    .expect("no counter output after reconnect — the live session did not survive");
    assert!(
        after_gap > before,
        "counter did not advance across the outage: before={before}, after={after_gap} \
             — the process paused or restarted (not the same live session)"
    );

    // Live continuation: after draining the replay to the current head, a further
    // strictly-greater value can come only from the still-running loop.
    let base = read_counter_until(
        &mut channel2,
        |_| false,
        Instant::now() + Duration::from_millis(800),
    )
    .await
    .unwrap_or(after_gap);
    let after_live = read_counter_until(
        &mut channel2,
        |m| m > base,
        Instant::now() + RECOVERY_CEILING,
    )
    .await
    .expect("counter stopped advancing after reconnect");
    assert!(
        after_live > base,
        "counter stopped after reconnect: base={base}, after_live={after_live} \
             — the recovered session is not live"
    );

    // Clean up the (setsid'd) daemon explicitly — teardown's sshd kill can't
    // reach it — then tear the transport down.
    let _ = channel_rpc(
        &mut channel2,
        &mut request_id,
        "connection.close",
        serde_json::json!({ "session_id": sid }),
    )
    .await;
    sshd.wait_for_closed_daemon(&sid);
    drop(channel2);
    drop(session2);
    sshd.stop_after_disconnect();
}

/// #2573: the SAME continuity invariant as above, but the transport is severed
/// with the **deterministic in-process primitive** ([`test_sever_desktop_transport`])
/// instead of `stop_sparing_daemon`'s process-title-matched sshd kill.
///
/// This is the exact sever the shipped path runs: `agent_io_task`'s
/// `TestSeverTransport` command (reached via
/// [`AgentConnectionManager::test_sever_transport`] and the test-bridge-gated
/// `test_sever_agent_transport`) drops the desktop russh transport through this
/// same helper. Dropping the channel + session closes the client socket, so the
/// sshd handler + `--stdio` agent see an abrupt EOF and exit while the setsid'd
/// session daemon survives — no `lsof`, no comm-matching, no root, no sshd
/// restart (the master keeps listening). The surviving daemon session must then
/// re-attach with its process CONTINUED (counter strictly beyond the pre-drop
/// value — neither reset to 0 nor stalled).
///
/// Requires `cargo build -p termihub-agent` and a local `sshd`; skips otherwise.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn in_process_sever_reattaches_same_daemon_session_and_process_keeps_running() {
    let Some((sshd, agent_bin)) = require_sshd_and_agent() else {
        return;
    };

    trust_all_host_keys();

    let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
    sshd.start();

    let config = sshd.agent_config();
    let settings = AgentSettings::default();
    let alive = AgentAlive::new();
    let mut request_id = 0u64;

    // Establish + a daemon-backed persistent session running a counter.
    let (session, mut channel, _buffered, _token_path, _) =
        reconnect_agent(&config, &settings, &mut request_id, &alive)
            .await
            .expect("initial agent establishment over local sshd failed");

    let created = channel_rpc(
        &mut channel,
        &mut request_id,
        "connection.create",
        serde_json::json!({ "type": "local", "title": "continuity", "config": {} }),
    )
    .await
    .expect("connection.create (persistent local shell) failed");
    let sid = created["session_id"]
        .as_str()
        .unwrap_or_else(|| panic!("create response missing session_id: {created}"))
        .to_string();

    channel_rpc(
        &mut channel,
        &mut request_id,
        "connection.attach",
        serde_json::json!({ "session_id": sid }),
    )
    .await
    .expect("initial attach failed");

    request_id += 1;
    let counter_cmd = "i=0; while true; do echo TICK=$i; i=$((i+1)); sleep 0.2; done\n";
    let write_line = serialize_request(
        request_id,
        "connection.write",
        serde_json::json!({ "session_id": sid, "data": B64.encode(counter_cmd.as_bytes()) }),
    )
    .expect("serialize write");
    channel
        .data(write_line.as_bytes())
        .await
        .expect("write counter command");

    let before = read_counter_until(&mut channel, |m| m >= 3, Instant::now() + RECOVERY_CEILING)
        .await
        .expect("counter never produced TICK values before the sever");
    assert!(
        before >= 3,
        "counter not clearly running before the sever: {before}"
    );

    // ── THE SEVER UNDER TEST: deterministic, in-process, sshd untouched.
    // Dropping the desktop transport closes the client socket abruptly; the
    // established russh channel is gone (we consumed it), and the peer's sshd
    // handler sees the EOF. The setsid'd daemon keeps the counter running.
    assert!(
        is_listening(sshd.port),
        "sshd must stay up across an in-process sever — no kill, no restart"
    );
    // Record the spared daemon NOW, while it is still a live descendant — the
    // in-process sever below reparents it beyond `stop()`'s subtree reach, so
    // teardown must reap it by exact PID (#2580).
    sshd.record_session_daemons();
    test_sever_desktop_transport(channel, Some(session));
    // The daemon keeps ticking with nobody attached.
    std::thread::sleep(Duration::from_millis(1500));
    assert!(
        is_listening(sshd.port),
        "the in-process sever must not touch the sshd — it is still listening"
    );

    // ── Reconnect over the still-listening sshd; the fresh `--stdio` agent's
    // startup recovery re-adopts the surviving daemon session.
    let (session2, mut channel2, _buffered2, _token_path, _) =
        reconnect_agent(&config, &settings, &mut request_id, &alive)
            .await
            .expect("reconnect_agent failed to re-establish after the in-process sever");

    // Same-session recovery: the SAME id must reappear (never a fresh create).
    let list = channel_rpc(
        &mut channel2,
        &mut request_id,
        "connection.list",
        serde_json::json!({}),
    )
    .await
    .expect("connection.list after reconnect failed");
    let recovered = list["sessions"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .any(|s| s["session_id"].as_str() == Some(sid.as_str()))
        })
        .unwrap_or(false);
    assert!(
        recovered,
        "daemon session {sid} was not recovered after the in-process sever \
             (a fresh shell, not the continued one) — list: {list}"
    );

    channel_rpc(
        &mut channel2,
        &mut request_id,
        "connection.attach",
        serde_json::json!({ "session_id": sid }),
    )
    .await
    .unwrap_or_else(|e| panic!("re-attach to the same session {sid} failed: {e}"));

    // Continuity: a counter value strictly BEYOND the pre-drop one — neither a
    // restart (back to 0) nor a stall (unchanged) across the outage.
    let after_gap = read_counter_until(
        &mut channel2,
        |m| m > before,
        Instant::now() + RECOVERY_CEILING,
    )
    .await
    .expect("no counter output after the in-process sever — the live session did not survive");
    assert!(
        after_gap > before,
        "counter did not advance across the in-process sever: before={before}, \
             after={after_gap} — the process paused or restarted (not the same live session)"
    );

    // Live continuation past the drained replay head can only come from the
    // still-running loop.
    let base = read_counter_until(
        &mut channel2,
        |_| false,
        Instant::now() + Duration::from_millis(800),
    )
    .await
    .unwrap_or(after_gap);
    let after_live = read_counter_until(
        &mut channel2,
        |m| m > base,
        Instant::now() + RECOVERY_CEILING,
    )
    .await
    .expect("counter stopped advancing after the in-process sever");
    assert!(
        after_live > base,
        "counter stopped after reconnect: base={base}, after_live={after_live} \
             — the recovered session is not live"
    );

    let _ = channel_rpc(
        &mut channel2,
        &mut request_id,
        "connection.close",
        serde_json::json!({ "session_id": sid }),
    )
    .await;
    sshd.wait_for_closed_daemon(&sid);
    drop(channel2);
    drop(session2);
    sshd.stop_after_disconnect();
}

/// #2573: a PERMANENT transport loss (endpoint gone) after an in-process sever
/// settles distinctly from a user-cancel.
///
/// After severing in-process and taking the sshd fully down, `reconnect_agent`
/// must **park** — keep retrying with backoff — never reporting a spurious
/// success against the dead endpoint (bounded so the test cannot hang). A
/// user-cancel (`alive = false`) is the DISTINCT settle: the next attempt
/// returns promptly with the stop signal, not an `Ok`. Together these pin the
/// two terminal outcomes the reconnect grade must tell apart.
///
/// Requires `cargo build -p termihub-agent` and a local `sshd`; skips otherwise.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn permanent_transport_loss_parks_distinct_from_user_cancel() {
    let Some((sshd, agent_bin)) = require_sshd_and_agent() else {
        return;
    };

    trust_all_host_keys();

    let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
    sshd.start();

    let config = sshd.agent_config();
    let settings = AgentSettings::default();
    let alive = AgentAlive::new();
    let mut request_id = 0u64;

    let (session, channel, _buffered, _token_path, _) =
        reconnect_agent(&config, &settings, &mut request_id, &alive)
            .await
            .expect("initial agent establishment over local sshd failed");

    // In-process sever, then take the endpoint permanently down.
    test_sever_desktop_transport(channel, Some(session));
    sshd.stop();
    let deadline = Instant::now() + Duration::from_secs(10);
    while is_listening(sshd.port) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !is_listening(sshd.port),
        "the endpoint must be fully down for the permanent-loss path"
    );

    // Permanent loss → PARK: reconnect keeps retrying, never settling early.
    // Bounded by a timeout so a regression to a false Ok/early-Err trips here.
    // (The `Ok` transport holds a russh handle that is not `Debug`, so match
    // rather than assert-format.)
    match tokio::time::timeout(
        Duration::from_secs(6),
        reconnect_agent(&config, &settings, &mut request_id, &alive),
    )
    .await
    {
        Err(_elapsed) => {} // still retrying when the window elapsed → parked
        Ok(Ok(_)) => {
            panic!("reconnect to a permanently-dead endpoint falsely reported success")
        }
        Ok(Err(e)) => {
            panic!("reconnect settled early on a permanent loss instead of parking: {e}")
        }
    }

    // User-cancel is the DISTINCT settle: with alive=false the next attempt
    // returns promptly with the stop signal — never a spurious Ok.
    alive.stop();
    match reconnect_agent(&config, &settings, &mut request_id, &alive).await {
        Err(e) => assert!(
            e.contains("stopped by user"),
            "a user-cancel must settle with the stop signal, got: {e}"
        ),
        Ok(_) => panic!("a user-cancel must not report a spurious reconnect success"),
    }
}

// ── #2576: the FULL shipped path — command → I/O task → reconnect — driven
// through the runtime-generic `AgentConnectionManager` against a headless
// `tauri::test::mock_app()` (`MockRuntime`), over a real loopback sshd + real
// `termihub-agent`. The tests above drive `reconnect_agent` in isolation; these
// drive the actual manager + `agent_io_task`, so the `TestSeverTransport` arm
// (flag → eager drop → reconnect) and the region folds it emits on `MockRuntime`
// get end-to-end coverage that `Wry`-only wiring could never exercise headlessly.

use crate::agents_projection::store::AgentsStore;
use crate::commands::projection::ProjectionState;
use crate::session_projection::projection::{publish_sessions, SESSION_LIFECYCLE_REGION};
use crate::session_projection::store::{SessionLifecycleStore, SessionStatus};
use crate::session_projection::timer::{ReconnectScheduler, ReconnectTimerDriver};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use termihub_core::connection::ConnectionTypeRegistry;

/// A [`ReconnectScheduler`] that records the tabs it was asked to arm, so a test
/// can assert the transient-break fold does NOT arm the backend redrive (#2556).
///
/// The timer driver calls `schedule` or `cancel` after every server-side
/// lifecycle fold, so when built with [`observing`](Self::observing) it also
/// records the tab's status at each of those calls: an ordered history of every
/// fold, which a test reads instead of polling for a transient state it could
/// miss under load (#3129). `ever_armed` likewise keeps a tab that was armed
/// and later cancelled.
#[derive(Default)]
struct RecordingScheduler {
    armed: std::sync::Mutex<std::collections::HashMap<String, Box<dyn FnOnce() + Send>>>,
    ever_armed: std::sync::Mutex<std::collections::HashSet<String>>,
    observed: Option<Arc<SessionLifecycleStore>>,
    history: std::sync::Mutex<Vec<(String, Option<SessionStatus>)>>,
}
impl RecordingScheduler {
    fn observing(store: Arc<SessionLifecycleStore>) -> Self {
        Self {
            observed: Some(store),
            ..Self::default()
        }
    }
    fn record(&self, key: &str) {
        if let Some(store) = &self.observed {
            let status = store.get(key).map(|s| s.status);
            self.history
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push((key.to_string(), status));
        }
    }
    /// Whether `key` was armed at any point, even if later cancelled.
    fn was_ever_armed(&self, key: &str) -> bool {
        self.ever_armed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(key)
    }
    /// Every status `key` was folded to, in fold order.
    fn statuses(&self, key: &str) -> Vec<SessionStatus> {
        self.history
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|(k, _)| k == key)
            .filter_map(|(_, status)| *status)
            .collect()
    }
}
impl ReconnectScheduler for RecordingScheduler {
    fn schedule(&self, key: String, _delay_ms: u64, task: Box<dyn FnOnce() + Send>) {
        self.record(&key);
        self.ever_armed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.clone());
        self.armed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key, task);
    }
    fn cancel(&self, key: &str) {
        self.record(key);
        self.armed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(key);
    }
}

/// Every `agent-state-change` state emitted for one agent, in emission order
/// (#3129). `emit_agent_state_with_error` folds the `agents` region and emits
/// this event for each transition, so the log is the full transition history.
/// Tests wait on it rather than polling the store, which can miss a transient
/// `Reconnecting` when the poller is descheduled on a loaded runner.
#[derive(Clone, Default)]
struct AgentStateLog(Arc<(std::sync::Mutex<Vec<String>>, std::sync::Condvar)>);

impl AgentStateLog {
    /// Start recording `agent_id`'s transitions on `handle`.
    fn attach<R: tauri::Runtime>(handle: &tauri::AppHandle<R>, agent_id: &str) -> Self {
        use tauri::Listener;
        let log = Self::default();
        let (sink, agent_id) = (log.clone(), agent_id.to_string());
        handle.listen_any("agent-state-change", move |event| {
            let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
                return;
            };
            if payload["session_id"].as_str() != Some(agent_id.as_str()) {
                return;
            }
            if let Some(state) = payload["state"].as_str() {
                let (states, changed) = &*sink.0;
                states
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(state.to_string());
                changed.notify_all();
            }
        });
        log
    }

    /// The states recorded so far.
    fn states(&self) -> Vec<String> {
        self.0
             .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Block until `done` holds for the recorded states, or `deadline` passes.
    /// Returns whether it held.
    fn wait_until(&self, deadline: Instant, done: impl Fn(&[String]) -> bool) -> bool {
        let (states, changed) = &*self.0;
        let mut guard = states
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if done(&guard) {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            guard = changed
                .wait_timeout(guard, deadline - now)
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .0;
        }
    }
}

/// Whether `states` holds `first` and, later, `then`.
fn saw_in_order(states: &[String], first: &str, then: &str) -> bool {
    states
        .iter()
        .position(|s| s == first)
        .is_some_and(|i| states[i + 1..].iter().any(|s| s == then))
}

/// Poll `probe` every 25ms on the current (blocking) thread until it yields
/// `Some`, or `deadline` elapses.
fn poll_blocking<T>(deadline: Instant, mut probe: impl FnMut() -> Option<T>) -> Option<T> {
    loop {
        if let Some(v) = probe() {
            return Some(v);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Track the highest `TICK=<n>` counter value seen on a session's decoded output
/// stream (the raw bytes the I/O task pushes to an [`OutputSender`]) until `want`
/// is satisfied or `deadline` elapses. Mirrors `read_counter_until`'s parser, but
/// reads the manager's `std::sync::mpsc` output channel instead of a raw channel.
fn read_counter_rx(
    rx: &Receiver<Vec<u8>>,
    want: impl Fn(u64) -> bool,
    deadline: Instant,
) -> Option<u64> {
    let mut max: Option<u64> = None;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => {
                let text = String::from_utf8_lossy(&chunk);
                for tail in text.split("TICK=").skip(1) {
                    let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if let Ok(v) = digits.parse::<u64>() {
                        max = Some(max.map_or(v, |m| m.max(v)));
                    }
                }
                if let Some(m) = max {
                    if want(m) {
                        return Some(m);
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    max.filter(|m| want(*m))
}

/// Everything the headless driver thread observed while driving the real
/// command → task → reconnect flow, asserted on the async test body.
struct SeverObservations {
    sever_accepted: bool,
    before: u64,
    after: u64,
    saw_agents_reconnecting: bool,
    saw_tab_reconnecting: bool,
    armed_during_reconnect: bool,
    agents_reconnected: bool,
    tab_resolved_connected: bool,
    sshd_listening_after_sever: bool,
    hosted_reattached: bool,
    cont_unattached_before_reattach: bool,
}

/// #2576: the real `AgentConnectionManager::test_sever_transport` →
/// `AgentIoCommand::TestSeverTransport` → `agent_io_task` reconnect path, driven
/// end-to-end against a `MockRuntime` app + a real sshd/agent, headlessly.
///
/// Unlike the `in_process_sever_*` tests above (which call
/// [`test_sever_desktop_transport`] + `reconnect_agent` directly), this exercises
/// the SHIPPED path: a live manager spawns the real I/O task, a
/// `test_sever_transport` command flows through it, and the task drives its own
/// reconnect while folding the projection regions on `MockRuntime`. It asserts:
///  * process continuity — a daemon-backed session's counter advances strictly
///    across the outage (same live process, re-attached through the manager);
///  * the `agents` region folds `Connected → Reconnecting → Connected` at the
///    task's own emission points (proving the runtime-generic emit path works);
///  * a resilient agent-hosted session's `session-lifecycle` region folds
///    `Reconnecting` on the transient break WITHOUT arming the redrive timer
///    (#2556), then resolves back to `Connected` when the agent recovers it;
///  * the sshd is never touched (deterministic in-process sever).
///
/// Requires `cargo build -p termihub-agent` and a local `sshd`; skips otherwise.
///
/// Was quarantined as flaky (#3129). Every recorded CI failure was the setup
/// connect reaching a stranger on the harness sshd's port, not the reconnect
/// itself; the harness now leases and verifies its port, and the transient
/// `Reconnecting` states are read from ordered transition logs, not polled.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn manager_test_sever_drives_reconnect_and_region_folds_headlessly() {
    let Some((sshd, agent_bin)) = require_sshd_and_agent() else {
        return;
    };

    trust_all_host_keys();

    let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
    sshd.start();
    let port = sshd.port;

    // ── Headless app + the managed state `lib.rs::setup()` wires for the folds.
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let agent_id = "agent-1".to_string();

    let agents_store = Arc::new(AgentsStore::new());
    // The entry is created client-side in production (it carries UI config the
    // backend never receives); the server folds live status into it.
    agents_store.add(
        &agent_id,
        "Test Agent",
        serde_json::json!({}),
        serde_json::json!({}),
    );
    handle.manage(agents_store.clone());
    let agent_states = AgentStateLog::attach(&handle, &agent_id);

    let lifecycle_store = Arc::new(SessionLifecycleStore::new());
    lifecycle_store.set_rand_for_test(Box::new(|| 0.0));
    handle.manage(lifecycle_store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SESSION_LIFECYCLE_REGION, lifecycle_store.snapshot());
    let projector = projection.projector.clone();
    let store_for_publish = lifecycle_store.clone();
    handle.manage(projection);

    let scheduler = Arc::new(RecordingScheduler::observing(lifecycle_store.clone()));
    let driver = Arc::new(ReconnectTimerDriver::new(
        lifecycle_store.clone(),
        scheduler.clone() as Arc<dyn ReconnectScheduler>,
        Arc::new(move || {
            publish_sessions(&projector, &store_for_publish);
        }),
    ));
    handle.manage(driver);

    // The runtime-generic manager, instantiated against `MockRuntime` — the whole
    // point of #2576. Its `AgentRpcClient` impl backs the `SessionManager` so an
    // agent-hosted session routes real RPC through this same manager.
    let manager = Arc::new(AgentConnectionManager::new(handle.clone()));
    let session_manager = SessionManager::new(
        ConnectionTypeRegistry::new(),
        manager.clone() as Arc<dyn AgentRpcClient>,
    );
    handle.manage(session_manager);

    let config = sshd.agent_config();
    let settings = AgentSettings::default();

    // ── Connect the real agent through the manager (spawns the real I/O task).
    // `connect_agent` blocks on the current runtime + spawns the task, so it must
    // run off the async worker.
    {
        let m = manager.clone();
        let cfg = config.clone();
        let st = settings.clone();
        let aid = agent_id.clone();
        tokio::task::spawn_blocking(move || m.connect_agent(&aid, &cfg, Some(&st)))
            .await
            .expect("connect_agent join")
            .expect("connect_agent over local sshd failed");
    }
    assert_eq!(
        agents_store.get(&agent_id).map(|a| a.connection_state),
        Some(AgentConnectionState::Connected),
        "the manager's connect must fold the agents region to Connected on MockRuntime"
    );

    // ── A resilient agent-hosted session, created through the real SessionManager
    // → RemoteProxy → this manager, so `fold_agent_hosted_reconnecting` has a real
    // hosted tab to fold on the sever. Settle its lifecycle entry Connected as the
    // frontend would after the initial connect.
    {
        let sm = handle.state::<SessionManager>();
        sm.create_connection(
            "local",
            serde_json::json!({}),
            Some(agent_id.as_str()),
            Some("tab-1:0"),
            false,
            true, // resilient
            handle.clone(),
        )
        .await
        .expect("create the agent-hosted session through the SessionManager");
    }
    lifecycle_store.connect("tab-1");
    lifecycle_store.connected("tab-1");
    assert_eq!(
        lifecycle_store.get("tab-1").map(|s| s.status),
        Some(SessionStatus::Connected),
        "the hosted tab starts settled Connected"
    );

    // ── Drive the sever + reconnect + continuity check on a blocking thread (the
    // manager's session RPC helpers block on a response internally).
    let obs = {
        let manager = manager.clone();
        let agents_store = agents_store.clone();
        let lifecycle_store = lifecycle_store.clone();
        let scheduler = scheduler.clone();
        let agent_id = agent_id.clone();
        // The sever runs on this blocking worker, which does not hold the
        // `sshd` handle — snapshot what it needs to record the spared daemons
        // for teardown (#2580).
        let daemon_sink = sshd.daemon_sink();
        let master_pid = sshd.master_pid();
        let agent_comm = sshd.agent_comm().to_string();
        tokio::task::spawn_blocking(move || {
            let deadline = Instant::now() + RECOVERY_CEILING;

            // A daemon-backed continuity session, observed DIRECTLY through the
            // manager's output channel (the hosted one's output goes to the event
            // emitter, which is not observable headlessly).
            let cont = manager
                .create_session(
                    &agent_id,
                    "local",
                    serde_json::json!({}),
                    Some("cont"),
                    None,
                )
                .expect("create continuity session");
            let cont_sid = cont.session_id;
            let (out_tx, out_rx) = std::sync::mpsc::channel::<Vec<u8>>();
            manager
                .register_session_output(&agent_id, &cont_sid, out_tx)
                .expect("register continuity output");
            manager
                .attach_session(&agent_id, &cont_sid)
                .expect("attach continuity session");
            let counter = "i=0; while true; do echo TICK=$i; i=$((i+1)); sleep 0.2; done\n";
            manager
                .send_session_input(&agent_id, &cont_sid, counter.as_bytes())
                .expect("write counter command");
            let before = read_counter_rx(&out_rx, |m| m >= 3, Instant::now() + RECOVERY_CEILING)
                .expect("counter never produced values before the sever");

            let sshd_up_before = is_listening(port);

            // Record the setsid'd session daemon(s) now, while the hosted +
            // continuity sessions' daemons are still live descendants of our
            // sshd — the in-process sever below reparents them beyond `stop()`'s
            // subtree reach, so teardown must reap them by exact PID (#2580).
            if let Some(root) = master_pid {
                record_daemons_into(&daemon_sink, root, &agent_comm);
            }

            // ── THE SHIPPED PATH UNDER TEST: command → task → reconnect.
            let sever_accepted = manager.test_sever_transport(&agent_id);

            // The real task folds the hosted tab, then the agents region,
            // Reconnecting BEFORE it re-establishes. Read both from the ordered
            // transition histories rather than polling the stores: a poller
            // descheduled on a loaded runner can miss the transient state
            // entirely (#3129).
            let saw_agents_reconnecting =
                agent_states.wait_until(deadline, |s| s.iter().any(|st| st == "reconnecting"));
            // The tab fold lands before the agents emit, so it is already recorded.
            let saw_tab_reconnecting = scheduler
                .statuses("tab-1")
                .contains(&SessionStatus::Reconnecting);

            let sshd_listening_after_sever = sshd_up_before && is_listening(port);

            // Wait for the real task to finish the reconnect (agents region back
            // to Connected after the Reconnecting fold).
            let agents_reconnected = agent_states
                .wait_until(deadline, |s| saw_in_order(s, "reconnecting", "connected"))
                && agents_store.get(&agent_id).map(|a| a.connection_state)
                    == Some(AgentConnectionState::Connected);

            // #4017: the fresh agent worker leaves orphaned sessions unattached
            // (#3369), so the task itself must re-attach the tab-hosted session —
            // otherwise its output never flows again. Read the holder state the
            // agent reports; the continuity session (hosted by no tab) is the
            // control and must stay unattached until re-attached below.
            let hosted_reattached = poll_blocking(deadline, || {
                let sessions = manager.list_sessions(&agent_id).ok()?;
                let hosted = sessions
                    .iter()
                    .find(|s| s.session_id != cont_sid)
                    .map(|s| s.attached)?;
                hosted.then_some(())
            })
            .is_some();
            let cont_unattached_before_reattach = manager
                .list_sessions(&agent_id)
                .ok()
                .and_then(|sessions| {
                    sessions
                        .iter()
                        .find(|s| s.session_id == cont_sid)
                        .map(|s| !s.attached)
                })
                .unwrap_or(false);

            // Re-attach the continuity session and prove the process CONTINUED —
            // a counter value strictly beyond the pre-drop one (neither reset to 0
            // nor stalled).
            manager
                .attach_session(&agent_id, &cont_sid)
                .expect("re-attach continuity session after reconnect");
            let after = read_counter_rx(&out_rx, |m| m > before, deadline).unwrap_or(0);

            // The task's post-reconnect resolve folds the recovered hosted tab back
            // to Connected.
            let tab_resolved_connected = poll_blocking(deadline, || {
                (lifecycle_store.get("tab-1").map(|s| s.status) == Some(SessionStatus::Connected))
                    .then_some(())
            })
            .is_some();

            let _ = manager.close_session(&agent_id, &cont_sid);
            wait_for_closed_session_daemon(&daemon_sink, &cont_sid, &agent_comm);

            // Armed at ANY point, not just while a poll happened to look: the
            // transient break is owned by the in-task loop (#2556).
            let armed_during_reconnect = scheduler.was_ever_armed("tab-1");

            SeverObservations {
                sever_accepted,
                before,
                after,
                saw_agents_reconnecting,
                saw_tab_reconnecting,
                armed_during_reconnect,
                agents_reconnected,
                tab_resolved_connected,
                sshd_listening_after_sever,
                hosted_reattached,
                cont_unattached_before_reattach,
            }
        })
        .await
        .expect("headless sever/reconnect driver thread panicked")
    };

    assert!(
        obs.sever_accepted,
        "test_sever_transport must accept the sever for a live agent"
    );
    assert!(
        obs.sshd_listening_after_sever,
        "the in-process sever must not touch the sshd — it must stay listening"
    );
    assert!(
        obs.saw_agents_reconnecting,
        "the real I/O task must fold the agents region to Reconnecting on the sever"
    );
    assert!(
        obs.saw_tab_reconnecting,
        "the real I/O task must fold the hosted tab's session-lifecycle region to Reconnecting"
    );
    assert!(
        !obs.armed_during_reconnect,
        "a transient in-task break must NOT arm the backend redrive timer (#2556)"
    );
    assert!(
        obs.agents_reconnected,
        "the real I/O task must drive the agents region back to Connected after reconnect"
    );
    assert!(
        obs.tab_resolved_connected,
        "the recovered hosted session must resolve back to Connected through the real task"
    );
    assert!(
        obs.hosted_reattached,
        "the real I/O task must re-attach the tab-hosted session the fresh agent worker left \
         unattached (#4017) — otherwise the tab shows Connected with frozen output"
    );
    assert!(
        obs.cont_unattached_before_reattach,
        "a session no tab hosts must not be adopted by the reconnect (#3369)"
    );
    assert!(
        obs.after > obs.before,
        "counter did not advance across the sever: before={}, after={} — the daemon \
             session did not survive with process continuity through the shipped path",
        obs.before,
        obs.after
    );

    sshd.stop();
    drop(app);
}

/// #2576: through the real manager + task, a PERMANENT transport loss PARKS
/// (keeps retrying, agent stays alive, region held Reconnecting) — distinct from
/// a user-cancel, which tears the agent down and settles the region Disconnected.
///
/// This pins the two terminal outcomes the reconnect grade must tell apart, on the
/// shipped command → task path rather than `reconnect_agent` in isolation.
///
/// Requires `cargo build -p termihub-agent` and a local `sshd`; skips otherwise.
///
/// Was quarantined on linux as flaky (#3129); see the test above for the cause.
/// The endpoint is also closed before the sever, so the first reconnect attempt
/// can never beat the teardown and turn the permanent drop into a reconnect.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn manager_user_cancel_settles_distinct_from_a_parked_permanent_drop() {
    let Some((sshd, agent_bin)) = require_sshd_and_agent() else {
        return;
    };

    trust_all_host_keys();

    let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
    sshd.start();

    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let agent_id = "agent-1".to_string();

    let agents_store = Arc::new(AgentsStore::new());
    agents_store.add(
        &agent_id,
        "Test Agent",
        serde_json::json!({}),
        serde_json::json!({}),
    );
    handle.manage(agents_store.clone());
    let agent_states = AgentStateLog::attach(&handle, &agent_id);

    let manager = Arc::new(AgentConnectionManager::new(handle.clone()));
    let config = sshd.agent_config();
    let settings = AgentSettings::default();

    {
        let m = manager.clone();
        let cfg = config.clone();
        let st = settings.clone();
        let aid = agent_id.clone();
        tokio::task::spawn_blocking(move || m.connect_agent(&aid, &cfg, Some(&st)))
            .await
            .expect("connect_agent join")
            .expect("connect_agent over local sshd failed");
    }
    assert_eq!(
        agents_store.get(&agent_id).map(|a| a.connection_state),
        Some(AgentConnectionState::Connected),
        "the manager's connect must fold the agents region to Connected"
    );

    let (reached_reconnecting, stayed_parked, still_alive_parked, settled_disconnected, torn_down) = {
        let manager = manager.clone();
        let agents_store = agents_store.clone();
        let agent_id = agent_id.clone();
        tokio::task::spawn_blocking(move || {
            // Take the endpoint permanently down FIRST, keeping the live
            // transport up, then sever it. The reverse order (sever, then
            // `stop()`) raced the task's first reconnect attempt against the
            // teardown and could reconnect before the endpoint was gone (#3129).
            sshd.close_listener();
            let severed = manager.test_sever_transport(&agent_id);
            assert!(severed, "sever must be accepted for a live agent");

            // PARK: the task folds Reconnecting and keeps retrying the dead
            // endpoint. Wait for that fold on the ordered transition log, then
            // hold for a window spanning several backoff attempts: the region
            // must never leave Reconnecting (no Disconnected, no Connected) and
            // the agent must stay alive (parked in its reconnect loop).
            let reached_reconnecting = agent_states
                .wait_until(Instant::now() + Duration::from_secs(10), |s| {
                    s.iter().any(|st| st == "reconnecting")
                });
            std::thread::sleep(Duration::from_secs(5));
            let parked_states = agent_states.states();
            let left_reconnecting = parked_states
                .iter()
                .skip_while(|st| *st != "reconnecting")
                .any(|st| st != "reconnecting");
            let still_alive_parked = manager.is_connected(&agent_id);

            // User-cancel is the DISTINCT settle: it tears the agent down and folds
            // the region Disconnected at once.
            manager
                .disconnect_agent(&agent_id)
                .expect("user disconnect of a live-but-parked agent");
            let settled_disconnected =
                agent_states.wait_until(Instant::now() + Duration::from_secs(5), |s| {
                    s.last().map(String::as_str) == Some("disconnected")
                }) && agents_store.get(&agent_id).map(|a| a.connection_state)
                    == Some(AgentConnectionState::Disconnected);
            let torn_down = !manager.is_connected(&agent_id);
            drop(sshd);

            (
                reached_reconnecting,
                !left_reconnecting,
                still_alive_parked,
                settled_disconnected,
                torn_down,
            )
        })
        .await
        .expect("permanent-drop driver thread panicked")
    };

    assert!(
        reached_reconnecting,
        "the real task must fold the agents region to Reconnecting on a transport loss"
    );
    assert!(
        stayed_parked,
        "a permanent drop must PARK (keep retrying), never settle Disconnected on its own"
    );
    assert!(
        still_alive_parked,
        "a parked agent must stay alive/connected while it retries — distinct from a cancel"
    );
    assert!(
        settled_disconnected,
        "a user-cancel must settle the agents region Disconnected"
    );
    assert!(
        torn_down,
        "a user-cancel must tear the agent down (is_connected == false) — the distinct settle"
    );

    drop(app);
}

/// Env var that turns [`sshd_guard_helper_process`] from a no-op into the
/// helper side of [`killed_test_process_takes_its_sshd_down`].
const SSHD_GUARD_HELPER_ENV: &str = "TERMIHUB_TEST_SSHD_GUARD_HELPER";

/// Helper half of the #3649 regression test, run in a child copy of this test
/// binary. It starts an sshd through the real harness, reports its PID, port and
/// temp dir on stdout, then parks until it is SIGKILLed — so its `Drop` never
/// runs, exactly like a killed test run. Without the env var (a normal suite
/// run) it returns at once. The park is bounded so an orphaned helper still
/// exits (and cleans up) on its own.
#[test]
fn sshd_guard_helper_process() {
    if std::env::var_os(SSHD_GUARD_HELPER_ENV).is_none() {
        return;
    }
    let sshd = find_sshd().expect("helper needs sshd");
    // Only sshd matters here; the agent path is never exec'd by this helper.
    let mut harness =
        LocalAgentSshd::new(sshd, PathBuf::from("/usr/bin/true")).expect("stand up sshd");
    harness.start();
    println!(
        "SSHD_GUARD_HELPER pid={} port={} dir={}",
        harness.master_pid().expect("sshd running"),
        harness.port,
        harness.dir.display()
    );
    use std::io::Write;
    let _ = std::io::stdout().flush();
    std::thread::sleep(Duration::from_secs(60));
}

/// Whether `pid` is alive and still names an sshd (so a reused PID never
/// counts, and is never killed by the cleanup below).
fn is_live_sshd(pid: u32) -> bool {
    comm_of(pid).contains("sshd")
}

/// Regression for #3649: a test process killed before `Drop` runs must not
/// leave its throwaway `sshd -D` listening. A helper copy of this test binary
/// starts an sshd through the harness; we SIGKILL the helper and assert the
/// sshd — which the helper never got to stop — exits, its port closes and its
/// temp dir is removed. Only PIDs this test spawned (the helper, and the sshd
/// it reported) are ever signalled. Skips when no `sshd` is installed.
#[test]
fn killed_test_process_takes_its_sshd_down() {
    use std::io::BufRead;

    if require_sshd().is_none() {
        return;
    }
    let exe = std::env::current_exe().expect("current test binary");
    // libtest filters on the path without the crate name.
    let module = module_path!()
        .split_once("::")
        .map(|(_, rest)| rest)
        .unwrap_or(module_path!());
    let mut helper = Command::new(exe)
        .arg(format!("{module}::sshd_guard_helper_process"))
        .args(["--exact", "--nocapture", "--test-threads=1"])
        .env(SSHD_GUARD_HELPER_ENV, "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn helper test process");

    // Read the helper's report on a thread so a wedged helper cannot hang us.
    let stdout = helper.stdout.take().expect("helper stdout");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            // libtest prints `test <name> ... ` without a newline first, so the
            // marker lands mid-line.
            if let Some((_, rest)) = line.split_once("SSHD_GUARD_HELPER ") {
                let _ = tx.send(rest.to_string());
                return;
            }
        }
    });
    let report = rx.recv_timeout(Duration::from_secs(30));
    // SIGKILL the helper before asserting anything, so it never outlives us.
    let _ = helper.kill();
    let _ = helper.wait();
    let report = report.expect("helper did not report its sshd in time");

    let field = |key: &str| -> String {
        report
            .split_whitespace()
            .find_map(|kv| kv.strip_prefix(&format!("{key}=")).map(str::to_string))
            .unwrap_or_else(|| panic!("helper report missing {key}: {report}"))
    };
    let pid: u32 = field("pid").parse().expect("sshd pid");
    let port: u16 = field("port").parse().expect("sshd port");
    let dir = PathBuf::from(field("dir"));

    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && (is_live_sshd(pid) || is_listening(port) || dir.exists()) {
        std::thread::sleep(Duration::from_millis(100));
    }
    let (alive, listening, dir_left) = (is_live_sshd(pid), is_listening(port), dir.exists());

    // Clean up whatever the guard missed before failing, so a regression does
    // not itself leak an sshd.
    if alive {
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(pid.to_string())
            .status();
    }
    if dir_left {
        let _ = std::fs::remove_dir_all(&dir);
    }
    assert!(
        !alive && !listening,
        "sshd {pid} outlived its killed test process (alive={alive}, listening={listening})"
    );
    assert!(
        !dir_left,
        "sshd harness temp dir {} was not removed",
        dir.display()
    );
}

// ── #3661: the reattach-config seam, end to end over a real sshd + agent ──
//
// A resilient agent tab's connect opts the agent's (expanded) transport config
// into the reap-surviving store; after the in-task loop reaps the transport, the
// redrive's `reconnect_retained_agent` cold-re-establishes it from that config
// instead of always folding `NoRetainedConfig`. The config carries `${VAR}` /
// quoted-path placeholders that only connect because the agent connect path now
// expands them.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resilient_agent_tab_retains_config_and_redrive_reestablishes_after_reap() {
    let Some((sshd, agent_bin)) = require_sshd_and_agent() else {
        return;
    };

    trust_all_host_keys();

    let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
    sshd.start();

    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let agent_id = "agent-3661".to_string();

    let agents_store = Arc::new(AgentsStore::new());
    agents_store.add(
        &agent_id,
        "Test Agent",
        serde_json::json!({}),
        serde_json::json!({}),
    );
    handle.manage(agents_store.clone());

    let manager = Arc::new(AgentConnectionManager::new(handle.clone()));
    let session_manager = SessionManager::new(
        ConnectionTypeRegistry::new(),
        manager.clone() as Arc<dyn AgentRpcClient>,
    );

    // Placeholders that only resolve through `RemoteAgentConfig::expand`: an
    // unset `${VAR}` expands to "" (so the host becomes `127.0.0.1`), and the
    // key path is wrapped in quotes that the expansion strips. Unexpanded, the
    // SSH connect would target a bogus host / unreadable key and fail. No
    // process-environment mutation is needed.
    let mut config = sshd.agent_config();
    config.host = format!("${{TERMIHUB_TEST_3661_UNSET_PLACEHOLDER}}{}", config.host);
    config.key_path = config.key_path.map(|p| format!("\"{p}\""));
    let settings = AgentSettings::default();

    {
        let m = manager.clone();
        let cfg = config.clone();
        let st = settings.clone();
        let aid = agent_id.clone();
        tokio::task::spawn_blocking(move || m.connect_agent(&aid, &cfg, Some(&st)))
            .await
            .expect("connect_agent join")
            .expect("connect_agent with placeholders must expand and connect");
    }
    assert!(manager.is_connected(&agent_id));
    assert!(
        !manager.has_retained_agent_config(&agent_id),
        "a bare agent connect (no resilient tab yet) retains nothing"
    );

    // A resilient agent tab connects → opts the agent config into the store.
    session_manager
        .create_connection(
            "local",
            serde_json::json!({}),
            Some(agent_id.as_str()),
            Some("tab-3661:0"),
            false,
            true, // resilient
            handle.clone(),
        )
        .await
        .expect("create the resilient agent-hosted session");
    assert!(
        manager.has_retained_agent_config(&agent_id),
        "a resilient agent tab's connect must retain the agent's reattach config"
    );
    sshd.record_session_daemons();

    // Simulate the in-task loop's reap: the map entry is removed and the I/O
    // task ends (the real `reap_agent` + task return), dropping the transport.
    {
        let reaped = manager
            .agents
            .lock()
            .unwrap()
            .remove(&agent_id)
            .expect("live entry to reap");
        reaped.io_task.abort();
    }
    assert!(!manager.is_connected(&agent_id));
    assert!(
        manager.has_retained_agent_config(&agent_id),
        "the retained config must survive the reap"
    );

    // The redrive's cold re-establish now finds the config and reconnects.
    {
        let m = manager.clone();
        let aid = agent_id.clone();
        tokio::task::spawn_blocking(move || m.reconnect_retained_agent(&aid))
            .await
            .expect("reconnect_retained_agent join")
            .expect("the retained config must re-establish the reaped transport");
    }
    assert!(
        manager.is_connected(&agent_id),
        "the reaped agent transport is re-established from the retained config"
    );

    // The last resilient tab releasing its request (give-up / tab close /
    // drop) scrubs the agent config.
    session_manager.clear_retained_request_with_agent_scrub("tab-3661");
    assert!(
        !manager.has_retained_agent_config(&agent_id),
        "the last resilient tab releasing its request scrubs the agent config"
    );

    sshd.record_session_daemons();
    let _ = manager.disconnect_agent(&agent_id);
    drop(app);
}

/// #3831: the profile path handed to sshd-launched agents is always absolute,
/// so an instrumented agent never resolves it against the session cwd (`$HOME`).
#[test]
fn agent_profile_file_is_always_absolute() {
    let cwd = Path::new("/work/checkout/src-tauri");
    let scratch = Path::new("/tmp/termihub-russh-reconnect-1-0");

    // cargo llvm-cov's own absolute value is forwarded unchanged.
    let absolute =
        std::ffi::OsStr::new("/work/checkout/target/llvm-cov-target/termihub-%p.profraw");
    assert_eq!(
        agent_profile_file(Some(absolute), cwd, scratch),
        PathBuf::from("/work/checkout/target/llvm-cov-target/termihub-%p.profraw")
    );

    // A relative value is anchored at the test process's cwd, not the session's.
    let relative = std::ffi::OsStr::new("cov/default_%p.profraw");
    assert_eq!(
        agent_profile_file(Some(relative), cwd, scratch),
        cwd.join("cov/default_%p.profraw")
    );

    // Unset or empty: the harness's temp dir, never the default `$HOME` fallback.
    for unset in [None, Some(std::ffi::OsStr::new(""))] {
        let path = agent_profile_file(unset, cwd, scratch);
        assert!(path.is_absolute(), "{path:?}");
        assert!(path.starts_with(scratch), "{path:?}");
    }
}

/// #3831: `SetEnv` tokens survive sshd's shell-style split.
#[test]
fn sshd_setenv_token_quotes_only_when_sshd_would_split() {
    assert_eq!(
        sshd_setenv_token("LLVM_PROFILE_FILE", "/a/b-%p.profraw"),
        "LLVM_PROFILE_FILE=/a/b-%p.profraw"
    );
    assert_eq!(
        sshd_setenv_token("LLVM_PROFILE_FILE", "/my dir/x\"y\\z"),
        "\"LLVM_PROFILE_FILE=/my dir/x\\\"y\\\\z\""
    );
}

/// #3831 guard: a session started through the harness's sshd actually carries
/// the absolute `LLVM_PROFILE_FILE` — `%p` pattern intact — so no instrumented
/// agent it launches writes `default_*.profraw` into `$HOME`. Uses the system
/// `ssh` client to print the session environment; skips without sshd/ssh.
#[test]
fn sshd_session_env_carries_the_absolute_profile_path() {
    let Some(sshd) = require_sshd() else {
        return;
    };
    let mut harness =
        LocalAgentSshd::new(sshd, PathBuf::from("/usr/bin/true")).expect("stand up sshd");
    harness.start();
    let output = match Command::new("ssh")
        .args(["-F", "/dev/null", "-o", "BatchMode=yes"])
        .args([
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
        ])
        .args([
            "-o",
            "LogLevel=ERROR",
            "-p",
            &harness.port.to_string(),
            "-i",
        ])
        .arg(&harness.client_key)
        .arg(format!("{}@127.0.0.1", harness.username))
        .arg(format!("printenv {LLVM_PROFILE_FILE_ENV}"))
        .stdin(Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(e) => {
            test_fixtures::missing(
                test_fixtures::REQUIRE_LOCAL_SSHD_ENV,
                &format!("no ssh client ({e})"),
                SSHD_HINT,
            );
            return;
        }
    };
    assert!(
        output.status.success(),
        "ssh printenv failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let forwarded = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // Exact match: sshd must not expand or strip `%p`-style patterns (#3831).
    assert_eq!(Path::new(&forwarded), harness.profile_file.as_path());
    assert!(Path::new(&forwarded).is_absolute(), "{forwarded}");
}

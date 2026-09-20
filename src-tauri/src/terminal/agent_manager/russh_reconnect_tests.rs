use super::*;
use base64::engine::general_purpose::STANDARD as B64;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

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

/// Grab a currently-free loopback TCP port (best-effort; the caller retries a
/// bind race by respawning on a new port).
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("bind ephemeral")
        .local_addr()
        .expect("local_addr")
        .port()
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
        if pid != root && is_session_leader(pid) && comm_of(pid) == agent_comm {
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
}

impl LocalAgentSshd {
    fn new(sshd: PathBuf, agent_bin: PathBuf) -> std::io::Result<Self> {
        let dir = std::env::temp_dir().join(format!(
            "termihub-russh-reconnect-{}-{}",
            std::process::id(),
            free_port()
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
        // never touches shared ADR-11 registry state (#2489).
        let config_body = [
            format!("Port {}", 0), // placeholder, rewritten per start
            "ListenAddress 127.0.0.1".to_string(),
            format!("HostKey {}", host_key.display()),
            format!("AuthorizedKeysFile {}.pub", client_key.display()),
            "UsePAM no".to_string(),
            "PasswordAuthentication no".to_string(),
            "PubkeyAuthentication yes".to_string(),
            "StrictModes no".to_string(),
            "LogLevel ERROR".to_string(),
            format!(
                "SetEnv TERMIHUB_REGISTRY_ENDPOINT={} XDG_CONFIG_HOME={}",
                registry_endpoint.display(),
                xdg.display()
            ),
            String::new(),
        ]
        .join("\n");
        // The port is fixed for the lifetime of the instance (drop/restore
        // must reuse it), so pick it now and write the final config.
        let port = free_port();
        let config_body = config_body.replacen("Port 0", &format!("Port {port}"), 1);
        std::fs::write(&config, config_body)?;

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
        })
    }

    /// Launch sshd (foreground `-D` so we own the tree) and wait until it
    /// accepts a TCP connection.
    fn start(&mut self) {
        assert!(self.child.is_none(), "already running");
        let child = Command::new(&self.sshd)
            .arg("-D")
            .arg("-f")
            .arg(&self.config)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sshd");
        self.child = Some(child);

        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if is_listening(self.port) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("sshd did not listen on 127.0.0.1:{} in time", self.port);
    }

    /// Kill the sshd tree (SIGKILL) — an abrupt server-side drop that severs
    /// the established agent connection, then wait for the port to close.
    fn stop(&mut self) {
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
        self.stop();
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

/// Drive a single JSON-RPC request over the raw agent channel and return its
/// matching response `result` (ignoring interleaved notifications). This is
/// the redrive's `connection.create`/`attach` path exercised over the real
/// re-established transport.
async fn channel_rpc(
    channel: &mut russh::Channel<russh::client::Msg>,
    request_id: &mut u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    *request_id += 1;
    let id = *request_id;
    let line = serialize_request(id, method, params)?;
    channel
        .data(line.as_bytes())
        .await
        .map_err(|e| format!("write {method}: {e}"))?;
    let mut buf = String::new();
    loop {
        let resp = read_handshake_line(channel, "test-agent", &mut buf)
            .await
            .ok_or_else(|| format!("channel closed before {method} response"))?;
        if resp.is_empty() {
            continue;
        }
        match jsonrpc::parse_message(&resp) {
            Ok(jsonrpc::JsonRpcMessage::Response { id: rid, result }) if rid == id => {
                return Ok(result)
            }
            Ok(jsonrpc::JsonRpcMessage::Error {
                id: rid, message, ..
            }) if rid == id => return Err(message),
            _ => continue,
        }
    }
}

/// Read `connection.output` notifications off the channel until one decodes to
/// text containing `needle`, or the deadline passes. Proves the session is
/// genuinely usable (input → PTY echo → notification), not merely created.
async fn wait_for_output(
    channel: &mut russh::Channel<russh::client::Msg>,
    needle: &str,
    deadline: Instant,
) -> bool {
    let mut buf = String::new();
    while Instant::now() < deadline {
        let read = tokio::time::timeout(
            Duration::from_millis(500),
            read_handshake_line(channel, "test-agent", &mut buf),
        )
        .await;
        match read {
            Ok(Some(line)) => {
                if line.is_empty() {
                    continue;
                }
                if let Ok(jsonrpc::JsonRpcMessage::Notification { method, params }) =
                    jsonrpc::parse_message(&line)
                {
                    if method == "connection.output" {
                        if let Some(data) = params["data"].as_str() {
                            if let Ok(bytes) = B64.decode(data) {
                                if String::from_utf8_lossy(&bytes).contains(needle) {
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
            Ok(None) => return false, // channel closed
            Err(_) => continue,       // read timeout — re-check the deadline
        }
    }
    false
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
    let Some(sshd) = find_sshd() else {
        eprintln!("SKIP: no sshd binary found — cannot stand up a local agent endpoint");
        return;
    };
    let Some(agent_bin) = find_agent_binary() else {
        eprintln!(
            "SKIP: termihub-agent binary not found — run `cargo build -p termihub-agent` \
                 (or set TERMIHUB_TEST_AGENT_BIN)"
        );
        return;
    };

    trust_all_host_keys();

    let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
    sshd.start();

    let config = sshd.agent_config();
    let settings = AgentSettings::default();
    let alive = Arc::new(AtomicBool::new(true));
    let mut request_id = 0u64;

    // ── Initial establish: connect over russh, exec the agent, initialize.
    // `reconnect_agent` performs the full establishment, so it doubles as the
    // "before" connect here.
    let (session, mut channel, _buffered) =
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
        let mut buf = String::new();
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
                Ok(None) => break true,  // channel closed — transport is down
                Ok(Some(_)) => continue, // drain any buffered line
                Err(_) => continue,      // read timeout — keep polling
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
    let (session2, mut channel2, _buffered2) = reconnected.unwrap_or_else(|e| {
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
    sshd.stop();
}

/// Read `connection.output` notifications off the channel, tracking the highest
/// `TICK=<n>` counter value seen, and return it once `want(max)` holds — else the
/// last-seen max (or `None`) at the deadline.
///
/// The counter loop prints `TICK=$i`; only *executed* output (`TICK=0`,
/// `TICK=1`, …) carries a digit, while the one-time keystroke echo of the
/// command line contains the literal `TICK=$i` (no digit) — so the echoed
/// command can never be mistaken for a counter value.
async fn read_counter_until(
    channel: &mut russh::Channel<russh::client::Msg>,
    want: impl Fn(u64) -> bool,
    deadline: Instant,
) -> Option<u64> {
    let mut buf = String::new();
    let mut max: Option<u64> = None;
    while Instant::now() < deadline {
        let read = tokio::time::timeout(
            Duration::from_millis(500),
            read_handshake_line(channel, "test-agent", &mut buf),
        )
        .await;
        match read {
            Ok(Some(line)) => {
                if line.is_empty() {
                    continue;
                }
                if let Ok(jsonrpc::JsonRpcMessage::Notification { method, params }) =
                    jsonrpc::parse_message(&line)
                {
                    if method == "connection.output" {
                        if let Some(data) = params["data"].as_str() {
                            if let Ok(bytes) = B64.decode(data) {
                                let text = String::from_utf8_lossy(&bytes);
                                for tail in text.split("TICK=").skip(1) {
                                    let digits: String =
                                        tail.chars().take_while(|c| c.is_ascii_digit()).collect();
                                    if let Ok(v) = digits.parse::<u64>() {
                                        max = Some(max.map_or(v, |m| m.max(v)));
                                    }
                                }
                            }
                        }
                    }
                }
                if let Some(m) = max {
                    if want(m) {
                        return Some(m);
                    }
                }
            }
            Ok(None) => return max, // channel closed
            Err(_) => continue,     // read timeout — re-check the deadline
        }
    }
    max
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
    let Some(sshd) = find_sshd() else {
        eprintln!("SKIP: no sshd binary found — cannot stand up a local agent endpoint");
        return;
    };
    let Some(agent_bin) = find_agent_binary() else {
        eprintln!(
            "SKIP: termihub-agent binary not found — run `cargo build -p termihub-agent` \
                 (or set TERMIHUB_TEST_AGENT_BIN)"
        );
        return;
    };

    trust_all_host_keys();

    let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
    sshd.start();

    let config = sshd.agent_config();
    let settings = AgentSettings::default();
    let alive = Arc::new(AtomicBool::new(true));
    let mut request_id = 0u64;

    // ── Establish, create a DAEMON-BACKED session ("local" is persistent, so the
    // agent runs it in a setsid'd daemon subprocess), attach, and start a
    // self-incrementing counter in it.
    let (session, mut channel, _buffered) =
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
        let mut buf = String::new();
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
                Ok(None) => break true,  // channel closed — transport is down
                Ok(Some(_)) => continue, // drain any buffered line
                Err(_) => continue,      // read timeout — keep polling
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
    let (session2, mut channel2, _buffered2) =
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
    drop(channel2);
    drop(session2);
    sshd.stop();
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
    let Some(sshd) = find_sshd() else {
        eprintln!("SKIP: no sshd binary found — cannot stand up a local agent endpoint");
        return;
    };
    let Some(agent_bin) = find_agent_binary() else {
        eprintln!(
            "SKIP: termihub-agent binary not found — run `cargo build -p termihub-agent` \
                 (or set TERMIHUB_TEST_AGENT_BIN)"
        );
        return;
    };

    trust_all_host_keys();

    let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
    sshd.start();

    let config = sshd.agent_config();
    let settings = AgentSettings::default();
    let alive = Arc::new(AtomicBool::new(true));
    let mut request_id = 0u64;

    // Establish + a daemon-backed persistent session running a counter.
    let (session, mut channel, _buffered) =
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
    let (session2, mut channel2, _buffered2) =
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
    drop(channel2);
    drop(session2);
    sshd.stop();
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
    let Some(sshd) = find_sshd() else {
        eprintln!("SKIP: no sshd binary found — cannot stand up a local agent endpoint");
        return;
    };
    let Some(agent_bin) = find_agent_binary() else {
        eprintln!(
            "SKIP: termihub-agent binary not found — run `cargo build -p termihub-agent` \
                 (or set TERMIHUB_TEST_AGENT_BIN)"
        );
        return;
    };

    trust_all_host_keys();

    let mut sshd = LocalAgentSshd::new(sshd, agent_bin).expect("stand up local agent sshd");
    sshd.start();

    let config = sshd.agent_config();
    let settings = AgentSettings::default();
    let alive = Arc::new(AtomicBool::new(true));
    let mut request_id = 0u64;

    let (session, channel, _buffered) =
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
    alive.store(false, Ordering::SeqCst);
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
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError};
use termihub_core::connection::ConnectionTypeRegistry;

/// A [`ReconnectScheduler`] that records the tabs it was asked to arm, so a test
/// can assert the transient-break fold does NOT arm the backend redrive (#2556).
#[derive(Default)]
struct RecordingScheduler {
    armed: std::sync::Mutex<std::collections::HashMap<String, Box<dyn FnOnce() + Send>>>,
}
impl RecordingScheduler {
    fn is_armed(&self, key: &str) -> bool {
        self.armed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(key)
    }
}
impl ReconnectScheduler for RecordingScheduler {
    fn schedule(&self, key: String, _delay_ms: u64, task: Box<dyn FnOnce() + Send>) {
        self.armed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key, task);
    }
    fn cancel(&self, key: &str) {
        self.armed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(key);
    }
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
/// QUARANTINE (#3129): timing-flaky on ALL CI runners under load — the real/mock
/// sshd reconnect timing intermittently overruns the fold deadline (observed on
/// macOS, Windows, AND ubuntu, so a per-platform gate is insufficient). Ignored on
/// every platform but kept (not deleted) for the local/manual reconnect grade; the
/// deterministic fix stays tracked in #3129.
#[ignore = "flaky under CI timing on all platforms, see #3129"]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn manager_test_sever_drives_reconnect_and_region_folds_headlessly() {
    let Some(sshd) = find_sshd() else {
        eprintln!("SKIP: no sshd binary found — cannot stand up a local agent endpoint");
        return;
    };
    let Some(agent_bin) = find_agent_binary() else {
        eprintln!(
            "SKIP: termihub-agent binary not found — run `cargo build -p termihub-agent` \
                 (or set TERMIHUB_TEST_AGENT_BIN)"
        );
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

    let lifecycle_store = Arc::new(SessionLifecycleStore::new());
    lifecycle_store.set_rand_for_test(Box::new(|| 0.5));
    handle.manage(lifecycle_store.clone());

    let projection = ProjectionState::new();
    projection
        .projector
        .register_region(SESSION_LIFECYCLE_REGION, lifecycle_store.snapshot());
    let projector = projection.projector.clone();
    let store_for_publish = lifecycle_store.clone();
    handle.manage(projection);

    let scheduler = Arc::new(RecordingScheduler::default());
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
            let (out_tx, out_rx) = sync_channel::<Vec<u8>>(4096);
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

            // The real task folds both regions Reconnecting BEFORE it re-establishes
            // (which takes seconds over a real sshd), so a poll reliably catches the
            // transient state — and the redrive timer must never be armed for it.
            let mut saw_tab_reconnecting = false;
            let mut saw_agents_reconnecting = false;
            let mut armed_during_reconnect = false;
            poll_blocking(deadline, || {
                if lifecycle_store.get("tab-1").map(|s| s.status)
                    == Some(SessionStatus::Reconnecting)
                {
                    saw_tab_reconnecting = true;
                    armed_during_reconnect = armed_during_reconnect || scheduler.is_armed("tab-1");
                }
                if agents_store.get(&agent_id).map(|a| a.connection_state)
                    == Some(AgentConnectionState::Reconnecting)
                {
                    saw_agents_reconnecting = true;
                }
                (saw_tab_reconnecting && saw_agents_reconnecting).then_some(())
            });

            let sshd_listening_after_sever = sshd_up_before && is_listening(port);

            // Wait for the real task to finish the reconnect (agents region back
            // to Connected).
            let agents_reconnected = poll_blocking(deadline, || {
                (agents_store.get(&agent_id).map(|a| a.connection_state)
                    == Some(AgentConnectionState::Connected))
                .then_some(())
            })
            .is_some();

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
/// QUARANTINE (#3129): timing-flaky on ubuntu/linux CI runners under load (the
/// park-vs-cancel settle timing intermittently races). Ignored on linux only;
/// kept full-strength on macOS + Windows, where it is stable, so the park/cancel
/// distinction still gates every PR on at least one platform. The deterministic
/// fix stays tracked in #3129 — do NOT delete or blanket-ignore.
#[cfg_attr(
    target_os = "linux",
    ignore = "flaky under CI timing on ubuntu/linux, see #3129"
)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn manager_user_cancel_settles_distinct_from_a_parked_permanent_drop() {
    let Some(sshd) = find_sshd() else {
        eprintln!("SKIP: no sshd binary found — cannot stand up a local agent endpoint");
        return;
    };
    let Some(agent_bin) = find_agent_binary() else {
        eprintln!(
            "SKIP: termihub-agent binary not found — run `cargo build -p termihub-agent` \
                 (or set TERMIHUB_TEST_AGENT_BIN)"
        );
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
            // Sever, then take the endpoint permanently down.
            let severed = manager.test_sever_transport(&agent_id);
            assert!(severed, "sever must be accepted for a live agent");
            sshd.stop();

            // PARK: the task folds Reconnecting and keeps retrying the dead
            // endpoint. Over the window it must reach Reconnecting and never settle
            // to Disconnected, and the agent must stay alive (the task is parked in
            // its reconnect loop, not torn down).
            let park_deadline = Instant::now() + Duration::from_secs(5);
            let mut reached_reconnecting = false;
            let mut settled_disconnected_early = false;
            while Instant::now() < park_deadline {
                match agents_store.get(&agent_id).map(|a| a.connection_state) {
                    Some(AgentConnectionState::Reconnecting) => reached_reconnecting = true,
                    Some(AgentConnectionState::Disconnected) => {
                        settled_disconnected_early = true;
                        break;
                    }
                    _ => {}
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let still_alive_parked = manager.is_connected(&agent_id);

            // User-cancel is the DISTINCT settle: it tears the agent down and folds
            // the region Disconnected at once.
            manager
                .disconnect_agent(&agent_id)
                .expect("user disconnect of a live-but-parked agent");
            let settled_disconnected =
                poll_blocking(Instant::now() + Duration::from_secs(5), || {
                    (agents_store.get(&agent_id).map(|a| a.connection_state)
                        == Some(AgentConnectionState::Disconnected))
                    .then_some(())
                })
                .is_some();
            let torn_down = !manager.is_connected(&agent_id);

            (
                reached_reconnecting,
                !settled_disconnected_early,
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

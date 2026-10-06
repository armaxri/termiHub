//! Secondary backends **hosted by the agent** against the platform's own
//! OpenSSH server (#3684; MT-AGENT-26/27/28).
//!
//! The desktop-side lane (`src-tauri/.../windows_ssh_host_tests.rs`) deploys
//! the agent to a Windows host and connects to it. These tests cover the next
//! hop: what a Windows-hosted agent opens *from* that host.
//!
//! - **MT-AGENT-26 (SSH half)** — an `ssh` session created through the agent:
//!   I/O, a resize, and a close that tears the session daemon down (no orphaned
//!   process on the agent host).
//! - **MT-AGENT-27** — the agent host's own credentials: key auth with the
//!   default key path `~/.ssh/id_rsa` (the editor's placeholder — an empty path
//!   is rejected by config validation), which the agent resolves under its own
//!   home, `%USERPROFILE%` on windows; and `authMethod = agent` through the
//!   host's SSH agent (the `\\.\pipe\openssh-ssh-agent` named pipe on
//!   windows, `SSH_AUTH_SOCK` on unix).
//! - **MT-AGENT-28 (engine half)** — windows only: `docker.list_containers`
//!   reaches the local Docker engine over its named pipe (no TCP port, no
//!   `DOCKER_HOST`), exactly as an agent-hosted Docker session reaches it.
//!
//! What is not covered here, and why: a Docker *container session* from a
//! windows agent (MT-AGENT-26's Docker half and the shell / file-browser half
//! of MT-AGENT-28). The Docker backend's container lifecycle is Linux-image
//! only (it keeps a new container alive with `tail -f /dev/null` and defaults
//! to `/bin/sh`), and GitHub's windows runners run only Windows containers.
//! That part stays in the manual corpus (`tests/manual/remote-agent.yaml`).
//!
//! # Fixture and gate
//!
//! The SSH target is the native sshd fixture
//! (`scripts/internal/native-sshd-fixture.sh`; Win32-OpenSSH on windows). The
//! `Windows SSH Host` workflow runs this file once per OpenSSH `DefaultShell`
//! through `scripts/internal/run-windows-ssh-host-suite.sh`, which also starts
//! the windows `ssh-agent` service with the fixture key loaded and says so in
//! `TERMIHUB_WINDOWS_SSH_AGENT=1`, and sets `TERMIHUB_WINDOWS_DOCKER=1` when
//! the runner's Docker engine answers. On macOS/Linux the same SSH tests run
//! against the unprivileged fixture sshd (bring it up and `eval` its exports,
//! then `cargo test -p termihub-agent --test native_sshd_agent_backends`); the
//! agent-auth test starts its own `ssh-agent` there.
//!
//! | Variable | Meaning |
//! | --- | --- |
//! | `TERMIHUB_NATIVE_SSHD_PORT` / `_USER` / `_KEY` / `_HOST_PUBKEY` | the fixture's port, login user, client key, host public key |
//! | `TERMIHUB_WINDOWS_SSH_DEFAULT_SHELL` | `cmd` (default) or `powershell` — the remote shell's dialect on windows |
//! | `TERMIHUB_WINDOWS_SSH_AGENT` | truthy → the windows `ssh-agent` service holds the fixture key |
//! | `TERMIHUB_WINDOWS_DOCKER` | truthy → the runner's Docker engine is up |
//! | `TERMIHUB_REQUIRE_WINDOWS_SSH` | truthy → a missing fixture (or windows prerequisite) fails instead of skipping |
//!
//! Without the fixture (every per-PR run) each test prints a visible
//! `SKIPPED:` line naming what is missing and passes; the recipe fails on any
//! `SKIPPED:` line, so a skip can never pass for a green there.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};
use tempfile::TempDir;
use termihub_core::protocol::methods as pm;

mod common;

use common::daemon_reaper::{session_endpoint, DaemonGuard};
use common::parent_death::GuardedSpawn;

const PORT_ENV: &str = "TERMIHUB_NATIVE_SSHD_PORT";
const USER_ENV: &str = "TERMIHUB_NATIVE_SSHD_USER";
const KEY_ENV: &str = "TERMIHUB_NATIVE_SSHD_KEY";
const HOST_PUBKEY_ENV: &str = "TERMIHUB_NATIVE_SSHD_HOST_PUBKEY";
const REQUIRE_ENV: &str = "TERMIHUB_REQUIRE_WINDOWS_SSH";
#[cfg_attr(not(windows), allow(dead_code))]
const DEFAULT_SHELL_ENV: &str = "TERMIHUB_WINDOWS_SSH_DEFAULT_SHELL";
#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_SSH_AGENT_ENV: &str = "TERMIHUB_WINDOWS_SSH_AGENT";
#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_DOCKER_ENV: &str = "TERMIHUB_WINDOWS_DOCKER";

/// Budget for one step (a response, a shell's output). Generous: a create
/// spawns a session daemon and runs a full SSH handshake, and a cold Windows
/// PowerShell behind a fresh user profile is slow on a hosted runner; a
/// passing run returns as soon as the message arrives.
const STEP_TIMEOUT: Duration = Duration::from_secs(120);

/// The fixture sshd listens on loopback only.
const FIXTURE_HOST: &str = "127.0.0.1";

fn agent_binary() -> &'static str {
    env!("CARGO_BIN_EXE_termihub-agent")
}

fn truthy(value: Option<String>) -> bool {
    value.is_some_and(|v| matches!(v.trim(), "1" | "true" | "yes"))
}

fn required() -> bool {
    truthy(std::env::var(REQUIRE_ENV).ok())
}

/// Skip (visibly) or, when the lane requires the prerequisite, fail.
fn skip_or_fail(test: &str, reason: &str) {
    if required() {
        panic!("{test}: {reason}, but {REQUIRE_ENV} is set");
    }
    eprintln!("SKIPPED: {test}: {reason}");
}

/// The live native sshd the tests connect to.
struct Fixture {
    port: u16,
    user: String,
    key: PathBuf,
    host_pubkey: String,
}

impl Fixture {
    /// The fixture from the environment, or `None` (after a visible skip) when
    /// it is absent.
    fn from_env(test: &str) -> Option<Self> {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let missing: Vec<&str> = [PORT_ENV, USER_ENV, KEY_ENV, HOST_PUBKEY_ENV]
            .into_iter()
            .filter(|name| var(name).is_none())
            .collect();
        if !missing.is_empty() {
            skip_or_fail(
                test,
                &format!("no native sshd fixture ({} unset)", missing.join(", ")),
            );
            return None;
        }
        let port = var(PORT_ENV)?
            .trim()
            .parse()
            .unwrap_or_else(|e| panic!("{PORT_ENV} is not a port: {e}"));
        let host_pubkey_path = var(HOST_PUBKEY_ENV)?;
        let host_pubkey = std::fs::read_to_string(&host_pubkey_path)
            .unwrap_or_else(|e| panic!("cannot read {HOST_PUBKEY_ENV} {host_pubkey_path}: {e}"))
            .trim()
            .to_string();
        Some(Self {
            port,
            user: var(USER_ENV)?,
            key: PathBuf::from(var(KEY_ENV)?),
            host_pubkey,
        })
    }

    /// Settings for an agent `ssh` session to the fixture.
    fn ssh_config(&self, auth_method: &str, key_path: Option<&str>) -> Value {
        let mut config = json!({
            "host": FIXTURE_HOST,
            "port": self.port,
            "username": self.user,
            "authMethod": auth_method,
            "enableMonitoring": false,
            "enableFileBrowser": false,
        });
        if let Some(path) = key_path {
            config["keyPath"] = json!(path);
        }
        config
    }
}

/// A command for the fixture's login shell plus the text only its *output*
/// contains (never the echo of the typed line). Typed with CR, the byte a
/// terminal sends for Enter, which every remote PTY accepts.
struct ShellProbe {
    line: String,
    expect: String,
}

/// The fixture login shell's dialect: POSIX on unix; on windows the OpenSSH
/// `DefaultShell` the lane configured (cmd.exe when unset).
fn shell_probe(tag: &str) -> ShellProbe {
    #[cfg(windows)]
    {
        let shell = std::env::var(DEFAULT_SHELL_ENV).unwrap_or_default();
        if shell.trim().eq_ignore_ascii_case("powershell") {
            return ShellProbe {
                line: format!("Write-Output ('TH3684_{tag}_' + 'PS')\r"),
                expect: format!("TH3684_{tag}_PS"),
            };
        }
        ShellProbe {
            line: format!("echo TH3684_{tag}_%OS%\r"),
            expect: format!("TH3684_{tag}_Windows_NT"),
        }
    }
    #[cfg(not(windows))]
    {
        ShellProbe {
            line: format!("echo TH3684_{tag}_$((6*7))\r"),
            expect: format!("TH3684_{tag}_42"),
        }
    }
}

/// A unique host-wide registry endpoint for one agent, so the test never
/// spawns or joins the developer's (or a parallel checkout's) real registry:
/// a socket inside the agent's temp home on unix, a pid-scoped pipe name on
/// windows (the `\\.\pipe\` namespace has no directory to scope it).
fn registry_endpoint(home: &Path) -> String {
    #[cfg(windows)]
    {
        use std::sync::atomic::{AtomicU16, Ordering};
        static COUNTER: AtomicU16 = AtomicU16::new(0);
        let _ = home;
        format!(
            r"\\.\pipe\termihub-nsab-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        )
    }
    #[cfg(not(windows))]
    {
        home.join("registry.sock").to_string_lossy().into_owned()
    }
}

/// A real `termihub-agent --stdio` worker playing against a test "desktop".
struct StdioAgent {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    /// Messages read while waiting for something else, in arrival order.
    stash: VecDeque<Value>,
    next_id: u64,
    home: TempDir,
    registry: String,
    /// Session daemons to reap if a test fails before closing them.
    daemons: Vec<DaemonGuard>,
}

impl StdioAgent {
    /// Spawn an agent whose home directory trusts the fixture's host key and
    /// holds `default_key` (if given) as `~/.ssh/id_rsa`. `extra_env` is added
    /// to the agent's environment (e.g. `SSH_AUTH_SOCK`).
    fn spawn(fixture: &Fixture, default_key: Option<&Path>, extra_env: &[(&str, &str)]) -> Self {
        let home = TempDir::new().expect("temp home");
        let ssh_dir = home.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).expect("create .ssh");
        std::fs::write(
            ssh_dir.join("known_hosts"),
            format!(
                "[{FIXTURE_HOST}]:{} {}\n",
                fixture.port, fixture.host_pubkey
            ),
        )
        .expect("write known_hosts");
        if let Some(key) = default_key {
            std::fs::copy(key, ssh_dir.join("id_rsa")).expect("copy the default key");
        }
        let stderr = std::fs::File::create(home.path().join("agent.stderr")).expect("stderr file");
        let registry = registry_endpoint(home.path());

        let mut cmd = Command::new(agent_binary());
        cmd.arg("--stdio")
            // The home directory: `~` in key paths and `~/.ssh/known_hosts`.
            // windows resolves it from USERPROFILE (std's `home_dir` and the
            // core's `home_directory`); HOME is set too for older toolchains.
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .env("XDG_CONFIG_HOME", home.path().join(".config"))
            .env("XDG_DATA_HOME", home.path().join(".local/share"))
            .env("XDG_STATE_HOME", home.path().join(".local/state"))
            .env("TERMIHUB_REGISTRY_ENDPOINT", &registry)
            .env(
                "TERMIHUB_REGISTRY_IDLE_TIMEOUT_SECS",
                common::TEST_REGISTRY_IDLE_SECS,
            )
            .env(
                "TERMIHUB_DAEMON_DETACHED_TIMEOUT_SECS",
                common::TEST_DAEMON_DETACHED_SECS,
            )
            .env("TERMIHUB_AGENT_WORKER_THREADS", "2")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr);
        for (name, value) in extra_env {
            cmd.env(name, value);
        }
        let mut child = {
            let _fork = common::fork_guard();
            cmd.spawn_guarded().expect("spawn agent")
        };
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut agent = Self {
            child,
            stdin,
            lines,
            stash: VecDeque::new(),
            next_id: 1,
            home,
            registry,
            daemons: Vec::new(),
        };
        agent.initialize();
        agent
    }

    fn stderr_log(&self) -> String {
        std::fs::read_to_string(self.home.path().join("agent.stderr")).unwrap_or_default()
    }

    /// Send a request and return its id.
    fn send(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let line = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(self.stdin, "{line}").expect("write to agent");
        self.stdin.flush().expect("flush agent stdin");
        id
    }

    /// The first message (stashed or new) matching `pred`; others are stashed.
    fn wait_for(&mut self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        if let Some(pos) = self.stash.iter().position(&pred) {
            return self.stash.remove(pos).expect("stashed message");
        }
        let deadline = Instant::now() + STEP_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = match self.lines.recv_timeout(left) {
                Ok(line) => line,
                Err(e) => panic!(
                    "no {what} from the agent ({e}); agent stderr:\n{}",
                    self.stderr_log()
                ),
            };
            let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if pred(&msg) {
                return msg;
            }
            self.stash.push_back(msg);
        }
    }

    fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params);
        self.wait_for(&format!("response to {method}"), |m| {
            m["id"] == json!(id) && m.get("method").is_none()
        })
    }

    fn initialize(&mut self) {
        let resp = self.rpc(
            "initialize",
            json!({
                "protocolVersion": "0.23.0",
                "client": "native-sshd-agent-backends",
                "clientVersion": "0.0.1",
            }),
        );
        assert!(resp["result"].is_object(), "initialize failed: {resp}");
    }

    /// Create an `ssh` session; returns its id, or the error response. The
    /// session daemon serving it is recorded in [`Self::daemons`] (last entry).
    fn create_ssh(&mut self, config: Value) -> Result<String, Value> {
        let resp = self.rpc(
            pm::CONNECTION_CREATE,
            json!({"type": "ssh", "title": "th3684", "config": config}),
        );
        let Some(session_id) = resp["result"]["session_id"].as_str() else {
            return Err(resp);
        };
        let session_id = session_id.to_string();
        // Reap the session daemon if the test fails before closing it. Looked
        // up once, before the attach, as in the keyboard-interactive suite: the
        // lookup connects to the daemon, so it must not race the worker's own
        // attach (a second lookup did, and the attach was refused).
        match DaemonGuard::try_discover(&session_endpoint(&session_id)) {
            Ok(guard) => self.daemons.push(guard),
            Err(e) => panic!("no session daemon serving session {session_id}: {e}"),
        }
        Ok(session_id)
    }

    fn session_ids(&mut self) -> Vec<String> {
        let resp = self.rpc(pm::CONNECTION_LIST, json!({}));
        resp["result"]["sessions"]
            .as_array()
            .map(|sessions| {
                sessions
                    .iter()
                    .filter_map(|s| s["session_id"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Type `probe` into the session and wait for its output.
    fn run_probe(&mut self, session_id: &str, probe: &ShellProbe) {
        let write = self.rpc(
            pm::CONNECTION_WRITE,
            json!({
                "session_id": session_id,
                "data": base64::engine::general_purpose::STANDARD.encode(&probe.line),
            }),
        );
        assert!(write.get("error").is_none(), "write failed: {write}");
        self.wait_for_output(session_id, &probe.expect);
    }

    /// Accumulate this session's `connection.output` until it contains
    /// `needle` (matching across notification boundaries: a PTY, and ConPTY
    /// most of all, chunks its output freely).
    fn wait_for_output(&mut self, session_id: &str, needle: &str) {
        let deadline = Instant::now() + STEP_TIMEOUT;
        let mut seen = String::new();
        // Output that arrived while waiting for an RPC response is stashed.
        let stashed: Vec<Value> = self.stash.drain(..).collect();
        for msg in stashed {
            if is_output_of(&msg, session_id) {
                seen.push_str(&decode_output(&msg));
            } else {
                self.stash.push_back(msg);
            }
        }
        while !seen.contains(needle) {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.lines.recv_timeout(left) {
                Ok(line) => {
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if is_output_of(&msg, session_id) {
                        seen.push_str(&decode_output(&msg));
                    } else {
                        self.stash.push_back(msg);
                    }
                }
                Err(e) => panic!(
                    "no {needle:?} in session {session_id}'s output ({e}); output so far: \
                     {seen:?}; agent stderr:\n{}",
                    self.stderr_log()
                ),
            }
        }
    }
}

impl Drop for StdioAgent {
    fn drop(&mut self) {
        // Kill by the exact PID we spawned; session daemons are reaped by
        // their `DaemonGuard`s (endpoint-verified PIDs) as `daemons` drops.
        let _ = self.child.kill();
        let _ = self.child.wait();
        drop(DaemonGuard::discover(&self.registry));
    }
}

fn is_output_of(msg: &Value, session_id: &str) -> bool {
    msg["method"] == pm::CONNECTION_OUTPUT && msg["params"]["session_id"] == json!(session_id)
}

fn decode_output(msg: &Value) -> String {
    let b64 = msg["params"]["data"].as_str().unwrap_or("");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .unwrap_or_default();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Create an `ssh` session with `config`, prove a command round-trips, and
/// close it again.
fn connect_and_round_trip(agent: &mut StdioAgent, config: Value, tag: &str) {
    let session_id = agent.create_ssh(config).unwrap_or_else(|resp| {
        panic!(
            "ssh create through the agent failed: {resp}; agent stderr:\n{}",
            agent.stderr_log()
        )
    });
    let attach = agent.rpc(pm::CONNECTION_ATTACH, json!({"session_id": session_id}));
    assert!(attach["result"].is_object(), "attach failed: {attach}");
    agent.run_probe(&session_id, &shell_probe(tag));
    let close = agent.rpc(pm::CONNECTION_CLOSE, json!({"session_id": session_id}));
    assert!(close.get("error").is_none(), "close failed: {close}");
}

/// The repo's unencrypted RSA fixture key, which the fixture's
/// `authorized_keys` trusts (it carries the whole `tests/fixtures/ssh-keys`
/// set).
fn fixture_rsa_key() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/ssh-keys/rsa_2048")
}

/// MT-AGENT-26 (SSH half): an SSH session opened *from* the agent host — I/O
/// round-trips, a resize keeps the session alive, and closing it tears the
/// session daemon down instead of leaving an orphaned process behind.
#[test]
fn ssh_session_through_agent_round_trips_resizes_and_closes_cleanly() {
    const TEST: &str = "ssh_session_through_agent_round_trips_resizes_and_closes_cleanly";
    let Some(fixture) = Fixture::from_env(TEST) else {
        return;
    };
    let mut agent = StdioAgent::spawn(&fixture, None, &[]);

    let session_id = agent
        .create_ssh(fixture.ssh_config("key", Some(&fixture.key.to_string_lossy())))
        .unwrap_or_else(|resp| {
            panic!(
                "ssh create through the agent failed: {resp}; agent stderr:\n{}",
                agent.stderr_log()
            )
        });
    // The session runs in its own daemon process; its pid is checked below.
    let daemon_pid = agent.daemons.last().expect("session daemon").pid();

    let attach = agent.rpc(pm::CONNECTION_ATTACH, json!({"session_id": session_id}));
    assert!(attach["result"].is_object(), "attach failed: {attach}");
    agent.run_probe(&session_id, &shell_probe("ALIVE"));

    let resize = agent.rpc(
        pm::CONNECTION_RESIZE,
        json!({"session_id": session_id, "cols": 132, "rows": 43}),
    );
    assert!(resize.get("error").is_none(), "resize failed: {resize}");
    agent.run_probe(&session_id, &shell_probe("RESIZED"));

    let close = agent.rpc(pm::CONNECTION_CLOSE, json!({"session_id": session_id}));
    assert!(close.get("error").is_none(), "close failed: {close}");
    let deadline = Instant::now() + STEP_TIMEOUT;
    while common::daemon_reaper::pid_alive(daemon_pid) {
        assert!(
            Instant::now() < deadline,
            "session daemon (pid {daemon_pid}) still running {STEP_TIMEOUT:?} after \
             connection.close — an orphaned process on the agent host"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !agent.session_ids().contains(&session_id),
        "closed session {session_id} still listed"
    );
}

/// MT-AGENT-27 (default key): key auth with the default key path
/// `~/.ssh/id_rsa` resolves it under the agent host's own home
/// (`%USERPROFILE%\.ssh\id_rsa` on windows) and authenticates.
#[test]
fn ssh_session_through_agent_authenticates_with_the_default_key() {
    const TEST: &str = "ssh_session_through_agent_authenticates_with_the_default_key";
    let Some(fixture) = Fixture::from_env(TEST) else {
        return;
    };
    let key = fixture_rsa_key();
    assert!(key.is_file(), "fixture key missing: {}", key.display());
    let mut agent = StdioAgent::spawn(&fixture, Some(&key), &[]);
    connect_and_round_trip(
        &mut agent,
        fixture.ssh_config("key", Some("~/.ssh/id_rsa")),
        "DEFKEY",
    );
}

/// MT-AGENT-27 (agent auth): `authMethod = agent` signs with a key held by the
/// agent host's SSH agent — the Win32-OpenSSH `ssh-agent` service behind
/// `\\.\pipe\openssh-ssh-agent` on windows, an `ssh-agent` this test starts
/// (via `SSH_AUTH_SOCK`) on unix. No key file is configured.
#[test]
fn ssh_session_through_agent_authenticates_with_the_ssh_agent() {
    const TEST: &str = "ssh_session_through_agent_authenticates_with_the_ssh_agent";
    let Some(fixture) = Fixture::from_env(TEST) else {
        return;
    };

    #[cfg(windows)]
    {
        if !truthy(std::env::var(WINDOWS_SSH_AGENT_ENV).ok()) {
            skip_or_fail(
                TEST,
                &format!(
                    "{WINDOWS_SSH_AGENT_ENV} unset: the ssh-agent service is not running with \
                     the fixture key (run-windows-ssh-host-suite.sh sets it up)"
                ),
            );
            return;
        }
        let mut agent = StdioAgent::spawn(&fixture, None, &[]);
        connect_and_round_trip(&mut agent, fixture.ssh_config("agent", None), "AGENTAUTH");
    }

    #[cfg(not(windows))]
    {
        let Some(ssh_agent) = unix_ssh_agent::SshAgent::start(&fixture.key) else {
            skip_or_fail(TEST, "could not start ssh-agent / ssh-add on this host");
            return;
        };
        let sock = ssh_agent.socket();
        let mut agent = StdioAgent::spawn(&fixture, None, &[("SSH_AUTH_SOCK", &sock)]);
        connect_and_round_trip(&mut agent, fixture.ssh_config("agent", None), "AGENTAUTH");
    }
}

/// MT-AGENT-28 (engine half): the agent reaches the runner's Docker engine
/// through its named pipe — `docker.list_containers` answers with a listing,
/// with no `DOCKER_HOST` and no TCP port involved. This is the same runtime
/// connect an agent-hosted Docker session makes.
#[cfg(windows)]
#[test]
fn docker_engine_is_reached_over_its_named_pipe() {
    const TEST: &str = "docker_engine_is_reached_over_its_named_pipe";
    let Some(fixture) = Fixture::from_env(TEST) else {
        return;
    };
    if !truthy(std::env::var(WINDOWS_DOCKER_ENV).ok()) {
        skip_or_fail(
            TEST,
            &format!("{WINDOWS_DOCKER_ENV} unset: no Docker engine on this host"),
        );
        return;
    }
    assert!(
        std::env::var_os("DOCKER_HOST").is_none(),
        "DOCKER_HOST is set; this test proves the default named-pipe endpoint"
    );
    let mut agent = StdioAgent::spawn(&fixture, None, &[]);
    let resp = agent.rpc(pm::DOCKER_LIST_CONTAINERS, json!({"runtime": "docker"}));
    assert!(
        resp["result"]["containers"].is_array(),
        "docker.list_containers did not reach the engine over \\\\.\\pipe\\docker_engine: \
         {resp}; agent stderr:\n{}",
        agent.stderr_log()
    );
}

/// An `ssh-agent` owned by the test, holding one key (unix).
#[cfg(not(windows))]
mod unix_ssh_agent {
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    use tempfile::TempDir;

    use super::common::{self, parent_death::GuardedSpawn};

    pub struct SshAgent {
        child: Child,
        dir: TempDir,
    }

    impl SshAgent {
        /// Start `ssh-agent -D` on a private socket and `ssh-add` `key`, or
        /// `None` when either tool is missing or fails.
        pub fn start(key: &Path) -> Option<Self> {
            let dir = TempDir::new().ok()?;
            let sock = dir.path().join("agent.sock");
            let child = {
                let _fork = common::fork_guard();
                Command::new("ssh-agent")
                    .arg("-D")
                    .arg("-a")
                    .arg(&sock)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn_guarded()
                    .ok()?
            };
            let agent = Self { child, dir };
            let deadline = Instant::now() + Duration::from_secs(10);
            while !sock.exists() {
                if Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let added = {
                let _fork = common::fork_guard();
                Command::new("ssh-add")
                    .arg(key)
                    .env("SSH_AUTH_SOCK", &sock)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .ok()?
            };
            added.success().then_some(agent)
        }

        pub fn socket(&self) -> String {
            self.socket_path().to_string_lossy().into_owned()
        }

        fn socket_path(&self) -> PathBuf {
            self.dir.path().join("agent.sock")
        }
    }

    impl Drop for SshAgent {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

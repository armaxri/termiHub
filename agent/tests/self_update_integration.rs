//! Live-agent integration test for the self-update **auto-apply-on-idle** cycle
//! (#1401, follow-up to PR #1533; sibling of #1519).
//!
//! The self-update logic is already covered by unit tests in
//! `agent/src/update/mod.rs` that drive `run_check_once` against a `wiremock`
//! GitHub server with an **injected** `UpdateApplier` (so nothing is really
//! swapped or re-execed) and an isolated `state.json`. What those cannot cover is
//! the real thing: a live `termihub-agent` process, launched with the production
//! `--allow-self-update --update-strategy …` flags, running the real
//! `SystemUpdateApplier` — the actual GitHub-poll → download → SHA-256-verify →
//! binary-swap → **re-exec** cycle, end to end over a running agent.
//!
//! This suite fills that gap. It uses the same in-process `wiremock` server the
//! unit tests use as the "mock GitHub", but points a **real child agent process**
//! at it via the `TERMIHUB_AGENT_UPDATE_*` env seams (see
//! [`termihub_agent::update::UpdateConfig::from_env`], mirrored below). The agent
//! is run from a throwaway copy of the built test binary so the real
//! self-replace + re-exec can overwrite *that* copy without clobbering cargo's
//! build artifact.
//!
//! ## Why not the SSH/Docker `remote-agent` container (#995)?
//!
//! The #995 harness deploys the agent into an Ubuntu+sshd container and drives it
//! from the desktop over SSH. The self-update mechanism, though, is entirely
//! process-level (poll a URL, swap the on-disk binary, `execve`) and needs no SSH
//! and no container to be exercised faithfully — the piece under test is the
//! *live agent process*, which a child `--listen` process reproduces exactly and
//! deterministically. One case that genuinely benefits from a container — the
//! never-interrupt guarantee against a *real* remote session — additionally runs
//! against a live Docker session, gated on Docker being available (it skips
//! cleanly otherwise, matching `docker_integration.rs`).
//!
//! ## What a single build can and cannot assert
//!
//! The agent reports its version from the compile-time `CARGO_PKG_VERSION`, so a
//! test that stages a *copy of the same binary* cannot make the re-execed agent
//! report a literally higher semver. The "new version" is therefore asserted
//! where it is genuinely observable — the release tag the agent detects, and the
//! `pending_update.version` a *coordinated* stage records — while the *apply
//! itself* is proven structurally: the on-disk binary is atomically replaced
//! (its inode changes) and the agent comes back alive on it. See the individual
//! tests.
//!
//! Unix-only: the self-replace + re-exec (`apply_update_binary`) is Unix-only.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

mod common;

/// Published asset suffix the mock release advertises. Forced via
/// `TERMIHUB_AGENT_UPDATE_ASSET_SUFFIX` so the test is independent of the host
/// architecture (the real `current_asset_suffix()` only resolves on Linux).
const AGENT_SUFFIX: &str = "linux-x64";

/// A version far above any real `CARGO_PKG_VERSION`, so the poll always sees it
/// as "newer" and stages it.
const NEWER_TAG: &str = "v9.9.9";
const NEWER_VERSION: &str = "9.9.9";

// ── Binary + hashing helpers ────────────────────────────────────────────────

/// Path to the freshly built agent binary under test.
fn agent_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_termihub-agent"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Reserve a free localhost TCP port by binding to `:0` and immediately
/// releasing it. The agent re-binds this fixed port across its re-exec, so a
/// reconnect after the swap lands on the same address.
fn reserve_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("bind ephemeral port")
        .local_addr()
        .expect("local_addr")
        .port()
}

fn inode(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.ino())
}

/// Set the permission bits on a directory (used to make the agent's install dir
/// read-only so a self-replace fails).
fn set_dir_mode(dir: &Path, mode: u32) {
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode))
        .expect("set dir permissions");
}

// ── Mock GitHub release ─────────────────────────────────────────────────────

/// Mount a `releases/latest` mock that advertises [`NEWER_TAG`] **once**, then
/// falls back to reporting the agent's own version as latest. Serving "newer"
/// only once is what stops a re-execed agent (which reports the *same* built
/// version) from detecting the update again and re-applying in a tight loop: its
/// post-restart poll gets the up-to-date response and stops.
///
/// The advertised binary/checksum assets serve the *running agent's own bytes*
/// (a valid, launchable agent) so the swapped-in binary can come back up and
/// serve the reconnect.
async fn mount_release(server: &MockServer, agent_bytes: &[u8]) {
    let base = server.uri();
    let newer_body = json!({
        "tag_name": NEWER_TAG,
        "assets": [
            {"name": format!("termihub-agent-{AGENT_SUFFIX}"), "browser_download_url": format!("{base}/bin")},
            {"name": format!("termihub-agent-{AGENT_SUFFIX}.sha256"), "browser_download_url": format!("{base}/bin.sha256")},
        ]
    })
    .to_string();
    // The re-execed agent reports its built version; report that same version as
    // "latest" so its follow-up poll is a clean no-op. `env!` here is the test
    // crate's view of the agent version (same workspace version).
    let uptodate_body = json!({ "tag_name": "v0.0.0", "assets": [] }).to_string();

    // High priority + `up_to_n_times(1)`: the first poll gets "newer"; every poll
    // after it falls through to the up-to-date response.
    Mock::given(method("GET"))
        .and(path("/releases/latest"))
        .respond_with(ResponseTemplate::new(200).set_body_string(newer_body))
        .up_to_n_times(1)
        .with_priority(1)
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/releases/latest"))
        .respond_with(ResponseTemplate::new(200).set_body_string(uptodate_body))
        .with_priority(5)
        .mount(server)
        .await;

    let sha = sha256_hex(agent_bytes);
    Mock::given(method("GET"))
        .and(path("/bin"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(agent_bytes.to_vec()))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/bin.sha256"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(format!("{sha}  termihub-agent-{AGENT_SUFFIX}\n")),
        )
        .mount(server)
        .await;
}

// ── Live agent process ──────────────────────────────────────────────────────

/// A running `termihub-agent --listen` child, pointed at the mock GitHub server,
/// running from a throwaway copy of the binary so its self-replace is contained.
struct LiveAgent {
    child: Child,
    addr: String,
    bin_path: PathBuf,
    stderr_path: PathBuf,
    _install_dir: TempDir,
    config_home: TempDir,
}

impl Drop for LiveAgent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl LiveAgent {
    /// Copy the agent binary into a private dir and spawn it with self-update
    /// enabled, pointed at `server`. `initial_delay` gates the first poll so a
    /// caller can open a session before it fires.
    fn spawn(server: &MockServer, strategy: &str, initial_delay: Duration) -> Self {
        let install_dir = TempDir::new().expect("install dir");
        let bin_path = install_dir.path().join("termihub-agent");

        let config_home = TempDir::new().expect("config home");
        let port = reserve_port();
        let addr = format!("127.0.0.1:{port}");

        let stderr_file = tempfile::NamedTempFile::new().expect("stderr file");
        let stderr_path = stderr_file.path().to_path_buf();
        let (stderr_handle, _keep) = stderr_file.keep().expect("persist stderr file");

        // Everything from the copy to the spawn runs under the fork lock: a
        // sibling thread forking mid-copy inherits our write fd and makes our
        // own execve fail with ETXTBSY (#1597). See `common::fork_guard`.
        let fork_guard = common::fork_guard();
        std::fs::copy(agent_binary(), &bin_path).expect("copy agent binary");
        std::fs::set_permissions(&bin_path, std::fs::Permissions::from_mode(0o755))
            .expect("chmod agent copy");

        let child = Command::new(&bin_path)
            .arg("--listen")
            .arg(&addr)
            .arg("--allow-self-update")
            .arg("--update-strategy")
            .arg(strategy)
            .env("XDG_CONFIG_HOME", config_home.path())
            .env(
                "TERMIHUB_AGENT_UPDATE_API_URL",
                format!("{}/releases/latest", server.uri()),
            )
            .env("TERMIHUB_AGENT_UPDATE_ASSET_SUFFIX", AGENT_SUFFIX)
            .env(
                "TERMIHUB_AGENT_UPDATE_INITIAL_DELAY_MS",
                initial_delay.as_millis().to_string(),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr_handle))
            .spawn()
            .expect("spawn agent process");
        // `spawn` returns only once the child has exec'd, so the inherited-fd
        // window is closed here.
        drop(fork_guard);

        LiveAgent {
            child,
            addr,
            bin_path,
            stderr_path,
            _install_dir: install_dir,
            config_home,
        }
    }

    fn state_json_path(&self) -> PathBuf {
        self.config_home
            .path()
            .join("termihub-agent")
            .join("state.json")
    }

    fn staging_dir(&self) -> PathBuf {
        self.config_home
            .path()
            .join("termihub-agent")
            .join("updates")
    }

    /// Parse the agent's persisted `state.json` (empty object if not written yet).
    fn state(&self) -> Value {
        match std::fs::read_to_string(self.state_json_path()) {
            Ok(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        }
    }

    fn stderr(&self) -> String {
        std::fs::read_to_string(&self.stderr_path).unwrap_or_default()
    }
}

// ── Waiting helpers ─────────────────────────────────────────────────────────

/// Poll `cond` until it returns `true` or the deadline elapses.
fn wait_until(timeout: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    cond()
}

// ── Minimal NDJSON JSON-RPC client ──────────────────────────────────────────

struct Client {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
    next_id: i64,
}

impl Client {
    /// Connect and complete the `initialize` handshake, retrying until the agent
    /// is listening (it may still be mid-restart after a self-apply).
    fn connect(addr: &str, timeout: Duration) -> Option<Self> {
        let deadline = Instant::now() + timeout;
        // Bound each handshake read to a fraction of the overall budget (#1579).
        // A single stalled `initialize` read must not consume the entire
        // `timeout` and leave no retry — the old flat 15s read matched the 15s
        // caller budget exactly, so one stall was fatal. A third of the budget
        // (capped at 5s) leaves several fresh-socket retries.
        let handshake_read = (timeout / 3).min(Duration::from_secs(5));
        while Instant::now() < deadline {
            if let Ok(stream) = TcpStream::connect(addr) {
                stream
                    .set_read_timeout(Some(handshake_read))
                    .expect("set read timeout");
                let writer = stream.try_clone().expect("clone stream");
                let mut client = Client {
                    reader: BufReader::new(stream),
                    writer,
                    next_id: 1,
                };
                let resp = client.rpc(
                    "initialize",
                    json!({"protocolVersion": "0.3.0", "client": "self-update-it", "clientVersion": "0.1.0"}),
                );
                if resp.get("result").is_some() {
                    // Handshake done: restore a generous read timeout for the
                    // normal RPCs this client goes on to make, which can be
                    // legitimately slow under load. Only the retry-until-ready
                    // handshake above needed the tight bound.
                    client
                        .reader
                        .get_ref()
                        .set_read_timeout(Some(Duration::from_secs(15)))
                        .expect("restore read timeout");
                    return Some(client);
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        None
    }

    /// Send an RPC and return the matching response, skipping notifications.
    fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        // The write races the peer just as the reads below do: during the
        // deferred idle→apply→re-exec cycle the agent swaps its binary and
        // re-execs, so a socket that `TcpStream::connect` just accepted against
        // the outgoing listener can be reset before this request lands
        // (`ConnectionReset`/`BrokenPipe`, #2333). Treat a failed write/flush as
        // a dead connection — return `Null` rather than panicking — so the
        // `connect` retry loop simply tries again on a fresh socket, exactly as
        // the read path already does.
        if writeln!(self.writer, "{req}")
            .and_then(|()| self.writer.flush())
            .is_err()
        {
            return Value::Null;
        }

        loop {
            let mut line = String::new();
            // A read error (connection reset while the agent re-execs, or a
            // timeout) is reported as `Null` rather than panicking, so the
            // `connect` retry loop can simply try again on a fresh socket.
            let n = match self.reader.read_line(&mut line) {
                Ok(n) => n,
                Err(_) => return Value::Null,
            };
            if n == 0 {
                return Value::Null; // connection closed
            }
            let Ok(msg): Result<Value, _> = serde_json::from_str(line.trim()) else {
                continue;
            };
            if msg.get("id").and_then(Value::as_i64) == Some(id) {
                return msg;
            }
            // otherwise a notification for an earlier/other id — keep reading
        }
    }

    fn agent_version(&mut self) -> String {
        let resp = self.rpc("initialize", json!({"protocolVersion": "0.3.0", "client": "self-update-it", "clientVersion": "0.1.0"}));
        resp["result"]["agent_version"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    fn create_session(&mut self, session_type: &str, config: Value) -> String {
        let resp = self.rpc(
            "connection.create",
            json!({"type": session_type, "config": config, "title": "self-update-test"}),
        );
        resp["result"]["session_id"]
            .as_str()
            .unwrap_or_else(|| panic!("connection.create failed: {resp}"))
            .to_string()
    }

    /// Raw `connection.list` response. Kept separate from [`Self::session_count`]
    /// so a failing assertion can print what the agent actually said (#1559):
    /// the count alone collapses "RPC died" and "agent listed N sessions" into
    /// the same number and hides which one happened.
    fn session_list_raw(&mut self) -> Value {
        self.rpc("connection.list", json!({}))
    }

    fn session_count(&mut self) -> usize {
        let resp = self.session_list_raw();
        resp["result"]["sessions"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0)
    }

    /// Close a session, returning the raw response so a caller can report a
    /// refused close (`result: false` / an error object) rather than silently
    /// dropping it (#1559).
    fn close_session(&mut self, session_id: &str) -> Value {
        self.rpc("connection.close", json!({"session_id": session_id}))
    }

    /// Everything needed to diagnose a session-count assertion in one CI hit
    /// (#1559): what the agent lists *now*, its live sessions, and its stderr.
    ///
    /// `connection.list` is re-issued here rather than cached from the failing
    /// poll, which also disambiguates the two failure shapes for free: a `Null`
    /// raw response means the RPC is dead (so the count was a false `0`), while a
    /// populated `sessions` array names the sessions that would not go away.
    fn failure_report(&mut self, agent: &LiveAgent) -> String {
        let raw = self.session_list_raw();
        let ids = match raw["result"]["sessions"].as_array() {
            Some(sessions) if sessions.is_empty() => "<none>".to_string(),
            Some(sessions) => sessions
                .iter()
                .map(|s| {
                    format!(
                        "{} (type={}, status={}, title={:?}, attached={})",
                        s["session_id"], s["session_type"], s["status"], s["title"], s["attached"]
                    )
                })
                .collect::<Vec<_>>()
                .join("\n  "),
            None => "<no sessions array — RPC returned no result>".to_string(),
        };
        format!(
            "--- agent addr ---\n{}\n\
             --- raw connection.list ---\n{raw}\n\
             --- listed sessions ---\n  {ids}\n\
             --- persisted state.json ---\n{}\n\
             --- agent stderr ---\n{}",
            agent.addr,
            agent.state(),
            agent.stderr()
        )
    }
}

// ── Docker availability ─────────────────────────────────────────────────────

/// Takes the fork lock even though it has nothing to do with the agent binary:
/// this `fork` inherits any write fd a sibling thread's `fs::copy` currently
/// holds, and that is enough to make *that* thread's `execve` fail with
/// ETXTBSY. The hazard is the fork, not the binary (#1597).
/// Forks under the fork lock even though it has nothing to do with the agent
/// binary: this `fork` inherits any write fd a sibling thread's `fs::copy`
/// currently holds, which is enough to make *that* thread's `execve` fail with
/// ETXTBSY. The hazard is the fork, not the binary (#1597).
///
/// `spawn` + `wait` rather than `status()` so the lock covers only the
/// fork-to-exec window, not the wait for `docker info` to finish.
fn docker_available() -> bool {
    let child = {
        let _fork_guard = common::fork_guard();
        Command::new("docker")
            .arg("info")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    };
    child
        .and_then(|mut c| c.wait())
        .map(|s| s.success())
        .unwrap_or(false)
}

// ── Tests ───────────────────────────────────────────────────────────────────

/// Deferred + idle: the live agent polls the mock, downloads + SHA-256-verifies
/// the "newer" release, stages it, and — because it is idle and the strategy
/// auto-applies — **swaps its own binary and re-execs**, then comes back alive.
#[tokio::test]
async fn deferred_strategy_auto_applies_on_idle_and_comes_back() {
    let agent_bytes = std::fs::read(agent_binary()).expect("read agent bytes");
    let server = MockServer::start().await;
    mount_release(&server, &agent_bytes).await;

    let agent = LiveAgent::spawn(&server, "deferred", Duration::from_millis(300));
    let bin_inode_before = inode(&agent.bin_path).expect("binary present before apply");

    // The self-apply atomically renames a fresh file over the running binary, so
    // its inode changes — the structural proof the swap happened.
    let swapped = wait_until(Duration::from_secs(30), || {
        inode(&agent.bin_path).is_some_and(|i| i != bin_inode_before)
    });
    assert!(
        swapped,
        "agent did not swap its binary on idle within 30s.\n--- agent stderr ---\n{}",
        agent.stderr()
    );

    // The staged, verified binary landed under the isolated staging dir.
    let staged = agent
        .staging_dir()
        .join(format!("termihub-agent-{AGENT_SUFFIX}"));
    assert!(
        staged.is_file(),
        "verified update was not staged at {staged:?}"
    );

    // It re-execed with the same args → same port → reconnect succeeds and the
    // agent is healthy on the swapped-in binary.
    let mut client = Client::connect(&agent.addr, Duration::from_secs(30)).unwrap_or_else(|| {
        panic!(
            "agent did not come back after self-apply.\n{}",
            agent.stderr()
        )
    });
    assert!(
        !client.agent_version().is_empty(),
        "re-execed agent did not report a version"
    );

    // The applied update leaves no `pending_update` behind (#1551).
    //
    // A successful `SystemUpdateApplier::apply` `execve`s the new binary and
    // never returns, so the in-process "clear `pending_update` on success" step
    // in `apply_pending_update` cannot run on this path. The re-execed agent
    // therefore sweeps the already-applied record at startup instead — here via
    // the binary evidence: its own executable is byte-identical to the staged
    // binary. Left in place, the record would re-fire on the next
    // last-session disconnect and re-exec the agent for nothing.
    let cleared = wait_until(Duration::from_secs(15), || {
        agent.state()["update"]["pending_update"].is_null()
    });
    assert!(
        cleared,
        "a successful self-apply must leave no pending_update; state was {}\n{}",
        agent.state(),
        agent.stderr()
    );
}

/// The #1551 property end to end: after a successful self-apply, taking the
/// re-execed agent through a full session open → close (a last-session
/// disconnect, the deferred-apply trigger) must NOT swap the binary again. A
/// retained `pending_update` would re-apply the already-installed binary and
/// re-exec, dropping this very connection every time the agent goes idle.
#[tokio::test]
async fn applied_update_does_not_re_exec_on_the_next_idle() {
    let agent_bytes = std::fs::read(agent_binary()).expect("read agent bytes");
    let server = MockServer::start().await;
    mount_release(&server, &agent_bytes).await;

    let agent = LiveAgent::spawn(&server, "deferred", Duration::from_millis(300));
    let bin_inode_before = inode(&agent.bin_path).expect("binary present before apply");

    // Let the self-apply happen (inode changes on the atomic replace).
    let swapped = wait_until(Duration::from_secs(30), || {
        inode(&agent.bin_path).is_some_and(|i| i != bin_inode_before)
    });
    assert!(
        swapped,
        "agent did not swap its binary on idle within 30s.\n--- agent stderr ---\n{}",
        agent.stderr()
    );

    let mut client = Client::connect(&agent.addr, Duration::from_secs(30)).unwrap_or_else(|| {
        panic!(
            "agent did not come back after self-apply.\n{}",
            agent.stderr()
        )
    });
    let inode_after_apply = inode(&agent.bin_path).expect("binary present after apply");

    // Drive a session through the idle transition that triggers a deferred apply.
    let session_id = client.create_session("shell", json!({}));
    assert!(
        wait_until(Duration::from_secs(15), || client.session_count() >= 1),
        "session {session_id} did not become active in time.\n{}",
        client.failure_report(&agent)
    );
    let close_resp = client.close_session(&session_id);
    // This assertion is the long-standing flake in #1559, and the bare message it
    // used to carry ("session did not close in time") was unactionable: it can
    // only fail when a *live* agent lists a session for 15s straight — every
    // dead/timed-out RPC path yields `Null` -> a count of 0 -> a pass. So a
    // failure here means a real, unexpected session is in the agent's map, and
    // the raw list plus the agent's own stderr is what identifies it.
    assert!(
        wait_until(Duration::from_secs(15), || client.session_count() == 0),
        "session {session_id} did not close in time.\n\
         --- connection.close response ---\n{close_resp}\n{}",
        client.failure_report(&agent)
    );
    // Give a spurious apply every chance to fire.
    std::thread::sleep(Duration::from_millis(500));

    assert_eq!(
        inode(&agent.bin_path),
        Some(inode_after_apply),
        "the last-session disconnect must not re-apply an already-applied update"
    );
    // Still the same process on the same connection — no re-exec cut it.
    assert!(
        !client.agent_version().is_empty(),
        "agent connection must survive going idle after a self-apply.\n{}",
        agent.stderr()
    );
}

/// Coordinated + idle: the agent stages the verified binary and notifies, but the
/// `coordinated` strategy must **not** auto-apply on idle — the binary is left
/// untouched and the staged update is recorded for a later coordinated apply.
#[tokio::test]
async fn coordinated_strategy_stages_without_applying() {
    let agent_bytes = std::fs::read(agent_binary()).expect("read agent bytes");
    let server = MockServer::start().await;
    mount_release(&server, &agent_bytes).await;

    let agent = LiveAgent::spawn(&server, "coordinated", Duration::from_millis(300));
    let bin_inode_before = inode(&agent.bin_path).expect("binary present");

    // Wait until the poll has staged the update into persisted state.
    let staged = wait_until(Duration::from_secs(30), || {
        !agent.state()["update"]["pending_update"].is_null()
    });
    assert!(
        staged,
        "coordinated strategy did not record a staged update.\n{}",
        agent.stderr()
    );

    // …but it must NOT have swapped the running binary (no auto-apply on idle).
    assert_eq!(
        inode(&agent.bin_path),
        Some(bin_inode_before),
        "coordinated strategy must not swap the binary on idle"
    );

    let pending = agent.state()["update"]["pending_update"].clone();
    assert_eq!(pending["version"], NEWER_VERSION);
    let staged_path = agent
        .staging_dir()
        .join(format!("termihub-agent-{AGENT_SUFFIX}"));
    assert_eq!(
        pending["binary_path"].as_str(),
        staged_path.to_str(),
        "pending_update should point at the staged binary"
    );

    // The agent stayed up on its original binary (it never re-execed).
    let mut client = Client::connect(&agent.addr, Duration::from_secs(15))
        .expect("agent should still be reachable after a coordinated stage");
    assert!(!client.agent_version().is_empty());
}

/// A failed apply (here: the running binary lives in a read-only directory, so
/// the atomic self-replace cannot write its temp file) must **keep**
/// `pending_update` for a later retry and leave the agent running its old binary.
#[tokio::test]
async fn failed_apply_keeps_pending_update() {
    let agent_bytes = std::fs::read(agent_binary()).expect("read agent bytes");
    let server = MockServer::start().await;
    mount_release(&server, &agent_bytes).await;

    let agent = LiveAgent::spawn(&server, "deferred", Duration::from_millis(800));
    let bin_inode_before = inode(&agent.bin_path).expect("binary present");

    // Make the binary's directory read-only *before* the (delayed) poll fires, so
    // staging (under the writable config dir) still succeeds but the self-replace
    // fails when it tries to create its sibling temp file.
    let install_dir = agent.bin_path.parent().unwrap().to_path_buf();
    set_dir_mode(&install_dir, 0o555);

    // The failed apply keeps the staged update recorded for retry.
    let kept = wait_until(Duration::from_secs(30), || {
        !agent.state()["update"]["pending_update"].is_null()
    });
    // Restore write perms so the TempDir can be cleaned up on drop.
    set_dir_mode(&install_dir, 0o755);

    assert!(
        kept,
        "failed apply did not keep pending_update for retry.\n{}",
        agent.stderr()
    );
    // The binary was never swapped (apply failed before the rename).
    assert_eq!(
        inode(&agent.bin_path),
        Some(bin_inode_before),
        "a failed apply must not swap the binary"
    );
    assert_eq!(
        agent.state()["update"]["pending_update"]["version"],
        NEWER_VERSION
    );

    // The agent kept running its old binary and is still reachable (no re-exec).
    let mut client = Client::connect(&agent.addr, Duration::from_secs(15))
        .expect("agent should keep running after a failed apply");
    assert!(!client.agent_version().is_empty());
}

/// Never-interrupt: with a live session open, the idle-apply guard must hold — the
/// poll sees a newer release but neither stages nor applies it, so the session is
/// never cut and the binary is never swapped. Uses a real local shell session.
#[tokio::test]
async fn active_shell_session_is_never_interrupted() {
    assert_never_interrupts("shell", json!({}), None).await;
}

/// Never-interrupt against a real **Docker** container session (the #995
/// live-agent flavour). Skips cleanly when Docker is unavailable.
#[tokio::test]
async fn active_docker_session_is_never_interrupted() {
    if !docker_available() {
        eprintln!("Skipping: Docker not available");
        return;
    }
    // Pre-pull so container start (and thus session activation) is fast enough to
    // beat the gated first poll deterministically.
    // Fork under the lock, wait outside it — an image pull is far too long to
    // hold the fork lock for. See `common::fork_guard` (#1597).
    let pull = {
        let _fork_guard = common::fork_guard();
        Command::new("docker")
            .args(["pull", "alpine:latest"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    };
    let _ = pull.and_then(|mut c| c.wait());
    assert_never_interrupts("docker", json!({"image": "alpine:latest"}), Some(60)).await;
}

/// Shared body for the never-interrupt tests: open a `session_type` session
/// *before* the gated first poll, then prove the poll ran, took no action, and
/// left the session and binary intact. `session_wait_secs` widens the
/// session-activation wait for slower backends (Docker).
async fn assert_never_interrupts(
    session_type: &str,
    config: Value,
    session_wait_secs: Option<u64>,
) {
    let agent_bytes = std::fs::read(agent_binary()).expect("read agent bytes");
    let server = MockServer::start().await;
    mount_release(&server, &agent_bytes).await;

    // Generous first-poll delay so the session is established before it fires.
    let agent = LiveAgent::spawn(&server, "deferred", Duration::from_secs(6));
    let bin_inode_before = inode(&agent.bin_path).expect("binary present");

    let mut client = Client::connect(&agent.addr, Duration::from_secs(15))
        .expect("agent should be reachable before the first poll");
    let session_id = client.create_session(session_type, config);
    // Confirm the session is actually active before the poll can fire.
    let wait = Duration::from_secs(session_wait_secs.unwrap_or(15));
    assert!(
        wait_until(wait, || client.session_count() >= 1),
        "{session_type} session {session_id} did not become active in time.\n{}",
        client.failure_report(&agent)
    );

    // Wait for the poll to run (it records last_check_time at its start).
    let polled = wait_until(Duration::from_secs(30), || {
        !agent.state()["update"]["last_check_time"].is_null()
    });
    assert!(polled, "self-update poll never ran.\n{}", agent.stderr());
    // Give the poll a moment to (wrongly) act, if it were going to.
    std::thread::sleep(Duration::from_millis(500));

    // The guarantee: with an active session the poll neither staged nor applied.
    assert!(
        agent.state()["update"]["pending_update"].is_null(),
        "an active session must prevent staging/applying a self-update"
    );
    assert_eq!(
        inode(&agent.bin_path),
        Some(bin_inode_before),
        "the binary must not be swapped while a session is active"
    );
    // The session survived and the agent is still serving it.
    assert!(
        client.session_count() >= 1,
        "the active session must not be interrupted by the self-update check"
    );
    client.close_session(&session_id);
}

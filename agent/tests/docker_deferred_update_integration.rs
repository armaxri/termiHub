//! Live-agent integration test for the **deferred-update apply-on-last-disconnect**
//! cycle, driven through the `agent.request_deferred_update` RPC against a real
//! **Docker** container session (#1519, follow-up to #1352 / PR #1518).
//!
//! ## What this proves that the sibling suites do not
//!
//! The deferred-update machinery is already covered in three places, and each
//! deliberately stops short of the one thing this suite exercises:
//!
//! - **`agent/src/session/manager.rs` unit tests** drive `request_deferred_update`
//!   and the last-disconnect apply against an **injected** `UpdateApplier`, so
//!   nothing is really swapped or re-execed — the binary evidence is faked.
//! - **`deferred_update_hook_integration.rs` (#1546)** runs a live agent through
//!   the deferred *busy* path, but its staged path does not exist, so its
//!   last-disconnect apply is proven to **never swap the binary** (by inode).
//! - **`self_update_integration.rs` (#1401)** performs a real binary swap +
//!   re-exec over a live agent — but via the *idle self-update poll auto-apply*
//!   (`--allow-self-update`, the 24h timer path), never through the
//!   `agent.request_deferred_update` RPC, and its Docker case only asserts the
//!   poll takes no action while a session is active.
//!
//! This suite is the missing intersection: the **`request_deferred_update` RPC**
//! staging a **real** newer binary, deferring because a **real Docker container
//! session** is busy, and then performing a genuine **swap + re-exec on the last
//! session's disconnect** — the full apply-on-last-disconnect flow #1519 calls
//! for, end to end over a live agent. The three properties #1519 lists map to the
//! three assertions in [`deferred_update_applies_on_last_docker_disconnect`]:
//!
//! 1. `request_deferred_update` with a staged newer binary, while a Docker
//!    session is open, **defers** (`applied: false`, reporting the busy count)
//!    and does **not** swap the running binary — the active session is never
//!    interrupted.
//! 2. Closing that last session applies the update: the agent **swaps its binary
//!    (inode changes) and re-execs**, then comes back alive and announces its listener.
//! 3. The applied update leaves **no `pending_update`** behind (#1551) — the
//!    re-execed agent, whose executable is now byte-identical to the staged
//!    binary, sweeps the already-applied record at startup.
//!
//! ## The staged "newer" binary
//!
//! There is no second build to stage, so — exactly as `self_update_integration.rs`
//! does — the "newer" binary is a **copy of the agent's own bytes**: a real,
//! launchable agent that can come back up and serve the reconnect. The agent
//! reports its version from the compile-time `CARGO_PKG_VERSION`, so a copy of
//! the same build cannot make the re-execed agent report a literally higher
//! semver. The apply is therefore asserted **structurally** — the on-disk binary
//! is atomically replaced (its inode changes) and the agent answers again on the
//! swapped-in binary — which is precisely what "swaps + re-execs and returns"
//! means for a process that reports a compile-time version.
//!
//! The agent runs from a throwaway **copy** of the built binary so the real
//! self-replace overwrites *that* copy, never cargo's build artifact.
//!
//! Skips cleanly when Docker is unavailable, matching `docker_integration.rs`.
//! Unix-only: the self-replace + re-exec (`apply_update_binary`) is Unix-only.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tempfile::TempDir;

mod common;

/// Version label staged for the deferred update. Bookkeeping only — see the
/// module docs on why the re-execed agent still reports its compile-time version.
/// Chosen far above any real `CARGO_PKG_VERSION` so the #1551 startup prune keeps
/// the record on version evidence and can only drop it on *binary* evidence (the
/// running exe being byte-identical to the staged copy), which is what a genuine
/// apply establishes.
const STAGED_VERSION: &str = "9.9.9";

/// Container image for the busy session. Alpine is tiny and already used by
/// `docker_integration.rs` / `self_update_integration.rs`.
const IMAGE: &str = "alpine:latest";

// ── Binary + fs helpers ───────────────────────────────────────────────────────

fn agent_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_termihub-agent"))
}

fn inode(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.ino())
}

// ── Docker availability ───────────────────────────────────────────────────────

/// Forks under the fork lock even though it has nothing to do with the agent
/// binary: this `fork` inherits any write fd a sibling thread's `fs::copy`
/// currently holds, which is enough to make *that* thread's `execve` fail with
/// ETXTBSY. The hazard is the fork, not the binary (#1597). `spawn` + `wait` so
/// the lock covers only the fork-to-exec window, not the wait for the child.
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

/// Pre-pull the container image so session activation is not gated on a first-run
/// image download. Fork under the lock, wait outside it (#1597).
fn pull_image() {
    let pull = {
        let _fork_guard = common::fork_guard();
        Command::new("docker")
            .args(["pull", IMAGE])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    };
    let _ = pull.and_then(|mut c| c.wait());
}

// ── Live agent process ────────────────────────────────────────────────────────

/// A running `termihub-agent --listen` child on a fixed port, from a throwaway
/// copy of the binary so its self-replace is contained. No `--allow-self-update`
/// and no test hook: the *only* pending update this agent ever holds is the one a
/// client stages through `agent.request_deferred_update`.
struct LiveAgent {
    child: Child,
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
    fn spawn() -> Self {
        let install_dir = TempDir::new().expect("install dir");
        let bin_path = install_dir.path().join("termihub-agent");
        let config_home = TempDir::new().expect("config home");

        let stderr_file = tempfile::NamedTempFile::new().expect("stderr file");
        let stderr_path = stderr_file.path().to_path_buf();
        let (stderr_handle, _keep) = stderr_file.keep().expect("persist stderr file");

        // Copy → chmod → spawn under the fork lock: a sibling thread forking
        // mid-copy inherits our write fd and makes our own execve fail with
        // ETXTBSY (#1597). See `common::fork_guard`.
        let fork_guard = common::fork_guard();
        std::fs::copy(agent_binary(), &bin_path).expect("copy agent binary");
        std::fs::set_permissions(&bin_path, std::fs::Permissions::from_mode(0o755))
            .expect("chmod agent copy");

        let child = Command::new(&bin_path)
            .arg("--listen")
            // Port 0: the agent binds an OS-assigned port and announces it; the
            // suite reads it back from the log (see `LiveAgent::addr`, #3533).
            .arg("127.0.0.1:0")
            .env("XDG_CONFIG_HOME", config_home.path())
            .env("RUST_LOG", "info")
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

    /// The agent-owned staging dir a pushed update binary may legitimately live
    /// in — the same `<config>/updates` the apply-path confinement trusts.
    fn staging_dir(&self) -> PathBuf {
        self.config_home
            .path()
            .join("termihub-agent")
            .join("updates")
    }

    /// The agent's persisted `state.json`, or `Null` before it is first written.
    fn state(&self) -> Value {
        match std::fs::read_to_string(self.state_json_path()) {
            Ok(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        }
    }

    fn stderr(&self) -> String {
        std::fs::read_to_string(&self.stderr_path).unwrap_or_default()
    }

    /// The address the agent's `generation`-th incarnation listens on (`0` = as
    /// spawned, `1` = after the first self-apply re-exec), read from its
    /// `Listening on` log line. The agent runs on `--listen 127.0.0.1:0`, so a
    /// re-exec re-binds a fresh OS-assigned port (#3533).
    fn addr(&self, generation: usize) -> String {
        common::wait_for_listen_addr(&self.stderr_path, generation, Duration::from_secs(30))
            .unwrap_or_else(|| {
                panic!(
                    "agent incarnation {generation} never logged a `Listening on` address.\n\
                     --- agent stderr ---\n{}",
                    self.stderr()
                )
            })
    }

    /// The agent's `XDG_CONFIG_HOME` (holds `termihub-agent/listen-auth.token`).
    fn config_home(&self) -> &Path {
        self.config_home.path()
    }
}

// ── Waiting helper ─────────────────────────────────────────────────────────────

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

// ── Minimal NDJSON JSON-RPC client ─────────────────────────────────────────────

struct Client {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
    next_id: i64,
}

impl Client {
    /// Connect and complete the `initialize` handshake, retrying until the agent
    /// answers or `timeout` elapses (it may still be mid-restart after a
    /// self-apply). Each handshake read is bounded well below the overall budget
    /// so a single stalled read leaves retries (#1579).
    fn connect(addr: &str, config_home: &Path, timeout: Duration) -> Option<Self> {
        let deadline = Instant::now() + timeout;
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
                // Auth gate first (AGT-002/SEC-004). Re-read the token each
                // attempt: a self-apply re-execs the agent and regenerates its
                // per-instance token, so a captured token would go stale across
                // the restart. A failure drops to a fresh-socket retry, as a
                // failed `initialize` does.
                let token = common::read_listen_token(config_home);
                if !client.authenticate(&token) {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                let resp = client.rpc(
                    "initialize",
                    json!({"protocolVersion": "0.3.0", "client": "docker-deferred-it", "clientVersion": "0.1.0"}),
                );
                if resp.get("result").is_some() {
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

    /// Complete the `--listen` auth handshake (AGT-002/SEC-004) before any RPC.
    /// Returns `false` on any failure so `connect` retries on a fresh socket.
    fn authenticate(&mut self, token: &str) -> bool {
        let line = common::auth_request_line(token);
        if writeln!(self.writer, "{line}")
            .and_then(|()| self.writer.flush())
            .is_err()
        {
            return false;
        }
        let mut resp = String::new();
        match self.reader.read_line(&mut resp) {
            Ok(n) if n > 0 => serde_json::from_str::<Value>(resp.trim())
                .ok()
                .and_then(|v| v["result"]["authenticated"].as_bool())
                .unwrap_or(false),
            _ => false,
        }
    }

    /// Send an RPC and return the matching response, skipping notifications. A
    /// read error/close (the agent re-execing mid-call) is reported as `Null` so
    /// the caller can simply reconnect.
    fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(self.writer, "{req}").expect("write request");
        self.writer.flush().expect("flush");

        loop {
            let mut line = String::new();
            let n = match self.reader.read_line(&mut line) {
                Ok(n) => n,
                Err(_) => return Value::Null,
            };
            if n == 0 {
                return Value::Null;
            }
            let Ok(msg): Result<Value, _> = serde_json::from_str(line.trim()) else {
                continue;
            };
            if msg.get("id").and_then(Value::as_i64) == Some(id) {
                return msg;
            }
            // A notification or a response for another id — keep reading.
        }
    }

    fn agent_version(&mut self) -> String {
        let resp = self.rpc(
            "initialize",
            json!({"protocolVersion": "0.3.0", "client": "docker-deferred-it", "clientVersion": "0.1.0"}),
        );
        resp["result"]["agent_version"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    fn create_session(&mut self, session_type: &str, config: Value) -> String {
        let resp = self.rpc(
            "connection.create",
            json!({"type": session_type, "config": config, "title": "docker-deferred-test"}),
        );
        resp["result"]["session_id"]
            .as_str()
            .unwrap_or_else(|| panic!("connection.create failed: {resp}"))
            .to_string()
    }

    fn session_list_raw(&mut self) -> Value {
        self.rpc("connection.list", json!({}))
    }

    fn session_count(&mut self) -> usize {
        self.session_list_raw()["result"]["sessions"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0)
    }

    fn close_session(&mut self, session_id: &str) -> Value {
        self.rpc("connection.close", json!({"session_id": session_id}))
    }

    /// Stage `binary_path` as a deferred update and ask the agent to apply it —
    /// the `agent.request_deferred_update` RPC (#1352). Returns the raw response.
    fn request_deferred_update(&mut self, binary_path: &Path, version: &str) -> Value {
        // AGT-004: the apply path re-verifies the staged bytes against this
        // digest before the swap, so a coordinated/pushed update must carry it.
        let expected_sha256 = sha256_hex_of_file(binary_path);
        self.rpc(
            "agent.request_deferred_update",
            json!({
                "binaryPath": binary_path,
                "version": version,
                "expectedSha256": expected_sha256,
            }),
        )
    }

    /// Diagnostics for a failing assertion in one CI hit: what the agent lists,
    /// its persisted state, and its stderr.
    fn failure_report(&mut self, agent: &LiveAgent) -> String {
        let raw = self.session_list_raw();
        format!(
            "--- agent listen addrs ---\n{}\n--- raw connection.list ---\n{raw}\n\
             --- persisted state.json ---\n{}\n--- agent stderr ---\n{}",
            common::listen_addrs(&agent.stderr()).join(", "),
            agent.state(),
            agent.stderr()
        )
    }
}

// ── Staged binary ──────────────────────────────────────────────────────────────

/// Stage a real, launchable "newer" agent binary into `staging_dir`: a copy of
/// the agent's own bytes, marked executable, that the deferred apply can swap in
/// and re-exec. Staged inside the agent's trusted `<config>/updates` dir so the
/// apply-path confinement (AGT-003) accepts it.
fn stage_newer_binary(staging_dir: &Path) -> PathBuf {
    std::fs::create_dir_all(staging_dir).expect("create staging dir");
    let staged = staging_dir.join("termihub-agent-newer");

    // Copy + chmod under the fork lock: a sibling thread forking mid-copy would
    // inherit our write fd and could ETXTBSY its own execve (#1597).
    let fork_guard = common::fork_guard();
    std::fs::copy(agent_binary(), &staged).expect("copy staged binary");
    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
        .expect("chmod staged binary");
    drop(fork_guard);

    staged
}

/// Lowercase-hex SHA-256 of a file's contents (mirrors the agent's
/// `update::checksum::sha256_hex_of_file`), used to send the AGT-004
/// `expectedSha256` the apply path re-verifies against.
fn sha256_hex_of_file(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).expect("read staged binary for checksum");
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    hex::encode(hasher.finalize())
}

// ── Test ───────────────────────────────────────────────────────────────────────

/// The #1519 flow end to end, against a real Docker container session:
///
/// 1. Open a Docker session, then `request_deferred_update` with a staged newer
///    binary → **deferred** (`applied: false`, one active session) and the binary
///    is **not** swapped: the active session is never interrupted.
/// 2. Close that last session → the agent **swaps its binary and re-execs**, and
///    answers again on the listener its new incarnation announces.
/// 3. The successful apply leaves **no `pending_update`** (#1551).
#[tokio::test]
#[ignore = "docker: real-daemon test, runs in the nightly integration lane via `cargo test -- --ignored`; see TIN-008"]
async fn deferred_update_applies_on_last_docker_disconnect() {
    if !docker_available() {
        eprintln!("Skipping: Docker not available");
        return;
    }
    // Pre-pull so the container starts fast enough for the session to activate.
    pull_image();

    let agent = LiveAgent::spawn();
    // Stage the newer binary inside the agent's trusted staging dir so the
    // apply-path confinement (AGT-003, #3214) accepts it; the harness sends its
    // SHA-256 so the AGT-004 integrity gate accepts it too.
    let staged_bin = stage_newer_binary(&agent.staging_dir());
    let mut client = Client::connect(&agent.addr(0), agent.config_home(), Duration::from_secs(30))
        .unwrap_or_else(|| panic!("agent never came up.\n{}", agent.stderr()));

    // ── Open a real Docker container session ────────────────────────────────
    let session_id = client.create_session("docker", json!({"image": IMAGE}));
    assert!(
        wait_until(Duration::from_secs(60), || client.session_count() >= 1),
        "docker session {session_id} did not become active in time.\n{}",
        client.failure_report(&agent)
    );

    let inode_before = inode(&agent.bin_path).expect("binary present before apply");

    // ── (1) Request a deferred update while busy → deferred, no swap ─────────
    let resp = client.request_deferred_update(&staged_bin, STAGED_VERSION);
    let result = &resp["result"];
    assert_eq!(
        result["applied"], false,
        "a busy agent must defer, never apply immediately: {resp}"
    );
    assert_eq!(
        result["activeSessions"], 1,
        "the deferred response must report the session holding it up: {resp}"
    );
    // The update is staged in persisted state, ready for the last disconnect.
    assert_eq!(
        agent.state()["update"]["pending_update"]["version"],
        STAGED_VERSION,
        "the staged update must be recorded while deferred: {}",
        agent.state()
    );
    // Never-interrupt: the running binary is untouched and the session survives.
    assert_eq!(
        inode(&agent.bin_path),
        Some(inode_before),
        "the binary must NOT be swapped while a session is active"
    );
    assert!(
        client.session_count() >= 1,
        "the active docker session must not be interrupted by the deferred request.\n{}",
        client.failure_report(&agent)
    );

    // ── (2) Close the last session → apply on last disconnect → swap + re-exec ─
    // The close handler applies the update in-line and re-execs, so its RPC
    // response never comes back (the connection drops mid-call) — expected.
    let _ = client.close_session(&session_id);

    let swapped = wait_until(Duration::from_secs(30), || {
        inode(&agent.bin_path).is_some_and(|i| i != inode_before)
    });
    assert!(
        swapped,
        "closing the last session must swap the agent binary (inode change) within 30s.\n{}",
        agent.stderr()
    );

    // It re-execed with the same args → its second incarnation announces a fresh
    // listener (the args say port 0) → reconnect succeeds and the agent is
    // healthy on the swapped-in binary.
    let mut client = Client::connect(&agent.addr(1), agent.config_home(), Duration::from_secs(30))
        .unwrap_or_else(|| {
            panic!(
                "agent did not come back after the deferred apply + re-exec.\n{}",
                agent.stderr()
            )
        });
    assert!(
        !client.agent_version().is_empty(),
        "re-execed agent did not report a version.\n{}",
        agent.stderr()
    );

    // ── (3) A successful apply leaves no pending_update (#1551) ──────────────
    // The re-exec never returns, so the in-process clear cannot run; the
    // re-execed agent — now byte-identical to the staged binary — sweeps the
    // already-applied record at startup instead.
    let cleared = wait_until(Duration::from_secs(15), || {
        agent.state()["update"]["pending_update"].is_null()
    });
    assert!(
        cleared,
        "a successful deferred apply must leave no pending_update; state was {}\n{}",
        agent.state(),
        agent.stderr()
    );
}

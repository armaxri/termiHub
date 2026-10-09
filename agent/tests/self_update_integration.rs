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
use std::net::TcpStream;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use termihub_core::test_fixtures;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

mod common;

use common::parent_death::GuardedSpawn;

/// Published asset suffix the mock release advertises. Forced via
/// `TERMIHUB_AGENT_UPDATE_ASSET_SUFFIX` so the test is independent of the host
/// architecture (the real `current_asset_suffix()` only resolves on Linux).
const AGENT_SUFFIX: &str = "linux-x64";

/// A version far above any real `CARGO_PKG_VERSION`, so the poll always sees it
/// as "newer" and stages it.
const NEWER_TAG: &str = "v9.9.9";
const NEWER_VERSION: &str = "9.9.9";

/// Fragment of the `warn!` the self-update poll logs once an apply has failed
/// and the staged update is kept (`run_check_once` in `agent/src/update/mod.rs`).
const FAILED_APPLY_LOG: &str = "keeping it staged for retry";

/// How long to wait for the self-update pipeline to reach a stage, apply or
/// failed-apply outcome after the agent starts.
///
/// The pipeline downloads the ~100 MB debug agent, hashes it, scans it for its
/// build version, and on apply re-hashes, re-scans and copies it twice. That is
/// all CPU- and IO-bound work in an unoptimised build, so its wall time scales
/// with host load. From the first poll to `staged` alone, measured on macOS
/// with this suite's agents running in parallel: about 6 s at a load average
/// near 40, 25–28 s near 250, and 43 s near 450. At load ~450 the apply began
/// only 63 s after the poll and had not finished swapping 120 s in. The old
/// 30 s budget was already too short at load ~250 (#3811). This is not a
/// queue that a longer timeout only postpones, like the first-exec check (see
/// [`prewarm_first_exec`]). The work is finite and just runs slower, so the
/// budget has to cover it. The value is a ceiling, not a wait: a passing run
/// returns as soon as the outcome is observed.
const UPDATE_PIPELINE_TIMEOUT: Duration = Duration::from_secs(240);

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

/// Execute a freshly written agent copy once with `--version`, so the OS's
/// first-exec check is paid here, before any test deadline starts (#3811).
///
/// **Why.** On macOS the first exec of a newly written executable is held while
/// the system assesses it. For the ~100 MB debug agent that takes about 2 s, and
/// the assessments run one at a time host-wide. Every [`LiveAgent`] runs its own
/// copy, so with the suite's agents starting in parallel the n-th one used to
/// reach `main` only after about 2n s, all of it inside its startup budget.
/// Under load, or with other checkouts' suites in the same queue, that pushed
/// agents past the budget. The sibling suite hit exactly this (#3796).
///
/// **Why not one shared, pre-warmed copy, as `deferred_update_hook_integration`
/// does.** These agents really swap their binary, and the tests assert on the
/// copy's inode and make its directory read-only, so each agent needs its own
/// file. Copying from an already-warmed copy does not help either: the check is
/// per file, not per content. Measured on macOS, three trials each: a fresh
/// `cp` of the build artifact took 1.96–2.24 s on first exec, a `cp` of an
/// already-warmed copy 2.24–2.34 s, a hard link to a warmed copy 0.77–0.80 s,
/// and a rename of a warmed copy 0.03 s, the same as a warm exec. So each copy
/// is warmed itself.
///
/// The swapped-in binary that the agent writes and re-execs is a new file too,
/// and pays the check once more. That cost is part of the self-update the tests
/// exercise and stays inside their budgets.
fn prewarm_first_exec(bin_path: &Path) {
    // `spawn` forks, so it takes the fork lock (#1597). The wait does not: the
    // check can take seconds, and siblings must be free to fork meanwhile.
    let mut child = {
        let _fork_guard = common::fork_guard();
        Command::new(bin_path)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("run agent copy --version")
    };
    let status = child.wait().expect("wait for agent copy --version");
    assert!(status.success(), "agent copy --version failed: {status}");
}

/// A running `termihub-agent --listen` child, pointed at the mock GitHub server,
/// running from a throwaway copy of the binary so its self-replace is contained.
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
    /// Copy the agent binary into a private dir and spawn it with self-update
    /// enabled, pointed at `server`. `initial_delay` gates the first poll so a
    /// caller can open a session before it fires.
    fn spawn(server: &MockServer, strategy: &str, initial_delay: Duration) -> Self {
        let install_dir = TempDir::new().expect("install dir");
        let bin_path = install_dir.path().join("termihub-agent");

        let config_home = TempDir::new().expect("config home");

        let stderr_file = tempfile::NamedTempFile::new().expect("stderr file");
        let stderr_path = stderr_file.path().to_path_buf();
        let (stderr_handle, _keep) = stderr_file.keep().expect("persist stderr file");

        // The copy runs under the fork lock: a sibling thread forking mid-copy
        // inherits our write fd and makes a later execve of this file fail
        // with ETXTBSY (#1597). See `common::fork_guard`. Once the copy is
        // done the fd is closed, so the lock can be dropped until the next
        // fork.
        {
            let _fork_guard = common::fork_guard();
            std::fs::copy(agent_binary(), &bin_path).expect("copy agent binary");
            std::fs::set_permissions(&bin_path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod agent copy");
        }
        prewarm_first_exec(&bin_path);

        // The spawn is a fork site, so it takes the fork lock (#1597).
        let fork_guard = common::fork_guard();
        let child = Command::new(&bin_path)
            .arg("--listen")
            // Port 0: the agent binds an OS-assigned port and announces it; the
            // suite reads it back from the log (see `LiveAgent::addr`, #3533).
            .arg("127.0.0.1:0")
            .arg("--allow-self-update")
            .arg("--update-strategy")
            .arg(strategy)
            .env("XDG_CONFIG_HOME", config_home.path())
            // Keep off the developer's live registry; bound leaked daemons (#3636).
            .envs(common::isolated_registry_env(config_home.path()))
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
            .spawn_guarded()
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
    /// Decoded `connection.output` bytes seen so far, from any read path, so a
    /// shell's output that arrives while an RPC waits for its response is kept
    /// rather than skipped.
    output: Vec<u8>,
    /// Other notifications seen while waiting for an RPC response, oldest
    /// first, for [`Self::wait_for_notification`].
    notifications: Vec<Value>,
}

impl Client {
    /// Connect and complete the `initialize` handshake, retrying until the agent
    /// is listening (it may still be mid-restart after a self-apply).
    fn connect(addr: &str, config_home: &Path, timeout: Duration) -> Option<Self> {
        // Re-read the token on every attempt: a self-apply **re-execs** the
        // agent, which regenerates its per-instance token, so a token captured
        // before the restart would be stale. Reading the file each attempt lets
        // the retry loop converge on the re-execed agent's fresh token.
        Self::connect_as(addr, timeout, "self-update-it", || {
            common::read_listen_token(config_home)
        })
    }

    /// [`connect`](Self::connect) for a named desktop (`client` in
    /// `initialize`, which `agent.list_connections` reports), taking the auth
    /// token from `token` on each attempt. Used when several workers share one
    /// config dir, and so one token file, and a caller has to keep the token of
    /// a worker that is no longer the file's last writer.
    fn connect_as(
        addr: &str,
        timeout: Duration,
        client_name: &str,
        token: impl Fn() -> String,
    ) -> Option<Self> {
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
                    output: Vec::new(),
                    notifications: Vec::new(),
                };
                // Auth handshake first (AGT-002/SEC-004).
                if !client.authenticate(&token()) {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                let resp = client.rpc(
                    "initialize",
                    json!({"protocolVersion": "0.3.0", "client": client_name, "clientVersion": "0.1.0"}),
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

    /// Complete the `--listen` auth handshake (AGT-002/SEC-004) before any RPC.
    ///
    /// Returns `false` on any write/read failure or a non-accepting response, so
    /// the `connect` retry loop tries again on a fresh socket — the same
    /// tolerance the racing `rpc` path uses during the agent's re-exec window.
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
            // otherwise a notification (or a response to an earlier id): keep
            // it for the output/notification waits and keep reading
            self.keep(msg);
        }
    }

    /// Buffer a message that is not the response being waited for.
    fn keep(&mut self, msg: Value) {
        if msg.get("id").is_some() {
            return;
        }
        if msg["method"] == "connection.output" {
            let data = msg["params"]["data"].as_str().unwrap_or_default();
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
                self.output.extend(bytes);
            }
        } else {
            self.notifications.push(msg);
        }
    }

    /// Read and buffer messages until `done` holds or `timeout` elapses.
    /// Returns whether `done` held. Each read is bounded, so the loop re-checks
    /// promptly; a closed connection ends the wait at once.
    fn pump_until(&mut self, timeout: Duration, mut done: impl FnMut(&Self) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        let socket = self.reader.get_ref().try_clone().expect("clone stream");
        let result = loop {
            if done(self) {
                break true;
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break false;
            };
            socket
                .set_read_timeout(Some(remaining.min(Duration::from_millis(200))))
                .expect("set read timeout");
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(0) => break done(self),
                Ok(_) => {
                    if let Ok(msg) = serde_json::from_str::<Value>(line.trim()) {
                        self.keep(msg);
                    }
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => break done(self),
            }
        };
        socket
            .set_read_timeout(Some(Duration::from_secs(15)))
            .expect("restore read timeout");
        result
    }

    /// Wait until the session output seen on this connection contains `needle`.
    fn wait_for_output(&mut self, needle: &str, timeout: Duration) -> bool {
        self.pump_until(timeout, |c| {
            String::from_utf8_lossy(&c.output).contains(needle)
        })
    }

    /// Wait for a notification named `method` and return it.
    fn wait_for_notification(&mut self, method: &str, timeout: Duration) -> Option<Value> {
        self.pump_until(timeout, |c| {
            c.notifications.iter().any(|n| n["method"] == method)
        });
        self.notifications
            .iter()
            .find(|n| n["method"] == method)
            .cloned()
    }

    /// Type `data` into a session.
    fn write_input(&mut self, session_id: &str, data: &str) -> Value {
        let encoded = base64::engine::general_purpose::STANDARD.encode(data.as_bytes());
        self.rpc(
            "connection.write",
            json!({"session_id": session_id, "data": encoded}),
        )
    }

    /// Run `printf '%s-%s\n' <word> <tag>` in a session and wait for its
    /// `<word>-<tag>` output. The typed command echoes `<word> <tag>`, never
    /// the joined form, so only the shell actually running it can produce the
    /// needle.
    fn run_marker(&mut self, session_id: &str, word: &str, tag: &str) -> bool {
        let written = self.write_input(session_id, &format!("printf '%s-%s\\n' {word} {tag}\n"));
        assert!(
            written.get("result").is_some(),
            "connection.write to {session_id} failed: {written}"
        );
        self.wait_for_output(&format!("{word}-{tag}"), Duration::from_secs(30))
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
            "--- agent listen addrs ---\n{}\n\
             --- raw connection.list ---\n{raw}\n\
             --- listed sessions ---\n  {ids}\n\
             --- persisted state.json ---\n{}\n\
             --- agent stderr ---\n{}",
            common::listen_addrs(&agent.stderr()).join(", "),
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

/// Whether the Docker tests should run: `true` with a reachable daemon; with
/// none, skip — or panic under `TERMIHUB_REQUIRE_DOCKER`, which the nightly
/// agent-Docker lane sets so the suite cannot go green by skipping (#4338).
fn docker_ready() -> bool {
    test_fixtures::require(
        docker_available(),
        test_fixtures::REQUIRE_DOCKER_ENV,
        "Docker not available (`docker info` failed)",
        DOCKER_HINT,
    )
}

/// How to provide what the Docker tests need.
const DOCKER_HINT: &str = "needs a running Docker daemon that can pull and run Linux images";

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
    let swapped = wait_until(UPDATE_PIPELINE_TIMEOUT, || {
        inode(&agent.bin_path).is_some_and(|i| i != bin_inode_before)
    });
    assert!(
        swapped,
        "agent did not swap its binary on idle within {UPDATE_PIPELINE_TIMEOUT:?}.\n--- agent stderr ---\n{}",
        agent.stderr()
    );

    // The staged, verified binary landed under the isolated staging dir (the
    // re-execed agent removes it once it has confirmed the apply — asserted
    // below — so it is identified here and checked at the end).
    let staged = agent
        .staging_dir()
        .join(format!("termihub-agent-{AGENT_SUFFIX}"));

    // It re-execed with the same args → its second incarnation announces a fresh
    // listener (the args say port 0) → reconnect succeeds and the agent is
    // healthy on the swapped-in binary.
    let mut client = Client::connect(&agent.addr(1), agent.config_home(), Duration::from_secs(30))
        .unwrap_or_else(|| {
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

    // The applied upload does not linger in the staging dir (AGT2-002, #4287).
    assert!(
        wait_until(Duration::from_secs(15), || !staged.exists()),
        "the applied staged binary {staged:?} must be removed after the apply"
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
    let swapped = wait_until(UPDATE_PIPELINE_TIMEOUT, || {
        inode(&agent.bin_path).is_some_and(|i| i != bin_inode_before)
    });
    assert!(
        swapped,
        "agent did not swap its binary on idle within {UPDATE_PIPELINE_TIMEOUT:?}.\n--- agent stderr ---\n{}",
        agent.stderr()
    );

    let mut client = Client::connect(&agent.addr(1), agent.config_home(), Duration::from_secs(30))
        .unwrap_or_else(|| {
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
    let staged = wait_until(UPDATE_PIPELINE_TIMEOUT, || {
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
    let mut client = Client::connect(&agent.addr(0), agent.config_home(), Duration::from_secs(15))
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

    // Wait for the apply to have actually *failed* before restoring write perms.
    // `pending_update` alone is not that signal: `request_deferred_update`
    // persists it at staging, *before* the apply runs, and the apply then
    // re-hashes, re-verifies and version-scans the staged binary (#3213) before
    // it touches the install dir. Restoring perms on `pending_update` alone
    // raced that window — a slow (coverage-instrumented) agent reached the swap
    // after the restore, applied for real and re-execed onto a new port.
    let apply_failed = wait_until(UPDATE_PIPELINE_TIMEOUT, || {
        agent.stderr().contains(FAILED_APPLY_LOG)
    });
    // Restore write perms so the TempDir can be cleaned up on drop.
    set_dir_mode(&install_dir, 0o755);

    assert!(
        apply_failed,
        "apply never failed against the read-only install dir.\n{}",
        agent.stderr()
    );
    // The failed apply keeps the staged update recorded for retry.
    assert!(
        !agent.state()["update"]["pending_update"].is_null(),
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
    let mut client = Client::connect(&agent.addr(0), agent.config_home(), Duration::from_secs(15))
        .expect("agent should keep running after a failed apply");
    assert!(!client.agent_version().is_empty());
}

/// A "new binary" that stages and swaps cleanly but whose `execve` fails with
/// `ENOEXEC` on every Unix kernel: no ELF / Mach-O / `#!` magic, just bytes.
/// This is the shape of a corrupt or wrong-format download that nonetheless
/// matches its published SHA-256.
///
/// It is deliberately *binary* (NULs, high bytes), not text: were the agent to
/// hand an `ENOEXEC` file to `/bin/sh` — which `execvp` does, and which is how
/// the revert was once bypassed (#3064) — the shell refuses to run it and exits,
/// taking the agent with it, rather than silently running it as a script.
fn unexecutable_agent_bytes() -> Vec<u8> {
    let mut bytes = b"\0TERMIHUB-TEST: not an executable image\0".to_vec();
    bytes.extend((0..4096u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8));
    bytes
}

/// AGT-006 end to end (#3064): the verified update stages and the swap
/// succeeds, but the new binary cannot be `execve`d. The apply must revert the
/// on-disk binary to the previous working one from `<exe>.backup`, keep the
/// agent process alive and reachable on its original listener, leave no backup
/// behind, and retain `pending_update` for a retry (the apply returned `Err`).
///
/// A successful `execve` replaces the process image, so this path can only be
/// proven with a live agent process — the revert logic itself is unit-tested in
/// `agent/src/update/apply.rs`.
#[tokio::test]
async fn failed_reexec_reverts_to_the_previous_binary() {
    let original_bytes = std::fs::read(agent_binary()).expect("read agent bytes");
    let original_sha = sha256_hex(&original_bytes);
    drop(original_bytes);
    let bad_bytes = unexecutable_agent_bytes();

    let server = MockServer::start().await;
    mount_release(&server, &bad_bytes).await;

    let mut agent = LiveAgent::spawn(&server, "deferred", Duration::from_millis(300));
    let pid = agent.child.id();
    let bin_path = agent.bin_path.clone();
    let backup_path = {
        let mut name = bin_path.file_name().unwrap().to_os_string();
        name.push(".backup");
        bin_path.with_file_name(name)
    };

    // Wait for the apply to report failure — or for the agent to die, which is
    // exactly the regression this guards against, so stop waiting at once.
    let mut exited = None;
    let apply_failed = wait_until(UPDATE_PIPELINE_TIMEOUT, || {
        if let Ok(Some(status)) = agent.child.try_wait() {
            exited = Some(status);
            return true;
        }
        agent.stderr().contains(FAILED_APPLY_LOG)
    });
    assert!(
        exited.is_none(),
        "the agent process died on the failed re-exec ({:?}) instead of reverting.\n\
         --- agent stderr ---\n{}",
        exited,
        agent.stderr()
    );
    assert!(
        apply_failed,
        "the self-apply never reported a failed re-exec within {UPDATE_PIPELINE_TIMEOUT:?}.\n\
         --- agent stderr ---\n{}",
        agent.stderr()
    );

    // It failed at the re-exec — after a successful swap — and reverted, not
    // at some earlier guard (which `failed_apply_keeps_pending_update` covers).
    let log = agent.stderr();
    assert!(
        log.contains("re-exec of") && log.contains("failed"),
        "the apply failed, but not at the re-exec.\n--- agent stderr ---\n{log}"
    );
    assert!(
        log.contains("restored the previous working binary"),
        "the failed re-exec did not restore the backup.\n--- agent stderr ---\n{log}"
    );

    // Still the original process, never replaced: alive, same PID, and it never
    // announced a second listener.
    assert!(
        matches!(agent.child.try_wait(), Ok(None)),
        "agent must survive a failed re-exec.\n{}",
        agent.stderr()
    );
    assert_eq!(agent.child.id(), pid);
    assert_eq!(
        common::listen_addrs(&log).len(),
        1,
        "a failed re-exec must not start a second agent incarnation.\n{log}"
    );

    // The on-disk binary is the restored original: byte-identical, executable,
    // and actually runnable. The backup was consumed by the restore.
    let on_disk = std::fs::read(&bin_path).expect("agent binary present after revert");
    assert_eq!(
        sha256_hex(&on_disk),
        original_sha,
        "the on-disk agent must be the restored original binary, not the bad one"
    );
    drop(on_disk);
    let mode = std::fs::metadata(&bin_path).unwrap().permissions().mode();
    assert_eq!(mode & 0o111, 0o111, "restored binary must stay executable");
    assert!(
        !backup_path.exists(),
        "the backup {backup_path:?} must be consumed by the restore"
    );
    prewarm_first_exec(&bin_path);

    // The apply returned `Err`, so the staged update is kept for a retry.
    let pending = agent.state()["update"]["pending_update"].clone();
    assert!(
        !pending.is_null(),
        "a failed re-exec must keep pending_update for retry.\n{}",
        agent.stderr()
    );
    assert_eq!(pending["version"], NEWER_VERSION);

    // And the surviving agent still serves on its original listener.
    let mut client = Client::connect(&agent.addr(0), agent.config_home(), Duration::from_secs(15))
        .unwrap_or_else(|| {
            panic!(
                "agent not reachable after a reverted re-exec.\n{}",
                agent.stderr()
            )
        });
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
#[ignore = "docker: real-daemon test, runs in the nightly integration lane via `cargo test -- --ignored`; see TIN-008"]
async fn active_docker_session_is_never_interrupted() {
    if !docker_ready() {
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

    let mut client = Client::connect(&agent.addr(0), agent.config_home(), Duration::from_secs(15))
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

// ── One host, several desktops (#1401, #1349) ───────────────────────────────
//
// On a real host every desktop gets its own agent **worker** process (`--stdio`
// over its SSH link), all run from the one installed binary and sharing the
// user's config dir: one `state.json`, one staging dir, one host-wide registry
// (ADR-11). A `--listen` agent serves a single client at a time, so the suite
// models each desktop's link as its own `--listen` worker over a shared
// `XDG_CONFIG_HOME` and a shared install dir. Ending a desktop's connection
// ends its worker, as an SSH disconnect ends a `--stdio` one.

/// The shared side of one simulated host: the installed agent binary and the
/// config dir every worker on it uses.
struct Host {
    _install_dir: TempDir,
    bin_path: PathBuf,
    home: TempDir,
}

impl Host {
    fn new() -> Self {
        let install_dir = TempDir::new().expect("install dir");
        let bin_path = install_dir.path().join("termihub-agent");
        {
            // Copy under the fork lock (#1597), as `LiveAgent::spawn` does.
            let _fork_guard = common::fork_guard();
            std::fs::copy(agent_binary(), &bin_path).expect("copy agent binary");
            std::fs::set_permissions(&bin_path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod agent copy");
        }
        prewarm_first_exec(&bin_path);
        Host {
            _install_dir: install_dir,
            bin_path,
            home: TempDir::new().expect("host config home"),
        }
    }

    fn agent_dir(&self) -> PathBuf {
        self.home.path().join("termihub-agent")
    }

    fn state(&self) -> Value {
        std::fs::read_to_string(self.agent_dir().join("state.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null)
    }

    /// The host-wide registry endpoint the workers share (see
    /// [`common::isolated_registry_env`]).
    fn registry_endpoint(&self) -> String {
        self.home
            .path()
            .join("registry.sock")
            .to_string_lossy()
            .into_owned()
    }

    /// Start a `--listen` worker from the installed binary with `args` and
    /// `envs`, wait for it to listen, and capture its auth token.
    ///
    /// Workers share the token file, so the token is read right after this
    /// worker announced its listener and before any other worker is started:
    /// at that point the file holds this worker's token.
    fn spawn_worker(&self, args: &[&str], envs: &[(&str, String)]) -> Worker {
        let stderr_file = tempfile::NamedTempFile::new().expect("stderr file");
        let stderr_path = stderr_file.path().to_path_buf();
        let (stderr_handle, _keep) = stderr_file.keep().expect("persist stderr file");

        let fork_guard = common::fork_guard();
        let child = Command::new(&self.bin_path)
            .args(["--listen", "127.0.0.1:0"])
            .args(args)
            .env("XDG_CONFIG_HOME", self.home.path())
            .envs(common::isolated_registry_env(self.home.path()))
            .envs(envs.iter().map(|(k, v)| (*k, v.as_str())))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr_handle))
            .spawn_guarded()
            .expect("spawn agent worker");
        drop(fork_guard);

        let mut worker = Worker {
            child,
            stderr_path,
            token: String::new(),
        };
        worker.addr(0);
        worker.token = common::read_listen_token(self.home.path());
        worker
    }
}

/// One desktop's agent worker on a [`Host`].
struct Worker {
    child: Child,
    stderr_path: PathBuf,
    /// This worker's own auth token (the shared file may since hold another's).
    token: String,
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Worker {
    fn stderr(&self) -> String {
        std::fs::read_to_string(&self.stderr_path).unwrap_or_default()
    }

    /// The listener of the worker's `generation`-th incarnation.
    fn addr(&self, generation: usize) -> String {
        common::wait_for_listen_addr(&self.stderr_path, generation, Duration::from_secs(30))
            .unwrap_or_else(|| {
                panic!(
                    "worker incarnation {generation} never logged a `Listening on` address.\n\
                     --- worker stderr ---\n{}",
                    self.stderr()
                )
            })
    }

    /// Connect as desktop `name` with this worker's own token.
    fn connect(&self, name: &str) -> Client {
        let token = self.token.clone();
        Client::connect_as(&self.addr(0), Duration::from_secs(30), name, move || {
            token.clone()
        })
        .unwrap_or_else(|| panic!("desktop {name} could not connect.\n{}", self.stderr()))
    }

    fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

/// Reaps what a test leaves running outside its own `Child` handles if it
/// fails midway: the shell's session daemon and the host's registry daemon.
/// Each is killed by the exact PID serving its endpoint (see
/// [`common::daemon_reaper`]), and only if it still serves it.
#[derive(Default)]
struct DaemonReapers(Vec<common::daemon_reaper::DaemonGuard>);

impl DaemonReapers {
    fn watch(&mut self, endpoint: &str) {
        if wait_until(Duration::from_secs(10), || {
            std::os::unix::net::UnixStream::connect(endpoint).is_ok()
        }) {
            if let Some(guard) = common::daemon_reaper::DaemonGuard::discover(endpoint) {
                self.0.push(guard);
            }
        }
    }
}

/// Open a persistent shell session as `desktop` and prove it runs, returning
/// its id. Shell sessions are daemon-backed (persistent) on unix.
fn open_persistent_shell(desktop: &mut Client, reapers: &mut DaemonReapers, tag: &str) -> String {
    let session_id = desktop.create_session("shell", json!({}));
    reapers.watch(&common::daemon_reaper::session_endpoint(&session_id));
    assert!(
        desktop.run_marker(&session_id, "before", tag),
        "the shell session never ran a command.\n--- output ---\n{}",
        String::from_utf8_lossy(&desktop.output)
    );
    session_id
}

/// Reconnect desktop `name` to `worker`, re-attach `session_id`, and prove it
/// is the same live shell: its scrollback replays the output from before, and
/// a new command still runs.
fn reattach_and_prove_alive(worker: &Worker, name: &str, session_id: &str, tag: &str) -> Client {
    let mut desktop = worker.connect(name);
    let attach = desktop.rpc("connection.attach", json!({"session_id": session_id}));
    assert!(
        attach.get("result").is_some(),
        "re-attaching {session_id} failed: {attach}\n--- worker stderr ---\n{}",
        worker.stderr()
    );
    assert!(
        desktop.wait_for_output(&format!("before-{tag}"), Duration::from_secs(30)),
        "the re-attached session did not replay its earlier output, so it is not the \
         same shell.\n--- output ---\n{}",
        String::from_utf8_lossy(&desktop.output)
    );
    assert!(
        desktop.run_marker(session_id, "after", tag),
        "the re-attached shell did not run a new command.\n--- output ---\n{}",
        String::from_utf8_lossy(&desktop.output)
    );
    desktop
}

/// Close `session_id` and wait until its daemon is gone.
fn close_and_reap(desktop: &mut Client, session_id: &str) {
    let closed = desktop.close_session(session_id);
    assert!(
        closed.get("result").is_some(),
        "closing {session_id} failed: {closed}"
    );
    let endpoint = common::daemon_reaper::session_endpoint(session_id);
    assert!(
        wait_until(Duration::from_secs(15), || {
            std::os::unix::net::UnixStream::connect(&endpoint).is_err()
        }),
        "the session daemon of {session_id} outlived its close"
    );
}

/// #1401: an idle auto-apply re-execs the agent, and the persistent daemon
/// sessions on the host survive it and can be re-attached.
///
/// A worker counts only its own sessions toward "idle". So desktop A's
/// worker is idle and auto-applies the self-update (swap the installed
/// binary, re-exec) while desktop B's worker holds a persistent shell. The
/// swap and re-exec must leave that shell alone: still served to B, and
/// re-attachable from a fresh connection afterwards. (One worker that holds a
/// session never auto-applies at all; see
/// `active_shell_session_is_never_interrupted`.)
#[tokio::test]
async fn idle_auto_apply_keeps_the_hosts_persistent_sessions() {
    let agent_bytes = std::fs::read(agent_binary()).expect("read agent bytes");
    let server = MockServer::start().await;
    mount_release(&server, &agent_bytes).await;

    let host = Host::new();
    let mut reapers = DaemonReapers::default();

    // Desktop B: a plain worker holding a persistent shell.
    let mut worker_b = host.spawn_worker(&[], &[]);
    reapers.watch(&host.registry_endpoint());
    let mut desktop_b = worker_b.connect("desktop-b");
    let session_id = open_persistent_shell(&mut desktop_b, &mut reapers, "1401");

    // Desktop A: a worker with self-update on, deferred strategy. It holds no
    // session, so its first poll stages the release and applies it at once.
    let bin_inode_before = inode(&host.bin_path).expect("installed binary present");
    let worker_a = host.spawn_worker(
        &["--allow-self-update", "--update-strategy", "deferred"],
        &[
            (
                "TERMIHUB_AGENT_UPDATE_API_URL",
                format!("{}/releases/latest", server.uri()),
            ),
            (
                "TERMIHUB_AGENT_UPDATE_ASSET_SUFFIX",
                AGENT_SUFFIX.to_string(),
            ),
            ("TERMIHUB_AGENT_UPDATE_INITIAL_DELAY_MS", "300".to_string()),
        ],
    );

    assert!(
        wait_until(UPDATE_PIPELINE_TIMEOUT, || {
            inode(&host.bin_path).is_some_and(|i| i != bin_inode_before)
        }),
        "desktop A's idle worker did not swap the installed binary within \
         {UPDATE_PIPELINE_TIMEOUT:?}.\n--- worker A stderr ---\n{}",
        worker_a.stderr()
    );
    // A re-execed onto the swapped binary and serves again.
    let mut desktop_a =
        Client::connect(&worker_a.addr(1), host.home.path(), Duration::from_secs(30))
            .unwrap_or_else(|| {
                panic!(
                    "worker A did not come back after the self-apply.\n{}",
                    worker_a.stderr()
                )
            });
    assert!(!desktop_a.agent_version().is_empty());
    assert!(
        wait_until(Duration::from_secs(15), || {
            host.state()["update"]["pending_update"].is_null()
        }),
        "the applied update must leave no pending_update; state was {}",
        host.state()
    );

    // B's shell survived the swap and the re-exec: still running on B's live
    // connection, and still recorded in the host's shared state.
    assert!(worker_b.is_running(), "worker B must not be touched");
    assert!(
        desktop_b.run_marker(&session_id, "during", "1401"),
        "B's shell stopped running across A's self-apply.\n--- worker A stderr ---\n{}",
        worker_a.stderr()
    );
    assert!(
        !host.state()["sessions"][&session_id].is_null(),
        "the session must stay in the shared state.json; state was {}",
        host.state()
    );

    // B's connection drops and comes back: the session re-attaches.
    drop(desktop_b);
    let mut desktop_b = reattach_and_prove_alive(&worker_b, "desktop-b", &session_id, "1401");
    close_and_reap(&mut desktop_b, &session_id);
}

/// #1349 at the agent level: desktop A updates the host while desktop B is
/// connected with a persistent session.
///
/// 1. The guard's view: A's `agent.list_connections` lists B (the hosts the
///    Update dialog warns about).
/// 2. A's update notifies B (`agent.update_pending`).
/// 3. B ignores the notice, so the update is forced through when its window
///    closes: A's worker swaps the installed binary and re-execs.
/// 4. B's connection ends and B reconnects. That spawns a fresh worker from the
///    installed binary, so B is now on the new binary, and B's persistent
///    session re-attaches there.
#[test]
fn forced_update_notifies_the_other_desktop_which_reconnects_to_the_new_binary() {
    let host = Host::new();
    let mut reapers = DaemonReapers::default();

    let worker_b = host.spawn_worker(&[], &[]);
    reapers.watch(&host.registry_endpoint());
    let mut desktop_b = worker_b.connect("desktop-b");
    let session_id = open_persistent_shell(&mut desktop_b, &mut reapers, "1349");

    let worker_a = host.spawn_worker(&[], &[]);
    let desktop_a = worker_a.connect("desktop-a");

    // 1. The connected-host guard's input: A sees B, with the fields the
    //    Update dialog renders.
    let mut desktop_a = desktop_a;
    let mut connections = Vec::new();
    assert!(
        wait_until(Duration::from_secs(15), || {
            let resp = desktop_a.rpc("agent.list_connections", json!({}));
            connections = resp["result"]["connections"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            connections.len() == 2
        }),
        "A must see both desktops on the host: {connections:?}"
    );
    let b = connections
        .iter()
        .find(|c| c["client"] == "desktop-b")
        .unwrap_or_else(|| panic!("desktop-b missing from A's view: {connections:?}"));
    assert_eq!(b["client_version"], "0.1.0", "{b}");
    assert!(
        b["client_id"].as_str().is_some_and(|s| !s.is_empty()),
        "{b}"
    );
    assert!(
        b["connected_since"].as_str().is_some_and(|s| !s.is_empty()),
        "{b}"
    );

    // 2–3. A requests the update with a staged binary; B gets the notice and
    //      does nothing, so the update goes ahead when the window closes.
    let staging = host.agent_dir().join("updates");
    std::fs::create_dir_all(&staging).expect("create staging dir");
    let staged = staging.join("termihub-agent-newer");
    {
        let _fork_guard = common::fork_guard();
        std::fs::copy(agent_binary(), &staged).expect("stage new binary");
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
            .expect("chmod staged binary");
    }
    let staged_sha = sha256_hex(&std::fs::read(&staged).expect("read staged binary"));
    let bin_inode_before = inode(&host.bin_path).expect("installed binary present");

    // The apply re-hashes the ~100 MB binary before it swaps, which is slow on
    // a loaded host. Keep the requester reading for as long as the pipeline
    // may take: closing its connection early would end the request.
    desktop_a
        .reader
        .get_ref()
        .set_read_timeout(Some(UPDATE_PIPELINE_TIMEOUT))
        .expect("set requester read timeout");
    let params = json!({
        "binaryPath": staged,
        "version": NEWER_VERSION,
        "expectedSha256": staged_sha,
        "ackTimeoutSecs": 2,
        "authToken": worker_a.token,
    });
    let requester = std::thread::spawn(move || desktop_a.rpc("agent.request_update", params));

    let notice = desktop_b
        .wait_for_notification("agent.update_pending", Duration::from_secs(15))
        .unwrap_or_else(|| {
            panic!(
                "desktop-b never got the update notice.\n--- worker B stderr ---\n{}",
                worker_b.stderr()
            )
        });
    assert_eq!(notice["params"]["requestedByVersion"], "0.1.0", "{notice}");

    assert!(
        wait_until(UPDATE_PIPELINE_TIMEOUT, || {
            inode(&host.bin_path).is_some_and(|i| i != bin_inode_before)
        }),
        "the forced update did not swap the installed binary.\n--- worker A stderr ---\n{}",
        worker_a.stderr()
    );
    // The apply execs before it can answer, so the request ends with A's
    // connection: no response, or a successful one. Never an error.
    let response = requester.join().expect("requester thread");
    assert!(
        response.is_null() || response["result"]["applied"] == true,
        "the forced update must apply: {response}"
    );
    let mut desktop_a =
        Client::connect(&worker_a.addr(1), host.home.path(), Duration::from_secs(30))
            .unwrap_or_else(|| panic!("worker A did not come back.\n{}", worker_a.stderr()));
    assert!(!desktop_a.agent_version().is_empty());
    assert_eq!(
        sha256_hex(&std::fs::read(&host.bin_path).expect("read installed binary")),
        staged_sha,
        "the installed binary must now be the staged one"
    );
    drop(desktop_a);

    // 4. B's connection ends, and its worker with it; B reconnects through a
    //    fresh worker, which runs the swapped-in binary.
    drop(desktop_b);
    drop(worker_b);
    let new_bin_inode = inode(&host.bin_path).expect("installed binary present");
    let worker_b2 = host.spawn_worker(&[], &[]);
    assert_eq!(
        inode(&host.bin_path),
        Some(new_bin_inode),
        "B's new worker must start from the swapped-in binary"
    );
    let mut desktop_b = reattach_and_prove_alive(&worker_b2, "desktop-b", &session_id, "1349");
    close_and_reap(&mut desktop_b, &session_id);
    drop(worker_a);
}

/// Seconds a coordinated push waits for its peers to leave before it applies
/// anyway: the documented ten-second window (see `agent/src/update/coordinate.rs`).
const COORDINATED_WINDOW_SECS: u64 = 10;

/// #1616: a coordinated desktop push with three desktops on one host.
///
/// 1. Desktop A pushes an update (`agent.request_update` with the ten-second
///    window). Both peers, B and C, get `agent.update_pending`.
/// 2. C acknowledges by leaving; B, which holds a persistent shell, ignores the
///    notice. With a peer still connected nothing is applied early: the binary
///    is untouched once both notices are in and after C has left.
/// 3. When the window closes the update applies: A's worker swaps the installed
///    binary and re-execs, and B's shell keeps running.
/// 4. B and C reconnect through fresh workers on the swapped-in binary, both
///    report the agent's version, and B re-attaches its shell.
#[test]
fn coordinated_push_notifies_every_peer_and_applies_after_the_window() {
    let host = Host::new();
    let mut reapers = DaemonReapers::default();

    let worker_b = host.spawn_worker(&[], &[]);
    reapers.watch(&host.registry_endpoint());
    let mut desktop_b = worker_b.connect("desktop-b");
    let session_id = open_persistent_shell(&mut desktop_b, &mut reapers, "1616");

    let worker_c = host.spawn_worker(&[], &[]);
    let mut desktop_c = worker_c.connect("desktop-c");

    let worker_a = host.spawn_worker(&[], &[]);
    let mut desktop_a = worker_a.connect("desktop-a");
    assert!(
        wait_until(Duration::from_secs(15), || {
            let resp = desktop_a.rpc("agent.list_connections", json!({}));
            resp["result"]["connections"]
                .as_array()
                .is_some_and(|c| c.len() == 3)
        }),
        "A must see all three desktops on the host"
    );

    // 1. A pushes a staged binary with the documented window.
    let staging = host.agent_dir().join("updates");
    std::fs::create_dir_all(&staging).expect("create staging dir");
    let staged = staging.join("termihub-agent-pushed");
    {
        let _fork_guard = common::fork_guard();
        std::fs::copy(agent_binary(), &staged).expect("stage pushed binary");
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
            .expect("chmod pushed binary");
    }
    let staged_sha = sha256_hex(&std::fs::read(&staged).expect("read pushed binary"));
    let bin_inode_before = inode(&host.bin_path).expect("installed binary present");

    // Keep the requester reading for as long as the pipeline may take; closing
    // its connection early would end the request.
    desktop_a
        .reader
        .get_ref()
        .set_read_timeout(Some(UPDATE_PIPELINE_TIMEOUT))
        .expect("set requester read timeout");
    let params = json!({
        "binaryPath": staged,
        "version": NEWER_VERSION,
        "expectedSha256": staged_sha,
        "ackTimeoutSecs": COORDINATED_WINDOW_SECS,
        "authToken": worker_a.token,
    });
    let requester = std::thread::spawn(move || desktop_a.rpc("agent.request_update", params));

    for (name, desktop, worker) in [
        ("desktop-b", &mut desktop_b, &worker_b),
        ("desktop-c", &mut desktop_c, &worker_c),
    ] {
        let notice = desktop
            .wait_for_notification("agent.update_pending", Duration::from_secs(15))
            .unwrap_or_else(|| {
                panic!(
                    "{name} never got the update notice.\n--- its worker's stderr ---\n{}",
                    worker.stderr()
                )
            });
        assert_eq!(notice["params"]["requestedByVersion"], "0.1.0", "{notice}");
    }

    // 2. C acks by leaving; B stays, so the update must wait out the window.
    drop(desktop_c);
    drop(worker_c);
    assert_eq!(
        inode(&host.bin_path),
        Some(bin_inode_before),
        "the update must not apply while a peer is still connected inside the window"
    );

    // 3. The window closes and the update applies; B's shell keeps running.
    assert!(
        wait_until(UPDATE_PIPELINE_TIMEOUT, || {
            inode(&host.bin_path).is_some_and(|i| i != bin_inode_before)
        }),
        "the coordinated push did not swap the installed binary.\n--- worker A stderr ---\n{}",
        worker_a.stderr()
    );
    let response = requester.join().expect("requester thread");
    assert!(
        response.is_null() || response["result"]["applied"] == true,
        "the coordinated push must apply: {response}"
    );
    assert_eq!(
        sha256_hex(&std::fs::read(&host.bin_path).expect("read installed binary")),
        staged_sha,
        "the installed binary must now be the pushed one"
    );
    assert!(
        desktop_b.run_marker(&session_id, "during", "1616"),
        "B's shell stopped running across the coordinated apply"
    );
    // A re-execed onto the new binary. Wait for it to serve again before any
    // other worker starts: the re-exec rewrites the shared token file, so a
    // worker started meanwhile could read A's token instead of its own.
    let mut desktop_a =
        Client::connect(&worker_a.addr(1), host.home.path(), Duration::from_secs(30))
            .unwrap_or_else(|| panic!("worker A did not come back.\n{}", worker_a.stderr()));
    assert!(!desktop_a.agent_version().is_empty());
    drop(desktop_a);

    // 4. B and C come back through fresh workers on the new binary.
    drop(desktop_b);
    drop(worker_b);
    let new_bin_inode = inode(&host.bin_path).expect("installed binary present");
    let worker_c2 = host.spawn_worker(&[], &[]);
    let mut desktop_c = worker_c2.connect("desktop-c");
    assert!(!desktop_c.agent_version().is_empty());
    drop(desktop_c);
    drop(worker_c2);
    let worker_b2 = host.spawn_worker(&[], &[]);
    assert_eq!(
        inode(&host.bin_path),
        Some(new_bin_inode),
        "the reconnecting workers must start from the swapped-in binary"
    );
    let mut desktop_b = reattach_and_prove_alive(&worker_b2, "desktop-b", &session_id, "1616");
    assert!(!desktop_b.agent_version().is_empty());
    close_and_reap(&mut desktop_b, &session_id);
    drop(worker_a);
}

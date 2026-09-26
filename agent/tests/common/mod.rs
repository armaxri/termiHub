//! Shared helpers for the live-agent test harnesses.
//!
//! Cargo does not build `tests/common/mod.rs` as a test binary of its own, so
//! this is a plain module each suite pulls in with `mod common;`.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

static FORK_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Read this agent's per-instance `--listen` auth token from its config dir
/// (AGT-002 / SEC-004).
///
/// The token file (`<config>/termihub-agent/listen-auth.token`) is written just
/// before the listener binds, so by the time a suite has observed readiness it
/// exists; the short retry only covers the rare interleaving where a test reads
/// it the instant the port becomes connectable. `config_home` is the same dir the
/// suite passes as `XDG_CONFIG_HOME` when spawning the agent.
#[allow(dead_code)]
pub fn read_listen_token(config_home: &Path) -> String {
    let path = config_home.join("termihub-agent").join("listen-auth.token");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match std::fs::read_to_string(&path) {
            Ok(s) if !s.trim().is_empty() => return s.trim().to_string(),
            _ if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            other => panic!(
                "listen auth token not found at {} within 10s: {other:?}",
                path.display()
            ),
        }
    }
}

/// The first NDJSON line a `--listen` client must send to authenticate, WITHOUT
/// the trailing newline (callers frame it however they frame their other lines).
#[allow(dead_code)]
pub fn auth_request_line(token: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":0,"method":"auth","params":{{"token":"{token}"}}}}"#)
}

/// Perform the `--listen` auth handshake on a raw [`TcpStream`]: write the auth
/// request, then read exactly one response line **byte-wise** — so no bytes past
/// the newline are pulled into a buffer a later reader would then miss — and
/// assert the agent accepted the token. Panics on rejection or a closed socket.
#[allow(dead_code)]
pub fn authenticate_raw(stream: &mut TcpStream, token: &str) {
    let line = format!("{}\n", auth_request_line(token));
    stream
        .write_all(line.as_bytes())
        .expect("write auth request");
    stream.flush().ok();
    let mut resp = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = stream.read(&mut byte).expect("read auth response");
        assert_ne!(
            n, 0,
            "agent closed the connection during the auth handshake"
        );
        if byte[0] == b'\n' {
            break;
        }
        resp.push(byte[0]);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&resp).expect("auth response was not valid JSON");
    assert_eq!(
        value["result"]["authenticated"],
        serde_json::json!(true),
        "auth handshake was not accepted: {}",
        String::from_utf8_lossy(&resp)
    );
}

/// Serialises **every `fork`** in this test binary against **every write to a
/// binary this suite is about to `execve`** (#1597).
///
/// ## The race
///
/// A harness that copies the agent binary into a temp dir and runs it does:
///
/// 1. Thread **A** calls `fs::copy`, which holds a **write fd** on `binA`.
/// 2. Thread **B** calls `Command::spawn`, which **forks**. The child inherits
///    *every* fd in the process — including A's write fd on `binA`. `O_CLOEXEC`
///    does not save you: it closes the fd at `execve`, and B's child is sitting
///    between `fork` and `exec`.
/// 3. A finishes its copy and closes its own fd, then `execve`s `binA`.
/// 4. Linux fails that `execve` with **`ETXTBSY`** ("Text file busy") because
///    B's not-yet-exec'd child *still* holds a write fd on the file.
///
/// Linux-only (macOS does not enforce `ETXTBSY` this way), and intermittent —
/// it needs a fork to land inside another thread's copy window. See
/// rust-lang/rust#3352.
///
/// ## Why this works
///
/// `Command::spawn` does not return until the child has `exec`'d (std blocks on
/// a `CLOEXEC` pipe to report exec failures). So holding this lock across
/// `copy` → `chmod` → `spawn` guarantees no fd is inherited that outlives the
/// critical section: by the time the lock drops, every child has already exec'd
/// and closed what it inherited.
///
/// ## Two things that look sufficient and are not
///
/// - **Copying to a temp path and renaming into place.** `rename` does not
///   change the inode, and `ETXTBSY` is enforced per *inode* — an inherited
///   write fd on the temp path still refers to the very inode being exec'd.
///   Measured on Linux, 6 threads × 200 spawns: 119/1200 failures, versus
///   220/1200 with no mitigation at all. It does not fix it.
/// - **Locking only the harness's own copy+spawn.** *Any* fork in the process
///   inherits the fd, including unrelated ones like a `docker` probe. With one
///   such fork site left unlocked: 47/1200 failures. With every fork site
///   taking this lock: 0/1200.
///
/// So the rule is not "lock the spawn" but **lock the fork** — if you add a
/// `Command` that forks anywhere in one of these suites, it takes this guard,
/// however unrelated it looks.
///
/// Hold it for the copy and the spawn only. Drop it before anything that waits
/// on the child (reading its log, polling its port), or the suite serialises
/// wholesale instead of just at the hazard.
#[allow(dead_code)]
pub fn fork_guard() -> MutexGuard<'static, ()> {
    FORK_LOCK
        .get_or_init(|| Mutex::new(()))
        // A test that panics while holding this must not cascade into every
        // sibling: the guard protects fd timing, not data, so there is no
        // invariant for a panic to have broken.
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Every address the agent announced with its `Listening on <addr>` log line,
/// in order, parsed from its captured stderr (`log`).
///
/// A re-exec (self-update apply) inherits the same stderr, so the *n*-th entry is
/// the listener of the agent's *n*-th incarnation.
#[allow(dead_code)]
pub fn listen_addrs(log: &str) -> Vec<String> {
    log.lines()
        .filter_map(|line| line.split("Listening on ").nth(1))
        .filter_map(|rest| rest.split_whitespace().next())
        .map(str::to_string)
        .collect()
}

/// Wait for the agent logging to `stderr_path` to announce the listener of its
/// `generation`-th incarnation (`0` = as spawned, `1` = after the first re-exec)
/// and return that address, or `None` on timeout.
///
/// Suites start the agent on `--listen 127.0.0.1:0` and read the bound address
/// back from this line, instead of reserving a port by binding and dropping it
/// first — a freed ephemeral port can be taken by a concurrent test before the
/// agent binds it (#3533). A re-exec re-binds `127.0.0.1:0`, so it announces a
/// fresh address, which is why callers pass the incarnation they expect.
#[allow(dead_code)]
pub fn wait_for_listen_addr(
    stderr_path: &Path,
    generation: usize,
    timeout: Duration,
) -> Option<String> {
    let deadline = Instant::now() + timeout;
    loop {
        let log = std::fs::read_to_string(stderr_path).unwrap_or_default();
        if let Some(addr) = listen_addrs(&log).into_iter().nth(generation) {
            return Some(addr);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

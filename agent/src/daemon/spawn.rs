//! Detached-spawn helpers shared by every daemon **role**.
//!
//! Both daemon roles — the per-session daemon (`--daemon <id>`, spawned by
//! [`crate::session::manager`]) and the host-wide registry daemon
//! (`--registry-daemon`, spawned by [`crate::registry_daemon::client`]) — must
//! outlive the agent worker that spawned them. The worker is typically running
//! as `termihub-agent --stdio` inside an SSH exec channel, so "outlive" has two
//! separate requirements, and both roles need both:
//!
//! 1. **Don't inherit the worker's stderr** ([`configure_detached_stderr`]) —
//!    that stderr *is* the exec channel.
//! 2. **Leave the worker's process session** ([`configure_detachment`]) — or
//!    sshd's SIGHUP on disconnect takes the daemon with it.
//!
//! Keeping these in one place is what lets the registry inherit the
//! survives-a-binary-swap property that ADR-11 leans on, rather than
//! re-deriving it (see ADR-11's amendment in `docs/architecture.md`).

/// Point a to-be-spawned daemon's stderr at `log`, or discard it.
///
/// The daemon must **not** inherit the agent's stderr: when the agent is reached
/// over SSH that stderr is the exec channel of `termihub-agent --stdio`, and
/// keeping it tethers the daemon's lifetime to the SSH connection — a disconnect
/// tears the channel down and takes the daemon with it (so a reconnect finds
/// nothing to re-attach). A detached daemon owns its own stderr on every
/// platform: callers pass a log file in the per-user socket dir (diagnostics
/// without the coupling) where one is available, and `None` falls back to a null
/// stderr.
pub fn configure_detached_stderr(command: &mut std::process::Command, log: Option<std::fs::File>) {
    let stderr = match log {
        Some(file) => std::process::Stdio::from(file),
        None => std::process::Stdio::null(),
    };
    command.stderr(stderr);
}

/// Detach a to-be-spawned daemon so it outlives the agent that spawns it — the
/// whole point of a *persistent* session, and of a registry that survives an
/// agent binary swap.
///
/// On Windows: a new process group with no console window. On unix: a fresh
/// session via `setsid`. Being merely orphaned (the agent never waits on the
/// child) is **not** enough on unix, because the agent is typically launched
/// over an SSH exec channel (`termihub-agent --stdio`); when that channel closes
/// sshd sends SIGHUP to the whole session, killing any daemon still in it, so a
/// reconnect would find no session to re-attach. `setsid` moves the daemon out
/// of the SSH session's process group, immunising it against that hangup.
/// (Detaching stderr from the same channel — see [`configure_detached_stderr`] —
/// is the other half of surviving the disconnect.)
pub fn configure_detachment(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{
            CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS,
        };
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Safety: `setsid` is async-signal-safe and touches no shared state of
        // the (forked, not-yet-exec'd) child before the following `exec`.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
}

/// Reap a spawned, detached daemon child so it never becomes a zombie.
///
/// [`configure_detachment`] uses `setsid` (unix), which starts a new *session*
/// but does **not** reparent the child to init — the spawning worker stays its
/// parent until the worker itself exits. A detached daemon that then terminates
/// while its worker is still alive (shell exits, `MSG_KILL`, crash) would sit as
/// a **zombie** in the worker's process table with no one to `wait()` it. A
/// long-lived worker cycling many persistent sessions would accumulate zombies
/// (AGT-018 / #2580).
///
/// A double-fork would sidestep this (reparent to init), but it is incompatible
/// with the session-daemon spawn: the worker polls the *real* daemon's exit
/// status with `try_wait` during the connect race (#847), which a double-fork's
/// throwaway intermediate child would break. So instead we hand the `Child` to a
/// dedicated reaper thread that blocks in `wait()` for the daemon's lifetime and
/// reaps it the moment it exits. The thread costs nothing while parked and ends
/// when its daemon does, so it does not accumulate. On Windows there are no
/// zombies, but reaping the handle here is harmless and keeps the seam uniform.
///
/// Returns the reaper thread's [`JoinHandle`](std::thread::JoinHandle) (its
/// result is the daemon's exit status) so tests can join it deterministically;
/// production callers ignore it. If the reaper thread cannot be spawned the
/// `Child` is dropped as before (best-effort, never a panic) and `None` is
/// returned.
#[must_use = "ignoring the handle is fine in production but tests should join it"]
pub fn reap_detached_child(
    child: std::process::Child,
) -> Option<std::thread::JoinHandle<std::io::Result<std::process::ExitStatus>>> {
    match std::thread::Builder::new()
        .name("termihub-daemon-reaper".to_string())
        .spawn(move || {
            let mut child = child;
            child.wait()
        }) {
        Ok(handle) => Some(handle),
        Err(e) => {
            tracing::warn!(
                "could not spawn daemon reaper thread ({e}); dropping child unreaped"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a trivially short-lived process for the reaper test.
    #[cfg(unix)]
    fn trivial_command() -> std::process::Command {
        let mut c = std::process::Command::new("sh");
        c.arg("-c").arg("exit 0");
        c
    }
    #[cfg(windows)]
    fn trivial_command() -> std::process::Command {
        let mut c = std::process::Command::new("cmd");
        c.arg("/C").arg("exit 0");
        c
    }

    /// A spawned, then-exited child handed to the reaper must be `wait()`ed —
    /// i.e. reaped, never left a zombie (AGT-018 / #2580). Joining the reaper
    /// thread returns the child's exit status, proving `wait()` completed.
    #[cfg(any(unix, windows))]
    #[test]
    fn reap_detached_child_reaps_a_short_lived_process() {
        let child = trivial_command().spawn().expect("spawn trivial process");
        let handle = reap_detached_child(child).expect("reaper thread spawned");
        let status = handle
            .join()
            .expect("reaper thread joins")
            .expect("wait() succeeds");
        assert!(status.success(), "the reaped process exited 0");
    }

    // ── daemon detachment (issue #995) ───────────────────────────────

    /// Moved here from `session::manager` with the helper itself (#1574): both
    /// the session daemon and the registry daemon depend on this property, so
    /// it is tested once, where the shared code lives.
    #[cfg(unix)]
    #[test]
    fn configure_detachment_starts_a_new_session() {
        // A detached daemon must survive the agent (and its SSH exec channel)
        // going away. On unix that requires the spawned child to leave the SSH
        // session via `setsid` — otherwise sshd's SIGHUP on disconnect kills it,
        // and a reconnect finds no persistent session to re-attach and no
        // registry to ask who is connected. Assert the child a
        // detachment-configured Command spawns is a session leader (its session
        // id equals its pid), which only holds after `setsid`.
        let mut command = std::process::Command::new("sleep");
        command.arg("30");
        configure_detachment(&mut command);
        let mut child = command.spawn().expect("spawn sleep");
        let pid = child.id() as libc::pid_t;
        // Safety: `getsid` merely reads the session id of an existing pid.
        let sid = unsafe { libc::getsid(pid) };
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(
            sid, pid,
            "daemon child should be its own session leader (setsid)"
        );
    }

    /// A daemon must never inherit the agent's stderr — over SSH that stderr is
    /// the exec channel, and inheriting it ties the daemon's life to the SSH
    /// connection. Assert the log file the caller supplies actually receives the
    /// child's stderr.
    #[cfg(unix)]
    #[test]
    fn configure_detached_stderr_redirects_into_the_supplied_log() {
        let path =
            std::env::temp_dir().join(format!("termihub-spawn-test-{}.log", std::process::id()));
        let log = std::fs::File::create(&path).expect("create log");

        let mut command = std::process::Command::new("sh");
        command.arg("-c").arg("echo daemon-diagnostics >&2");
        configure_detached_stderr(&mut command, Some(log));
        let status = command.status().expect("run child");
        assert!(status.success());

        let written = std::fs::read_to_string(&path).expect("read log");
        assert!(
            written.contains("daemon-diagnostics"),
            "child stderr should land in the log file, got {written:?}"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// With no log available (the non-unix path) stderr must be discarded, never
    /// inherited.
    #[cfg(unix)]
    #[test]
    fn configure_detached_stderr_falls_back_to_null() {
        let mut command = std::process::Command::new("sh");
        command.arg("-c").arg("echo noise >&2");
        configure_detached_stderr(&mut command, None);
        // Captured output would be non-empty if stderr were inherited or piped;
        // a null stderr yields nothing.
        let output = command.output().expect("run child");
        assert!(output.stderr.is_empty(), "stderr should be discarded");
    }
}

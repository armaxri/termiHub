//! `termihub-plugin-runner` — the out-of-process host for one native plugin
//! backend (#4182, plugin OS-sandbox phase 1).
//!
//! The termiHub host spawns one runner per enabled native plugin:
//!
//! ```text
//! termihub-plugin-runner --protocol <n>
//! ```
//!
//! with the runner's end of a `socketpair` inherited as descriptor 3 (Unix).
//! There is no filesystem rendezvous path and no other argument: what to load
//! arrives in the `Configure` frame. The runner exits when the host sends
//! `Shutdown`, when the channel reaches end of stream (the host is gone) and —
//! on Linux — when the parent dies (`PR_SET_PDEATHSIG`).
//!
//! Phase 1 applies **no OS sandbox** yet; the per-OS confinement (Seatbelt,
//! landlock + seccomp, LPAC) lands in later phases between the handshake and
//! the `dlopen`. See `docs/concepts/backlog/plugin-os-sandbox.html`.

// Windows has no runner transport yet (next slice of #4182), so the session
// server is unreachable there until it lands.
#[cfg_attr(
    not(unix),
    allow(dead_code, unused_imports, reason = "no Windows transport yet")
)]
mod runner;

use termihub_plugin_runner::ipc::{PROTOCOL_ARG, PROTOCOL_VERSION};

fn main() {
    std::process::exit(real_main());
}

fn real_main() -> i32 {
    if !protocol_matches(std::env::args().skip(1)) {
        eprintln!(
            "termihub-plugin-runner: expected `{PROTOCOL_ARG} {PROTOCOL_VERSION}`; this runner is \
             started by termiHub, not by hand"
        );
        return runner::exit::USAGE;
    }
    platform::run()
}

/// Whether the arguments are exactly `--protocol <PROTOCOL_VERSION>`.
fn protocol_matches(mut args: impl Iterator<Item = String>) -> bool {
    let flag = args.next();
    let value = args.next();
    flag.as_deref() == Some(PROTOCOL_ARG)
        && value.as_deref() == Some(PROTOCOL_VERSION.to_string().as_str())
        && args.next().is_none()
}

#[cfg(unix)]
mod platform {
    use std::os::fd::FromRawFd;
    use std::os::unix::net::UnixStream;
    use std::sync::Arc;

    use termihub_plugin_runner::ipc::IPC_FD;

    use crate::runner::{self, Channel};

    pub(crate) fn run() -> i32 {
        #[cfg(target_os = "linux")]
        if !die_with_parent() {
            return runner::exit::OK;
        }
        // SAFETY: descriptor 3 is the channel end the host passed us; nothing
        // else in this process owns it. A missing/foreign fd fails the first
        // read or write, which ends the runner.
        let stream = unsafe { UnixStream::from_raw_fd(IPC_FD) };
        // Keep the channel out of any process a plugin might start.
        // SAFETY: plain `fcntl` on a descriptor we own.
        unsafe { libc::fcntl(IPC_FD, libc::F_SETFD, libc::FD_CLOEXEC) };
        let writer = match stream.try_clone() {
            Ok(writer) => writer,
            Err(_) => return runner::exit::PROTOCOL,
        };
        let channel = Arc::new(Channel::new(Box::new(writer)));
        runner::run(stream, channel)
    }

    /// Linux: get SIGKILLed when the host dies. Returns `false` if the parent
    /// already died before the request took effect (we were re-parented).
    #[cfg(target_os = "linux")]
    fn die_with_parent() -> bool {
        // SAFETY: `prctl(PR_SET_PDEATHSIG)` only sets a signal number for the
        // calling process.
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) };
        // SAFETY: `getppid` has no preconditions.
        let parent = unsafe { libc::getppid() };
        parent != 1
    }
}

#[cfg(not(unix))]
mod platform {
    use crate::runner;

    /// The Windows transport (a private duplex named pipe passed through
    /// `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, plus a kill-on-close job object)
    /// is the next slice of #4182; until then the host never spawns a runner on
    /// Windows.
    pub(crate) fn run() -> i32 {
        eprintln!("termihub-plugin-runner: no IPC transport on this platform yet");
        runner::exit::UNAVAILABLE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> impl Iterator<Item = String> {
        list.iter()
            .map(|s| (*s).to_owned())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn only_the_exact_protocol_argument_is_accepted() {
        let v = PROTOCOL_VERSION.to_string();
        assert!(protocol_matches(args(&[PROTOCOL_ARG, &v])));
        assert!(!protocol_matches(args(&[])));
        assert!(!protocol_matches(args(&[PROTOCOL_ARG])));
        assert!(!protocol_matches(args(&[PROTOCOL_ARG, "999"])));
        assert!(!protocol_matches(args(&["--other", &v])));
        assert!(!protocol_matches(args(&[PROTOCOL_ARG, &v, "extra"])));
    }
}

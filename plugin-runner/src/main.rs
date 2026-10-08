//! `termihub-plugin-runner` — the out-of-process host for one native plugin
//! backend (#4182, plugin OS-sandbox phase 1).
//!
//! The termiHub host spawns one runner per enabled native plugin:
//!
//! ```text
//! termihub-plugin-runner --protocol <n>                          (Unix)
//! termihub-plugin-runner --protocol <n> --ipc-handle <value>     (Windows)
//! ```
//!
//! On Unix the runner's end of a `socketpair` is inherited as descriptor 3; on
//! Windows the runner's end of a private named pipe is the only handle it
//! inherits besides its standard handles, and its value is given on the command
//! line (#4201). There is no filesystem rendezvous path and no other argument:
//! what to load arrives in the `Configure` frame. The runner exits when the
//! host sends `Shutdown`, when the channel reaches end of stream (the host is
//! gone) and — on Linux — when the parent dies (`PR_SET_PDEATHSIG`); on Windows
//! the host's kill-on-close job object ends it with the host.
//!
//! Between the handshake and the `dlopen` the runner confines itself with the
//! OS sandbox the host requests in `Configure` (Seatbelt on macOS, #4186;
//! no_new_privs + landlock + seccomp on Linux, #4185; LPAC follows in #4187).
//! See
//! `docs/concepts/backlog/plugin-os-sandbox.html`.

mod runner;

use termihub_plugin_runner::ipc::{PROTOCOL_ARG, PROTOCOL_VERSION};

fn main() {
    std::process::exit(real_main());
}

fn real_main() -> i32 {
    let Some(launch) = parse_args(std::env::args().skip(1)) else {
        eprintln!(
            "termihub-plugin-runner: expected `{PROTOCOL_ARG} {PROTOCOL_VERSION}`; this runner is \
             started by termiHub, not by hand"
        );
        return runner::exit::USAGE;
    };
    platform::run(launch)
}

/// What the command line hands the runner besides the protocol version.
#[cfg(unix)]
type Launch = ();
/// The inherited channel handle's value (Windows).
#[cfg(windows)]
type Launch = usize;

/// Accept exactly `--protocol <PROTOCOL_VERSION>` (Unix) or
/// `--protocol <PROTOCOL_VERSION> --ipc-handle <value>` (Windows).
fn parse_args(mut args: impl Iterator<Item = String>) -> Option<Launch> {
    let flag = args.next()?;
    let version = args.next()?;
    if flag != PROTOCOL_ARG || version != PROTOCOL_VERSION.to_string() {
        return None;
    }
    #[cfg(windows)]
    let launch = {
        if args.next()? != termihub_plugin_runner::ipc::IPC_HANDLE_ARG {
            return None;
        }
        args.next()?.parse::<usize>().ok().filter(|&v| v != 0)?
    };
    #[cfg(unix)]
    let launch = ();
    args.next().is_none().then_some(launch)
}

#[cfg(unix)]
mod platform {
    use std::os::fd::FromRawFd;
    use std::os::unix::net::UnixStream;
    use std::sync::Arc;

    use termihub_plugin_runner::ipc::fd::FdReader;
    use termihub_plugin_runner::ipc::IPC_FD;

    use crate::runner::{self, Channel};

    pub(crate) fn run((): super::Launch) -> i32 {
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
        // Read through `recvmsg` so sockets the host passes with bridge replies
        // (`SCM_RIGHTS`) are collected rather than discarded (#4183).
        let reader = FdReader::new(stream);
        let fds = reader.fds();
        runner::run(reader, channel, Some(fds))
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

#[cfg(windows)]
mod platform {
    use std::sync::Arc;

    use termihub_plugin_runner::ipc::pipe::PipeStream;
    use termihub_plugin_runner::ipc::ChannelStream;

    use crate::runner::{self, Channel};

    /// Drive the inherited pipe handle with overlapped `ReadFile` /
    /// `WriteFile`. Never Winsock or `std::net`: under LPAC `WSAStartup` fails
    /// and std's lazy Winsock initialisation panics (spike #4181).
    pub(crate) fn run(handle: super::Launch) -> i32 {
        // SAFETY: the value names the pipe end the host passed us through the
        // handle list; nothing else in this process owns it. A value that is
        // not a pipe is refused without being touched.
        let stream = match unsafe { PipeStream::from_inherited(handle) } {
            Ok(stream) => stream,
            Err(error) => {
                eprintln!("termihub-plugin-runner: the inherited channel is unusable: {error}");
                return runner::exit::PROTOCOL;
            }
        };
        let writer = match stream.try_clone() {
            Ok(writer) => writer,
            Err(error) => {
                eprintln!("termihub-plugin-runner: cloning the channel failed: {error}");
                return runner::exit::PROTOCOL;
            }
        };
        let channel = Arc::new(Channel::new(Box::new(writer)));
        // No handle passing over the pipe yet (#4219): bridge connections are
        // proxied.
        runner::run(stream, channel, ())
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

    #[cfg(unix)]
    #[test]
    fn only_the_exact_protocol_argument_is_accepted() {
        let v = PROTOCOL_VERSION.to_string();
        assert!(parse_args(args(&[PROTOCOL_ARG, &v])).is_some());
        assert!(parse_args(args(&[])).is_none());
        assert!(parse_args(args(&[PROTOCOL_ARG])).is_none());
        assert!(parse_args(args(&[PROTOCOL_ARG, "999"])).is_none());
        assert!(parse_args(args(&["--other", &v])).is_none());
        assert!(parse_args(args(&[PROTOCOL_ARG, &v, "extra"])).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn the_protocol_and_a_channel_handle_value_are_required() {
        use termihub_plugin_runner::ipc::IPC_HANDLE_ARG;
        let v = PROTOCOL_VERSION.to_string();
        assert_eq!(
            parse_args(args(&[PROTOCOL_ARG, &v, IPC_HANDLE_ARG, "1234"])),
            Some(1234)
        );
        assert!(parse_args(args(&[PROTOCOL_ARG, &v])).is_none());
        assert!(parse_args(args(&[PROTOCOL_ARG, &v, IPC_HANDLE_ARG])).is_none());
        assert!(parse_args(args(&[PROTOCOL_ARG, &v, IPC_HANDLE_ARG, "0"])).is_none());
        assert!(parse_args(args(&[PROTOCOL_ARG, &v, IPC_HANDLE_ARG, "x"])).is_none());
        assert!(parse_args(args(&[PROTOCOL_ARG, "999", IPC_HANDLE_ARG, "1234"])).is_none());
        assert!(parse_args(args(&[PROTOCOL_ARG, &v, "--other", "1234"])).is_none());
        assert!(parse_args(args(&[PROTOCOL_ARG, &v, IPC_HANDLE_ARG, "1234", "x"])).is_none());
    }
}

//! Linux: the `SIGSYS` handler behind seccomp denial reporting (#4236).
//!
//! The `trapped` seccomp filter answers each [`denial::REPORTED_SYSCALLS`]
//! denial with `SECCOMP_RET_TRAP` instead of `SECCOMP_RET_ERRNO(EPERM)`: the
//! kernel skips the call and raises `SIGSYS` on the calling thread, with the
//! system call number in `siginfo.si_syscall` (the technique Chromium uses).
//! `on_sigsys` then
//!
//! 1. writes `-EPERM` into the saved return register of the interrupted
//!    context (`rax` on x86_64, `x0` on aarch64), so when the handler returns
//!    the libc wrapper sees exactly the `EPERM` failure the plugin saw before
//!    reporting existed; and
//! 2. adds one to that system call's counter in a fixed table of atomics.
//!
//! Both steps are async-signal-safe: no allocation, no lock, no system call
//! (so `errno` is untouched too), and the handler runs on whichever plugin
//! thread made the call. A reporter thread ([`take`]) swaps the counters to
//! zero once per [`denial::REPORT_INTERVAL`] and forwards them as
//! `Denied{syscall}` log frames — the counters are the lock-free "ring": they
//! never overflow into lost reports, and coalescing them is the rate limit.
//!
//! **What a plugin can and cannot do about it.** The denied call is never
//! executed, whatever happens in user space. Installing its own `SIGSYS`
//! handler (which could fake a success return) is refused: the silent seccomp
//! filter answers `rt_sigaction(SIGSYS, <new action>)` with `EPERM`. A thread
//! that **blocks** `SIGSYS` and then makes a trapped call is killed by the
//! kernel (a forced, blocked `SIGSYS` falls back to its default action), which
//! harms only the plugin itself. Process creation (`fork`, `vfork`, `clone`
//! of a new process) is therefore *not* trapped: libc wrappers such as
//! `posix_spawn` block every signal around that `clone`, so a trap there
//! would crash the runner instead of failing with `EPERM`; those denials stay
//! silent `SECCOMP_RET_ERRNO`.

use std::sync::atomic::{AtomicU32, Ordering};

use super::{denial, layer, SandboxError};

/// `si_code` of a `SIGSYS` raised by `SECCOMP_RET_TRAP` (`SYS_SECCOMP`).
const SYS_SECCOMP: libc::c_int = 1;

/// The trapped system calls, by number, in [`denial::REPORTED_SYSCALLS`]
/// order (a unit test keeps the two in step).
const TRAPPED: [i64; 9] = [
    libc::SYS_socket,
    libc::SYS_connect,
    libc::SYS_bind,
    libc::SYS_listen,
    libc::SYS_open_by_handle_at,
    libc::SYS_ioctl,
    libc::SYS_kill,
    libc::SYS_tgkill,
    libc::SYS_prlimit64,
];

/// Denials counted since the last [`take`], per [`TRAPPED`] entry.
static COUNTS: [AtomicU32; TRAPPED.len()] = [const { AtomicU32::new(0) }; TRAPPED.len()];

/// The system call numbers the `trapped` filter traps.
#[must_use]
pub fn trapped() -> &'static [i64] {
    &TRAPPED
}

/// The `SIGSYS` part of `siginfo_t` (`_sigsys` in the kernel's union): the
/// layout is the same on x86_64 and aarch64 — three `int`s, then the union at
/// pointer alignment.
#[repr(C)]
struct SigsysInfo {
    signo: libc::c_int,
    errno: libc::c_int,
    code: libc::c_int,
    call_addr: *mut libc::c_void,
    syscall: libc::c_int,
    arch: libc::c_uint,
}

/// Count one trapped call of system call `nr` (async-signal-safe).
fn record(nr: i64) {
    if let Some(i) = TRAPPED.iter().position(|&t| t == nr) {
        COUNTS[i].fetch_add(1, Ordering::Relaxed);
    }
}

/// Swap every counter to zero and return the `(name, count)` pairs (zero
/// counts included).
#[must_use]
pub fn take() -> Vec<(&'static str, u32)> {
    denial::REPORTED_SYSCALLS
        .iter()
        .zip(COUNTS.iter())
        .map(|(name, count)| (*name, count.swap(0, Ordering::Relaxed)))
        .collect()
}

/// Make the interrupted system call return `value` (a negative errno).
///
/// # Safety
///
/// `context` must be the `ucontext_t` the kernel passed to an `SA_SIGINFO`
/// handler.
unsafe fn set_return(context: *mut libc::c_void, value: i64) {
    let context = context.cast::<libc::ucontext_t>();
    #[cfg(target_arch = "x86_64")]
    {
        // SAFETY: the caller passes the kernel's live signal frame.
        unsafe { (*context).uc_mcontext.gregs[libc::REG_RAX as usize] = value };
    }
    #[cfg(target_arch = "aarch64")]
    {
        // SAFETY: the caller passes the kernel's live signal frame. The
        // two's-complement bit pattern of the negative errno is what the
        // kernel itself leaves in x0.
        unsafe { (*context).uc_mcontext.regs[0] = value as u64 };
    }
}

/// The signature of an `SA_SIGINFO` handler.
type SigactionHandler = extern "C" fn(libc::c_int, *mut libc::siginfo_t, *mut libc::c_void);

/// `on_sigsys` as the `sa_sigaction` value.
fn handler_address() -> libc::sighandler_t {
    on_sigsys as SigactionHandler as libc::sighandler_t
}

/// The `SIGSYS` handler. Async-signal-safe: atomics and a store into the
/// signal frame only.
extern "C" fn on_sigsys(
    _signal: libc::c_int,
    info: *mut libc::siginfo_t,
    context: *mut libc::c_void,
) {
    if info.is_null() || context.is_null() {
        return;
    }
    // SAFETY: the kernel passes a valid `siginfo_t` to an `SA_SIGINFO`
    // handler; `SigsysInfo` is a prefix of it.
    let sigsys = unsafe { &*info.cast::<SigsysInfo>() };
    // A `SIGSYS` someone sent with `kill` carries no system call: leave it.
    if sigsys.code != SYS_SECCOMP {
        return;
    }
    record(i64::from(sigsys.syscall));
    // SAFETY: `context` is the kernel's `ucontext_t` for this delivery.
    unsafe { set_return(context, -i64::from(libc::EPERM)) };
}

/// Install `on_sigsys` for `SIGSYS` and unblock the signal on the calling
/// thread (threads started later inherit the mask). Must run before the
/// `trapped` filter is installed; the silent filter then keeps the plugin
/// from replacing it.
pub fn install_handler() -> Result<(), SandboxError> {
    let failed = |what: &str| SandboxError::Apply {
        layer: layer::SECCOMP,
        detail: format!("{what} failed: {}", std::io::Error::last_os_error()),
    };
    // SAFETY: a zeroed `sigaction` is a valid starting value; every field the
    // kernel reads is set below.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = handler_address();
    // NODEFER: a trapped call made while the handler runs (it makes none)
    // must not find SIGSYS blocked, which would kill the process.
    action.sa_flags = libc::SA_SIGINFO | libc::SA_NODEFER;
    // SAFETY: `sa_mask` is a valid, writable signal set.
    unsafe { libc::sigemptyset(&raw mut action.sa_mask) };
    // SAFETY: installs a handler for SIGSYS; both pointers are valid.
    if unsafe { libc::sigaction(libc::SIGSYS, &raw const action, std::ptr::null_mut()) } != 0 {
        return Err(failed("sigaction(SIGSYS)"));
    }
    // SAFETY: a zeroed `sigset_t` is valid and `sigemptyset` initialises it.
    let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
    // SAFETY: `set` is a valid, writable signal set.
    unsafe {
        libc::sigemptyset(&raw mut set);
        libc::sigaddset(&raw mut set, libc::SIGSYS);
    }
    // SAFETY: changes only this thread's mask; `set` is initialised.
    let rc =
        unsafe { libc::pthread_sigmask(libc::SIG_UNBLOCK, &raw const set, std::ptr::null_mut()) };
    if rc != 0 {
        return Err(SandboxError::Apply {
            layer: layer::SECCOMP,
            detail: format!(
                "pthread_sigmask(SIG_UNBLOCK, SIGSYS) failed: {}",
                std::io::Error::from_raw_os_error(rc)
            ),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Set in the child process [`trapped_denials_fail_with_eperm_and_are_counted`]
    /// re-executes this test binary as: only the child installs filters.
    const CHILD_ENV: &str = "TERMIHUB_SIGSYS_TRAP_CHILD";

    fn errno() -> Option<i32> {
        std::io::Error::last_os_error().raw_os_error()
    }

    fn count(snapshot: &[(&str, u32)], name: &str) -> u32 {
        snapshot
            .iter()
            .find(|(n, _)| *n == name)
            .map_or(0, |(_, c)| *c)
    }

    /// Runs in the child: install the handler and the two `EPERM` filters,
    /// then make denied calls from the main thread and a plugin-like thread.
    fn trap_child() {
        use super::super::linux::filters;

        // SAFETY: `prctl(PR_SET_NO_NEW_PRIVS)` takes no pointers.
        assert_eq!(
            unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) },
            0
        );
        install_handler().unwrap();
        let pid = std::process::id();
        for program in [filters::trapped(pid).unwrap(), filters::silent().unwrap()] {
            seccompiler::apply_filter_all_threads(&program).unwrap();
        }
        let _ = take();

        // SAFETY: plain system calls with constant or null arguments; the
        // filter refuses each before the kernel looks at them.
        unsafe {
            assert_eq!(libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0), -1);
            assert_eq!(errno(), Some(libc::EPERM), "socket");
            assert_eq!(libc::connect(-1, std::ptr::null(), 0), -1);
            assert_eq!(errno(), Some(libc::EPERM), "connect");
            // Another process: trapped. Itself: allowed and untouched.
            assert_eq!(libc::kill(1, 0), -1);
            assert_eq!(errno(), Some(libc::EPERM), "kill");
            assert_eq!(libc::kill(libc::getpid(), 0), 0);
            // A SIGSYS sent with `kill` carries no system call: ignored.
            assert_eq!(libc::kill(libc::getpid(), libc::SIGSYS), 0);
        }
        // A trap on another thread works the same way.
        std::thread::spawn(|| {
            // SAFETY: `listen` on an invalid descriptor; refused by the filter.
            let rc = unsafe { libc::listen(-1, 0) };
            assert_eq!((rc, errno()), (-1, Some(libc::EPERM)), "listen");
        })
        .join()
        .unwrap();
        // The handler cannot be replaced, but it can be queried.
        // SAFETY: zeroed `sigaction`s are valid for these calls.
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = libc::SIG_IGN;
            assert_eq!(
                libc::sigaction(libc::SIGSYS, &raw const action, std::ptr::null_mut()),
                -1
            );
            assert_eq!(errno(), Some(libc::EPERM), "rt_sigaction(SIGSYS)");
            let mut current: libc::sigaction = std::mem::zeroed();
            assert_eq!(
                libc::sigaction(libc::SIGSYS, std::ptr::null(), &raw mut current),
                0
            );
            assert_eq!(current.sa_sigaction, handler_address());
        }

        let snapshot = take();
        assert_eq!(count(&snapshot, "socket"), 1);
        assert_eq!(count(&snapshot, "connect"), 1);
        assert_eq!(count(&snapshot, "kill"), 1);
        assert_eq!(count(&snapshot, "listen"), 1);
        assert_eq!(count(&snapshot, "bind"), 0);
        // Drained: the next report starts from zero.
        assert!(take().iter().all(|(_, c)| *c == 0));
    }

    /// The trap end to end, in a child process (the filters are permanent).
    #[test]
    fn trapped_denials_fail_with_eperm_and_are_counted() {
        if std::env::var_os(CHILD_ENV).is_some() {
            trap_child();
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "sandbox::sigsys::tests::trapped_denials_fail_with_eperm_and_are_counted",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD_ENV, "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "child failed ({:?}):\n{stdout}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn only_trapped_calls_are_counted() {
        if std::env::var_os(CHILD_ENV).is_some() {
            return;
        }
        let _ = take();
        record(libc::SYS_bind);
        record(libc::SYS_bind);
        record(libc::SYS_execve);
        let snapshot = take();
        assert_eq!(count(&snapshot, "bind"), 2);
        assert_eq!(snapshot.iter().map(|(_, c)| c).sum::<u32>(), 2);
    }

    #[test]
    fn the_trapped_table_matches_the_reported_names() {
        assert_eq!(TRAPPED.len(), denial::REPORTED_SYSCALLS.len());
        let expected = [
            (libc::SYS_socket, "socket"),
            (libc::SYS_connect, "connect"),
            (libc::SYS_bind, "bind"),
            (libc::SYS_listen, "listen"),
            (libc::SYS_open_by_handle_at, "open_by_handle_at"),
            (libc::SYS_ioctl, "ioctl"),
            (libc::SYS_kill, "kill"),
            (libc::SYS_tgkill, "tgkill"),
            (libc::SYS_prlimit64, "prlimit64"),
        ];
        for (i, (nr, name)) in expected.into_iter().enumerate() {
            assert_eq!(TRAPPED[i], nr, "{name}");
            assert_eq!(denial::REPORTED_SYSCALLS[i], name);
        }
    }

    #[test]
    fn the_siginfo_prefix_has_the_kernel_layout() {
        assert_eq!(std::mem::offset_of!(SigsysInfo, call_addr), 16);
        assert_eq!(std::mem::offset_of!(SigsysInfo, syscall), 24);
        assert_eq!(std::mem::offset_of!(SigsysInfo, arch), 28);
        assert!(std::mem::size_of::<SigsysInfo>() <= std::mem::size_of::<libc::siginfo_t>());
    }
}

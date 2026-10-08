//! Linux: `PR_SET_NO_NEW_PRIVS`, optional namespaces (#4237), a landlock
//! ruleset and a seccomp-bpf filter applied by the runner to itself before
//! `dlopen` (#4185).
//!
//! Mechanisms chosen in the concept and proven in the phase-0 spike (#4181):
//! the official [`landlock`] crate (best-effort compatibility mode, so the
//! report says what the running kernel actually enforced) and [`seccompiler`]
//! (pure Rust, no libseccomp). `extrasafe` and `birdcage` were rejected: the
//! focused crates give exact control over the enforced-layer report the
//! fail-closed policy depends on.
//!
//! **Layers** (in this order):
//!
//! 1. `PR_SET_NO_NEW_PRIVS` — required by landlock and seccomp for an
//!    unprivileged process, and it keeps set-uid binaries from gaining
//!    privileges (there is no `execve` anyway).
//! 2. **namespaces** ([`layer::NETNS`], optional, #4237) — an unprivileged
//!    user + network + IPC namespace: the runner's own ids mapped to
//!    themselves, every capability the new user namespace grants dropped again,
//!    and an empty network namespace (no interface up, not even the loopback).
//!    Entered before landlock (which would deny writing the id maps) and
//!    seccomp (which kills `unshare`). Defence in depth behind the seccomp
//!    `socket` denial and landlock's TCP rules. Where unprivileged user
//!    namespaces are not allowed (Ubuntu 23.10+ AppArmor restriction,
//!    `kernel.unprivileged_userns_clone = 0`, Docker's default seccomp profile)
//!    it is skipped silently: never `missing`, never required, so it does not
//!    change the isolation class. See [`namespaces`].
//! 3. **landlock** ([`layer::LANDLOCK`]) — default-deny filesystem: the
//!    install folder read (+ execute), the data folder read/write (when it
//!    exists: the host creates it for ABI 1.1 plugins only), the system
//!    libraries and a few device and time-zone files read-only, nothing else.
//!    On ABI v4+ (Linux 6.7) every TCP `bind` / `connect` is denied as a second
//!    network layer; on ABI v6+ (Linux 6.12) signals and abstract Unix sockets
//!    are scoped to the runner. A kernel without landlock (< 5.13, or landlock
//!    not enabled) is reported as `missing` — **reduced** isolation, which the
//!    host gates behind the `reducedIsolationAccepted` acknowledgement (#4188).
//! 4. **seccomp** ([`layer::SECCOMP`]) — required: if it cannot be installed
//!    the setup fails and the plugin never loads. See [`filters`]. Its
//!    `EPERM` denials of network and signal calls are reported to the host as
//!    `Denied{syscall}` log frames through a `SIGSYS` trap
//!    ([`super::sigsys`], #4236).
//!
//! Descriptors opened before the sandbox keep working: the IPC socket, the
//! pinned library handle and the connected sockets the host passes with bridge
//! replies (`SCM_RIGHTS`). What is denied is *creating* access — opening paths
//! outside the two folders, `socket` / `connect` / `bind`, `fork`, `execve`.
//!
//! Runs on the main thread before any other thread exists. landlock confines
//! the calling thread (and its future threads); the seccomp filters are
//! installed with `TSYNC` regardless.

use std::os::fd::AsFd;

use landlock::{
    path_beneath_rules, Access, AccessFs, AccessNet, PathBeneath, PathFd, Ruleset, RulesetAttr,
    RulesetCreatedAttr, RulesetStatus, Scope, ABI,
};

use super::{layer, SandboxError, SandboxPolicy};
use crate::ipc::SandboxReport;

/// The newest landlock ABI the ruleset asks for; older kernels get the subset
/// they support (best-effort), newer ones are not asked for rights this code
/// does not know.
const LANDLOCK_ABI: ABI = ABI::V6;

/// System paths a dynamically linked plugin needs to read (its own shared
/// libraries, the loader cache, locale data). Missing paths are skipped.
const SYSTEM_READ_DIRS: &[&str] = &[
    "/lib",
    "/lib32",
    "/lib64",
    "/usr/lib",
    "/usr/lib32",
    "/usr/lib64",
    "/usr/local/lib",
    "/etc/ld.so.cache",
    // Time zone data, so a plugin can format local times (`TZ` is forwarded).
    "/etc/localtime",
    "/usr/share/zoneinfo",
    "/dev/urandom",
    "/dev/random",
    "/dev/zero",
];

/// Device files a plugin may also write.
const SYSTEM_WRITE_FILES: &[&str] = &["/dev/null"];

/// Layers [`apply`] must leave out (debug builds only, through
/// [`SandboxPolicy::simulate_missing`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Skip {
    /// Force the reduced path: landlock reported missing.
    pub landlock: bool,
    /// Do not enter the optional namespaces (as on a system that forbids
    /// unprivileged user namespaces).
    pub namespaces: bool,
}

/// Confine the calling process to `policy`. Irreversible.
///
/// Must run while the process is single-threaded (entering a user namespace
/// requires it; the attempt is skipped otherwise).
pub fn apply(policy: &SandboxPolicy, skip: Skip) -> Result<SandboxReport, SandboxError> {
    set_no_new_privs()?;
    // Before landlock (which would deny writing the id maps under `/proc`)
    // and before seccomp (which kills `unshare`).
    let namespaces = !skip.namespaces && namespaces::enter()?;
    let landlock = if skip.landlock {
        false
    } else {
        apply_landlock(policy)?
    };
    filters::install()?;
    let mut report = SandboxReport::enforced(&[layer::SECCOMP]);
    if landlock {
        report.enforced.push(layer::LANDLOCK.to_owned());
    } else {
        report.missing.push(layer::LANDLOCK.to_owned());
    }
    if namespaces {
        // Optional: listed when enforced, never as missing.
        report.enforced.push(layer::NETNS.to_owned());
    }
    Ok(report)
}

fn set_no_new_privs() -> Result<(), SandboxError> {
    // SAFETY: `prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)` takes no pointers.
    let rc = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if rc == 0 {
        Ok(())
    } else {
        Err(SandboxError::Apply {
            layer: layer::SECCOMP,
            detail: format!(
                "prctl(PR_SET_NO_NEW_PRIVS) failed: {}",
                std::io::Error::last_os_error()
            ),
        })
    }
}

/// Apply the landlock ruleset. `Ok(false)` when this kernel does not enforce
/// landlock at all; an error when it does but the ruleset could not be built
/// (fail closed: never silently skip the filesystem layer).
fn apply_landlock(policy: &SandboxPolicy) -> Result<bool, SandboxError> {
    let failed = |e: &dyn std::fmt::Display| SandboxError::Apply {
        layer: layer::LANDLOCK,
        detail: e.to_string(),
    };
    let abi = LANDLOCK_ABI;
    // The install folder must be confinable: open it explicitly so a missing
    // folder fails the setup instead of being skipped.
    let install = PathFd::new(&policy.install_dir).map_err(|e| failed(&e))?;
    let mut ruleset = Ruleset::default()
        .handle_access(AccessFs::from_all(abi))
        .map_err(|e| failed(&e))?
        .handle_access(AccessNet::BindTcp | AccessNet::ConnectTcp)
        .map_err(|e| failed(&e))?
        .scope(Scope::AbstractUnixSocket | Scope::Signal)
        .map_err(|e| failed(&e))?
        .create()
        .map_err(|e| failed(&e))?
        .add_rule(PathBeneath::new(install, AccessFs::from_read(abi)))
        .map_err(|e| failed(&e))?
        .add_rules(path_beneath_rules(
            SYSTEM_READ_DIRS,
            AccessFs::from_read(abi),
        ))
        .map_err(|e| failed(&e))?
        .add_rules(path_beneath_rules(
            SYSTEM_WRITE_FILES,
            AccessFs::from_read(abi) | AccessFs::WriteFile,
        ))
        .map_err(|e| failed(&e))?;
    if let Some(data) = &policy.data_dir {
        // Absent for an ABI 1.0 plugin: it then has nothing it can write.
        if let Ok(fd) = PathFd::new(data) {
            if is_dir(&fd) {
                ruleset = ruleset
                    .add_rule(PathBeneath::new(fd, AccessFs::from_all(abi)))
                    .map_err(|e| failed(&e))?;
            }
        }
    }
    // No TCP port rule: every bind / connect is denied (ABI v4+).
    let status = ruleset.restrict_self().map_err(|e| failed(&e))?;
    Ok(status.ruleset != RulesetStatus::NotEnforced)
}

/// Whether `fd` names a directory (a data folder replaced by a file or a
/// symlink to one is not granted).
fn is_dir(fd: &PathFd) -> bool {
    let Ok(file) = fd.as_fd().try_clone_to_owned() else {
        return false;
    };
    std::fs::File::from(file)
        .metadata()
        .is_ok_and(|m| m.is_dir())
}

/// The optional namespace layer (#4237): an unprivileged user + network + IPC
/// namespace the runner enters before landlock and seccomp.
///
/// * **user** — required to create the other two without privileges. The
///   runner's effective uid and gid are mapped to themselves (so files it
///   creates in its data folder keep their owner; an unmapped id would make
///   every file creation fail with `EOVERFLOW`), `setgroups` is denied, and
///   every capability the new namespace grants is dropped right away.
/// * **network** — an empty network namespace: no interface is up (the loopback
///   starts down), so even a gap in the seccomp `socket` denial would reach
///   nothing. Descriptors opened before — the IPC channel and the connected
///   bridge sockets the host passes later with `SCM_RIGHTS` — keep working: a
///   socket belongs to the namespace it was created in.
/// * **IPC** — no access to the host's System V IPC objects and POSIX message
///   queues.
///
/// Whether the kernel allows it is first tried in a throw-away child
/// ([`available`](namespaces::available)): `unshare` itself can succeed where writing the id maps
/// then fails (Ubuntu's AppArmor userns restriction drops the capabilities
/// the write needs), and once the runner is in a user namespace it cannot
/// leave it. Only if the child succeeded does the runner enter for real; if
/// that then fails half way (the maps, the capability drop), the setup fails
/// closed rather than run a plugin with unmapped ids or namespace
/// capabilities.
pub mod namespaces {
    use std::ffi::CStr;
    use std::io;

    use super::super::{layer, SandboxError};

    /// The namespaces entered together. `unshare` is all-or-nothing: if one
    /// of them cannot be created, none is.
    const FLAGS: libc::c_int = libc::CLONE_NEWUSER | libc::CLONE_NEWNET | libc::CLONE_NEWIPC;

    const SETGROUPS: &CStr = c"/proc/self/setgroups";
    const UID_MAP: &CStr = c"/proc/self/uid_map";
    const GID_MAP: &CStr = c"/proc/self/gid_map";

    /// `_LINUX_CAPABILITY_VERSION_3`: 64-bit capability sets, two words.
    const CAPABILITY_VERSION_3: u32 = 0x2008_0522;

    /// `struct __user_cap_header_struct`.
    #[repr(C)]
    struct CapHeader {
        version: u32,
        pid: libc::c_int,
    }

    /// `struct __user_cap_data_struct`.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct CapData {
        effective: u32,
        permitted: u32,
        inheritable: u32,
    }

    /// The id maps of the new user namespace: the caller's effective ids
    /// mapped to themselves. Built before `fork` / `unshare`, so writing them
    /// allocates nothing (and `geteuid` still answers in the parent
    /// namespace).
    struct IdMaps {
        uid: Vec<u8>,
        gid: Vec<u8>,
    }

    impl IdMaps {
        fn of_caller() -> Self {
            // SAFETY: neither call takes arguments or can fail.
            let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
            Self {
                uid: format!("{uid} {uid} 1").into_bytes(),
                gid: format!("{gid} {gid} 1").into_bytes(),
            }
        }

        /// Write the maps of the user namespace the caller just entered.
        /// Async-signal-safe (it runs in a forked child too).
        fn write(&self) -> Result<(), (&'static CStr, i32)> {
            // An unprivileged process may only write its gid map once
            // `setgroups` is denied. Kernels before 3.19 have no such file
            // (and no such rule).
            match write_file(SETGROUPS, b"deny") {
                Err((_, libc::ENOENT)) | Ok(()) => {}
                Err(e) => return Err(e),
            }
            write_file(UID_MAP, &self.uid)?;
            write_file(GID_MAP, &self.gid)
        }
    }

    fn errno() -> i32 {
        io::Error::last_os_error().raw_os_error().unwrap_or(0)
    }

    /// Write `bytes` to `path` in one `write`. Async-signal-safe.
    fn write_file(path: &'static CStr, bytes: &[u8]) -> Result<(), (&'static CStr, i32)> {
        // SAFETY: `path` is NUL-terminated; the descriptor is closed below.
        let fd = unsafe { libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err((path, errno()));
        }
        // SAFETY: `bytes` is valid for `bytes.len()` bytes.
        let written = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        let error = errno();
        // SAFETY: `fd` was opened above and is not used again.
        unsafe { libc::close(fd) };
        if usize::try_from(written).is_ok_and(|n| n == bytes.len()) {
            Ok(())
        } else {
            Err((path, error))
        }
    }

    /// Whether this process could enter the namespaces: a forked child tries
    /// `unshare` and the id maps, and exits with the verdict. Leaves the
    /// caller untouched. Safe to call from a multi-threaded process (the
    /// child makes only async-signal-safe calls on memory prepared before the
    /// fork). `false` also when `fork` itself is refused.
    #[must_use]
    pub fn available() -> bool {
        let maps = IdMaps::of_caller();
        // SAFETY: the child only calls `unshare`, `open`, `write`, `close`
        // and `_exit` on memory that exists before the fork; the parent
        // reaps it below.
        match unsafe { libc::fork() } {
            -1 => false,
            0 => {
                // SAFETY: as above; `_exit` skips every atexit handler and
                // buffer flush of the parent's state.
                let entered = unsafe { libc::unshare(FLAGS) } == 0 && maps.write().is_ok();
                unsafe { libc::_exit(i32::from(!entered)) }
            }
            child => exited_cleanly(child),
        }
    }

    /// Reap `child`; whether it exited with code 0.
    fn exited_cleanly(child: libc::pid_t) -> bool {
        let mut status = 0;
        loop {
            // SAFETY: `status` is a valid out pointer; `child` is our child.
            let rc = unsafe { libc::waitpid(child, &mut status, 0) };
            if rc == child {
                return libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0;
            }
            if rc == -1 && errno() != libc::EINTR {
                return false;
            }
        }
    }

    /// Enter the namespaces if this system allows it: `Ok(true)` when the
    /// process now runs in them, `Ok(false)` when they are unavailable (the
    /// process is unchanged), an error when entering failed half way (fail
    /// closed). Must run single-threaded, before landlock and seccomp.
    pub fn enter() -> Result<bool, SandboxError> {
        if !available() {
            return Ok(false);
        }
        let maps = IdMaps::of_caller();
        let death_signal = parent_death_signal();
        // SAFETY: `unshare` takes no pointers.
        if unsafe { libc::unshare(FLAGS) } != 0 {
            // Nothing was entered (e.g. another thread exists after all).
            return Ok(false);
        }
        maps.write().map_err(|(path, errno)| {
            failed(format!(
                "writing {} failed: {}",
                path.to_string_lossy(),
                io::Error::from_raw_os_error(errno)
            ))
        })?;
        drop_capabilities()?;
        // A credential change can clear the parent-death signal; the runner
        // must still die with its host.
        if death_signal != 0 && parent_death_signal() != death_signal {
            // SAFETY: `prctl(PR_SET_PDEATHSIG, sig)` takes no pointers.
            unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, death_signal) };
        }
        Ok(true)
    }

    fn parent_death_signal() -> libc::c_int {
        let mut signal: libc::c_int = 0;
        // SAFETY: `prctl(PR_GET_PDEATHSIG, &int)` writes one `int`.
        unsafe { libc::prctl(libc::PR_GET_PDEATHSIG, &mut signal) };
        signal
    }

    /// Clear the effective, permitted and inheritable capability sets (the
    /// ambient set follows the permitted one). The new user namespace grants
    /// all of them; the runner needs none.
    fn drop_capabilities() -> Result<(), SandboxError> {
        let mut header = CapHeader {
            version: CAPABILITY_VERSION_3,
            pid: 0,
        };
        let data = [CapData::default(); 2];
        // SAFETY: `capset` reads one header and two data structs, laid out
        // as the kernel's v3 structs.
        let rc = unsafe {
            libc::syscall(
                libc::SYS_capset,
                std::ptr::addr_of_mut!(header),
                data.as_ptr(),
            )
        };
        if rc == 0 {
            Ok(())
        } else {
            Err(failed(format!(
                "capset failed: {}",
                io::Error::last_os_error()
            )))
        }
    }

    fn failed(detail: String) -> SandboxError {
        SandboxError::Apply {
            layer: layer::NETNS,
            detail,
        }
    }
}

/// The seccomp-bpf filters (#4185). Four filters are stacked; for every
/// system call the kernel takes the most severe verdict of all of them
/// (`KILL_PROCESS` > `TRAP` > `ERRNO` > `ALLOW`):
///
/// 1. **allow-list** — [`allowed`](filters::allowed) syscalls pass, everything else fails with
///    `ENOSYS` (the conventional "not available here", which libraries fall
///    back from). `clone3` is deliberately absent: its flags sit behind a
///    pointer seccomp cannot inspect, and on `ENOSYS` glibc falls back to
///    `clone`, whose flags filter 2 checks.
/// 2. **denials with `EPERM`** — "soft" calls a plugin may reasonably try and
///    must see fail cleanly. Using descriptors the host passed in (`read`,
///    `write`, `sendmsg`, `recvmsg`, `shutdown`, socket options) stays
///    allowed. Two filters (#4236):
///    * [`trapped`](filters::trapped) — `socket`, `connect`, `bind`, `listen`,
///      `open_by_handle_at`, `ioctl(TIOCSTI)` (terminal input injection),
///      `kill` / `tgkill` of another process, `prlimit64` on another process
///      — answered with `SECCOMP_RET_TRAP`: the `SIGSYS` handler
///      ([`super::sigsys`]) makes the call fail with `EPERM` and counts it for
///      the host's denial report;
///    * [`silent`](filters::silent) — `fork` / `vfork`, `clone` without
///      `CLONE_THREAD` (a new process) or with a namespace flag, and
///      `rt_sigaction(SIGSYS, <new action>)` (replacing the trap handler) —
///      answered with plain `SECCOMP_RET_ERRNO(EPERM)`, unreported: libc
///      blocks every signal around a process-creating `clone`, where a trap
///      would kill the runner instead of failing.
/// 3. **denials with `KILL_PROCESS`** — escape primitives no plugin has a
///    reason to call: `execve*`, `ptrace`, `process_vm_*`, `pidfd_getfd`,
///    mounts, `bpf`, keyrings, `perf_event_open`, `io_uring_*`, `unshare`,
///    `setns`, module and kexec loading, `userfaultfd`.
pub mod filters {
    use std::collections::BTreeMap;

    use seccompiler::{
        apply_filter_all_threads, BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp,
        SeccompCondition, SeccompFilter, SeccompRule, TargetArch,
    };

    use super::super::{layer, SandboxError};

    /// The syscalls the allow-list filter passes. Everything a Rust or C
    /// plugin and the runner itself need — memory, threads, futexes, timers,
    /// polling, signals, file I/O within what landlock grants, and I/O on
    /// existing sockets — plus the calls filter 2 answers with `EPERM` (so
    /// that verdict, not `ENOSYS`, is what the plugin sees).
    #[must_use]
    pub fn allowed() -> Vec<i64> {
        let mut calls = vec![
            // File and descriptor I/O (paths are confined by landlock).
            libc::SYS_read,
            libc::SYS_write,
            libc::SYS_readv,
            libc::SYS_writev,
            libc::SYS_pread64,
            libc::SYS_pwrite64,
            libc::SYS_preadv,
            libc::SYS_pwritev,
            libc::SYS_preadv2,
            libc::SYS_pwritev2,
            libc::SYS_close,
            libc::SYS_close_range,
            libc::SYS_dup,
            libc::SYS_dup3,
            libc::SYS_fcntl,
            libc::SYS_ioctl,
            libc::SYS_lseek,
            libc::SYS_openat,
            libc::SYS_openat2,
            libc::SYS_newfstatat,
            libc::SYS_fstat,
            libc::SYS_statx,
            libc::SYS_statfs,
            libc::SYS_fstatfs,
            libc::SYS_faccessat,
            libc::SYS_faccessat2,
            libc::SYS_readlinkat,
            libc::SYS_getdents64,
            libc::SYS_mkdirat,
            libc::SYS_unlinkat,
            libc::SYS_renameat,
            libc::SYS_renameat2,
            libc::SYS_linkat,
            libc::SYS_symlinkat,
            libc::SYS_ftruncate,
            libc::SYS_fsync,
            libc::SYS_fdatasync,
            libc::SYS_fallocate,
            libc::SYS_flock,
            libc::SYS_fchmod,
            libc::SYS_fchmodat,
            libc::SYS_utimensat,
            libc::SYS_getcwd,
            libc::SYS_chdir,
            libc::SYS_fchdir,
            libc::SYS_umask,
            libc::SYS_copy_file_range,
            libc::SYS_splice,
            libc::SYS_pipe2,
            libc::SYS_memfd_create,
            libc::SYS_inotify_init1,
            libc::SYS_inotify_add_watch,
            libc::SYS_inotify_rm_watch,
            // Polling, events, timers.
            libc::SYS_epoll_create1,
            libc::SYS_epoll_ctl,
            libc::SYS_epoll_pwait,
            libc::SYS_epoll_pwait2,
            libc::SYS_ppoll,
            libc::SYS_pselect6,
            libc::SYS_eventfd2,
            libc::SYS_signalfd4,
            libc::SYS_timerfd_create,
            libc::SYS_timerfd_settime,
            libc::SYS_timerfd_gettime,
            libc::SYS_timer_create,
            libc::SYS_timer_settime,
            libc::SYS_timer_gettime,
            libc::SYS_timer_getoverrun,
            libc::SYS_timer_delete,
            libc::SYS_getitimer,
            libc::SYS_setitimer,
            libc::SYS_nanosleep,
            libc::SYS_clock_nanosleep,
            libc::SYS_clock_gettime,
            libc::SYS_clock_getres,
            libc::SYS_gettimeofday,
            // Memory (malloc arenas, thread stacks, the plugin's mappings).
            libc::SYS_mmap,
            libc::SYS_munmap,
            libc::SYS_mprotect,
            libc::SYS_mremap,
            libc::SYS_madvise,
            libc::SYS_brk,
            libc::SYS_msync,
            libc::SYS_mincore,
            libc::SYS_membarrier,
            libc::SYS_get_mempolicy,
            // Threads and synchronisation. `clone` is narrowed by filter 2.
            libc::SYS_clone,
            libc::SYS_futex,
            libc::SYS_futex_waitv,
            libc::SYS_set_robust_list,
            libc::SYS_get_robust_list,
            libc::SYS_set_tid_address,
            libc::SYS_rseq,
            libc::SYS_sched_yield,
            libc::SYS_sched_getaffinity,
            libc::SYS_sched_getparam,
            libc::SYS_sched_getscheduler,
            libc::SYS_sched_getattr,
            libc::SYS_sched_get_priority_max,
            libc::SYS_sched_get_priority_min,
            libc::SYS_getcpu,
            libc::SYS_exit,
            libc::SYS_exit_group,
            libc::SYS_wait4,
            libc::SYS_waitid,
            libc::SYS_restart_syscall,
            // Signals (to itself; filter 2 narrows `kill` / `tgkill`).
            libc::SYS_rt_sigaction,
            libc::SYS_rt_sigprocmask,
            libc::SYS_rt_sigreturn,
            libc::SYS_rt_sigsuspend,
            libc::SYS_rt_sigtimedwait,
            libc::SYS_sigaltstack,
            libc::SYS_kill,
            libc::SYS_tgkill,
            // Process information.
            libc::SYS_getpid,
            libc::SYS_gettid,
            libc::SYS_getppid,
            libc::SYS_getuid,
            libc::SYS_geteuid,
            libc::SYS_getgid,
            libc::SYS_getegid,
            libc::SYS_getgroups,
            libc::SYS_getresuid,
            libc::SYS_getresgid,
            libc::SYS_getpgid,
            libc::SYS_getsid,
            libc::SYS_getpriority,
            libc::SYS_getrusage,
            libc::SYS_prlimit64,
            libc::SYS_uname,
            libc::SYS_sysinfo,
            libc::SYS_times,
            libc::SYS_prctl,
            libc::SYS_getrandom,
            // I/O on existing sockets (the IPC channel, bridge sockets).
            libc::SYS_sendto,
            libc::SYS_recvfrom,
            libc::SYS_sendmsg,
            libc::SYS_recvmsg,
            libc::SYS_sendmmsg,
            libc::SYS_recvmmsg,
            libc::SYS_shutdown,
            libc::SYS_getsockopt,
            libc::SYS_setsockopt,
            libc::SYS_getsockname,
            libc::SYS_getpeername,
            libc::SYS_socketpair,
            // Answered with EPERM by the trapped filter.
            libc::SYS_socket,
            libc::SYS_connect,
            libc::SYS_bind,
            libc::SYS_listen,
            libc::SYS_open_by_handle_at,
        ];
        #[cfg(target_arch = "x86_64")]
        calls.extend([
            // Legacy x86_64 entry points glibc and older code still use.
            libc::SYS_open,
            libc::SYS_stat,
            libc::SYS_lstat,
            libc::SYS_access,
            libc::SYS_readlink,
            libc::SYS_getdents,
            libc::SYS_mkdir,
            libc::SYS_rmdir,
            libc::SYS_unlink,
            libc::SYS_rename,
            libc::SYS_poll,
            libc::SYS_select,
            libc::SYS_pipe,
            libc::SYS_dup2,
            libc::SYS_epoll_create,
            libc::SYS_epoll_wait,
            libc::SYS_eventfd,
            libc::SYS_signalfd,
            libc::SYS_inotify_init,
            libc::SYS_fadvise64,
            libc::SYS_sendfile,
            libc::SYS_time,
            libc::SYS_getpgrp,
            libc::SYS_alarm,
            libc::SYS_pause,
            libc::SYS_arch_prctl,
            // Answered with EPERM by the silent filter.
            libc::SYS_fork,
            libc::SYS_vfork,
        ]);
        // `libc` names neither on aarch64 (asm-generic `sendfile` = 71,
        // `fadvise64_64` = 223).
        #[cfg(target_arch = "aarch64")]
        calls.extend([71, 223]);
        calls
    }

    /// Syscalls killed outright (filter 3).
    #[must_use]
    pub fn killed() -> Vec<i64> {
        #[cfg_attr(not(target_arch = "x86_64"), allow(unused_mut))]
        let mut calls = vec![
            libc::SYS_execve,
            libc::SYS_execveat,
            libc::SYS_ptrace,
            libc::SYS_process_vm_readv,
            libc::SYS_process_vm_writev,
            libc::SYS_process_madvise,
            libc::SYS_pidfd_getfd,
            libc::SYS_mount,
            libc::SYS_umount2,
            libc::SYS_pivot_root,
            libc::SYS_chroot,
            libc::SYS_fsopen,
            libc::SYS_fsmount,
            libc::SYS_fsconfig,
            libc::SYS_move_mount,
            libc::SYS_open_tree,
            libc::SYS_mount_setattr,
            libc::SYS_bpf,
            libc::SYS_keyctl,
            libc::SYS_add_key,
            libc::SYS_request_key,
            libc::SYS_perf_event_open,
            libc::SYS_io_uring_setup,
            libc::SYS_io_uring_enter,
            libc::SYS_io_uring_register,
            libc::SYS_unshare,
            libc::SYS_setns,
            libc::SYS_init_module,
            libc::SYS_finit_module,
            libc::SYS_delete_module,
            libc::SYS_kexec_load,
            libc::SYS_kexec_file_load,
            libc::SYS_userfaultfd,
            libc::SYS_reboot,
            libc::SYS_swapon,
            libc::SYS_swapoff,
            libc::SYS_acct,
        ];
        #[cfg(target_arch = "x86_64")]
        calls.extend([
            libc::SYS_iopl,
            libc::SYS_ioperm,
            libc::SYS_modify_ldt,
            libc::SYS_uselib,
        ]);
        calls
    }

    /// `ioctl(TIOCSTI)`: the same number on x86_64 and aarch64 (`libc` types
    /// it differently per C library).
    const TIOCSTI: u64 = 0x5412;

    /// Namespace flags `clone` must not carry.
    const CLONE_NAMESPACES: &[libc::c_int] = &[
        libc::CLONE_NEWNS,
        libc::CLONE_NEWUSER,
        libc::CLONE_NEWPID,
        libc::CLONE_NEWNET,
        libc::CLONE_NEWIPC,
        libc::CLONE_NEWUTS,
        libc::CLONE_NEWCGROUP,
    ];

    fn arch() -> Result<TargetArch, SandboxError> {
        std::env::consts::ARCH.try_into().map_err(|e| failed(&e))
    }

    fn failed(e: &dyn std::fmt::Display) -> SandboxError {
        SandboxError::Apply {
            layer: layer::SECCOMP,
            detail: e.to_string(),
        }
    }

    fn condition(arg: u8, op: SeccompCmpOp, value: u64) -> Result<SeccompCondition, SandboxError> {
        SeccompCondition::new(arg, SeccompCmpArgLen::Qword, op, value).map_err(|e| failed(&e))
    }

    fn rule(conditions: Vec<SeccompCondition>) -> Result<SeccompRule, SandboxError> {
        SeccompRule::new(conditions).map_err(|e| failed(&e))
    }

    fn compile(
        rules: BTreeMap<i64, Vec<SeccompRule>>,
        mismatch: SeccompAction,
        matched: SeccompAction,
    ) -> Result<BpfProgram, SandboxError> {
        SeccompFilter::new(rules, mismatch, matched, arch()?)
            .and_then(BpfProgram::try_from)
            .map_err(|e| failed(&e))
    }

    /// Filter 1: the allow-list.
    pub fn allow_list() -> Result<BpfProgram, SandboxError> {
        let rules = allowed().into_iter().map(|nr| (nr, Vec::new())).collect();
        compile(
            rules,
            SeccompAction::Errno(libc::ENOSYS as u32),
            SeccompAction::Allow,
        )
    }

    /// Filter 2a: the reported `EPERM` denials, answered with
    /// `SECCOMP_RET_TRAP` (the `SIGSYS` handler returns `EPERM`). `pid` is
    /// the runner's own process id (the only target `kill`, `tgkill` and
    /// `prlimit64` may name). Covers exactly [`super::super::sigsys::trapped`].
    pub fn trapped(pid: u32) -> Result<BpfProgram, SandboxError> {
        let pid = u64::from(pid);
        let mut rules: BTreeMap<i64, Vec<SeccompRule>> = [
            libc::SYS_socket,
            libc::SYS_connect,
            libc::SYS_bind,
            libc::SYS_listen,
            libc::SYS_open_by_handle_at,
        ]
        .into_iter()
        .map(|nr| (nr, Vec::new()))
        .collect();
        // Typing into the controlling terminal of another process.
        rules.insert(
            libc::SYS_ioctl,
            vec![rule(vec![condition(
                1,
                SeccompCmpOp::MaskedEq(0xffff_ffff),
                TIOCSTI,
            )?])?],
        );
        // Signals and resource limits of other processes.
        rules.insert(
            libc::SYS_kill,
            vec![rule(vec![condition(0, SeccompCmpOp::Ne, pid)?])?],
        );
        rules.insert(
            libc::SYS_tgkill,
            vec![rule(vec![condition(0, SeccompCmpOp::Ne, pid)?])?],
        );
        rules.insert(
            libc::SYS_prlimit64,
            vec![rule(vec![
                condition(0, SeccompCmpOp::Ne, 0)?,
                condition(0, SeccompCmpOp::Ne, pid)?,
            ])?],
        );
        compile(rules, SeccompAction::Allow, SeccompAction::Trap)
    }

    /// Filter 2b: the unreported `EPERM` denials — process creation (where
    /// libc blocks every signal, so a trap would kill instead of fail) and
    /// replacing the `SIGSYS` handler the trapped filter relies on.
    pub fn silent() -> Result<BpfProgram, SandboxError> {
        let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
        #[cfg(target_arch = "x86_64")]
        for nr in [libc::SYS_fork, libc::SYS_vfork] {
            rules.insert(nr, Vec::new());
        }
        // A new process (no CLONE_THREAD), or any new namespace.
        let thread = libc::CLONE_THREAD as u64;
        let mut clone = vec![rule(vec![condition(
            0,
            SeccompCmpOp::MaskedEq(thread),
            0,
        )?])?];
        for &flag in CLONE_NAMESPACES {
            let flag = flag as u64;
            clone.push(rule(vec![condition(
                0,
                SeccompCmpOp::MaskedEq(flag),
                flag,
            )?])?);
        }
        rules.insert(libc::SYS_clone, clone);
        // `rt_sigaction(SIGSYS, act, …)` with a new action: a plugin handler
        // could make a trapped call look successful. Querying (`act` = NULL)
        // stays allowed. The signal number is an `int`: compare 32 bits.
        let sigsys = SeccompCondition::new(
            0,
            SeccompCmpArgLen::Dword,
            SeccompCmpOp::Eq,
            libc::SIGSYS as u64,
        )
        .map_err(|e| failed(&e))?;
        rules.insert(
            libc::SYS_rt_sigaction,
            vec![rule(vec![sigsys, condition(1, SeccompCmpOp::Ne, 0)?])?],
        );
        compile(
            rules,
            SeccompAction::Allow,
            SeccompAction::Errno(libc::EPERM as u32),
        )
    }

    /// Filter 3: the `KILL_PROCESS` denials.
    pub fn kill_list() -> Result<BpfProgram, SandboxError> {
        let rules = killed().into_iter().map(|nr| (nr, Vec::new())).collect();
        compile(rules, SeccompAction::Allow, SeccompAction::KillProcess)
    }

    /// x86_64 only: kill any call through the x32 ABI (syscall numbers with
    /// bit 30 set). x32 shares the x86_64 audit architecture, so the
    /// per-number filters above would not see `socket` called as x32.
    #[cfg(target_arch = "x86_64")]
    fn x32_guard() -> BpfProgram {
        use seccompiler::sock_filter;
        const BPF_LD_W_ABS: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
        const BPF_JGE_K: u16 = 0x35; // BPF_JMP | BPF_JGE | BPF_K
        const BPF_RET_K: u16 = 0x06; // BPF_RET | BPF_K
        const X32_SYSCALL_BIT: u32 = 0x4000_0000;
        let insn = |code, jt, jf, k| sock_filter { code, jt, jf, k };
        vec![
            // A = seccomp_data.nr (offset 0)
            insn(BPF_LD_W_ABS, 0, 0, 0),
            // if A >= X32_SYSCALL_BIT goto kill else goto allow
            insn(BPF_JGE_K, 0, 1, X32_SYSCALL_BIT),
            insn(BPF_RET_K, 0, 0, libc::SECCOMP_RET_KILL_PROCESS),
            insn(BPF_RET_K, 0, 0, libc::SECCOMP_RET_ALLOW),
        ]
    }

    /// Install the `SIGSYS` handler, then every filter on all threads of
    /// this process. Requires `PR_SET_NO_NEW_PRIVS` (set first by the
    /// caller).
    ///
    /// The allow-list goes last: it does not allow `seccomp` itself, so no
    /// filter can be installed after it (not by us, not by the plugin).
    pub fn install() -> Result<(), SandboxError> {
        super::super::sigsys::install_handler()?;
        let mut programs = vec![trapped(std::process::id())?, silent()?, kill_list()?];
        #[cfg(target_arch = "x86_64")]
        programs.push(x32_guard());
        programs.push(allow_list()?);
        for program in &programs {
            apply_filter_all_threads(program).map_err(|e| failed(&e))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::filters;

    #[test]
    fn every_filter_compiles_for_this_architecture() {
        assert!(!filters::allow_list().unwrap().is_empty());
        assert!(!filters::trapped(std::process::id()).unwrap().is_empty());
        assert!(!filters::silent().unwrap().is_empty());
        assert!(!filters::kill_list().unwrap().is_empty());
    }

    #[test]
    fn the_lists_are_disjoint_and_free_of_duplicates() {
        let allowed = filters::allowed();
        let unique: HashSet<_> = allowed.iter().collect();
        assert_eq!(unique.len(), allowed.len(), "duplicate allow-list entry");
        for nr in filters::killed() {
            assert!(
                !unique.contains(&nr),
                "syscall {nr} is both allowed and killed"
            );
        }
    }

    /// Every trapped call must pass the allow-list (otherwise the plugin
    /// would see `ENOSYS` there instead of the trapped `EPERM`) and none may
    /// be killed.
    #[test]
    fn every_trapped_call_passes_the_allow_list() {
        let allowed: HashSet<_> = filters::allowed().into_iter().collect();
        let killed: HashSet<_> = filters::killed().into_iter().collect();
        for nr in super::super::sigsys::trapped() {
            assert!(allowed.contains(nr), "trapped syscall {nr} is not allowed");
            assert!(!killed.contains(nr), "trapped syscall {nr} is killed");
        }
    }

    /// `clone3` must answer `ENOSYS` (not be allowed) so glibc falls back to
    /// the inspectable `clone`; `execve` and `ptrace` are never allowed.
    #[test]
    fn process_creation_primitives_are_not_allowed() {
        let allowed: HashSet<_> = filters::allowed().into_iter().collect();
        for nr in [libc::SYS_clone3, libc::SYS_execve, libc::SYS_ptrace] {
            assert!(!allowed.contains(&nr), "syscall {nr} must not be allowed");
        }
        assert!(allowed.contains(&libc::SYS_clone), "threads need clone");
        let killed: HashSet<_> = filters::killed().into_iter().collect();
        for nr in [libc::SYS_execve, libc::SYS_execveat, libc::SYS_ptrace] {
            assert!(killed.contains(&nr));
        }
    }
}

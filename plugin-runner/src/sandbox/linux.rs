//! Linux: `PR_SET_NO_NEW_PRIVS`, a landlock ruleset and a seccomp-bpf filter
//! applied by the runner to itself before `dlopen` (#4185).
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
//! 1. `PR_SET_NO_NEW_PRIVS` — required by both other layers for an
//!    unprivileged process, and it keeps set-uid binaries from gaining
//!    privileges (there is no `execve` anyway).
//! 2. **landlock** ([`layer::LANDLOCK`]) — default-deny filesystem: the
//!    install folder read (+ execute), the data folder read/write (when it
//!    exists: the host creates it for ABI 1.1 plugins only), the system
//!    libraries and a few device and time-zone files read-only, nothing else.
//!    On ABI v4+ (Linux 6.7) every TCP `bind` / `connect` is denied as a second
//!    network layer; on ABI v6+ (Linux 6.12) signals and abstract Unix sockets
//!    are scoped to the runner. A kernel without landlock (< 5.13, or landlock
//!    not enabled) is reported as `missing` — **reduced** isolation, which the
//!    host gates behind the `reducedIsolationAccepted` acknowledgement (#4188).
//! 3. **seccomp** ([`layer::SECCOMP`]) — required: if it cannot be installed
//!    the setup fails and the plugin never loads. See [`filters`].
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

/// Confine the calling process to `policy`. Irreversible.
///
/// `skip_landlock` forces the reduced path (debug builds only, through
/// [`SandboxPolicy::simulate_missing`]).
pub fn apply(policy: &SandboxPolicy, skip_landlock: bool) -> Result<SandboxReport, SandboxError> {
    set_no_new_privs()?;
    let landlock = if skip_landlock {
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

/// The seccomp-bpf filters (#4185). Three filters are stacked; for every
/// system call the kernel takes the most severe verdict of all of them
/// (`KILL_PROCESS` > `ERRNO` > `ALLOW`):
///
/// 1. **allow-list** — [`allowed`] syscalls pass, everything else fails with
///    `ENOSYS` (the conventional "not available here", which libraries fall
///    back from). `clone3` is deliberately absent: its flags sit behind a
///    pointer seccomp cannot inspect, and on `ENOSYS` glibc falls back to
///    `clone`, whose flags filter 2 checks.
/// 2. **denials with `EPERM`** — "soft" calls a plugin may reasonably try and
///    must see fail cleanly: `socket`, `connect`, `bind`, `listen`,
///    `open_by_handle_at`, `fork` / `vfork`, `clone` without `CLONE_THREAD`
///    (a new process) or with a namespace flag, `ioctl(TIOCSTI)` (terminal
///    input injection), `kill` / `tgkill` of another process, `prlimit64` on
///    another process. Using descriptors the host passed in (`read`, `write`,
///    `sendmsg`, `recvmsg`, `shutdown`, socket options) stays allowed.
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
            // Answered with EPERM by filter 2.
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
            // Answered with EPERM by filter 2.
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

    /// Filter 2: the `EPERM` denials. `pid` is the runner's own process id
    /// (the only target `kill`, `tgkill` and `prlimit64` may name).
    pub fn eperm(pid: u32) -> Result<BpfProgram, SandboxError> {
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

    /// Install every filter on all threads of this process. Requires
    /// `PR_SET_NO_NEW_PRIVS` (set first by the caller).
    ///
    /// The allow-list goes last: it does not allow `seccomp` itself, so no
    /// filter can be installed after it (not by us, not by the plugin).
    pub fn install() -> Result<(), SandboxError> {
        let mut programs = vec![eperm(std::process::id())?, kill_list()?];
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
        assert!(!filters::eperm(std::process::id()).unwrap().is_empty());
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

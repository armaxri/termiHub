---
id: SEC2-003
title: "Linux reduced isolation (no landlock) still lets a plugin open /proc/<host>/mem and write dotfiles; the warning says the opposite"
angle: security
severity: low
category: security
is_workaround: false
subsystem: "plugin-runner/src/sandbox/linux.rs, reduced-isolation consent"
evidence:
  - plugin-runner/src/sandbox/linux.rs:109
  - plugin-runner/src/sandbox/linux.rs:495
  - plugin-runner/src/sandbox/linux.rs:484
  - plugin-runner/src/sandbox/linux.rs:685
  - src/components/Settings/nativePluginSandbox.ts:77
  - src/components/Settings/nativePluginSandbox.ts:83
  - core/src/plugin/host.rs:935
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

When landlock is unavailable (kernel < 5.13, e.g. RHEL/Alma 8 on 4.18, Debian 11, or landlock not in `lsm=`), seccomp is the only required layer. seccomp allows `openat`/`pwrite64` on any path and only kills `process_vm_*`/`ptrace`. The runner is a same-uid child of the dumpable host. Where Yama `ptrace_scope` is 0 (the RHEL default) or Yama is absent, `open("/proc/<ppid>/mem", O_RDWR)` passes `ptrace_may_access`, because the same-kuid check succeeds even inside the optional user namespace. The plugin can then write code into the termiHub host process. Even without that, it can write ~/.bashrc, ~/.config/autostart and the termiHub trust store. The reduced-isolation warning the user accepts says "This system cannot restrict file access … Network and program limits still apply."

## Why it matters

The consent understates the risk. Accepting "file access is unrestricted" in fact means "the plugin can take over termiHub (all sessions and credentials) and run programs at your next login". For a safety-critical release, informed consent must be accurate, and the reduced mode should not include a same-uid host-memory primitive.

## Evidence

- `plugin-runner/src/sandbox/linux.rs:109`
- `plugin-runner/src/sandbox/linux.rs:495`
- `plugin-runner/src/sandbox/linux.rs:484`
- `plugin-runner/src/sandbox/linux.rs:685`
- `src/components/Settings/nativePluginSandbox.ts:77`
- `src/components/Settings/nativePluginSandbox.ts:83`
- `core/src/plugin/host.rs:935`

## Recommendation

In reduced mode, deny same-uid /proc access to the host. Options: (a) call prctl(PR_SET_DUMPABLE, 0) in the release host process; (b) have the runner, while in its user namespace, unshare(CLONE_NEWNS) and mount an empty tmpfs over /proc and $HOME before installing seccomp; (c) refuse reduced mode when /proc/sys/kernel/yama/ptrace_scope < 1 and no mount-namespace confinement was applied. Also reword the warning (e.g. "can read and change any of your files, including startup scripts, so it can effectively run programs as you") and drop "program limits still apply".

## Verification

Partly confirmed. With landlock skipped, linux.rs apply() leaves seccomp as the only file control, and seccomp allows openat and pwrite64 on any path. A plugin can therefore write ~/.bashrc or autostart entries, so the line 'Network and program limits still apply' (nativePluginSandbox.ts:83) overstates the protection, because a written dotfile runs programs at the next login. No PR_SET_DUMPABLE or ptrace_scope handling exists anywhere. The /proc/<ppid>/mem claim is overstated, though. When the optional user namespace is entered (CLONE_NEWUSER, linux.rs:235), the kernel's cap_ptrace_access_check needs the same user_ns or CAP_SYS_PTRACE in the host's namespace, so PTRACE_MODE_ATTACH on the parent fails even with a matching kuid. The memory write needs both namespace entry failing and Yama ptrace_scope=0. The user has also explicitly accepted 'cannot restrict file access' (reducedIsolationAccepted, #4188). Real, but the warning wording plus a narrower host-memory path is low, not medium.

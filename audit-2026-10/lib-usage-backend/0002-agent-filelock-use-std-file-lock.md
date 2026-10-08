---
id: LIBBE2-002
title: "Agent FileLock hand-rolls unsafe LockFileEx/UnlockFileEx and nix flock where std::fs::File::lock (already used by the desktop) suffices"
angle: lib-usage-backend
severity: low
category: maintainability
is_workaround: false
subsystem: "agent/fs"
evidence:
  - agent/src/fs.rs:76
  - agent/src/fs.rs:105
  - agent/src/fs.rs:114
  - agent/src/fs.rs:125
  - agent/src/fs.rs:149
  - agent/src/fs.rs:156
  - src-tauri/src/utils/data_dir_lock.rs:79
  - .github/rust-version:1
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

agent::fs::FileLock (the AGT-016 lock that serialises state.json read-modify-write) has three cfg branches. Unix uses nix::fcntl::Flock. Windows calls LockFileEx and UnlockFileEx inside `unsafe` blocks with a zeroed OVERLAPPED and needs a manual Drop impl. Every other platform gets a no-op. The toolchain is pinned to Rust 1.98 (.github/rust-version), and std::fs::File::lock / try_lock / unlock have been stable since 1.89. The desktop's data-dir lock already uses std File::try_lock (src-tauri/src/utils/data_dir_lock.rs:79).

## Why it matters

About 60 lines of platform-specific code, two unsafe FFI blocks and a hand-written Drop are kept for something std now provides on every platform, with the same flock/LockFileEx semantics underneath. The desktop and agent also take advisory locks in two different ways. Each unsafe block is extra review surface in a safety-critical codebase, and the windows-sys FileSystem/IO features are only enabled to support it.

## Evidence

- `agent/src/fs.rs:76`
- `agent/src/fs.rs:105`
- `agent/src/fs.rs:114`
- `agent/src/fs.rs:125`
- `agent/src/fs.rs:149`
- `agent/src/fs.rs:156`
- `src-tauri/src/utils/data_dir_lock.rs:79`
- `.github/rust-version:1`

## Recommendation

Replace FileLock's internals with `let file = OpenOptions…open(&lock_path)?; file.lock()?; Ok(Self { file })`. std releases the lock when the File is dropped, or call file.unlock() in Drop if explicit release is preferred. Delete the cfg(windows) unsafe branch and its Drop impl, and the nix Flock branch. Then drop `Win32_Storage_FileSystem` and `Win32_System_IO` from agent/Cargo.toml if nothing else uses them. The existing tests at agent/src/fs.rs:249-290 cover the behaviour.

## Verification

Confirmed at agent/src/fs.rs:76-163. Unix uses nix Flock. Windows calls LockFileEx/UnlockFileEx in unsafe blocks with a manual Drop. The toolchain is pinned to 1.98.0 (.github/rust-version, workspace rust-version), and std File::lock has been stable since 1.89. The desktop already uses std try_lock (src-tauri/src/utils/data_dir_lock.rs:79). The comment at agent/Cargo.toml:115-117 shows Win32_Storage_FileSystem and Win32_System_IO are enabled only for this lock, and no other agent source uses them. This is a maintainability issue, not a bug.

---
id: SEC2-006
title: "Linux sandbox lets plugins watch and stat paths outside their landlock scope (inotify / stat metadata leak)"
angle: security
severity: low
category: security
is_workaround: false
subsystem: "plugin-runner/src/sandbox/linux.rs"
evidence:
  - plugin-runner/src/sandbox/linux.rs:497
  - plugin-runner/src/sandbox/linux.rs:498
  - plugin-runner/src/sandbox/linux.rs:528
  - plugin-runner/src/sandbox/linux.rs:529
status: fixed
resolution: "#4342 — inotify answers ENOSYS; the userns layer masks the home folder; the metadata leak without userns is documented"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

The seccomp allow-list includes `inotify_init1`/`inotify_add_watch`, `newfstatat`/`statx`/`faccessat2` and `readlinkat`. Landlock only mediates open/create/rename/link/truncate/ioctl; it doesn't hook path lookups for stat or inotify watches. A confined plugin can probe the existence, size and mtime of any path under the user's home (e.g. ~/.ssh/id_ed25519, ~/.config/termihub/\*), and can inotify-watch home directories to get the names of files the user creates or opens (IN_CREATE/IN_OPEN events carry entry names) in real time. On macOS, Seatbelt's `(deny default)` blocks file-read-metadata for the same paths, so the platforms differ.

## Why it matters

Not content disclosure, but it is a continuous activity and file-name side channel from code the user was told has "No access to your home folder or other files". Plugins have no legitimate need to watch anything beyond their own data folder.

## Evidence

- `plugin-runner/src/sandbox/linux.rs:497`
- `plugin-runner/src/sandbox/linux.rs:498`
- `plugin-runner/src/sandbox/linux.rs:528`
- `plugin-runner/src/sandbox/linux.rs:529`

## Recommendation

Remove `inotify_init1`/`inotify_init`/`inotify_add_watch` from the allow-list (ENOSYS), or move them to the trapped EPERM list. Where the user namespace is available, also unshare(CLONE_NEWNS) before seccomp and bind/tmpfs-mask $HOME, so stat-based probing outside the two folders fails. If metadata leakage is accepted on Linux, document it in the trust disclosure.

## Verification

Confirmed. The seccomp allow-list includes inotify_init1, inotify_add_watch, newfstatat, statx, faccessat2 and readlinkat (linux.rs ~497-529). Landlock does not mediate stat or inotify watches, so metadata and file-name events outside the plugin's scope can be observed. macOS uses (deny default) with no metadata allow outside the listed subpaths. The UI chip says 'No access to your home folder or other files' (nativePluginSandbox.ts:210). It leaks metadata only, not contents, so low.

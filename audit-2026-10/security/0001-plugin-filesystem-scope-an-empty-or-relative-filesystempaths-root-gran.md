---
id: SEC2-001
title: 'Plugin filesystem scope: an empty, "." or relative filesystemPaths root grants the whole filesystem through the bridge'
angle: security
severity: medium
category: security
is_workaround: false
subsystem: "core/src/plugin/security.rs (FilesystemScope), plugin capability bridge"
evidence:
  - core/src/plugin/manifest.rs:313
  - core/src/plugin/security.rs:197
  - core/src/plugin/security.rs:251
  - core/src/plugin/security.rs:252
  - core/src/plugin/security.rs:316
  - core/src/plugin/sandbox/bridge.rs:1
  - core/src/plugin/capabilities.rs:217
  - src/components/Settings/nativePluginSandbox.ts:199
  - src/components/Settings/nativePluginSandbox.ts:211
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Nothing validates manifest `filesystemPaths`: there is no absolute-path, non-empty or non-root check in manifest validation, and `check_consistency` only requires the list to be non-empty. `FilesystemScope::new` normalizes each root lexically, so `"."` and `""` both become the empty `PathBuf`. In `check()`, `resolve_existing_prefix("")` returns None, so the code falls back to the empty lexical root. `resolved.starts_with("")` is true for every path because std's `Path::starts_with` with an empty prefix always matches. A relative root such as `"Users"` or `"home"` is canonicalized against the host process's CWD, which is `/` for a Finder- or desktop-launched app, so it silently covers /Users or /home. The trust UI then shows the user "Declared folders: Through termiHub only: ." (or an empty string) next to the chip "Your files: No access to your home folder or other files".

## Why it matters

After ADR-19 the capability bridge is the only file channel out of the OS sandbox. A plugin that declares `permissions:["filesystem"]` and `filesystemPaths:["."]` can call read*file or write_file on any path the user can access: read ~/.ssh/id*\*, termiHub's credential files and the trust store, or write ~/.bashrc or LaunchAgents for code execution outside the sandbox. The consent screen gives no hint of this. It defeats the main containment promise of the plugin OS sandbox for any trusted plugin, including a signed one from a compromised author.

## Evidence

- `core/src/plugin/manifest.rs:313`
- `core/src/plugin/security.rs:197`
- `core/src/plugin/security.rs:251`
- `core/src/plugin/security.rs:252`
- `core/src/plugin/security.rs:316`
- `core/src/plugin/sandbox/bridge.rs:1`
- `core/src/plugin/capabilities.rs:217`
- `src/components/Settings/nativePluginSandbox.ts:199`
- `src/components/Settings/nativePluginSandbox.ts:211`

## Recommendation

Validate `filesystemPaths` at manifest parse/validate time and again in `FilesystemScope::new`. Require each entry to be absolute and non-empty, and reject the filesystem root, the user's home folder itself, termiHub's config/plugins directories, and any entry that changes under lexical normalization. Make `check()` refuse when a root normalizes to an empty path (never fall back to an empty root). Show the declared paths in PluginInstallDialog as well as in the trust chips. Separately, close the check-then-open race: open through the canonical result with O_NOFOLLOW / openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS) on Linux, or re-verify the opened handle's path, instead of `File::open(resolved)`.

## Verification

I confirmed the mechanism in the code, but I think the severity is overstated.

What the code shows:

- `PluginManifest::validate` (`manifest.rs:342`) never checks `filesystem_paths`. `check_consistency` (`security.rs:166`) only checks that paths exist when the permission is granted, and the reverse. Nothing requires a path to be absolute, non-empty or not the root.
- `FilesystemScope::new` lexically normalizes `"."` and `""` to an empty `PathBuf`. In `check()`, `resolve_existing_prefix("")` fails to canonicalize and `"".parent()` is None, so it returns None. The code then uses `unwrap_or_else(|| root.clone())`, so the root is `""`. `Path::starts_with("")` is true for every path, so every request passes.
- A relative root like `"Users"` canonicalizes against the process CWD.
- `nativePluginSandbox.ts:199-211` shows "Through termiHub only: ." next to the chip "No access to your home folder or other files".
- I found nothing in `docs/architecture.md` or `audit/FINAL-SUMMARY.md` (grep for `filesystemPaths` / `filesystem_paths`) that records this as a deliberate decision.

Why medium rather than high:

- The attacker here is the plugin author, and the author already controls the manifest. They could declare `"/"` or `"/Users"` openly and get the same access with no bug involved.
- The plugin must request the `filesystem` permission explicitly, and the user must trust or install it.
- So the real defects are (a) the "Declared folders" line can hide whole-filesystem access behind `"."` or `""`, and (b) there are no sanity limits on roots (root folder, home folder, termiHub's config directory). Both undermine informed consent rather than bypass consent entirely.
- The suggested fixes (require absolute, non-empty roots; reject the filesystem root, the home folder and termiHub's directories; never fall back to an empty root) are cheap and appropriate.
- I did not verify the check-then-open race mentioned in the suggested fix; it sits outside this finding's core claim.

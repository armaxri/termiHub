---
id: PLG2-001
title: 'Manifest filesystemPaths are never validated: an entry of "" or "." turns into an empty scope root that matches every path, giving whole-disk read and write through the host bridge'
angle: plugin-extensibility
severity: high
category: security
is_workaround: false
subsystem: "core/src/plugin/security.rs (FilesystemScope) + host capability bridge"
evidence:
  - core/src/plugin/manifest.rs:313
  - core/src/plugin/security.rs:197
  - core/src/plugin/security.rs:252
  - core/src/plugin/security.rs:171
  - core/src/plugin/capabilities.rs:283
  - core/src/plugin/sandbox/bridge.rs:440
  - src/components/Settings/nativePluginSandbox.ts:203
  - src/components/Settings/nativePluginSandbox.ts:209
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`filesystem_paths` is a plain `Vec<String>`, and `PluginManifest::validate` never looks at it. `FilesystemScope::new` passes each entry through `normalize_lexical`. For "", "." or "./" this returns an EMPTY PathBuf, because CurDir components are dropped. `resolve_existing_prefix("")` returns None, so `check()` falls back to the lexical root, which is the empty path. The containment test `resolved.starts_with(&canonical_root)` is then true for every path, because `Path::starts_with` with an empty base always holds. `check_consistency` counts [""] as a declared path, so the load passes. A relative root such as "docs" also resolves against the host process's working directory, which differs between Finder or desktop launches and terminal launches. Plugin-supplied relative paths resolve against the host working directory as well. On the UI side, the access chip shows `Through termiHub only: .` (or an empty list), right next to a struck-through 'Your files — No access to your home folder or other files'.

## Why it matters

Since ADR-19 the host-side capability bridge is the only path from a sandboxed native plugin to user files. The trust disclosure and the access chips promise that the plugin can only reach its data folder plus the listed folders. A plugin whose manifest declares `"permissions":["filesystem"], "filesystemPaths":["."]` gets host-privileged `write_file` and `read_file` on any path. That includes ~/.ssh keys, termiHub's config and vault files, and writes to ~/.zshrc or ~/Library/LaunchAgents, which means code execution outside the sandbox. The UI meanwhile says the plugin has no access to the user's files. This defeats the main guarantee of the sandbox.

## Recommendation

Validate `filesystemPaths` in `PluginManifest::validate` and again in `FilesystemScope::new` as defence in depth. Reject empty entries and entries that normalise to empty, relative paths, bare filesystem roots (`/`, `C:\`), and paths containing NUL. Make an empty-root containment match impossible: skip empty roots, or assert `!root.as_os_str().is_empty()`. In `check()`, refuse relative requested paths instead of resolving them against the host working directory. Add tests for [""], ["."], ["./"] and ["relative"]. In the UI, render each declared path on its own line, and drop or reword the 'No access to your files' chip whenever declared paths fall under the home folder.

## Verification

I confirmed the finding from the code. `PluginManifest::validate` (manifest.rs:342) never looks at `filesystem_paths`, which is a plain `Vec<String>` at manifest.rs:313. `FilesystemScope::new` (security.rs:197) only runs `normalize_lexical`, and that function drops `CurDir`, so "" , "." and "./" all become an empty PathBuf. For an empty root, `resolve_existing_prefix` returns None: `canonicalize("")` fails, `symlink_metadata` fails, and `parent()` of an empty path is None. `check()` then falls back to the empty lexical root, and `resolved.starts_with("")` is true for every path, so any canonicalized absolute path passes. `check_consistency` only tests `!roots.is_empty()`, and `[""]` still counts as one root, so the load passes. The paths through the bridge are confirmed: `scoped()` in capabilities.rs:218 calls `check_path`, and `guarded_read_chunk` and `guarded_write` use the result directly; `bridge.rs` `serve` dispatches ReadFile and WriteFile to them. Relative roots and relative requested paths resolve against the host working directory through `canonicalize`. I found no other guard: no host-side rewriting of the declared paths and no data-folder anchoring. The UI part also holds. `accessChips` (nativePluginSandbox.ts:199-211) joins the raw paths into "Through termiHub only: " (blank for "") or "...: .", and always adds the struck-through "Your files — No access to your home folder or other files" chip. I found no ADR in architecture.md that accepts this risk. The broader lack of validation also lets "/" through; that at least shows up honestly in the chip, but the empty and "." forms hide whole-disk read and write, and writing to shell rc files or LaunchAgents is a way out of the sandbox. The attacker still has to get the user to install the plugin, but containing malicious native plugins is exactly what the sandbox is for, so I am keeping the severity at high. Side note: the frontend test fixture uses "~/captures", and nothing expands `~`, so that entry would also resolve relative to the working directory.

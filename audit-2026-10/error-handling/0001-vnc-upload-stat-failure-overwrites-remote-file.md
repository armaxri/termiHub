---
id: ERR2-001
title: "VNC side-channel upload treats any stat failure as 'name is free', so an existing remote file can be truncated"
angle: error-handling
severity: medium
category: data-loss
is_workaround: true
subsystem: "src-tauri/src/session/graphical_upload.rs (VNC file side channel, #4192)"
evidence:
  - src-tauri/src/session/graphical_upload.rs:475
  - src-tauri/src/session/graphical_upload.rs:476
  - src-tauri/src/session/graphical_upload.rs:478
  - src-tauri/src/session/graphical_upload.rs:505
  - src-tauri/src/session/graphical_upload.rs:217
  - src-tauri/src/session/graphical_upload.rs:231
  - src-tauri/src/session/graphical_upload.rs:262
  - src-tauri/src/session/graphical_upload.rs:352
  - core/src/backends/ssh/file_browser.rs:495
  - core/src/backends/ssh/file_browser.rs:255
  - core/src/files/ranged.rs:110
  - core/src/protocol/errors.rs:48
  - src/hooks/useFileMoveTransfer.ts:162
status: fixed
resolution: "#4299 — only a definite not-found frees a name; other stat errors skip the item; SFTP claims names with O_EXCL"
audit: "2026-10"
commit: "663465d52"
relation: new
---

## What

The module says a name clash 'keeps both, never an overwrite'. It enforces this in free_name(), which treats a name as free when UploadDestination::probe() returns None. Both probes turn every error into None:

- AgentHostFiles::probe does `Ok(self.stat_entry(path).await.ok().map(..))`. The comment there says 'treat any stat failure as free'.
- SftpDestination::probe does `FileBrowser::stat(..).await.ok()`.
  So a stat that fails for any reason other than 'not found' makes the existing name count as free. That covers a 60 s agent RPC timeout (AGENT_REQUEST_TIMEOUT), a transport hiccup, 'SFTP not connected' from ensure_connected, EACCES, or a dangling symlink.
  The file is then uploaded to that exact path. A fresh upload truncates whatever is there: the agent route's write_range at offset 0 calls std::fs::File::create (core/src/files/ranged.rs:110), and the SFTP route calls create_write, which uses sftp.create (truncating). A dangling remote symlink is followed and the write lands on its target.
  The same collapse produces a misleading error in resolve_dest_dir: a probe failure on the destination folder reports 'the folder X does not exist' (line 262).

## Why it matters

The safety guarantee only holds on the happy path, and when it fails the user's existing remote file is silently replaced. The usual trigger is an overloaded agent or a flaky SSH link: dropping many files while other transfers saturate the agent makes stat timeouts realistic. This is the opposite of the established pattern in the main file browser, which treats an unlistable destination as a conflict and asks the user (useFileMoveTransfer.ts:162, 'destination not listable'). The type information to tell the cases apart exists. The agent sends a distinct FILE_NOT_FOUND code (-32010) and FileError has a NotFound variant. Both are thrown away: AgentRequests flattens errors with e.to_string() (line 352), and SftpFileBrowser::stat maps every SFTP status to OperationFailed (file_browser.rs:495-504).

## Recommendation

1. Make probe return Ok(None) only for a genuine not-found. On the agent route, keep the JSON-RPC error code through AgentRequests (return a typed error, or map -32010 to FileError::NotFound). On the SFTP route, map StatusCode::NoSuchFile to FileError::NotFound in SftpFileBrowser::stat.
2. Propagate every other probe error. free_name already returns Result, so the item ends up skipped with the real reason instead of overwriting.
3. In resolve_dest_dir, report the real probe error instead of 'does not exist'.
4. Add tests where probe returns a timeout or permission error for an existing name and assert the file is skipped, not truncated.

## Verification

Confirmed. AgentHostFiles::probe (graphical_upload.rs:475-478) does `Ok(self.stat_entry(path).await.ok().map(..))`, and its comment says to treat any stat failure as free. SftpDestination::probe also uses `.ok()`. free_name therefore treats a stat timeout or error as a free name. SftpFileBrowser::stat maps every error to OperationFailed, so not-found cannot be told apart from other failures. A write at offset 0 goes through File::create, which truncates. resolve_dest_dir reports 'does not exist' when the probe fails for any reason. This breaks the module's documented 'never an overwrite' guarantee whenever the stat fails transiently, such as an agent timeout under load. Medium is fair.

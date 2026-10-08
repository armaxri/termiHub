---
id: TAURI2-002
title: "Graphical file side-channel commands skip the window-ownership gate: a stale (taken-over) window's tab close unregisters the controlling window's File Browser"
angle: backend-tauri-rust
severity: low
category: bug
is_workaround: false
subsystem: commands/remote_desktop_browse + remote_desktop (VNC file side channel)
evidence:
  - src-tauri/src/commands/remote_desktop_browse.rs:35
  - src-tauri/src/commands/remote_desktop_browse.rs:96
  - src-tauri/src/commands/remote_desktop.rs:273
  - src-tauri/src/commands/remote_desktop.rs:312
  - src-tauri/src/commands/remote_desktop.rs:733
  - src-tauri/src/commands/remote_desktop.rs:772
  - src/hooks/useRemoteDesktopBrowse.ts:21
  - src/components/RemoteDesktop/browseRemoteFiles.ts:81
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Since #3388/#3401, every graphical command that acts on a session takes the invoking
`WebviewWindow` and is ownership-gated: input, clipboard, resize, monitor layout,
clipboard images, and disconnect (a stale window's call is a no-op, remote_desktop.rs:772).
The newer file side-channel commands take no window and check no ownership:
`remote_desktop_open_file_browser`, `remote_desktop_close_file_browser`,
`remote_desktop_upload`, and `remote_desktop_file_channel` (including its `linked_secret`
supply). The side-channel registry is keyed only by `session_id`
(`SideChannelBrowsers::register_with_target` / `remove`). The frontend hook unregisters on
tab unmount (`useRemoteDesktopBrowse.ts:21` → `remote_desktop_close_file_browser`). A tab
left in a window another window has taken over still has its own browse source. When the
user closes that stale tab, the gated disconnect correctly does nothing, but the ungated
close removes the side channel the controlling window registered.

## Why it matters

Concrete multi-window failure: window A browses a VNC session's files, window B takes the
session over and opens Browse remote files (re-registering it), then the user closes A's
stale tab. B's File Browser now fails every listing and download as an unknown session,
and uploads already queued keep running but browsing is gone until the user reopens it.
More generally, an evicted window can still upload to, rename on, and delete from the
remote host over a session it no longer controls. That contradicts the "an evicted window
never drives the desktop" rule the other graphical commands enforce.

## Evidence

- `commands/remote_desktop_browse.rs:35, 96` — open/close file browser take no window and
  check no ownership; close removes `sessions.side_channels` by session_id.
- `commands/remote_desktop.rs:273, 312` — `remote_desktop_upload` / `remote_desktop_file_channel`
  are not window-gated.
- `commands/remote_desktop.rs:733-777` — `gated_disconnect` → `WindowManager::may_close`,
  removing the side channel only for the owner.
- `src/hooks/useRemoteDesktopBrowse.ts:21`, `src/components/RemoteDesktop/browseRemoteFiles.ts:81`
  — unmount cleanup invokes the ungated close unconditionally.

## Recommendation

Add `window: tauri::WebviewWindow` and `window_manager: State<WindowManager>` to the four
commands. Route them through the same gate the clipboard/input commands use
(`window_manager.may_send_input(session_id, window.label())`, or the `may_close` gate for
close). Make `remote_desktop_close_file_browser` a no-op when the caller does not control
the session, as `gated_disconnect` is. Add owner/non-owner cases to the existing
mock-remote-desktop gate tests in remote_desktop.rs (the `tests` module at line 789).

## Verification

Confirmed in the code. `remote_desktop_close_file_browser` takes no window and removes the
side channel by session_id with no check; open/upload/file_channel are likewise ungated,
while `remote_desktop_disconnect` goes through `gated_disconnect` → `may_close`. The
frontend unmount cleanup calls `closeRemoteDesktopBrowser(tabId)` whenever that window's
store holds a source for the tab. No ADR or documented exception covers this. Severity
lowered to low: it needs a multi-window takeover after A opened Browse, nothing is lost,
and reopening Browse remote files recovers. The broader "evicted window can upload, rename
or delete" claim is weaker — regular session file ops are not window-gated either, so that
part is consistent with existing file-op behaviour, not a regression.

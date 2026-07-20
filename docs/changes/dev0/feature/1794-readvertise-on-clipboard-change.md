### Changed

- RDP clipboard file serving now **re-advertises the host clipboard's file list
  when you copy files locally mid-session** (#1794). Previously the host-clipboard
  file list was read only at connect (or when the server re-requested it), so files
  you copied in your file manager _after_ connecting stayed invisible to the remote
  until the server asked again. The sidecar now polls the host OS clipboard's native
  file list while connected and, on a change, re-sends the CLIPRDR file offer through
  the same sandboxed serve pipeline — the file sibling of the existing text push
  seam. This is an independent trigger from the shared-folder watcher (#1788): either
  a clipboard copy or a shared-folder change can re-advertise on its own. The poll
  interval rate-bounds the re-advertise so rapid host copies cannot flood the
  clipboard channel, and it honours the existing opt-in and view-only gates — a
  view-only or text-only session never polls the clipboard. Files copied locally
  after connecting can now be pasted into the remote without reconnecting.

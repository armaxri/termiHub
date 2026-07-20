### Changed

- RDP clipboard file serving now **re-advertises the shared folder's file list
  when its contents change** while a session is connected (#1788). Previously the
  local file list was offered only once, at connect (or on a host text copy), so a
  file added to, removed from, or renamed inside the shared folder afterwards
  stayed invisible to the remote until you reconnected. The sidecar now watches
  the shared folder (via the cross-platform `notify` filesystem watcher) and
  re-sends the CLIPRDR file offer on change, re-enumerating the current contents
  through the same sandboxed serve pipeline. Changes are debounced and
  rate-bounded so a busy folder cannot flood the clipboard channel, and the
  re-advertise honours the existing opt-in and view-only gates — a view-only
  session never advertises local files. A file dropped into the shared folder
  after connecting can now be pasted into the remote without reconnecting.

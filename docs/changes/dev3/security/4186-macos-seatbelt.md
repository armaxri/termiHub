### Security

- Out-of-process plugins (preview) on macOS now run inside an OS sandbox
  (Seatbelt): the plugin can read its install folder and read and write its
  private data folder, and nothing else — no other files, no network sockets
  of its own (network goes through the capability bridge), no child
  processes. If the sandbox cannot be applied, the plugin is not loaded
  (#4186).

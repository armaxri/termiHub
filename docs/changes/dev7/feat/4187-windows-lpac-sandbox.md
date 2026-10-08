### Security

- Out-of-process plugins (preview) on Windows now run inside an OS sandbox: a
  per-plugin Less-Privileged AppContainer with no capabilities, inside a job
  object. The plugin can read its install folder and read and write its
  private data folder, and nothing else — not the user profile, not
  `HKCU\Software`, no network sockets of its own (network goes through the
  capability bridge), no child processes. Uninstalling a plugin removes its
  AppContainer profile. If the sandbox cannot be set up, the plugin is not
  loaded (#4187).

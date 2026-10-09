### Fixed

- Plugins: sandboxed native plugins can verify TLS certificates against the
  system's roots, including company CAs: on Linux the distribution CA bundles
  are readable, on macOS the platform certificate verifier works (#4342).
- Plugins (security): the plugin sandbox is tighter (#4342).
  - On macOS a plugin can no longer list processes or read other programs'
    arguments, environment or paths, and only the system values a runtime
    needs are readable.
  - On Linux inotify is unavailable to plugins, and where user namespaces are
    allowed the home folder is hidden from them, metadata included.
  - Reduced isolation (a kernel without landlock) is refused when neither user
    namespaces nor Yama `ptrace_scope` ≥ 1 keep a plugin out of other
    programs' memory.

### Security

- Out-of-process plugins (preview) on Linux now run inside an OS sandbox
  (landlock + seccomp): the plugin can read its install folder and the system
  libraries and read and write its private data folder, and nothing else — no
  other files, no network sockets of its own (network goes through the
  capability bridge), no child processes, no `execve` or `ptrace`. On a kernel
  without landlock the system-call filter still applies and the runner reports
  reduced isolation. If the sandbox cannot be applied, the plugin is not loaded
  (#4185).

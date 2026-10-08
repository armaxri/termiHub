### Security

- Out-of-process plugins (preview) on Linux: system calls the OS sandbox
  refuses with `EPERM` (opening network sockets, signalling other processes,
  terminal input injection) are now reported to termiHub's log as
  `Denied{syscall}` entries, at most one per system call per second, and
  recorded with the plugin's other denials. The plugin still sees the same
  `EPERM` failure (#4236).

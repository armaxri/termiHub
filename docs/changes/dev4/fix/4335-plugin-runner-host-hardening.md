### Security

- The plugin runner no longer inherits termiHub's standard output: its stdout is
  now the null device, so sandboxed plugin code can no longer read from or write
  to the terminal termiHub was started from (#4335).
- Plugin runner stderr is now written to the log through the plugin's log rate
  limiter, tagged with the plugin id and stripped of control characters, instead
  of being copied raw to termiHub's stderr. A plugin can no longer make its exit
  look like "out of memory" just by printing the allocation-failure message (#4335).
- A plugin no longer runs with its hang and memory watchdog silently off: if the
  watchdog thread cannot start, the plugin fails to start with an error. A bridged
  connection whose relay thread cannot start is closed, and a failed idle-reaper or
  crash-recovery thread is logged as an error (#4335).

### Added

- The process table's kill confirmation now has a **signal menu** with the
  common signals: SIGTERM (still the default), SIGKILL, SIGINT, SIGHUP,
  SIGQUIT, SIGSTOP, SIGCONT, SIGUSR1 and SIGUSR2 (#3209). Every signal still
  goes through the confirmation that names the exact pid and process, and
  SIGKILL and SIGSTOP show an extra warning because the process cannot catch
  them.
- For a local session on Windows only SIGTERM and SIGKILL can be chosen, since
  Windows has no POSIX signals; a tooltip and a note explain why.

### Fixed

- A signal the host cannot deliver is now reported as a clear "signal not
  supported" error. Previously an unsupported local signal fell back to a
  plain terminate.
- Pressing Enter on a drop-down inside a confirmation dialog no longer
  confirms the dialog.

### Added

- System monitoring now works for **macOS SSH hosts** (#5471). The status bar
  shows CPU, memory, swap, disk, network throughput, load average, uptime and
  OS info for a Mac you connect to over SSH. Per-core CPU is not available on
  macOS hosts.

### Changed

- A host with no readable stats source (for example a Windows host whose login
  shell is `cmd.exe` or PowerShell) now says "Monitoring not supported on this
  host" instead of "Offline — remote output unreadable" (#5471).

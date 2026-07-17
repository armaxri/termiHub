### Added

- **termiHub now writes an application log file** (#1570). Previously the log
  existed only in memory — the in-app LogViewer's ring buffer — and vanished with
  the process, so a post-mortem of an unexpected exit had to be reconstructed
  entirely from the OS log with no contribution from termiHub itself. The app now
  writes to the platform's conventional log location:

  | Platform | Path                                                |
  | -------- | --------------------------------------------------- |
  | macOS    | `~/Library/Logs/com.termihub.app/termihub.log`      |
  | Windows  | `%LOCALAPPDATA%\com.termihub.app\logs\termihub.log` |
  | Linux    | `~/.local/share/com.termihub.app/logs/termihub.log` |

  The file records the startup banner (version, PID) and the shutdown path, ending
  in `termiHub exited cleanly`, so a clean exit is now visible as such in termiHub's
  own log rather than only in the OS log — and a run that ends without that line is
  recognisable as a kill or a crash. Older runs are kept as `termihub.1.log` /
  `termihub.2.log`.

  The log is **hard-capped at 15 MiB total** — it rotates at 5 MiB and keeps three
  files — so it cannot grow without bound. It records INFO and above (the LogViewer
  keeps its more detailed DEBUG view), and never contains passwords, key material,
  or terminal contents. Set `TERMIHUB_FILE_LOG` (e.g. `TERMIHUB_FILE_LOG=debug`) to
  raise the file's detail when diagnosing a problem — SSH packet-level logging stays
  clamped even then, so raising verbosity cannot accidentally put transport internals
  into a file you are about to share.

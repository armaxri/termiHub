### Added

- **Native plugin sandbox status in Settings → Plugins.** When native plugins
  run in their own sandboxed process, each trusted plugin shows its isolation
  (Isolated, Reduced isolation, Not sandboxed, Isolation unavailable, Could not
  start the plugin sandbox, Plugin runner is missing, Disabled after 3 crashes),
  whether its process is running, idle or restarting, and a summary of what it
  can reach. Plugins disabled after repeated crashes can be re-enabled there.
- **Reduced-isolation acknowledgement.** On a system that cannot apply every
  sandbox layer (for example Linux without Landlock), a plugin no longer loads
  silently: the row explains which protection is missing and loads the plugin
  only after you choose _Load with reduced isolation…_. The choice is bound to
  that exact plugin build.
- **Plugin crash overlay.** When a sandboxed plugin crashes, stops responding,
  uses too much memory or sends invalid data, its tabs show what happened, that
  termiHub and your other sessions are unaffected, and a _Restart session_
  button.
- **Blocked plugin request toasts.** When termiHub refuses a plugin request (for
  example a network connection without the network permission), a toast says so,
  at most once per plugin every 30 seconds. Details are in the Log Viewer.

### Changed

- The native-plugin disclosure in Settings → Plugins now matches how native
  plugins run: sandboxed in their own process, or inside termiHub.

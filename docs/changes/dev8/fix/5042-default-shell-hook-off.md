### Changed

- New local, SSH and WSL connections no longer get **Command Marks (Shell Hook)** turned
  on from the app-level default (#5042). The Settings toggle, now called **Command Marks
  (Shell Hook) by Default** under **New Connection Defaults**, is off by default, so a new
  connection types nothing into your shell unless you opt in. Shells opened from outside
  termiHub (for example from a file manager's context menu) also start without the hook.
- If your settings still had this toggle on from the old default, it is switched off
  **once** when the settings are loaded after the update. Turning it back on afterwards is
  kept; the reset never runs again.

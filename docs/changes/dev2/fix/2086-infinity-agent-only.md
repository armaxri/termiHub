### Changed

- The persistent-connection ∞ (infinity) badge is now reserved for
  **agent-backed** connections only — sessions that live on a remote agent and
  survive closing termiHub _and_ powering off / restarting your machine. Its
  tooltip now states that guarantee explicitly. **Desktop-local** persistent
  connections (SSH/Docker/WSL/Serial run inside the app) no longer show the ∞,
  since they only live while the app is open; they now display a distinct,
  lesser Hourglass marker whose tooltip does not overclaim ("Runs while the app
  is open — closing termiHub ends the session. Use a remote agent for
  persistence across app restarts."). The same tiered marker applies to the tab
  decoration. This removes the misleading ∞ that appeared on plain SSH and other
  desktop-local connections (#2086).

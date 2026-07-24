### Added

- **Session history & Recent Sessions sidebar** (#1883): every terminal session
  you open is now recorded automatically to a browsable history (stored in a
  new `session-history.json`, separate from your saved connections). A new
  **Recent Sessions** activity-bar panel lists recorded sessions with a
  connection-type icon, a type badge, and relative last-used time; double-click
  (or the Connect action) reconnects. Entries can be pinned to the top, saved as
  a full connection, copied as a connection string, or removed, via per-row
  buttons and a right-click context menu.
- **Quick-connect bar**: the Recent Sessions panel has a `user@host[:port]`
  entry bar for instant SSH connections, with autocomplete drawn from history.
  When the user is omitted the default SSH user is used; when the port is
  omitted 22 is assumed.
- **Deduplication & retention**: identical connection parameters collapse into a
  single entry (its timestamp and use-count are updated). History is bounded by
  a configurable limit; the least-recently-used unpinned entry is evicted first,
  and pinned entries are exempt.
- **Session history settings** (General section): "Auto-Save Sessions to
  History" (`sessionHistoryEnabled`), "Session History Limit"
  (`sessionHistoryLimit`, default 50, range 10–500), "Show Recent Sessions
  Panel" (`showRecentSessions`), and a "Clear All History" button.

### Security

- Passwords and key passphrases are **never** written to session history —
  history stores only connection metadata (host, port, user, auth method).

### Added

- Session restore now has a three-way **restore mode** — Never, Ask, or Always —
  replacing the previous on/off toggle (General settings → "Restore Last Session
  on Startup"). When the mode is **Ask** and a previous session was stored, a
  **"Restore Previous Session?"** dialog appears on startup listing the tabs that
  were open, with **Restore** / **Start Fresh** and a **"Remember my choice"**
  opt-out that saves the mode as Always or Never so the dialog is not shown again.
  **Always** restores silently (the prior behavior) and **Never** starts fresh.
  The legacy `restoreLastSessionOnStartup` setting is migrated automatically
  (off → Never, otherwise Ask) (#1884).

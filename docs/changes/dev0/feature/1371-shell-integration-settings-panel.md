### Added

- **Shell Integration settings panel.** A new **Shell Integration** section in
  Settings surfaces the OS context-menu integration (epic #1363). It shows the
  registration status with **Reinstall / Update** and **Uninstall** actions
  (full loading → success/error feedback), a draggable **Quick-Access Entries**
  list (reorder, add, edit, delete), a **Fallback when no entry matches** choice
  (session picker / system default shell), a **new-window** toggle, and — on
  Linux only — per-file-manager install toggles (Nautilus / KDE / Thunar) with
  detection labels. When the integration is registered and the executable has
  moved, a staleness banner prompts a reinstall.
- **Quick-access entry editor.** Add or edit an entry's name, the connection it
  opens (or "Show session picker"), its Windows context-menu visibility
  (Always / Extended-only), and which right-click targets it appears for
  (folders / files / folder background).
- **First-launch install banner.** A one-time, non-blocking banner offers to add
  "Open in termiHub" to your file manager. "Install Now" registers the
  integration; "Don't ask again" persists the opt-out
  (`shellIntegration.firstLaunchBannerDismissed`).

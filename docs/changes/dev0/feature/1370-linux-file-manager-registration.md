# Changes — Linux file-manager registration (#1370)

## Added

- **Linux file-manager context-menu integration.** "Open in termiHub" entries
  can now be registered into Linux file managers from the shell-integration
  settings:
  - A universal XDG `.desktop` launcher (registered for the `inode/directory`
    MIME type) so termiHub appears under **Open With** in any XDG-compliant file
    manager; the desktop database is refreshed automatically.
  - **Nautilus** (GNOME) scripts, **KDE / Dolphin** service menus (KDE 5 and
    KDE 6), and a **Thunar** (XFCE) custom action — each installed only when the
    file manager is detected on the host and enabled by its per-manager toggle.
  - The settings status now reports which file managers were detected on the
    host.
  - Uninstalling removes all four artifacts and, for the shared Thunar
    `uca.xml`, removes only termiHub's action while preserving any custom
    actions you added yourself.

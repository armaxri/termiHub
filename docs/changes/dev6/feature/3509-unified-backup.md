### Added

- **Unified backup and restore** (PROD-068, #3509): Settings → Backup & Restore can back up all
  app data — connections and agents, settings (including custom themes and keyboard shortcuts),
  workspaces, macros, workflows, tunnels, embedded servers, Wake-on-LAN devices, HTTP monitors,
  network-tool history and, optionally, the encrypted credential vault — to a single file. The
  whole file is encrypted with one passphrase by default; saved passwords are never written in
  plaintext, and parts that contain passwords can only be backed up encrypted.
  Restore previews each part (item counts, what is new or different, and whether it came from an
  older or newer termiHub), lets you choose which parts to restore and whether to merge them with
  or replace what is here, and applies the chosen parts all-or-nothing before restarting
  termiHub. Backups from an older termiHub are upgraded; parts from a newer termiHub are refused.
  Including credentials needs the master password; in OS Keychain mode the credentials part is
  unavailable until system authentication is supported (#3433) while everything else still backs
  up.

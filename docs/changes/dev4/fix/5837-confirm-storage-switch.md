### Fixed

- Settings ▸ Security now asks before a credential storage switch that moves or
  deletes saved passwords, and says how many and from where (for example "This
  permanently deletes the 2 saved passwords in your master-password vault").
  A switch with nothing saved happens at once. After you confirm, the new
  option is selected right away with progress ("Moving 2 passwords…"), the
  result uses the option names in plain words ("Stopped saving passwords. 1
  saved password removed.", "Moved 1 saved password to the OS Keychain. Your
  master-password vault is kept.") and a successful result fades after a few
  seconds.

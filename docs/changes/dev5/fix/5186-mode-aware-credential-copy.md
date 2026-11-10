### Fixed

- The "Save credentials" help now matches the active credential storage mode:
  with storage off it says so and points to Settings ▸ Security, with OS
  Keychain it names the system keychain, and only Master Password mode
  mentions a master-password vault. Previously it always described the
  master-password vault, even in the default mode where nothing is saved.
- With credential storage off, the password prompt and the connection editor
  no longer hide the save option. They show it disabled, with an "Enable
  credential storage…" action that opens Settings ▸ Security in one click.

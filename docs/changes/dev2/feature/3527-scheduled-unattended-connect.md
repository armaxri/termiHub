### Added

- Scheduled runs can connect their targets: a schedule's new **Connect if not
  connected** option (off by default) connects each saved target that has no
  connected terminal before the run, without asking anything — saved
  passwords, key files and the SSH agent only, and only hosts whose key is
  already trusted. A target that would need input (a password, a key
  passphrase, a one-time code, a new host key, or unlocking the credential
  store) is skipped and the reason is logged in the schedule's history. Tabs
  opened for the run close when it ends; tabs that were already open stay open
  (#3527).

### Added

- SSH connection editor: the **Jump Host** section now has an **Import from
  ~/.ssh/config** action. It reads the user's OpenSSH client config (plus any
  `Include`d files), lists the hosts that declare a `ProxyJump`, and — on
  selection — populates the first-class jump-host chain (each hop resolved to
  its own `Host` stanza's `Hostname`/`User`/`Port`/`IdentityFile`, ordered
  outermost → innermost). Import only pre-fills the editor fields for review;
  nothing is saved until the user saves the connection. A missing / empty /
  unparseable config shows a friendly empty state rather than an error. Parsing
  is handled by the maintained `ssh2-config` crate (#1702).

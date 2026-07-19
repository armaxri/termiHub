### Added

- SSH connection editor: an **Import from ~/.ssh/config** action now imports a
  whole connection, not just a jump-host chain (#1702). It reads the user's
  OpenSSH client config (plus any `Include`d files), lists every concrete `Host`
  alias — direct hosts and hosts behind a `ProxyJump` alike — and, on selection,
  pre-fills the editor's name plus the target's resolved
  `Hostname`/`User`/`Port`/`IdentityFile` and any jump-host chain. Auth follows
  the jump-host import's mapping (`IdentityFile` → key, otherwise agent).
  Wildcard / `Match` / negated stanzas are skipped, and a missing / empty /
  unparseable config shows a friendly empty state rather than an error. Import
  only pre-fills the editor fields for review; nothing is saved until the user
  saves the connection. Parsing is handled by the maintained `ssh2-config`
  crate (#1722).

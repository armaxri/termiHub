### Added

- SSH connections: a new **Import from ~/.ssh/config** action in the Connections
  sidebar header opens a bulk importer. It reads every concrete `Host` alias from
  your OpenSSH client config (reusing the #1722 backend), lets you multi-select
  hosts (with a select-all), and creates a saved SSH connection per selection in
  a folder you pick — each with the resolved host/user/port/identity and any
  jump-host chain, and each editable afterwards. Names collision-resolve within
  the chosen folder (` (2)`, ` (3)`, …). A missing or empty config shows a
  friendly empty state (#1731).

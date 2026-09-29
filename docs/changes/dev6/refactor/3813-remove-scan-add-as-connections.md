### Removed

- The Ping Sweep and Port Scanner tools no longer offer an "Add as connections"
  action. Fleet onboarding is available only from a CSV / inventory file via the
  connection list.

### Changed

- Fleet onboarding no longer pre-selects a template connection: you pick the
  template explicitly, and "Add" stays disabled until you do. Only connection
  types that have a host (for example SSH and Telnet) are offered as templates,
  and a picked template is no longer reset when the connection list updates
  while the dialog is open.

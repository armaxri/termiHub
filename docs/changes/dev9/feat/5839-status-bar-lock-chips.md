### Changed

- Status bar: the credential lock is now an outlined button at normal contrast
  that says whether the store is locked and locks it right away when clicked
  (or opens the unlock dialog when locked). Its accessible name says the state
  and the action.
- Status bar: the SSH chip shows a shield for the host key's trust (remembered,
  trusted once, or not checked yet) and is now a button. Clicking it opens a
  "Connection security" popover with the host, "Encrypted (SSH)", the sign-in
  method, the host key's type and fingerprint, and a link to manage trusted
  host keys.

### Added

- Status bar: local shell and WSL tabs show a chip with the shell's name
  (e.g. "Zsh"), with the start directory in its tooltip.

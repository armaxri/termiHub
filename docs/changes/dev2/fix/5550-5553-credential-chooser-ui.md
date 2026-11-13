### Fixed

- The "Where should termiHub keep passwords?" chooser opens with focus on the selected
  option instead of the close button, so Enter accepts the recommended choice; dialogs in
  general no longer open focused on their close button (#5550).
- The chooser's Continue and Create vault buttons keep one filled primary style on every
  step instead of turning green-outlined after moving between steps (#5551).
- Setting a master password shows persistent "Master password" / "Confirm password"
  labels, a live length requirement hint and an inline "Passwords do not match." error
  (#5552).
- Settings ▸ Security ▸ Credential storage lists the same options as the chooser, in the
  same order (OS Keychain first, marked Recommended) with the same names and descriptions
  (#5553).

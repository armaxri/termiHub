### Changed

- Connection editor: Type now comes first, above Name, since it decides every
  field below it. Hints that only repeated their field's label ("SSH port
  number", "SSH login username", "Hostname or IP address of the SSH server" and
  similar) are gone, so the form is shorter. "Fill from ~/.ssh/config…" is a
  compact link beside the Host label instead of a block above the form (#5835).
- Connection editor footer: Test sits on the left with its result and Cancel
  test; Cancel and the two save buttons sit on the right, with the primary
  right-most. The row no longer shifts while a test runs or its result appears
  (#5835).
- VNC and RDP editors: Host and Port are followed directly by the SSH tunnel
  option, then Username, Password and Save password. Connect timeout moved to
  Features. The Terminal page is no longer offered for VNC, RDP and other
  types without a terminal (#5835).

### Fixed

- Connection editor: the password field no longer disappears while credential
  storage is off or not yet chosen, so "Save password" never shows without a
  password to save. While storage is off or not yet chosen, the field says
  "Passwords aren't saved. This one is used only for Test and this connect."
  with a "Turn on saving…" link, the same one the connect prompt offers. A typed
  password is never written to disk (#5835).
- Connection editor: the inline Test result ("Reached …") clears as soon as a
  connection setting changes, so it only describes the settings in the form
  (#5879).

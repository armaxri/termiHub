### Added

- Connection editor: password fields whose secret is saved in the credential store — such as a
  VNC SSH-tunnel password, a plugin's password field or a jump-host hop's password — now read
  "Saved — leave empty to keep", and a **Clear** button removes the saved secret when you save
  (with **Undo** until then). Leaving the field empty still keeps the saved secret (#4431).

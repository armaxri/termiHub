### Fixed

- Connecting a saved connection while the credential store is locked no longer
  ends silently when you skip the unlock. The unlock dialog's **Skip** is now
  **Connect without saved password**: it asks for the password (or key
  passphrase) for this connect and connects with it. The store stays locked
  and nothing is saved. Closing the dialog with Escape or × cancels the
  connect and says "Connect canceled", the same message every other cancel of
  a saved connection now shows. The "Forgot password? Reset credential
  store…" link moved below the dialog's buttons, away from the wrong-password
  error, and still asks for confirmation before it deletes anything. When the
  unlock dialog is opened from the status bar, the button is a plain
  **Cancel** (#5188).

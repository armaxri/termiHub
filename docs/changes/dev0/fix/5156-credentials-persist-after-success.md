### Fixed

- Credentials: a saved password or SSH key passphrase is no longer deleted when
  the server rejects it. A rejection can be transient (an account lock, a PAM
  hiccup, the wrong 2FA path), so the saved secret is kept and the password
  prompt says so, with a **Replace saved password** box (ticked by default).
  Unticked, the password you type is used for that connect only. The same
  applies to agent connections and to the file editor's saved sudo password
  (#5156).
- Credentials: a password or passphrase typed into the connect prompt or the
  "Update Credentials" form is saved only once the connection is established.
  A typo is never saved, and a replacement takes over from the saved secret
  only after it connects (#5156).

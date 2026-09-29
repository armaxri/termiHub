### Changed

- A saved FTP or SFTP transfer (and a remote-to-remote copy) now resumes after restarting the
  app without reopening its connection first, when the connection's password or key passphrase
  is saved in the unlocked credential store (#3876). If the store is locked or the secret is not
  saved, the transfer stays paused with "Needs credentials — open the connection to resume":
  open the connection (or unlock the store) and click **Resume**. A transfer never prompts for a
  password on its own, and transfer records still never store credentials.

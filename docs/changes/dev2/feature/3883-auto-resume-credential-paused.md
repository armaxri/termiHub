### Changed

- A transfer paused with "Needs credentials — open the connection to resume" now resumes by
  itself when you open its connection or unlock the credential store (#3883). You no longer have
  to click **Resume**. It never prompts for a password on its own. If the secret is still
  missing, the transfer stays paused. A transfer you paused yourself never resumes on its own.

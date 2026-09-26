### Security

- Embedded server passwords (FTP login and HTTP Basic auth) are no longer stored
  in plaintext in `embedded_servers.json`. They are kept in the credential store
  (master password or OS keychain), like connection passwords, and read from it
  when a server starts. Existing passwords are moved there automatically; with a
  locked master-password store the move completes after you unlock it (#3514).
- When editing a server, the password field stays blank: leave it blank to keep
  the saved password, or type a new one to replace it. Starting a server while
  the credential store is locked asks you to unlock it first.
- With credential storage turned off, embedded server passwords are kept only
  until termiHub restarts and must be re-entered afterwards (a startup notice
  says so when existing passwords are removed from the file). Deleting a server
  also deletes its saved password.
- Backups: embedded servers can now be included in an unencrypted backup. The
  section never carries a password; the passwords travel in the (always
  sealed) credentials section. Restoring a backup made by an older termiHub
  that still holds plaintext server passwords moves them into the credential
  store (unlock it first) instead of writing them back to the file (#3520).

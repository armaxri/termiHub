### Added

- Backend support for **sudo-elevated remote save** over SFTP: a new
  `sftp_write_file_content_elevated` command uploads the edited buffer to a
  termiHub-generated temp path (`/tmp/termihub-<uuid>`) via SFTP, then rewrites
  the destination in place with `sudo -S` over the SSH exec channel
  (`cat "$1" > "$2"`, preserving the file's owner/mode/ACLs), passing the sudo
  password on stdin. The result is a typed outcome — `success`,
  `incorrectPassword` (re-promptable), or `other` (sudo missing / not in
  sudoers / `requiretty` / write error) — the temp file is always cleaned up on
  failure, and the password is never logged. The destination path is
  POSIX-quoted and passed as a positional argument, so a hostile remote path
  cannot inject shell commands. This is the backend building block; the editor
  UI, password prompt, and retry loop land in follow-up work. (#1328, epic
  #1323, concept #970)

### Fixed

- File editor: saving a root-owned file over SSH with sudo now recognises a wrong sudo
  password on remote hosts that use a non-English language (for example German, French or
  Japanese). Before, the wrong password showed up as a generic save error and a stale
  stored sudo password was never cleared. termiHub now asks you for the password again.
- File editor: when elevated save cannot use sudo, the error now says why: sudo is not
  installed, the user is not in the sudoers file, or sudo requires a terminal.

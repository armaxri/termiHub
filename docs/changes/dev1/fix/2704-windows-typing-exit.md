### Fixed

- Windows: a local shell that exits on its own — for example typing `exit`,
  or a script ending — is now reported as ended, so the terminal tab shows
  its exited state instead of appearing to hang open forever. Windows ConPTY,
  unlike a Unix PTY, does not signal end-of-output when the child process
  exits, so the backend now watches the shell process directly and closes the
  session as soon as it exits.

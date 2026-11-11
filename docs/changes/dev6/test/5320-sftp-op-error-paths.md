### Fixed

- Creating a symlink in the file browser of an SSH connection now works.
  OpenSSH reads the two paths of an SFTP symlink request in reverse order, so
  the link was attempted at the target's path and always failed. Symlinks inside
  a folder copied on an SSH host are recreated correctly as well (#5320).
- Copying a file onto itself on an SSH host is now refused. It used to empty the
  file and report success. Copying a folder into itself is refused too, instead
  of recursing until termiHub ran out of stack (#5320).
- A refused chmod, chown or symlink on an SSH host now says "Permission denied"
  and names the file, and a missing file says "File not found", instead of a
  generic "Operation failed" (#5320).

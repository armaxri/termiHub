### Fixed

- Remote desktop: uploading files to a VNC session's host (over SSH or a
  remote agent) could overwrite an existing remote file. When checking whether
  a name was free, any failure to look at it (a permission error, a timeout, a
  dropped connection) counted as "free", and the upload then replaced the file
  that was there. Now only a definite "not found" makes a name free; any other
  failure skips that file with the real reason. Over SSH, the chosen name is
  also created exclusively before the upload starts, so a file that appears in
  the meantime is kept and the upload moves on to the next "name (N)" (#4299).

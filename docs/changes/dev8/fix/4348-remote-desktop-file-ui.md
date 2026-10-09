### Fixed

- Remote desktop: dropping files on a VNC session whose linked SSH connection needs a
  password no longer silently discards the drop when the prompt is canceled, the password
  is rejected, or the route fails — a toast now says why nothing was uploaded.
- Remote desktop: the "Uploading N files…" toast always resolves. If the uploads stop
  reporting progress or the session closes, it points to Transfers instead of spinning
  forever, and a drop no longer shows a per-file toast for every file on top of the summary.
- Remote desktop: RDP tabs no longer show a disabled Files button, a drop overlay and a
  toast telling you to turn on a "File Transfer" setting that RDP does not have. RDP moves
  files with drive redirection and clipboard copy/paste instead.

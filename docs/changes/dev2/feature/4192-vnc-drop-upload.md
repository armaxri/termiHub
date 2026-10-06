### Added

- VNC: drag files or folders onto a VNC session to upload them over the connection's SSH tunnel
  (SFTP) or its agent. The drop overlay names the destination folder and host before you drop.
  A new toolbar **Files** button offers **Upload files…** and **Upload to folder…** and lists
  the session's transfers. Uploads run in the Transfers queue with progress and cancel; a name
  clash keeps both files, symbolic links are skipped, and closing the session cancels its
  uploads. Requires **File Transfer** to be turned on for the connection (#4192, concept #3770).

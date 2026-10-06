### Added

- VNC: uploads and downloads over a VNC session's file side channel (drop-to-upload and
  **Browse remote files**) are now kept in the Transfers queue across a restart. One cut off by
  quitting termiHub comes back paused with "VNC session unavailable — reconnect to resume" and
  continues from where it stopped as soon as you reopen that saved VNC connection, over the SSH
  tunnel or the agent. If the connection now leads to a different file host, the transfer is not
  continued there and says so. Sessions of unsaved connections are not resumed (#4205).

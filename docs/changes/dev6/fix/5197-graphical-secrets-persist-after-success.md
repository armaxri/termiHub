### Fixed

- A VNC/RDP password typed into the connect prompt with "Save password" ticked is now saved only
  once the remote desktop connects. A typo, a rejected or failed connect, a canceled connect or a
  closed tab no longer saves it, and a saved password is never deleted (#5197).
- The password or key passphrase of a VNC connection's linked SSH file route is now saved only
  once the file channel opens with it, so a rejected typo is never saved (#5197).
